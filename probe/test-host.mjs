// Local Playwright fixture only. Production MCP never imports or serves this host.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const port = Number(process.env.PROBE_TEST_PORT || 4387);
const host = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{display:block;width:100%;height:1600px;border:0}</style></head><body>
<script>
const goal = '挑选住宿，兼顾通勤与日常生活';
const scope = '接入演示 · 固定示例，不调用 DeepSeek';
const roots = [
  { id: 'commute', label: '通勤是否顺畅', hint: '看看时间、路线与备选方式' },
  { id: 'rest', label: '能否安心休息', hint: '看看噪声、光线与作息' },
  { id: 'daily', label: '日常生活便利', hint: '看看吃饭、办事与活动空间' },
  { id: 'cost', label: '费用与取舍', hint: '看看总费用、弹性与优先级' }
];
const children = {
  commute: ['commute-time', 'commute-route', 'commute-backup'],
  rest: ['rest-noise', 'rest-light', 'rest-routine'],
  daily: ['daily-food', 'daily-errands', 'daily-space'],
  cost: ['cost-total', 'cost-flexibility', 'cost-tradeoff']
};
const labels = {
  'commute-time': '通勤时长', 'commute-route': '路线可靠性', 'commute-backup': '备选交通',
  'rest-noise': '夜间噪声', 'rest-light': '室内光线', 'rest-routine': '作息匹配',
  'daily-food': '吃饭选择', 'daily-errands': '日常办事', 'daily-space': '活动空间',
  'cost-total': '总费用', 'cost-flexibility': '预算弹性', 'cost-tradeoff': '取舍优先级'
};
const query = new URLSearchParams(location.search);
window.probeHost = { messages: [], failure: query.get('failure'), notifications: [] };
function rootResult() {
  return { fixture: true, view: 'root', goal: query.has('escape') ? '<img src=x onerror="window.injected=true">' : goal, scope,
    options: query.has('escape') ? roots.map((o, i) => i === 0 ? {...o, label:'<script>alert(1)<' + '/script>', hint:'<img src=x onerror="window.injected=true">'} : o) : roots };
}
window.addEventListener('message', event => {
  const frame = document.querySelector('iframe');
  if (event.source !== frame.contentWindow) return;
  const m = event.data;
  window.probeHost.messages.push(m);
  const reply = result => frame.contentWindow.postMessage({ jsonrpc:'2.0', id:m.id, result }, location.origin);
  const reject = () => frame.contentWindow.postMessage({jsonrpc:'2.0', id:m.id, error:{code:-32000,message:'模拟宿主拒绝'}}, location.origin);
  if (m.method === 'ui/initialize') {
    const caps = {serverTools:{},message:{text:{}},updateModelContext:{text:{},structuredContent:{}}};
    if (window.probeHost.failure === 'image-only') { caps.message = {image:{}}; caps.updateModelContext = {image:{}}; }
    if (window.probeHost.failure === 'text-only') caps.updateModelContext = {text:{}};
    reply({protocolVersion:'2026-01-26',hostInfo:{name:'local-fake-host',version:'1'},hostCapabilities:caps,hostContext:{theme:'light'}});
  }
  else if (m.method === 'ui/notifications/initialized') {
    const result = {jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:rootResult()}};
    window.probeHost.notifications.push(result);
    if (window.probeHost.failure !== 'initial-delay') frame.contentWindow.postMessage(result, location.origin);
  } else if (m.method === 'tools/call') {
    const {name, arguments:args} = m.params;
    if (window.probeHost.failure === 'expand' && name === 'expand_prethink_probe') return reject();
    if (name === 'start_prethink_probe') {
      if (window.probeHost.failure === 'initial-delay') { window.probeHost.finishLoad = () => reply({structuredContent:rootResult()}); return; }
      reply({structuredContent:rootResult()});
    }
    else if (name === 'expand_prethink_probe') reply({structuredContent:{fixture:true,view:'expanded',focus:args.focus,goal,scope,options:children[args.focus].map(id => ({id,label:labels[id],hint:'待核实的考虑方向'}))}});
    else if (name === 'prepare_probe_handoff') {
      if (window.probeHost.failure === 'prepare') return reply({isError:true,content:[{type:'text',text:'模拟工具失败'}]});
      const selected = args.selected_ids.map(id => ({id,label:roots.find(o => o.id===id)?.label || labels[id]}));
      reply({structuredContent:{fixture:true,goal,selected,note:args.note,summary:'固定演示；待核实方向：'+selected.map(o=>o.label).join('、')+'；用户补充：'+args.note}});
    }
    else reject();
  } else if (m.method === 'ui/update-model-context') {
    if (window.probeHost.failure === 'context') return reject();
    if (window.probeHost.failure === 'context-result') return reply({isError:true});
    reply({});
  } else if (m.method === 'ui/message') {
    if (window.probeHost.failure === 'message-timeout') return;
    reply({});
  }
});
</script><iframe src="/widget.html" title="ThoughtScout local bridge simulation"></iframe></body></html>`;
createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/widget.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(new URL('./widget.html', import.meta.url), 'utf8'));
    } else if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(host); }
    else { res.writeHead(404); res.end('Not found'); }
  } catch { res.writeHead(500); res.end('Local fixture unavailable'); }
}).listen(port, '127.0.0.1', () => console.log('Local probe bridge fixture on 127.0.0.1:' + port));
