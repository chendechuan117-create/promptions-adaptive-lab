import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectContract, readBaseline, REQUIRED_URIS, gateFailureMessage } from '../inspect-contract.mjs';

const baseline = readBaseline();
function simulatedInspector(mutate = () => {}) {
  const calls = [];
  const runInspector = async request => {
    calls.push(request);
    let envelope;
    if (request.method === 'initialize') envelope = { result: { serverInfo: { name: 'thoughtscout-live-prethinking' } } };
    else if (request.method === 'tools/list') envelope = { result: { tools: baseline.tools } };
    else if (request.method === 'resources/list') envelope = { result: { resources: baseline.resources } };
    else if (request.method === 'resources/read') envelope = { result: { contents: [{ uri: request.uri, mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><html><body>current bundle</body></html>', _meta: baseline.resources.find(resource => resource.uri === request.uri)._meta }] } };
    else if (request.method === 'tools/call' && request.appInfo) envelope = { appInfo: { hasApp: true, toolName: request.toolName, resourceUri: REQUIRED_URIS[0], resourceMimeType: 'text/html;profile=mcp-app', ...baseline.resources[0]._meta.ui } };
    else if (request.method === 'tools/call') envelope = { result: { structuredContent: { mode: 'start', goal: '', provider: 'deepseek', model: 'deepseek-flash' } } };
    else assert.fail('Unexpected method');
    envelope = structuredClone(envelope);
    mutate(request, envelope);
    return envelope;
  };
  return { calls, runInspector };
}
const healthReader = async () => ({ ok: true, service: 'thoughtscout-live-prethinking', budget: { used: 0, maxCalls: 0, inFlight: 0 } });
function run(simulation, overrides = {}) { return inspectContract({ url: 'http://127.0.0.1:12345/mcp', baseline, healthReader, runInspector: simulation.runInspector, ...overrides }); }

test('reviewed contract passes free-only flow and checks every resource and both App openers', async () => {
  const simulation = simulatedInspector();
  const report = await run(simulation);
  assert.equal(report.ok, true);
  assert.equal(report.tools, 5);
  assert.equal(report.resources, 2);
  assert.equal(report.inspectorVersion, '2.12.0');
  assert.equal(report.budgetUsedBefore, report.budgetUsedAfter);
  assert.deepEqual(simulation.calls.filter(call => call.method === 'resources/read').map(call => call.uri).sort(), [...REQUIRED_URIS].sort());
  const invoked = simulation.calls.filter(call => call.method === 'tools/call' && !call.appInfo).map(call => call.toolName);
  assert.deepEqual(invoked, ['start_prethinking', 'start_prethink_probe']);
  assert.ok(simulation.calls.filter(call => call.appInfo).length === 2);
});
test('missing legacy resource fails before any tool call', async () => {
  const simulation = simulatedInspector((request, envelope) => { if (request.method === 'resources/list') envelope.result.resources = envelope.result.resources.filter(resource => resource.uri !== 'ui://thoughtscout/probe.html'); });
  await assert.rejects(run(simulation), /Required resource missing/);
  assert.ok(!simulation.calls.some(call => call.method === 'tools/call'));
});
test('schema tightening differs from reviewed snapshot and cannot silently pass', async () => {
  const simulation = simulatedInspector((request, envelope) => {
    if (request.method === 'tools/list') envelope.result.tools.find(tool => tool.name === 'start_prethinking').inputSchema.required = ['goal'];
  });
  await assert.rejects(run(simulation), /Reviewed contract snapshot changed/);
});
test('App resourceError is a failure even with hasApp true and an Inspector exit-zero-shaped envelope', async () => {
  const simulation = simulatedInspector((request, envelope) => { if (request.appInfo) envelope.appInfo.resourceError = 'Resource not found'; });
  await assert.rejects(run(simulation), /resourceError/);
  assert.ok(!simulation.calls.some(call => call.method === 'tools/call' && !call.appInfo));
});
test('HTTP-success-shaped Inspector envelope carrying resource RPC error is rejected', async () => {
  const simulation = simulatedInspector((request, envelope) => { if (request.method === 'resources/read') { delete envelope.result; envelope.error = { code: -32602, message: 'Resource not found' }; } });
  await assert.rejects(run(simulation), /Inspector reported an error/);
});
test('legacy alias serving different HTML fails before calling openers', async () => {
  const simulation = simulatedInspector((request, envelope) => { if (request.method === 'resources/read' && request.uri === 'ui://thoughtscout/probe.html') envelope.result.contents[0].text += '<!-- stale -->'; });
  await assert.rejects(run(simulation), /identical HTML/);
});
test('changed free-start response and concurrent budget consumption fail the gate', async () => {
  const simulation = simulatedInspector((request, envelope) => { if (request.method === 'tools/call' && !request.appInfo) envelope.result.structuredContent.mode = 'root'; });
  await assert.rejects(run(simulation), /start response changed/);
  let reads = 0;
  await assert.rejects(run(simulatedInspector(), { healthReader: async () => ({ budget: { used: reads++ } }) }), /Budget changed/);
});

test('CLI diagnostic formatter prints controlled gate failures and redacts unknown exception text', async () => {
  const simulation = simulatedInspector((request, envelope) => { if (request.method === 'resources/read') { delete envelope.result; envelope.error = { code: -32602, message: 'untrusted private body and token' }; } });
  try { await run(simulation); assert.fail('must reject'); }
  catch (error) { const message = gateFailureMessage(error); assert.match(message, /resources\/read ui:\/\/thoughtscout\//); assert.doesNotMatch(message, /private body|token/); }
  assert.equal(gateFailureMessage(new Error('https://private.invalid/?token=secret provider body')), 'Inspector contract gate failed; inspect diagnostics locally.');
});
