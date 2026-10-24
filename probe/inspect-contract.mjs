import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { startLiveServer } from './live-server.mjs';

export const INSPECTOR_VERSION = '2.12.0';
export const REQUIRED_URIS = ['ui://thoughtscout/prethinking-v1.html', 'ui://thoughtscout/probe.html'];
const START_TOOLS = ['start_prethinking', 'start_prethink_probe'];
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const baselinePath = fileURLToPath(new URL('./contracts/live-v1.json', import.meta.url));
const defaultBin = join(repoRoot, 'tools/inspector/node_modules/.bin/mcp-inspector');
class SafeGateError extends Error {}
function safeError(message) { return new SafeGateError(message); }
export function gateFailureMessage(error) { return error instanceof SafeGateError ? error.message : 'Inspector contract gate failed; inspect diagnostics locally.'; }
function check(value, message) { if (!value) throw safeError(message); }
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function contractSnapshot(tools, resources) {
  return canonical({ format: 1, tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)), resources: [...resources].sort((a, b) => a.uri.localeCompare(b.uri)) });
}
export function readBaseline() { return JSON.parse(readFileSync(baselinePath, 'utf8')); }
export function verifyInspectorBinary(binary) {
  let current;
  try { current = dirname(realpathSync(binary)); } catch { throw safeError('Inspector binary missing; install the isolated pinned Inspector 2.12.0 or set INSPECTOR_BIN.'); }
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8'));
      if (pkg.name === '@modelcontextprotocol/inspector') {
        check(pkg.version === INSPECTOR_VERSION, `Inspector must be pinned to ${INSPECTOR_VERSION}.`);
        return;
      }
    } catch (error) { if (error instanceof SafeGateError) throw error; }
    const parent = dirname(current);
    check(parent !== current, 'Cannot verify Inspector package version from binary path.'); current = parent;
  }
}
export function createInspectorRunner(binary = process.env.INSPECTOR_BIN || defaultBin) {
  verifyInspectorBinary(binary);
  return async ({ url, method, toolName, uri, appInfo = false, strict = false }) => {
    // The only tool invocations permitted by this gate are the two free openers.
    check(method !== 'tools/call' || START_TOOLS.includes(toolName), 'Gate refuses non-start tool calls.');
    const args = ['--cli', '--transport', 'http', '--server-url', url, '--protocol-era', 'legacy', '--connect-timeout', '15000', '--stored-auth-only', '--method', method, '--format', 'json'];
    if (toolName) args.push('--tool-name', toolName);
    if (method === 'tools/call' && !appInfo) args.push('--tool-args-json', '{}');
    if (uri) args.push('--uri', uri);
    if (appInfo) args.push('--app-info', '--advertise-apps');
    if (strict) args.push('--strict');
    const stage = method === 'resources/read' && REQUIRED_URIS.includes(uri) ? `${method} ${uri}` : method;
    return new Promise((resolveResult, reject) => {
      const stateDir = mkdtempSync(join(tmpdir(), 'thoughtscout-inspector-'));
      writeFileSync(join(stateDir, 'client.json'), '{}', { mode: 0o600 });
      const env = { ...process.env, MCP_AUTO_OPEN_ENABLED: 'false', MCP_STORAGE_DIR: join(stateDir, 'storage'), MCP_INSPECTOR_OAUTH_STATE_PATH: join(stateDir, 'oauth.json'), MCP_CLIENT_CONFIG_PATH: join(stateDir, 'client.json'), MCP_CATALOG_PATH: join(stateDir, 'catalog.json'), MCP_INSPECTOR_SECRET_STORE: 'memory', MCP_INSPECTOR_PERSIST_TOKENS: 'none', MCP_INSPECTOR_SECRET_FILE: join(stateDir, 'secrets.json'), MCP_INSPECTOR_LOG_DIR: join(stateDir, 'logs') };
      const child = spawn(binary, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', bytes = 0, finished = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(safeError(`Inspector ${stage} timed out.`)); }, 45_000);
      function finish(error, result) { if (finished) return; finished = true; clearTimeout(timer); rmSync(stateDir, { recursive: true, force: true }); if (error) reject(error); else resolveResult(result); }
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { child.kill('SIGKILL'); finish(safeError('Inspector output exceeded gate bound.')); }
        else stdout += chunk.toString('utf8');
      });
      // Never echo provider diagnostics, private endpoints, OAuth URLs, or tokens.
      child.stderr.resume();
      child.once('error', () => finish(safeError(`Inspector ${stage} could not launch.`)));
      child.once('close', code => {
        if (code !== 0) return finish(safeError(`Inspector ${stage} failed (exit ${code}).`));
        try { finish(null, JSON.parse(stdout)); } catch { finish(safeError(`Inspector ${stage} did not return a single JSON envelope.`)); }
      });
    });
  };
}
function unwrap(envelope, context) {
  check(envelope && typeof envelope === 'object' && !envelope.error && !envelope.resourceError, `${context}: Inspector reported an error.`);
  check(envelope.result && !envelope.result.isError && !envelope.result.error, `${context}: missing or failed result.`);
  return envelope.result;
}
export async function readHealth(url) {
  const response = await fetch(new URL('/', url), { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  check(response.ok, 'Health request failed.');
  const health = await response.json();
  check(health.ok === true && health.service === 'thoughtscout-live-prethinking' && Number.isInteger(health.budget?.used), 'Health contract mismatch.');
  return health;
}
export async function inspectContract({ url, runInspector, baseline = readBaseline(), healthReader = readHealth } = {}) {
  const target = new URL(url);
  check(!target.username && !target.password && !target.search && !target.hash && target.pathname === '/mcp', 'Use a credential-free /mcp URL.');
  check(target.protocol === 'https:' || (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)), 'HTTP targets must be loopback.');
  runInspector ??= createInspectorRunner();
  const invoke = request => runInspector({ url: target.href, ...request });
  const before = await healthReader(target.href);
  const initialized = unwrap(await invoke({ method: 'initialize' }), 'initialize');
  check(initialized.serverInfo?.name === 'thoughtscout-live-prethinking', 'Server identity mismatch.');
  const listed = await invoke({ method: 'tools/list', strict: true });
  check(!listed.schemaFindings?.some(finding => finding.severity === 'error'), 'Inspector schema portability error.');
  const tools = unwrap(listed, 'tools/list').tools;
  const resources = unwrap(await invoke({ method: 'resources/list' }), 'resources/list').resources;
  check(Array.isArray(tools) && Array.isArray(resources), 'Discovery result malformed.');
  for (const uri of REQUIRED_URIS) check(resources.some(resource => resource.uri === uri), `Required resource missing: ${uri}`);
  check(isDeepStrictEqual(contractSnapshot(tools, resources), canonical(baseline)), 'Reviewed contract snapshot changed; review schema/metadata compatibility and update baseline explicitly.');
  const contents = new Map();
  for (const resource of resources) {
    const result = unwrap(await invoke({ method: 'resources/read', uri: resource.uri }), REQUIRED_URIS.includes(resource.uri) ? `resources/read ${resource.uri}` : 'resources/read');
    check(Array.isArray(result.contents) && result.contents.length === 1, 'Resource must return one content item.');
    const content = result.contents[0];
    check(content.uri === resource.uri && content.mimeType === 'text/html;profile=mcp-app', 'Resource URI or MIME mismatch.');
    check(typeof content.text === 'string' && /<!doctype html>/i.test(content.text) && /<html[\s>]/i.test(content.text), 'Resource HTML missing.');
    check(isDeepStrictEqual(content._meta, resource._meta), 'Resource read/list metadata mismatch.');
    contents.set(resource.uri, content);
  }
  const [current, legacy] = REQUIRED_URIS.map(uri => contents.get(uri));
  check(isDeepStrictEqual({ ...current, uri: '' }, { ...legacy, uri: '' }), 'Legacy/current resources do not serve identical HTML and metadata.');
  for (const toolName of START_TOOLS) {
    const envelope = await invoke({ method: 'tools/call', toolName, appInfo: true });
    const app = envelope?.appInfo;
    check(app?.hasApp === true && !app.resourceError && !envelope.error && !envelope.resourceError, `${toolName}: missing App or resourceError.`);
    check(app.toolName === toolName && app.resourceUri === REQUIRED_URIS[0] && app.resourceMimeType === current.mimeType, `${toolName}: App URI or MIME mismatch.`);
    check(isDeepStrictEqual(canonical(app.csp), canonical(current._meta.ui.csp)), `${toolName}: App CSP mismatch.`);
    check(app.prefersBorder === current._meta.ui.prefersBorder, `${toolName}: App border metadata mismatch.`);
    const result = unwrap(await invoke({ method: 'tools/call', toolName }), toolName);
    check(isDeepStrictEqual(result.structuredContent, { mode: 'start', goal: '', provider: 'deepseek', model: 'deepseek-flash' }), `${toolName}: start response changed.`);
  }
  const after = await healthReader(target.href);
  check(after.budget.used === before.budget.used, 'Budget changed during free-only gate; concurrent traffic or a free-tool regression requires review.');
  return { ok: true, inspectorVersion: INSPECTOR_VERSION, tools: tools.length, resources: resources.length, freeStarts: START_TOOLS.length, budgetUsedBefore: before.budget.used, budgetUsedAfter: after.budget.used, widgetSha256: createHash('sha256').update(current.text).digest('hex') };
}

export async function main(args = process.argv.slice(2)) {
  check(args.length === 0 || (args.length === 2 && args[0] === '--url'), 'Usage: node probe/inspect-contract.mjs [--url https://host/mcp]');
  const runner = createInspectorRunner();
  let server;
  try {
    const url = args.length ? args[1] : await (async () => { server = await startLiveServer({ port: 0 }); return `http://127.0.0.1:${server.address().port}/mcp`; })();
    const report = await inspectContract({ url, runInspector: runner });
    process.stdout.write(JSON.stringify(report) + '\n');
  } finally { if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(gateFailureMessage(error) + ' Baseline is never auto-updated.\n'); process.exitCode = 1; });
}
