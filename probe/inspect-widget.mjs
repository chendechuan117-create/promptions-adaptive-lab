#!/usr/bin/env node
// Independent, zero-model-cost browser smoke against the pinned official host.
// Prerequisites: build:widget, probe dependencies, Inspector, Playwright Chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createLiveRuntime } from './live-runtime.mjs';
import { startLiveServer } from './live-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const expectedVersion = '2.12.0';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node probe/inspect-widget.mjs [--artifacts DIR]\nINSPECTOR_BIN overrides tools/inspector/node_modules/.bin/mcp-inspector. No model is called.');
  process.exit(0);
}
const validArgs = args.length === 0 || (args.length === 2 && args[0] === '--artifacts' && args[1]);
const artifactDir = validArgs && args.length ? resolve(args[1]) : null;
const token = randomBytes(24).toString('hex');
const abort = new AbortController();
const report = {
  passed: false, inspectorVersion: expectedVersion, modelCalls: 0,
  generationAttempts: 0, blockedGenerationRequests: 0, freeToolAttempts: 0,
  evidenceBoundary: 'Local official Inspector host: rendering and free app-only tool routing; not ChatGPT authorization or mobile acceptance.',
  consoleErrors: [], consoleWarnings: [], pageErrors: [], cspViolations: [], failedRequests: [], httpErrors: [],
};
let temp, inspector, inspectorExit, inspectorFailure, browser, page, live, runtime;
let inspectorLog = '', observing = true;
const reservations = [];

