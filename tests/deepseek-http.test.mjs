import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { requestStructured } from '../server/deepseek-http.mjs';

const schema = { type: 'object', properties: { next_step: { type: 'string' } }, required: ['next_step'], additionalProperties: false };
const value = { next_step: '核查步行距离，保留十五分钟限制。' };
const defaults = { prompt: '测试用假资料', schema, apiKey: 'test-key-never-real' };
const sse = event => `data: ${JSON.stringify(event)}\r\n\r\n`;
const message = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const complete = (text = JSON.stringify(value), extra = {}) => ({ type: 'response.completed', response: { id: 'resp_test', model: 'deepseek-flash', status: 'completed', output: [message(text)], usage: { input_tokens: 12, output_tokens: 23, total_tokens: 35, output_tokens_details: { reasoning_tokens: 8 } }, ...extra } });
async function serve(t, handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => { res.destroy(error); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
function stream(res, body) { res.setHeader('Content-Type', 'text/event-stream; charset=utf-8'); res.end(body); }
const hasCode = code => error => error.code === code;

test('DeepSeek consumes split UTF-8/SSE, waits for completion, and returns no reasoning or provider extras', async t => {
  let received, authorization, requestPath, release;
  const released = new Promise(resolve => { release = resolve; });
  let deltaSent;
  const deltaReady = new Promise(resolve => { deltaSent = resolve; });
  const baseUrl = await serve(t, async (req, res) => {
    requestPath = req.url; authorization = req.headers.authorization;
    let body = ''; for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.setHeader('Content-Type', 'text/event-stream');
    const bytes = Buffer.from(': keepalive\r\nevent: response.output_text.delta\r\n' + sse({ type: 'response.reasoning_text.delta', delta: 'PRIVATE_REASONING' }) + sse({ type: 'response.output_text.delta', delta: JSON.stringify(value) }));
    for (let i = 0; i < bytes.length; i += 5) res.write(bytes.subarray(i, i + 5));
    deltaSent();
    await released;
    // Multiline SSE data is valid, and completion can precede connection close.
    const finished = complete(undefined, { output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] }, message(JSON.stringify(value))], usage: { input_tokens: 12, output_tokens: 23, hidden: 'PRIVATE_REASONING' } });
    res.write('data: ' + JSON.stringify(finished, null, 2).replaceAll('\n', '\r\ndata: ') + '\r\n\r\n');
  });
  let resolved = false;
  const pending = requestStructured({ ...defaults, baseUrl }).then(result => { resolved = true; return result; });
  await deltaReady;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(resolved, false);
  release();
  const output = await pending;
  assert.deepEqual(output.value, value);
  assert.equal(output.metrics.model, 'deepseek-flash');
  assert.equal(output.metrics.responseId, 'resp_test');
  assert.ok(output.metrics.firstTextMs <= output.metrics.elapsedMs);
  assert.equal(JSON.stringify(output).includes('PRIVATE_REASONING'), false);
  assert.deepEqual(output.metrics.usage, { input_tokens: 12, output_tokens: 23 });
  assert.equal(requestPath, '/responses');
  assert.equal(authorization, 'Bearer test-key-never-real');
  assert.deepEqual(received.text.format.schema, schema);
  assert.deepEqual(received.reasoning, { effort: 'low' });
  assert.equal(received.max_output_tokens, 3000);
  assert.equal(received.tools, undefined);
});

test('DeepSeek rejects nonofficial remote endpoints before sending a key, and refuses redirects', async t => {
  let calls = 0;
  for (const baseUrl of ['https://example.com', 'http://api.deepseek.com', 'https://api.deepseek.com@evil.example', 'https://api.deepseek.com/other', 'https://api.deepseek.com/?key=secret']) {
    await assert.rejects(requestStructured({ ...defaults, baseUrl, fetchImpl: () => { calls++; } }), hasCode('INVALID_ENDPOINT'));
  }
  assert.equal(calls, 0);
  const target = await serve(t, () => { calls++; });
  const baseUrl = await serve(t, (_req, res) => { res.writeHead(302, { Location: target }); res.end(); });
  await assert.rejects(requestStructured({ ...defaults, baseUrl }), hasCode('NETWORK_ERROR'));
  assert.equal(calls, 0);
});

test('DeepSeek accepts CR-only SSE and a complete terminal event at EOF', async t => {
  let calls = 0;
  const baseUrl = await serve(t, (_req, res) => {
    calls++;
    stream(res, calls === 1 ? sse(complete()).replaceAll('\r\n', '\r') : sse(complete()).trimEnd());
  });
  assert.deepEqual((await requestStructured({ ...defaults, baseUrl })).value, value);
  assert.deepEqual((await requestStructured({ ...defaults, baseUrl })).value, value);
});

