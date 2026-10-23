import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startProbeServer, RESOURCE_URI, MAX_BODY_BYTES } from '../server.mjs';
import { OPTION_IDS, GOAL } from '../data.mjs';

async function fixture(t) {
  const server = await startProbeServer({ port: 0 });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: 'probe-integration-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(url);
  t.after(async () => { await client.close(); server.closeAllConnections(); server.close(); await once(server, 'close'); });
  await client.connect(transport);
  return { server, client, transport, url };
}

test('real MCP initialize, discovery, UI resource, deterministic expansion and handoff', async (t) => {
  const { server, client, transport, url } = await fixture(t);
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal(transport.sessionId, undefined);
  assert.ok(client.getServerCapabilities().tools);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['start_prethink_probe', 'expand_prethink_probe', 'prepare_probe_handoff']);
  for (const tool of tools) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool._meta.securitySchemes, [{ type: 'noauth' }]);
    assert.ok(tool.outputSchema);
  }
  assert.equal(tools[0]._meta.ui.resourceUri, RESOURCE_URI);
  assert.equal(tools[1]._meta.ui.resourceUri, undefined);
  assert.equal(tools[2]._meta.ui.resourceUri, undefined);
  const { resources } = await client.listResources();
  assert.equal(resources[0].uri, RESOURCE_URI);
  assert.equal(resources[0].mimeType, 'text/html;profile=mcp-app');
  const resource = (await client.readResource({ uri: RESOURCE_URI })).contents[0];
  assert.match(resource.text, /<!doctype html>/i);
  assert.deepEqual(resource._meta.ui.csp.connectDomains, []);
  assert.deepEqual(resource._meta.ui.csp.resourceDomains, []);
  const root = (await client.callTool({ name: 'start_prethink_probe', arguments: {} })).structuredContent;
  assert.equal(root.fixture, true);
  assert.equal(root.view, 'root');
  assert.equal(root.goal, GOAL);
  assert.deepEqual(root.options.map(({ id }) => id), ['commute', 'rest', 'daily', 'cost']);
  const discovered = root.options.map(({ id }) => id);
  for (const focus of discovered.slice()) {
    const args = { name: 'expand_prethink_probe', arguments: { focus } };
    const expanded = (await client.callTool(args)).structuredContent;
    assert.deepEqual(expanded, (await client.callTool(args)).structuredContent);
    assert.equal(expanded.view, 'expanded');
    assert.equal(expanded.focus, focus);
    assert.equal(expanded.options.length, 3);
    discovered.push(...expanded.options.map(({ id }) => id));
  }
  assert.deepEqual(discovered, OPTION_IDS);
  const handoff = (await client.callTool({ name: 'prepare_probe_handoff', arguments: { selected_ids: ['commute', 'rest-noise', 'commute'], note: '<script>user note</script>' } })).structuredContent;
  assert.deepEqual(handoff.selected.map(({ id }) => id), ['commute', 'rest-noise']);
  assert.equal(handoff.note, '<script>user note</script>');
  assert.match(handoff.summary, /可考虑方向：通勤/);
  assert.match(handoff.summary, /用户提供的备注/);
  assert.match(handoff.summary, /未经核实/);
  assert.match(handoff.summary, /请根据当前信息回答原问题/);
  const empty = (await client.callTool({ name: 'prepare_probe_handoff', arguments: { selected_ids: [] } })).structuredContent;
  assert.equal(empty.note, '');
  assert.deepEqual(empty.selected, []);
  const independent = new Client({ name: 'independent-client', version: '0.1.0' });
  try {
    await independent.connect(new StreamableHTTPClientTransport(url));
    assert.deepEqual((await independent.callTool({ name: 'start_prethink_probe', arguments: {} })).structuredContent, root);
    assert.deepEqual((await independent.callTool({ name: 'prepare_probe_handoff', arguments: { selected_ids: [] } })).structuredContent, empty);
  } finally { await independent.close(); }
});

test('rejects invalid and excessive inputs via MCP', async (t) => {
  const { client } = await fixture(t);
  const invalid = [
    ['start_prethink_probe', { extra: 'reject' }],
    ['expand_prethink_probe', {}],
    ['expand_prethink_probe', { focus: 'unknown' }],
    ['expand_prethink_probe', { focus: 'commute', extra: true }],
    ['prepare_probe_handoff', { selected_ids: ['unknown'] }],
    ['prepare_probe_handoff', { selected_ids: Array(13).fill('commute') }],
    ['prepare_probe_handoff', { selected_ids: [], note: 'a'.repeat(401) }],
    ['prepare_probe_handoff', { selected_ids: [], note: 12 }],
    ['prepare_probe_handoff', { selected_ids: [] , extra: true }],
  ];
  for (const [name, args] of invalid) {
    try {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} accepted invalid input`);
      assert.equal(result.structuredContent, undefined);
    } catch (error) { assert.match(error.message, /validation|invalid|unrecognized|argument/i); }
  }
  const boundary = await client.callTool({ name: 'prepare_probe_handoff', arguments: { selected_ids: OPTION_IDS.slice(0, 12), note: 'a'.repeat(400) } });
  assert.equal(boundary.isError, undefined);
  assert.equal(boundary.structuredContent.selected.length, 12);
});

test('HTTP health, body bounds, malformed JSON, routing and browser-origin rejection', async (t) => {
  const { url } = await fixture(t);
  const health = await fetch(new URL('/', url));
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal((await health.json()).fixture, true);
  assert.equal((await fetch(new URL('/missing', url))).status, 404);
  assert.equal((await fetch(url, { method: 'PUT' })).status, 405);
  assert.equal((await fetch(url, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const huge = await fetch(url, { method: 'POST', headers, body: 'x'.repeat(MAX_BODY_BYTES + 1) });
  assert.equal(huge.status, 413);
  const chunked = await fetch(url, { method: 'POST', headers, duplex: 'half', body: (async function* () { yield 'x'.repeat(MAX_BODY_BYTES); yield 'x'; })() });
  assert.equal(chunked.status, 413);
  const malformed = await fetch(url, { method: 'POST', headers, body: '{broken' });
  assert.equal(malformed.status, 400);
});