function redact(value) {
  return String(value).replaceAll(token, '[REDACTED]')
    .replace(/([?&](?:autoConnect|autoOpen|MCP_INSPECTOR_API_TOKEN)=)[^&#\s"']+/gi, '$1[REDACTED]')
    .replace(/\u001b\[[0-9;]*m/g, '');
}
function safeUrl(value) {
  try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href; }
  catch { return redact(value); }
}
function killInspector(signal) {
  if (!inspector?.pid) return;
  try {
    if (process.platform === 'win32') inspector.kill(signal);
    else process.kill(-inspector.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function stop(reason) {
  abort.abort(new Error(reason));
  killInspector('SIGTERM');
  void browser?.close().catch(() => {});
}
const onInterrupt = () => stop('Interrupted');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);
const deadline = setTimeout(() => stop('Inspector smoke exceeded 90 seconds'), 90_000);
deadline.unref();

async function freePort() {
  const server = createServer();
  reservations.push(server);
  await new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePort);
  });
  return server.address().port;
}
async function releasePorts() {
  await Promise.all(reservations.splice(0).map(server => new Promise((done) => server.close(done))));
}
async function inspectorPackageVersion(binary) {
  let directory = dirname(await realpath(binary));
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (pkg.name === '@modelcontextprotocol/inspector') return pkg.version;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('INSPECTOR_BIN must point to the installed official Inspector executable');
    directory = parent;
  }
}
async function waitUntil(check, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  do {
    abort.signal.throwIfAborted();
    if (inspectorFailure) throw inspectorFailure;
    const result = await check();
    if (result) return result;
    await delay(100, undefined, { signal: abort.signal });
  } while (Date.now() < until);
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  assert.ok(validArgs, 'Usage: node probe/inspect-widget.mjs [--artifacts DIR]');
  const binary = resolve(process.env.INSPECTOR_BIN || join(root, 'tools/inspector/node_modules/.bin/mcp-inspector'));
  assert.equal(await inspectorPackageVersion(binary), expectedVersion, `This smoke pins official Inspector ${expectedVersion}`);
  const widgetHtml = await readFile(join(root, 'dist-prethink-widget/widget.html'), 'utf8');
  report.widgetSha256 = createHash('sha256').update(widgetHtml).digest('hex');
  temp = await mkdtemp(join(tmpdir(), 'thoughtscout-inspector-'));
  const storage = join(temp, 'storage');
  await mkdir(storage, { mode: 0o700 });
  runtime = createLiveRuntime({ maxCalls: 0, ledgerPath: join(temp, 'budget.json') });
  const run = runtime.run;
  runtime.run = (...input) => { report.generationAttempts++; return run(...input); };
  const prepareHandoff = runtime.prepareHandoff;
  runtime.prepareHandoff = (...input) => { report.freeToolAttempts++; return prepareHandoff(...input); };
  live = await startLiveServer({ port: 0, runtime, widgetHtml });
  const liveOrigin = `http://127.0.0.1:${live.address().port}`;
  const budget = async () => {
    const response = await fetch(liveOrigin, { signal: AbortSignal.timeout(3000) });
    assert.ok(response.ok, 'Temporary live service health failed');
    return (await response.json()).budget;
  };
  report.budgetBefore = await budget();
  assert.deepEqual(report.budgetBefore, { used: 0, maxCalls: 0, inFlight: 0 });
  const uiPort = await freePort(), sandboxPort = await freePort();
  const inspectorOrigin = `http://127.0.0.1:${uiPort}`;
  // Do not inherit provider credentials, proxy settings, public addresses or
  // authentication overrides. Inspector state never touches the user's catalog.
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'SystemRoot']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, {
    HOST: '127.0.0.1', CLIENT_PORT: String(uiPort), MCP_SANDBOX_PORT: String(sandboxPort), MCP_APP_ORIGIN_PORT: '0',
    MCP_AUTO_OPEN_ENABLED: 'false', MCP_INSPECTOR_API_TOKEN: token, MCP_INSPECTOR_SECRET_STORE: 'memory',
    MCP_STORAGE_DIR: storage, MCP_CATALOG_PATH: join(storage, 'catalog.json'),
    MCP_CLIENT_CONFIG_PATH: join(storage, 'client.json'), MCP_INSPECTOR_OAUTH_STATE_PATH: join(storage, 'oauth.json'),
    MCP_INSPECTOR_LOG_DIR: join(storage, 'logs'), NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
  });
  await releasePorts();
  inspector = spawn(binary, ['--web'], { cwd: temp, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  inspectorExit = new Promise((done) => {
    inspector.once('error', error => { inspectorFailure = error; done(); });
    inspector.once('exit', (code, signal) => { inspectorFailure = new Error(`Inspector exited (${signal || code})`); done(); });
  });
  for (const stream of [inspector.stdout, inspector.stderr]) stream.on('data', chunk => { inspectorLog = (inspectorLog + chunk).slice(-16_000); });
  await waitUntil(async () => {
    try { return (await fetch(`${inspectorOrigin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, 25_000, 'Inspector web startup');
  const configResponse = await fetch(`${inspectorOrigin}/api/config`, {
    headers: { 'x-mcp-remote-auth': `Bearer ${token}` }, signal: AbortSignal.timeout(3000),
  });
  assert.ok(configResponse.ok, 'Inspector configuration request failed');
  const config = await configResponse.json();
  assert.equal(new URL(config.sandboxUrl).origin, `http://127.0.0.1:${sandboxPort}`, 'Inspector sandbox did not bind the reserved independent port');

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  page.on('console', message => {
    if (!observing) return;
    const entry = redact(message.text()).slice(0, 1000);
    if (message.type() === 'error') report.consoleErrors.push(entry);
    if (message.type() === 'warning') report.consoleWarnings.push(entry);
  });
  page.on('pageerror', error => { if (observing) report.pageErrors.push(redact(error.message).slice(0, 1000)); });
  page.on('requestfailed', request => { if (observing) report.failedRequests.push({ url: safeUrl(request.url()), error: redact(request.failure()?.errorText) }); });
  page.on('response', response => { if (observing && response.status() >= 400) report.httpErrors.push({ status: response.status(), url: safeUrl(response.url()) }); });
  await page.exposeFunction('__inspectCspViolation', entry => { if (observing) report.cspViolations.push(entry); });
  await page.addInitScript(() => {
    addEventListener('securitypolicyviolation', event => {
      void window.__inspectCspViolation({ directive: event.effectiveDirective, disposition: event.disposition });
    });
  });
  await page.route('**/*', async route => {
    if ((route.request().postData() || '').includes('generate_prethink_cues')) {
      report.blockedGenerationRequests++;
      await route.abort();
    } else await route.continue();
  });
  const url = new URL(inspectorOrigin);
  for (const [key, value] of Object.entries({
    serverUrl: `${liveOrigin}/mcp`, transport: 'http', autoConnect: token,
    openApp: 'start_prethinking', appArgs: Buffer.from('{"goal":""}').toString('base64url'), autoOpen: token,
  })) url.searchParams.set(key, value);
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.locator('[data-testid="connection-status"][data-status="connected"]').waitFor({ timeout: 20_000 });
  await page.locator('[data-testid="apps-form"][data-app-status="ready"]').waitFor({ timeout: 20_000 });
  const widget = await waitUntil(async () => {
    for (const frame of page.frames()) if (frame !== page.mainFrame() && await frame.locator('#goal-input').count()) return frame;
  }, 5000, 'rendered widget goal input');
  const goal = widget.getByLabel('你的问题', { exact: true });
  const generate = widget.getByRole('button', { name: '生成联想线索', exact: true });
  await goal.waitFor({ state: 'visible', timeout: 5000 });
  await generate.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await goal.inputValue(), '', 'Initial goal must stay empty');
  assert.ok(await goal.isEnabled(), 'Goal input must be usable');
  assert.ok(await generate.isDisabled(), 'Empty goal must disable paid generation');
  report.ready = true;
  report.generateDisabled = true;
  report.frames = page.frames().map(frame => safeUrl(frame.url()));
  // Exercise app-only routing through the actual widget -> sandbox -> official
  // host bridge. This sends no ui/message and never invokes a model generator.
  const freeGoal = '组织一次公开读书交流活动';
  const freeNote = '仅用于官方宿主免费工具通路检查';
  const handoff = await widget.evaluate(({ goal, note }) => new Promise((resolveReply, rejectReply) => {
    const id = `inspector-free-handoff-${crypto.randomUUID()}`;
    const cleanup = () => { clearTimeout(timer); removeEventListener('message', receive); };
    const receive = event => {
      if (event.source !== window.parent || event.data?.jsonrpc !== '2.0' || event.data.id !== id || event.data.method) return;
      cleanup();
      if (event.data.error || event.data.result?.isError || !event.data.result) rejectReply(new Error('Official host rejected the free app-only tool call'));
      else resolveReply(event.data.result.structuredContent);
    };
    const timer = setTimeout(() => { cleanup(); rejectReply(new Error('Official host free app-only tool call timed out')); }, 12_000);
    addEventListener('message', receive);
    window.parent.postMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'prepare_prethink_handoff', arguments: { clientId: crypto.randomUUID(), goal, parentRequestId: null, selected: [], note },
    } }, '*');
  }), { goal: freeGoal, note: freeNote });
  assert.equal(handoff?.goal, freeGoal, 'App-only handoff lost the test goal');
  assert.deepEqual(handoff?.rounds, [{ selected: [], note: freeNote }], 'App-only handoff lost the current draft note');
  assert.ok(typeof handoff?.summary === 'string' && handoff.summary.includes(freeGoal) && handoff.summary.includes(freeNote) && handoff.summary.includes('不是事实'), 'App-only handoff summary contract mismatch');
  assert.equal(report.freeToolAttempts, 1, 'Free app-only request did not reach the actual temporary MCP service exactly once');
  report.freeAppOnlyTool = { name: 'prepare_prethink_handoff', passed: true, rounds: handoff.rounds.length };
  // Allow the next paint before recording the actual rendered widget.
  await widget.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  report.budgetAfter = await budget();
  assert.deepEqual(report.budgetAfter, report.budgetBefore, 'Model budget changed');
  assert.equal(report.generationAttempts + report.blockedGenerationRequests, 0, 'Opening an empty goal attempted model generation');
  for (const key of ['consoleErrors', 'pageErrors', 'cspViolations', 'failedRequests', 'httpErrors']) assert.equal(report[key].length, 0, `Browser reported ${key}`);
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    await page.getByTestId('apps-form').screenshot({ path: join(artifactDir, 'inspector-widget.png') });
  }
  abort.signal.throwIfAborted();
  report.passed = true;
} catch (error) {
  report.error = redact(error.message);
  if (page && !page.isClosed()) {
    report.hostState = await page.locator('[data-testid="apps-form"]').evaluate(element => ({ status: element.dataset.appStatus, error: element.dataset.appError })).catch(() => null);
    report.connectionState = await page.locator('[data-testid="connection-status"]').evaluate(element => ({ status: element.dataset.status, error: element.dataset.errorMessage, deepLink: element.dataset.deeplink })).catch(() => null);
  }
} finally {
  observing = false;
  clearTimeout(deadline);
  report.budgetAfter ??= runtime?.stats();
  const cleanupErrors = [];
  const clean = async action => { try { await action(); } catch (error) { cleanupErrors.push(redact(error.message)); } };
  await clean(() => browser?.close());
  await clean(async () => {
    killInspector('SIGTERM');
    if (inspectorExit) {
      await Promise.race([inspectorExit, delay(2000)]);
      killInspector('SIGKILL');
      await inspectorExit;
    }
  });
  await clean(async () => {
    if (live) {
      live.closeAllConnections();
      await new Promise((done, reject) => live.close(error => error ? reject(error) : done()));
    }
    runtime?.close();
  });
  await clean(releasePorts);
  await clean(() => temp && rm(temp, { recursive: true, force: true }));
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onInterrupt);
  if (cleanupErrors.length) { report.passed = false; report.cleanupErrors = cleanupErrors; }
  if (!report.passed) report.inspectorLog = redact(inspectorLog).slice(-8000);
  if (artifactDir) {
    try {
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      await writeFile(join(artifactDir, 'inspector-report.json'), redact(JSON.stringify(report, null, 2)) + '\n', { mode: 0o600 });
    } catch (error) { report.passed = false; report.error = `Artifact write failed: ${redact(error.message)}`; }
  }
  console.log(JSON.stringify({
    passed: report.passed, inspectorVersion: report.inspectorVersion, ready: report.ready ?? false,
    modelCalls: report.modelCalls, generationAttempts: report.generationAttempts, blockedGenerationRequests: report.blockedGenerationRequests,
    freeToolAttempts: report.freeToolAttempts, freeAppOnlyTool: report.freeAppOnlyTool, evidenceBoundary: report.evidenceBoundary,
    budgetBefore: report.budgetBefore, budgetAfter: report.budgetAfter,
    ...(report.error ? { error: report.error } : {}), ...(cleanupErrors.length ? { cleanupErrors } : {}),
  }));
  process.exitCode = report.passed ? 0 : 1;
}
