import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { createLiveRuntime, CLIENT_ID_PATTERN, LiveError, liveDeltaSchema, handoffDeltaSchema } from './live-runtime.mjs';

export const LIVE_RESOURCE_URI = 'ui://thoughtscout/prethinking-v1.html';
// JSON-RPC envelope + escaped Unicode can be larger than the original 24KB payload.
export const LIVE_MAX_BODY_BYTES = 96 * 1024;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const clientId = z.string().regex(CLIENT_ID_PATTERN);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const option = z.strictObject({ label: z.string().trim().min(1).max(80), hint: z.string().trim().min(1).max(240) });
const rounds = z.array(z.strictObject({ selected: z.array(option).max(24), note: z.string().max(2000) })).max(24);
const goal = z.string().trim().min(1).max(4000);
const requestSchema = liveDeltaSchema;
const cancelSchema = z.strictObject({ clientId, requestId: id, version });
const handoffSchema = handoffDeltaSchema;
const securitySchemes = [{ type: 'noauth' }];
const uiMeta = { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } };
const pure = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const dataMeta = { securitySchemes, ui: { visibility: ['app'] } };
const reply = structuredContent => ({ structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] });
const safely = fn => async args => {
  try { return reply(await fn(args)); }
  catch (error) {
    const safe = error instanceof LiveError ? { code: error.code, error: error.message } : { code: 'INTERNAL_ERROR', error: '操作未完成，已有输入仍保留。' };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(safe) }] };
  }
};

export function createLiveMcpServer({ runtime = createLiveRuntime(), widgetHtml } = {}) {
  const server = new McpServer({ name: 'thoughtscout-live-prethinking', version: '0.2.0' });
  // Keep the prior resource URI readable while hosts refresh cached tool metadata.
  // Both URIs serve the current dynamic widget; tool descriptions/schemas still need refresh.
  for (const [name, uri] of [['thoughtscout-prethinking', LIVE_RESOURCE_URI], ['thoughtscout-prethinking-legacy-uri', 'ui://thoughtscout/probe.html']]) {
    registerAppResource(server, name, uri,
      { description: '自主输入目标、连续联想与用户主动交接。', _meta: { ui: uiMeta } },
      async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE,
        text: widgetHtml ?? readFileSync(new URL('../dist-prethink-widget/widget.html', import.meta.url), 'utf8'), _meta: { ui: uiMeta } }] }));
  }
  const start = initialGoal => reply({ mode: 'start', goal: initialGoal, provider: 'deepseek', model: 'deepseek-flash' });
  const startConfig = {
    title: '开启预思考',
    description: '打开预思考卡片，可传入用户原目标。仅打开界面，不调用模型。等待用户在卡片内输入、点击联想或交接，不自动遍历方向或提前给出完整答案。联想生成使用DeepSeek并受试验预算限制；最终回答由ChatGPT完成。',
    annotations: pure, _meta: { securitySchemes, ui: { resourceUri: LIVE_RESOURCE_URI, visibility: ['model', 'app'] } },
    outputSchema: z.strictObject({ mode: z.literal('start'), goal: z.string(), provider: z.literal('deepseek'), model: z.literal('deepseek-flash') }),
  };
  registerAppTool(server, 'start_prethinking', { ...startConfig, inputSchema: z.strictObject({ goal: z.string().trim().max(4000).default('') }) }, async ({ goal }) => start(goal));
  registerAppTool(server, 'start_prethink_probe', { ...startConfig, title: '开启预思考（兼容入口）', inputSchema: z.strictObject({}) }, async () => start(''));
  server.registerTool('generate_prethink_cues', {
    title: '生成下一轮联想方向', description: '仅卡片主动调用：提交本轮选择和备注，由服务端衔接当前任务生成联想，DeepSeek Flash reasoning none；不生成正式答案。消耗有限试验预算，失败不返还；不自动重试。',
    inputSchema: requestSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, _meta: dataMeta,
  }, safely(args => runtime.run(args)));
  server.registerTool('cancel_prethink', {
    title: '取消当前联想请求', description: '仅取消匹配随机客户端标识、请求标识和版本的当前请求。已经开始的模型调用不退回预算。',
    inputSchema: cancelSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: dataMeta,
  }, safely(args => runtime.cancel(args)));
  server.registerTool('prepare_prethink_handoff', {
    title: '整理预思考交接', description: '按原顺序整理原目标、历轮待考虑方向和用户补充，方向不是事实。不调用模型；由卡片更新上下文并主动交给ChatGPT回答。',
    inputSchema: handoffSchema, outputSchema: z.strictObject({ goal, rounds, summary: z.string() }), annotations: pure, _meta: dataMeta,
  }, safely(args => runtime.prepareHandoff(args)));
  return server;
}

export function createLiveHttpServer({ runtime = createLiveRuntime(), publicHost = '', widgetHtml } = {}) {
  const hosts = new Set(['localhost', '127.0.0.1']);
  if (publicHost) {
    if (!/^[a-z0-9.-]+$/i.test(publicHost)) throw new Error('Invalid public hostname');
    hosts.add(publicHost.toLowerCase());
  }
  const http = createServer({ requestTimeout: 40_000, headersTimeout: 10_000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    let pathname;
    try {
      if (!hosts.has(new URL(`http://${req.headers.host || ''}`).hostname)) { res.writeHead(403).end('Host not allowed'); return; }
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch { res.writeHead(400).end('Bad Request'); return; }
    if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end('Browser origin not allowed'); return; }
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'thoughtscout-live-prethinking', provider: 'deepseek', model: 'deepseek-flash', budget: runtime.stats() })); return;
    }
    if (pathname !== '/mcp') { res.writeHead(404).end('Not Found'); return; }
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) { res.writeHead(405, { Allow: 'POST, GET, DELETE' }).end('Method Not Allowed'); return; }
    const server = createLiveMcpServer({ runtime, widgetHtml });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: LIVE_MAX_BODY_BYTES });
    res.once('close', () => { void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500).end('Internal server error'); else res.end(); }
  });
  http.once('close', () => runtime.close());
  return http;
}
export async function startLiveServer({ port = 5195, ...options } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const server = createLiveHttpServer(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rawBudget = process.env.THOUGHTSCOUT_LIVE_MAX_CALLS;
  if (rawBudget !== undefined && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawBudget)) throw new Error('Invalid explicit live call budget');
  const runtime = createLiveRuntime({ maxCalls: rawBudget === undefined ? 0 : Number(rawBudget), ledgerPath: process.env.THOUGHTSCOUT_LIVE_BUDGET_LEDGER });
  const server = await startLiveServer({ port: Number(process.env.PORT ?? 5195), publicHost: process.env.THOUGHTSCOUT_PUBLIC_HOST || '', runtime });
  console.log(`ThoughtScout live prethinking: http://127.0.0.1:${server.address().port}/mcp`);
}
