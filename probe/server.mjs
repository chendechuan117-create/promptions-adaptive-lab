import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { OPTION_IDS, rootResult, expandedResult, handoffResult } from './data.mjs';

export const RESOURCE_URI = 'ui://thoughtscout/probe.html';
export const MAX_BODY_BYTES = 16 * 1024;
const annotation = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const security = { securitySchemes: [{ type: 'noauth' }] };
const ui = { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true };
const optSchema = z.strictObject({ id: z.enum(OPTION_IDS), label: z.string(), hint: z.string() });
const baseSchema = { fixture: z.literal(true), scope: z.string(), goal: z.string(), options: z.array(optSchema) };
const reply = (structuredContent) => ({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent });

export function createProbeMcpServer({ widgetHtml } = {}) {
  const server = new McpServer({ name: 'thoughtscout-fixed-probe', version: '0.1.0' });
  registerAppResource(server, 'thoughtscout-probe', RESOURCE_URI,
    { description: '固定合成方向交互探针；无外部资源或联网需求。', _meta: { ui } },
    async () => ({ contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE,
      text: widgetHtml ?? readFileSync(new URL('./widget.html', import.meta.url), 'utf8'), _meta: { ui } }] }));
  registerAppTool(server, 'start_prethink_probe', {
    title: '打开固定方向交互探针',
    description: '展示挑选住宿的固定合成考虑方向，仅验证 MCP Apps 交互，不生成建议、不证明模型质量。无需认证、不存储私密数据、不使用付费后端。打开卡片后等待用户在卡片中选择或交接，不自动遍历子方向或提前给出完整答案。',
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ ...baseSchema, view: z.literal('root') }),
    annotations: annotation, _meta: { ...security, ui: { resourceUri: RESOURCE_URI, visibility: ['model', 'app'] } },
  }, async () => reply(rootResult()));
  server.registerTool('expand_prethink_probe', {
    title: '展开固定考虑方向',
    description: '返回所选方向的固定子方向，未经核实，不是住宿事实；无存储、无外部调用。',
    inputSchema: z.strictObject({ focus: z.enum(['commute', 'rest', 'daily', 'cost']) }),
    outputSchema: z.strictObject({ ...baseSchema, view: z.literal('expanded'), focus: z.enum(['commute', 'rest', 'daily', 'cost']) }),
    annotations: annotation, _meta: { ...security, ui: { visibility: ['model', 'app'] } },
  }, async ({ focus }) => reply(expandedResult(focus)));
  server.registerTool('prepare_probe_handoff', {
    title: '整理待考虑方向',
    description: '把最多12个固定方向及最多400字用户备注整理为继续讨论的文本。所有方向均待考虑且未经核实；备注为用户输入。无持久化、无共享会话、无模型调用。',
    inputSchema: z.strictObject({ selected_ids: z.array(z.enum(OPTION_IDS)).max(12), note: z.string().max(400).default('') }),
    outputSchema: z.strictObject({ fixture: z.literal(true), goal: z.string(), selected: z.array(z.strictObject({ id: z.enum(OPTION_IDS), label: z.string() })), note: z.string(), summary: z.string() }),
    annotations: annotation, _meta: { ...security, ui: { visibility: ['model', 'app'] } },
  }, async ({ selected_ids, note }) => reply(handoffResult(selected_ids, note)));
  return server;
}

// Each request owns its server and transport; no sessions or notes are retained.
export function createProbeHttpServer(options = {}) {
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let pathname;
    try { pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname; }
    catch { res.writeHead(400).end('Bad Request'); return; }
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, fixture: true, service: 'thoughtscout-fixed-probe' }));
      return;
    }
    if (pathname !== '/mcp') { res.writeHead(404).end('Not Found'); return; }
    // Browser origins are unnecessary: ChatGPT accesses this server through its host proxy.
    if (req.headers.origin) { res.writeHead(403).end('Browser origin not allowed'); return; }
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      res.writeHead(405, { Allow: 'POST, GET, DELETE' }).end('Method Not Allowed'); return;
    }
    const server = createProbeMcpServer(options);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
    res.once('close', () => { void server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      // Never log request bodies, user notes, or SDK errors containing user input.
      if (!res.headersSent) res.writeHead(500).end('Internal server error');
      else res.end();
    }
  });
}
export async function startProbeServer({ port = 5195, ...options } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid probe port');
  const server = createProbeHttpServer(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startProbeServer({ port: Number(process.env.PORT ?? 5195) });
  console.log(`ThoughtScout fixed fixture probe: http://127.0.0.1:${server.address().port}/mcp`);
}