test('DeepSeek distinguishes caller cancellation from a full-response deadline', async t => {
  const baseUrl = await serve(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(sse({ type: 'response.output_text.delta', delta: JSON.stringify(value) }));
  });
  const controller = new AbortController();
  const pending = requestStructured({ ...defaults, baseUrl, signal: controller.signal });
  setTimeout(() => controller.abort(new Error('PRIVATE_REASON')), 25);
  await assert.rejects(pending, error => error.code === 'CANCELLED' && !error.message.includes('PRIVATE_REASON'));
  const start = performance.now();
  await assert.rejects(requestStructured({ ...defaults, baseUrl, timeoutMs: 45 }), hasCode('TIMEOUT'));
  assert.ok(performance.now() - start < 1000);
  const cancelled = new AbortController(); cancelled.abort();
  let calls = 0;
  await assert.rejects(requestStructured({ ...defaults, signal: cancelled.signal, fetchImpl: () => { calls++; } }), hasCode('CANCELLED'));
  assert.equal(calls, 0);
});

test('DeepSeek rejects interrupted, incomplete, failed, or contradictory completed responses', async t => {
  const cases = [
    [sse({ type: 'response.output_text.delta', delta: JSON.stringify(value) }) + 'data: [DONE]\n\n', 'INCOMPLETE'],
    [sse({ type: 'response.incomplete', response: { status: 'incomplete' } }), 'INCOMPLETE'],
    [sse({ type: 'response.failed', response: { error: { message: 'PRIVATE_PROVIDER_ERROR' } } }), 'PROVIDER_ERROR'],
    [sse(complete(undefined, { status: 'incomplete' })), 'INCOMPLETE'],
    [sse(complete(undefined, { status: undefined })), 'INCOMPLETE'],
    [sse(complete(undefined, { output: [] })), 'PROTOCOL_ERROR'],
    [sse({ type: 'response.output_text.delta', delta: '{"different":true}' }) + sse(complete()), 'PROTOCOL_ERROR'],
  ];
  let index = 0;
  const baseUrl = await serve(t, (_req, res) => stream(res, cases[index++][0]));
  for (const [, code] of cases) {
    await assert.rejects(requestStructured({ ...defaults, baseUrl }), error => error.code === code && !error.message.includes('PRIVATE_PROVIDER_ERROR'));
  }
});

test('DeepSeek rejects tool outputs, malformed events, invalid JSON and oversized reasoning', async t => {
  const cases = [
    [sse({ type: 'response.output_item.added', item: { type: 'function_call', name: 'do_something' } }), 'TOOL_OUTPUT'],
    [sse({ type: 'response.created', response: { output: [{ type: 'function_call', name: 'do_something' }] } }), 'TOOL_OUTPUT'],
    [sse(complete(undefined, { output: [{ type: 'web_search_call' }] })), 'TOOL_OUTPUT'],
    ['data: {broken\n\n', 'PROTOCOL_ERROR'],
    [sse(complete('{"unfinished":')), 'INVALID_JSON'],
    [sse({ type: 'response.reasoning_text.delta', delta: 'x'.repeat(128 * 1024 + 1) }), 'OUTPUT_LIMIT'],
    ['data: ' + 'x'.repeat(256 * 1024 + 1), 'OUTPUT_LIMIT'],
  ];
  let index = 0;
  const baseUrl = await serve(t, (_req, res) => stream(res, cases[index++][0]));
  for (const [, code] of cases) await assert.rejects(requestStructured({ ...defaults, baseUrl }), hasCode(code));
});

test('DeepSeek HTTP and malformed failures do not retry, leak payloads, or poison a later request', async t => {
  let calls = 0;
  const baseUrl = await serve(t, (_req, res) => {
    calls++;
    if (calls === 1) { res.writeHead(429); res.end('PRIVATE_KEY test-key-never-real'); return; }
    if (calls === 2) { stream(res, 'data: broken\n\n'); return; }
    stream(res, sse(complete()));
  });
  await assert.rejects(requestStructured({ ...defaults, baseUrl }), error => error.code === 'HTTP_ERROR' && error.status === 429 && !JSON.stringify(error).includes('test-key-never-real'));
  assert.equal(calls, 1);
  await assert.rejects(requestStructured({ ...defaults, baseUrl }), hasCode('PROTOCOL_ERROR'));
  assert.equal(calls, 2);
  assert.deepEqual((await requestStructured({ ...defaults, baseUrl })).value, value);
  assert.equal(calls, 3);
  await assert.rejects(requestStructured({ ...defaults, fetchImpl: async () => { throw new Error('PRIVATE_KEY test-key-never-real'); } }), error => error.code === 'NETWORK_ERROR' && !error.message.includes('test-key-never-real'));
});
