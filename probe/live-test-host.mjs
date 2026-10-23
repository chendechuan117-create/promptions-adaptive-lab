// Browser acceptance fixture ONLY: no model or production MCP server is called.
// The real, bundled resource is loaded inside a parent implementing the JSON-RPC host bridge.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.LIVE_PROBE_TEST_PORT || 4388);
function installFakeHost() {
  const params = new URLSearchParams(location.search);
  const startGoal = params.get('goal') || '';
  const state = window.liveHost = { messages: [], toolCalls: [], count: 0, pendingFirst: null, pendingContext: null, snapshots: {}, handoffs: [] };
  const frameWindow = () => document.querySelector('iframe').contentWindow;
  const send = message => frameWindow().postMessage({ jsonrpc: '2.0', ...message }, location.origin);
  function restoreRounds(args) {
    if ('rounds' in args) throw new Error('Prior-turn rounds must not be sent to an MCP tool');
    if (!Array.isArray(args.selected) || typeof args.note !== 'string' || typeof args.clientId !== 'string') throw new Error('Missing current-step delta');
    let rounds = [];
    if (args.parentRequestId !== null) {
      const parent = state.snapshots[args.parentRequestId];
      if (!parent || parent.clientId !== args.clientId || parent.goal !== args.goal) throw new Error('Invalid parent snapshot');
      rounds = structuredClone(parent.rounds);
    }
    if (args.selected.length || args.note.trim()) rounds.push({ selected: structuredClone(args.selected), note: args.note.trim() });
    return rounds;
  }
  function cueResult(args) {
    const rounds = restoreRounds(args);
    const cycling = args.goal.includes('自行车');
    const first = cycling ? ['制动安全', '路线难度', '工具准备', '同行安排'] : ['参与人群', '交换规则', '场地动线', '天气变化'];
    const later = cycling ? ['短程试骑', '突发状况', '返程检查', '体力分配'] : ['雨天备选', '搬运安排', '物品流转', '现场沟通'];
    const note = rounds.map(round => round.note).filter(Boolean).join('；');
    const labels = !rounds.length ? first : later.map(label => label + '·第' + (rounds.length + 1) + '轮');
    state.snapshots[args.requestId] = { clientId: args.clientId, goal: args.goal, rounds };
    return {
      requestId: args.requestId, version: args.version, mode: 'cues', variant: args.variant,
      scope: '本地模拟方向，仅验证桥接与交互，不代表模型质量。',
      options: labels.map((label, i) => ({ label, hint: params.has('long') ? 'unbroken_context_token_'.repeat(12) : note && i === 0 ? '带入当前补充：' + note : '从这个方向继续核实具体情境。' })),
      metrics: { elapsedMs: 3, fixture: true },
    };
  }
  state.releaseFirst = () => {
    if (!state.pendingFirst) throw new Error('No held generation');
    const { id, args } = state.pendingFirst; state.pendingFirst = null;
    send({ id, result: { structuredContent: cueResult(args) } });
  };
  state.releaseContext = () => {
    if (!state.pendingContext) throw new Error('No held context');
    const id = state.pendingContext; state.pendingContext = null; send({ id, result: {} });
  };
  window.addEventListener('message', event => {
    if (event.source !== frameWindow() || event.data?.jsonrpc !== '2.0') return;
    const message = event.data;
    state.messages.push(message);
    const reply = result => send({ id: message.id, result });
    const reject = text => send({ id: message.id, error: { code: -32000, message: text } });
    if (message.method === 'ui/initialize') reply({
      protocolVersion: '2026-01-26', hostInfo: { name: 'local-live-ui-fixture', version: '1.0.0' },
      hostCapabilities: { serverTools: {}, message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} } },
      hostContext: { theme: 'light', platform: params.has('mobile') ? 'mobile' : 'web' },
    });
    else if (message.method === 'ui/notifications/initialized') send({ method: 'ui/notifications/tool-result', params: { structuredContent: { mode: 'start', goal: startGoal, provider: 'deepseek', model: 'deepseek-flash' } } });
    else if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      state.toolCalls.push({ name, args });
      if (name === 'generate_prethink_cues') {
        try { restoreRounds(args); } catch (error) { reject(error.message); return; }
        const count = ++state.count;
        if (count === 1 && params.has('holdFirst')) { state.pendingFirst = { id: message.id, args }; return; }
        const result = cueResult(args);
        // Identity is valid but a child option violates the UI shape contract.
        if (count === 2 && params.has('malformedChild')) result.options = [{ label: 42, hint: 'Invalid fixture option' }];
        reply({ structuredContent: result });
      } else if (name === 'cancel_prethink') reply({ structuredContent: { ok: true, cancelled: true } });
      else if (name === 'prepare_prethink_handoff') {
        let rounds;
        try { rounds = restoreRounds(args); } catch (error) { reject(error.message); return; }
        const handoff = {
          goal: args.goal, rounds,
          summary: '原问题：' + args.goal + '\n待核实的考虑方向：' + rounds.map(round => round.selected.map(option => option.label).join('、') + '；补充：' + round.note).join('\n'),
        };
        state.handoffs.push(handoff);
        reply({ structuredContent: handoff });
      }
      else reject('Unexpected fixture tool: ' + name);
    } else if (message.method === 'ui/update-model-context') {
      if (params.has('contextFail')) reject('模拟上下文更新失败');
      else if (params.has('holdContext')) state.pendingContext = message.id;
      else reply({});
    } else if (message.method === 'ui/message') {
      if (params.has('messageTeardown')) send({ id: 'fixture-teardown', method: 'ui/resource-teardown', params: {} });
      else if (params.has('messageMalformed')) send({ id: message.id });
      else if (!params.has('messageTimeout')) reply({});
    }
  });
}
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{display:block;width:100%;height:1800px;border:0}</style></head><body><script>(${installFakeHost.toString()})()</script><iframe src="/widget.html" title="Live prethinking local bridge simulation"></iframe></body></html>`;
createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fixture); }
    else if (path === '/widget.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(new URL('../dist-prethink-widget/widget.html', import.meta.url), 'utf8'));
    } else { res.writeHead(404); res.end('No fixture route'); }
  } catch { res.writeHead(500); res.end('Build dist-prethink-widget/widget.html before running browser tests.'); }
}).listen(port, '127.0.0.1', () => console.log('Local live bridge fixture on 127.0.0.1:' + port));
