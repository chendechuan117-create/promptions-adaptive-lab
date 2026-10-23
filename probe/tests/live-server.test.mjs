import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { generatePrethink } from '../../server/prethink.mjs';
import { createLiveRuntime } from '../live-runtime.mjs';
import { startLiveServer, LIVE_RESOURCE_URI, LIVE_MAX_BODY_BYTES } from '../live-server.mjs';
const rounds = [
  { selected: [{ label: '读者兴趣', hint: '从读者已有的问题进入' }], note: '每周三在图书馆举办' },
  { selected: [{ label: '共同创作', hint: '可以考虑协作写作' }], note: '有人只在线参加' },
  { selected: [{ label: '后续联系', hint: '可考虑活动后的交流' }], note: '不收集私人联系方式' },
];
const request = (overrides = {}) => ({ clientId: randomUUID(), requestId: randomUUID(), version: 1, mode: 'cues', variant: 'baseline', goal: '设计一次社区读书交流活动', parentRequestId: null, selected: [], note: '', ...overrides });
const resultFor = req => ({ requestId: req.requestId, version: req.version, mode: req.mode, variant: req.variant, options: rounds.flatMap(round => round.selected), metrics: { reasoning: 'none', toolsUsed: [] } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferredGenerate() {
  const calls = [];
  return { calls, generate: (req, { signal }) => new Promise((resolve, reject) => {
    const call = { req, signal, resolve: () => resolve(resultFor(req)), reject }; calls.push(call);
    signal.addEventListener('abort', () => reject(new Error('sensitive provider cancellation')), { once: true });
  }) };
}
async function connect(server) {
  const client = new Client({ name: 'live-mock-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  return client;
}
async function fixture(t, options = {}) {
  const server = await startLiveServer({ port: 0, widgetHtml: '<!doctype html><html><body>mock widget</body></html>', ...options });
  const client = await connect(server);
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, client };
}
test('MCP discovery, free start/legacy alias, arbitrary goal+3 ordered rounds reach generate unchanged', async t => {
  const calls = [];
  const runtime = createLiveRuntime({ maxCalls: 8, generate: async req => { calls.push(req); return resultFor(req); } });
  const { server, client } = await fixture(t, { runtime });
  assert.equal(server.address().address, '127.0.0.1');
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name), ['start_prethinking', 'start_prethink_probe', 'generate_prethink_cues', 'cancel_prethink', 'prepare_prethink_handoff']);
  for (const tool of tools.slice(2)) { assert.deepEqual(tool._meta.ui.visibility, ['app']); assert.equal(tool._meta.ui.resourceUri, undefined); }
  assert.equal(tools[0]._meta.ui.resourceUri, LIVE_RESOURCE_URI);
  const start = await client.callTool({ name: 'start_prethinking', arguments: { goal: '组织社区活动' } });
  assert.deepEqual(start.structuredContent, { mode: 'start', goal: '组织社区活动', provider: 'deepseek', model: 'deepseek-flash' });
  assert.equal((await client.callTool({ name: 'start_prethink_probe', arguments: {} })).structuredContent.goal, '');
  assert.equal(calls.length, 0);
  assert.equal(runtime.stats().used, 0);
  assert.match((await client.readResource({ uri: LIVE_RESOURCE_URI })).contents[0].text, /mock widget/);
  const first = request();
  let req = first;
  let response = await client.callTool({ name: 'generate_prethink_cues', arguments: req });
  assert.equal(response.isError, undefined);
  for (const [i, round] of rounds.entries()) {
    req = request({ clientId: first.clientId, version: i + 2, parentRequestId: req.requestId, selected: round.selected, note: round.note });
    response = await client.callTool({ name: 'generate_prethink_cues', arguments: req });
    assert.equal(response.isError, undefined);
  }
  assert.deepEqual(response.structuredContent, resultFor(req));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3].rounds, rounds);
  assert.equal(calls[3].goal, req.goal);
  assert.equal(calls[3].variant, 'baseline');
  assert.equal(calls[3].mode, 'cues');
  assert.equal(tools[2].inputSchema.properties.rounds, undefined);
  assert.equal(tools[4].inputSchema.properties.rounds, undefined);
  const handoff = await client.callTool({ name: 'prepare_prethink_handoff', arguments: { clientId: first.clientId, goal: req.goal, parentRequestId: req.requestId, selected: [], note: '' } });
  assert.deepEqual(handoff.structuredContent.rounds, rounds);
  assert.equal(handoff.structuredContent.goal, req.goal);
  assert.equal(calls.length, 4);
  const answer = await client.callTool({ name: 'generate_prethink_cues', arguments: { ...req, version: 2, mode: 'answer' } });
  assert.equal(answer.isError, true);
  assert.equal(calls.length, 4);
});
test('client cancellation isolation; duplicates share pending/completed result without extra debit', async () => {
  const mock = deferredGenerate();
  const runtime = createLiveRuntime({ maxCalls: 5, generate: mock.generate });
  const a = request(), b = request();
  const pa = runtime.run(a), duplicate = runtime.run(a), pb = runtime.run(b);
  assert.equal(pa, duplicate);
  await tick();
  assert.equal(mock.calls.length, 2);
  assert.equal(runtime.stats().used, 2);
  assert.deepEqual(runtime.cancel({ ...a, clientId: b.clientId }), { ok: true, cancelled: false });
  assert.equal(mock.calls[0].signal.aborted, false);
  assert.equal(runtime.cancel(a).cancelled, true);
  await assert.rejects(pa, /取消/);
  assert.equal(mock.calls[1].signal.aborted, false);
  mock.calls[1].resolve();
  const result = await pb;
  assert.deepEqual(await runtime.run(b), result);
  assert.equal(runtime.stats().used, 2);
  await assert.rejects(runtime.run({ ...b, goal: 'different' }), /不同内容/);
});
test('superseded versions cannot return late results; only two provider calls can be active', async () => {
  const mock = deferredGenerate(); const runtime = createLiveRuntime({ maxCalls: 5, generate: mock.generate });
  const a = request(); const first = runtime.run(a); first.catch(() => {});
  await tick();
  const next = runtime.run({ ...a, version: 2, requestId: randomUUID() });
  await tick();
  await assert.rejects(first, /取消|替换/);
  mock.calls[1].resolve(); await next;
  await assert.rejects(runtime.run({ ...a, requestId: randomUUID(), version: 1 }), /过期/);
  const x = runtime.run(request()), y = runtime.run(request());
  await assert.rejects(runtime.run(request()), /较多/);
  await tick(); mock.calls.at(-2).resolve(); mock.calls.at(-1).resolve(); await Promise.all([x, y]);
});
test('budget defaults off, failures charged once and redacted; no answer or oversized original request reaches generate', async t => {
  let calls = 0;
  const generate = async () => { calls++; throw new Error('sk-secret PRIVATE USER NOTE'); };
  const disabled = createLiveRuntime({ generate });
  await assert.rejects(disabled.run(request()), /预算/); assert.equal(calls, 0);
  const runtime = createLiveRuntime({ maxCalls: 1, generate });
  const { client } = await fixture(t, { runtime });
  const req = request();
  const failed = await client.callTool({ name: 'generate_prethink_cues', arguments: req });
  assert.equal(failed.isError, true); assert.doesNotMatch(JSON.stringify(failed), /sk-secret|PRIVATE USER NOTE/);
  const repeated = await client.callTool({ name: 'generate_prethink_cues', arguments: req });
  assert.deepEqual(repeated, failed); assert.equal(calls, 1);
  const exhausted = await client.callTool({ name: 'generate_prethink_cues', arguments: request() });
  assert.match(JSON.stringify(exhausted), /BUDGET_EXHAUSTED/); assert.equal(calls, 1);
  assert.throws(() => runtime.run(request({ mode: 'answer' })), /不生成正式答案/);
  const large = Array.from({ length: 24 }, () => ({ selected: [], note: 'a'.repeat(2000) }));
  assert.throws(() => runtime.run(request({ rounds: large })), /过长/);
  assert.equal(calls, 1);
});
test('deadline aborts and redacts; ledger persists only count across restart and fails closed', async t => {
  const mock = deferredGenerate();
  const runtime = createLiveRuntime({ maxCalls: 1, deadlineMs: 10, generate: mock.generate });
  await assert.rejects(runtime.run(request()), /超时/);
  assert.equal(mock.calls[0].signal.aborted, true);
  const dir = mkdtempSync(join(tmpdir(), 'thoughtscout-count-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, 'budget.json');
  const one = createLiveRuntime({ maxCalls: 1, ledgerPath, generate: async req => resultFor(req) });
  await one.run(request());
  assert.deepEqual(JSON.parse(readFileSync(ledgerPath, 'utf8')), { used: 1 });
  const two = createLiveRuntime({ maxCalls: 1, ledgerPath, generate: async () => assert.fail('must not call') });
  await assert.rejects(two.run(request()), /预算/);
  writeFileSync(ledgerPath, 'broken');
  assert.throws(() => createLiveRuntime({ maxCalls: 1, ledgerPath }), /账本无效/);
});
test('handoff preserves original goal and ordered selected hints/notes without fact promotion', async () => {
  const goal = '社区活动'; const runtime = createLiveRuntime({ maxCalls: 5, generate: async req => resultFor(req) });
  let req = request({ goal }); await runtime.run(req);
  for (const [i, round] of rounds.entries()) { req = request({ goal, clientId: req.clientId, version: i + 2, parentRequestId: req.requestId, selected: round.selected, note: round.note }); await runtime.run(req); }
  const result = runtime.prepareHandoff({ clientId: req.clientId, goal, parentRequestId: req.requestId, selected: [], note: '' });
  assert.deepEqual(result.rounds, rounds); assert.equal(result.goal, goal);
  assert.ok(result.summary.indexOf(rounds[0].note) < result.summary.indexOf(rounds[1].note));
  assert.ok(result.summary.indexOf(rounds[1].note) < result.summary.indexOf(rounds[2].note));
  assert.match(result.summary, /不是事实/); assert.match(result.summary, /未选择不等于排除/);
  const empty = runtime.prepareHandoff({ clientId: randomUUID(), goal, parentRequestId: null, selected: [], note: '初始补充' });
  assert.deepEqual(empty.rounds, [{ selected: [], note: '初始补充' }]);
});
test('HTTP host/origin, JSON body bounds and stateless JSON response protections', async t => {
  const { server } = await fixture(t);
  const url = `http://127.0.0.1:${server.address().port}`;
  const hostStatus = await new Promise((resolve, reject) => { const req = httpRequest(url, { headers: { Host: 'untrusted.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(url, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await fetch(url + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: 'x'.repeat(LIVE_MAX_BODY_BYTES + 1) })).status, 413);
  const health = await fetch(url); assert.equal(health.status, 200); assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal((await health.json()).budget.maxCalls, 0);
});

test('real original generator uses flash reasoning none with complete internally reconstructed rounds', async () => {
  let providerArgs;
  const runtime = createLiveRuntime({ maxCalls: 5, generate: (input, { signal }) => generatePrethink(input, { signal, transport: async args => {
    providerArgs = args;
    return { value: { options: rounds.flatMap(round => round.selected) }, metrics: {} };
  } }) });
  let req = request(); await runtime.run(req); let result;
  for (const [i, round] of rounds.entries()) { req = request({ clientId: req.clientId, version: i + 2, parentRequestId: req.requestId, selected: round.selected, note: round.note }); result = await runtime.run(req); }
  assert.equal(providerArgs.model, 'deepseek-flash');
  assert.equal(providerArgs.reasoning, 'none');
  assert.equal(providerArgs.timeoutMs, 30_000);
  assert.match(providerArgs.prompt, /设计一次社区读书交流活动/);
  for (const round of rounds) assert.ok(providerArgs.prompt.includes(round.note));
  assert.equal(result.mode, 'cues');
  assert.equal(result.metrics.reasoning, 'none');
});
test('cancelled provider ignoring abort retains concurrency slot until its actual settlement', async () => {
  const releases = [];
  const runtime = createLiveRuntime({ maxCalls: 5, generate: req => new Promise(resolve => releases.push(() => resolve(resultFor(req)))) });
  const a = request(), b = request();
  const pa = runtime.run(a), pb = runtime.run(b);
  await tick();
  runtime.cancel(a); await assert.rejects(pa, /取消/);
  assert.equal(runtime.stats().inFlight, 2);
  await assert.rejects(runtime.run(request()), /较多/);
  releases[0](); releases[1](); await pb; await tick();
  assert.equal(runtime.stats().inFlight, 0);
});

test('parent is isolated by client, matched to goal/variant and validates selected options before debit', async () => {
  const runtime = createLiveRuntime({ maxCalls: 5, generate: async req => resultFor(req) });
  const parent = request(); await runtime.run(parent);
  const next = request({ clientId: parent.clientId, version: 2, parentRequestId: parent.requestId, selected: rounds[0].selected, note: rounds[0].note });
  for (const invalid of [ { clientId: randomUUID() }, { goal: 'other' }, { variant: 'scoped' }, { selected: [{ label: '注入方向', hint: '不是上轮生成的选项' }] } ]) await assert.rejects(runtime.run({ ...next, ...invalid }), /上轮记录|所选方向/);
  assert.throws(() => runtime.prepareHandoff({ clientId: randomUUID(), goal: parent.goal, parentRequestId: parent.requestId, selected: [], note: '' }), /上轮记录/);
  assert.throws(() => runtime.run({ ...next, rounds }), /增量格式/);
  assert.equal(runtime.stats().used, 1);
  await runtime.run(next); assert.equal(runtime.stats().used, 2);
});
test('cancelled or failed child never commits; an older completed parent remains usable for branch retry', async () => {
  const mock = deferredGenerate(); const runtime = createLiveRuntime({ maxCalls: 6, generate: mock.generate });
  const parent = request(); const p = runtime.run(parent); await tick(); mock.calls[0].resolve(); await p;
  const child = request({ clientId: parent.clientId, version: 2, parentRequestId: parent.requestId, selected: rounds[0].selected, note: '被取消的备注' });
  const cancelled = runtime.run(child); await tick(); runtime.cancel(child); await assert.rejects(cancelled, /取消/);
  assert.throws(() => runtime.prepareHandoff({ clientId: child.clientId, goal: child.goal, parentRequestId: child.requestId, selected: [], note: '' }), /上轮记录/);
  const retry = { ...child, requestId: randomUUID(), version: 3, note: '分支重试的备注' };
  const done = runtime.run(retry); await tick(); mock.calls[2].resolve(); await done;
  assert.deepEqual(mock.calls[2].req.rounds, [{ selected: rounds[0].selected, note: '分支重试的备注' }]);
  const sibling = { ...retry, requestId: randomUUID(), version: 4, note: '从更早parent另试' };
  const branched = runtime.run(sibling); await tick(); mock.calls[3].resolve(); await branched;
  assert.equal(mock.calls[3].req.rounds.length, 1);
  const failed = { ...child, requestId: randomUUID(), version: 5, note: '失败备注' };
  const failure = runtime.run(failed); await tick(); mock.calls[4].reject(new Error('private provider text')); await assert.rejects(failure, /未能生成/);
  assert.throws(() => runtime.prepareHandoff({ clientId: failed.clientId, goal: failed.goal, parentRequestId: failed.requestId, selected: [], note: '' }), /上轮记录/);
  const recovered = { ...child, requestId: randomUUID(), version: 6, note: '恢复后的备注' };
  const recoveredPromise = runtime.run(recovered); await tick(); mock.calls[5].resolve(); await recoveredPromise;
  assert.deepEqual(mock.calls[5].req.rounds, [{ selected: rounds[0].selected, note: '恢复后的备注' }]);
});
test('snapshot TTL is separate from dedup cache and retained task still enforces original 24K bound', async () => {
  let clock = 1000; const runtime = createLiveRuntime({ maxCalls: 30, now: () => clock, generate: async req => resultFor(req) });
  const first = request(); await runtime.run(first); clock += 61_000;
  let req = request({ clientId: first.clientId, parentRequestId: first.requestId, version: 2, note: 'a'.repeat(2000) });
  for (let i = 0; i < 10; i++) { await runtime.run(req); req = request({ clientId: req.clientId, parentRequestId: req.requestId, version: req.version + 1, note: 'a'.repeat(2000) }); }
  await runtime.run(req); req = request({ clientId: req.clientId, parentRequestId: req.requestId, version: req.version + 1, note: 'a'.repeat(2000) });
  await assert.rejects(runtime.run(req), /内容过长/);
  clock += 2 * 60 * 60 * 1000 + 1;
  assert.throws(() => runtime.prepareHandoff({ clientId: first.clientId, goal: first.goal, parentRequestId: first.requestId, selected: [], note: '' }), /上轮记录/);
});

test('per-client snapshot capacity fails closed at 32 completed records without extra billing', async () => {
  const runtime = createLiveRuntime({ maxCalls: 40, generate: async req => resultFor(req) });
  const clientId = randomUUID();
  for (let version = 1; version <= 32; version++) await runtime.run(request({ clientId, version }));
  assert.equal(runtime.stats().used, 32);
  await assert.rejects(runtime.run(request({ clientId, version: 33 })), /容量已满/);
  assert.equal(runtime.stats().used, 32);
});
