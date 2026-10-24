import type { PrethinkTransport } from './prethink-transport';
import type { CueResponse, RequestBody, Round } from './prethink-types';

type RecordValue = Record<string, unknown>;
const businessErrors = {
  BUDGET_EXHAUSTED: '本次试验的模型调用预算已用尽或未启用。',
  INVALID_INPUT: '本次任务参数格式不正确或内容过长。',
  PARENT_UNAVAILABLE: '上轮任务记录不存在、已过期或不匹配，请保留内容后重新开始。',
  INVALID_SELECTION: '所选方向与上轮结果不匹配，请保留当前补充。',
  REQUEST_CONFLICT: '请求标识与已有任务冲突，当前内容已保留。',
  STALE_REQUEST: '请求已过期，未采用结果。',
  CAPACITY: '当前任务记录容量已满，请稍后再试。',
  BUSY: '当前请求较多，请稍后再试。',
  TIMEOUT: '生成超时，输入和联想已保留。',
  CANCELLED: '请求已取消或替换，当前内容已保留。',
  GENERATION_FAILED: '未能生成完整联想方向，输入和联想已保留。',
  CONFIGURATION: '服务配置不可用，当前内容已保留。',
  LEDGER_UNAVAILABLE: '预算记录不可用，已停止新的模型调用。',
} as const;
type BusinessCode = keyof typeof businessErrors;
type BridgeDiagnostic = {
  method: 'ui/initialize' | 'tools/call' | 'ui/update-model-context' | 'ui/message' | 'unknown';
  tool?: 'generate_prethink_cues' | 'cancel_prethink' | 'prepare_prethink_handoff';
  code?: number;
  businessCode?: BusinessCode;
  category: 'method_not_found' | 'tool_not_found' | 'invalid_params' | 'invalid_request' | 'internal_error' | 'unknown_error' | 'tool_execution_error';
};
type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void; diagnostic: BridgeDiagnostic };
type BridgeError = Error & { timedOut?: boolean; uncertain?: boolean; definiteRejection?: boolean; diagnostic?: BridgeDiagnostic };
type AcceptedState = { clientId: string; requestId: string; goal: string; variant: string; rounds: Round[] };
const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const bridgeError = (message: string, extra: Partial<BridgeError> = {}): BridgeError => Object.assign(new Error(message), extra);

// Only locally defined method/tool identifiers and integer codes are retained.
// Host error messages/data can contain user input, URLs or credentials.
function requestDiagnostic(method: string, params: RecordValue): BridgeDiagnostic {
  const safeMethod = method === 'ui/initialize' || method === 'tools/call' || method === 'ui/update-model-context' || method === 'ui/message' ? method : 'unknown';
  const tool = safeMethod === 'tools/call' && (params.name === 'generate_prethink_cues' || params.name === 'cancel_prethink' || params.name === 'prepare_prethink_handoff') ? params.name : undefined;
  return { method: safeMethod, ...(tool ? { tool } : {}), category: 'unknown_error' };
}

function responseError(diagnostic: BridgeDiagnostic, value: unknown, toolError = false): BridgeError {
  const code = !toolError && object(value) && Number.isSafeInteger(value.code) ? value.code as number : undefined;
  // Some hosts use -32602 for a missing tool. Match only the entire known
  // diagnostic shape; never retain or interpolate the host-supplied identifier.
  const missingTool = diagnostic.method === 'tools/call' && (code === -32601 || code === -32602)
    && object(value) && typeof value.message === 'string'
    && (/^Tool [A-Za-z0-9_-]+ not found$/i.test(value.message) || /^Unknown tool: [A-Za-z0-9_-]+$/i.test(value.message));
  const category: BridgeDiagnostic['category'] = toolError ? 'tool_execution_error'
    : missingTool ? 'tool_not_found' : code === -32601 ? 'method_not_found' : code === -32602 ? 'invalid_params'
      : code === -32600 || code === -32700 ? 'invalid_request' : code === -32603 ? 'internal_error' : 'unknown_error';
  let businessCode: BusinessCode | undefined;
  if (toolError && object(value) && Array.isArray(value.content)) {
    for (const item of value.content) {
      if (!object(item) || item.type !== 'text' || typeof item.text !== 'string' || item.text.length > 4096) continue;
      try {
        const parsed: unknown = JSON.parse(item.text);
        if (object(parsed) && Object.keys(parsed).every(key => key === 'code' || key === 'error')
          && typeof parsed.error === 'string' && typeof parsed.code === 'string'
          && Object.hasOwn(businessErrors, parsed.code)) {
          businessCode = parsed.code as BusinessCode;
          break;
        }
      } catch { /* Unknown or non-JSON content is never reflected. */ }
    }
  }
  const safe = { ...diagnostic, ...(code !== undefined ? { code } : {}), ...(businessCode ? { businessCode } : {}), category };
  const stage = diagnostic.tool === 'generate_prethink_cues' ? '生成联想'
    : diagnostic.tool === 'cancel_prethink' ? '取消生成'
      : diagnostic.tool === 'prepare_prethink_handoff' ? '整理交接'
        : diagnostic.method === 'ui/update-model-context' ? '更新交接上下文'
          : diagnostic.method === 'ui/message' ? '发送交接消息' : '初始化卡片连接';
  const classification = { method_not_found: '方法不支持', tool_not_found: '连接工具目录中找不到此工具，请刷新连接', invalid_params: '参数被拒绝', invalid_request: '协议请求被拒绝', internal_error: '内部错误', unknown_error: '原因未知', tool_execution_error: '工具执行失败' }[category];
  const definiteRejection = category === 'method_not_found' || category === 'tool_not_found' || category === 'invalid_params' || category === 'invalid_request';
  const detail = `${code !== undefined ? `错误码 ${code}；` : ''}${classification}`;
  const advice = code === -32601 ? '请刷新插件连接的工具目录后再试。' : '当前内容已保留。';
  return bridgeError(businessCode
    ? `${stage}：${businessErrors[businessCode]}（${businessCode}）`
    : `${stage}：${definiteRejection ? 'ChatGPT 未接受这次请求' : '这次请求未完成，执行状态尚未确认'}（${detail}）。${advice}`, { diagnostic: safe, definiteRejection });
}

/** Host-only transport. The component contains no provider key or external fetch. */
export function createMcpTransport(): PrethinkTransport {
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let origin = '*';
  let connected = false;
  let connection: Promise<void> | undefined;
  let capabilities: RecordValue = {};
  let initialGoalValue: string | undefined;
  let resolveInitial: ((goal: string) => void) | undefined;
  const initialGoalPromise = new Promise<string>((resolve) => { resolveInitial = resolve; });
  let lastHeight = 0;
  let lastClientId = '';
  let requestSerial = 0;
  let accepted: AcceptedState | null = null;
  let pendingAccepted: AcceptedState | null = null;

  function deltaFor(goal: string, rounds: Round[]) {
    const parent = accepted?.goal === goal ? accepted : null;
    const previous = parent?.rounds ?? [];
    if (rounds.length < previous.length || rounds.length > previous.length + 1
      || JSON.stringify(rounds.slice(0, previous.length)) !== JSON.stringify(previous)) {
      throw bridgeError('当前联想记录与连接状态不一致，请保留内容后重新开始。');
    }
    const draft = rounds[previous.length] ?? { selected: [], note: '' };
    return { parentRequestId: parent?.requestId ?? null, selected: draft.selected, note: draft.note };
  }

  function post(message: RecordValue) {
    window.parent.postMessage({ jsonrpc: '2.0', ...message }, origin);
  }

  function rpc(method: string, params: RecordValue, signal?: AbortSignal, timeoutMs = 12_000): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const abort = () => {
        pending.delete(id); cleanup(); reject(new DOMException('已取消', 'AbortError'));
      };
      const timer = window.setTimeout(() => {
        pending.delete(id); cleanup(); reject(bridgeError('ChatGPT 连接响应超时，请保留当前内容。', { timedOut: true }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, cleanup, diagnostic: requestDiagnostic(method, params) });
      signal?.addEventListener('abort', abort, { once: true });
      post({ id, method, params });
    });
  }

  function applyContext(value: unknown) {
    if (!object(value)) return;
    if (value.theme === 'light' || value.theme === 'dark') {
      document.documentElement.dataset.hostTheme = value.theme;
      document.documentElement.dataset.theme = value.theme;
      document.documentElement.style.colorScheme = value.theme;
    }
  }

  function acceptInitial(value: unknown) {
    if (initialGoalValue !== undefined || !object(value)) return;
    const data = value.structuredContent;
    if (object(data) && data.mode === 'start' && typeof data.goal === 'string') {
      initialGoalValue = data.goal.slice(0, 4000);
      resolveInitial?.(initialGoalValue);
      resolveInitial = undefined;
    }
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent || (origin !== '*' && event.origin !== origin)) return;
    const message: unknown = event.data;
    if (!object(message) || message.jsonrpc !== '2.0') return;
    if (typeof message.id === 'number' && !message.method && pending.has(message.id)) {
      const job = pending.get(message.id)!;
      pending.delete(message.id); job.cleanup();
      if (event.origin !== 'null') origin = event.origin;
      if (message.error) job.reject(responseError(job.diagnostic, message.error));
      else if (!('result' in message)) job.reject(bridgeError('ChatGPT 返回了无法识别的响应。'));
      else if (object(message.result) && message.result.isError) {
        job.reject(responseError(job.diagnostic, message.result, true));
      } else job.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') acceptInitial(message.params);
    else if (message.method === 'ui/notifications/host-context-changed') applyContext(message.params);
    else if (message.method === 'ping' && message.id !== undefined) post({ id: message.id, result: {} });
    else if (message.method === 'ui/resource-teardown' && message.id !== undefined) {
      connected = false; connection = undefined;
      for (const job of pending.values()) { job.cleanup(); job.reject(bridgeError('预思考视图已关闭。')); }
      pending.clear();
      post({ id: message.id, result: {} });
    }
  });

  function notifySize() {
    if (!connected) return;
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      post({ method: 'ui/notifications/size-changed', params: { height } });
    }
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(notifySize).observe(document.body);

  async function ready() {
    if (!connection) {
      connection = (async () => {
        if (window.parent === window) throw bridgeError('请从 ChatGPT 中打开预思考卡片。');
        const result = await rpc('ui/initialize', {
          appInfo: { name: 'ThoughtScout', version: '0.2.0' },
          appCapabilities: { availableDisplayModes: ['inline'] },
          protocolVersion: '2026-01-26',
        });
        if (!object(result) || result.protocolVersion !== '2026-01-26' || !object(result.hostCapabilities) || !result.hostCapabilities.serverTools) {
          throw bridgeError('当前 ChatGPT 未提供卡片调用能力，请更新客户端后重试。');
        }
        capabilities = result.hostCapabilities;
        applyContext(result.hostContext);
        connected = true;
        post({ method: 'ui/notifications/initialized', params: {} });
        notifySize();
      })().catch((error: unknown) => { connection = undefined; connected = false; throw error; });
    }
    await connection;
  }

  async function tool(name: string, args: RecordValue, signal?: AbortSignal, timeoutMs = 12_000): Promise<RecordValue> {
    await ready();
    const result = await rpc('tools/call', { name, arguments: args }, signal, timeoutMs);
    if (!object(result) || !object(result.structuredContent)) throw bridgeError('没有收到完整结果，输入和联想仍保留。');
    return result.structuredContent;
  }

  return {
    async health(signal) {
      await ready();
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      return { provider: 'deepseek', model: 'deepseek-flash', dataMode: 'no_live_sources' };
    },
    async initialGoal() {
      await ready();
      if (initialGoalValue !== undefined) return initialGoalValue;
      // Some hosts omit the start notification. Keep an editable empty input available.
      let timer = 0;
      try {
        return await Promise.race([initialGoalPromise, new Promise<string>((resolve) => { timer = window.setTimeout(() => resolve(''), 2000); })]);
      } finally { clearTimeout(timer); }
    },
    async request(body: RequestBody, signal) {
      if (body.mode !== 'cues') throw bridgeError('请使用“交给 ChatGPT 回答”继续。');
      const serial = ++requestSerial;
      pendingAccepted = null;
      lastClientId = body.clientId;
      if (!body.rounds.length || accepted?.clientId !== body.clientId || accepted?.goal !== body.goal || accepted?.variant !== body.variant) accepted = null;
      const delta = deltaFor(body.goal, body.rounds);
      // Only this click's selection/note crosses the tool boundary. The server
      // reconstructs task state from the last response this UI actually accepted.
      const data = await tool('generate_prethink_cues', {
        clientId: body.clientId, requestId: body.requestId, version: body.version,
        mode: body.mode, variant: body.variant, goal: body.goal, ...delta,
      }, signal, 45_000);
      if (signal.aborted || serial !== requestSerial) throw new DOMException('已取消', 'AbortError');
      if (data.requestId !== body.requestId || data.version !== body.version || data.mode !== 'cues' || !Array.isArray(data.options)) {
        throw bridgeError('返回内容与当前问题不匹配，未替换已有联想。');
      }
      pendingAccepted = { clientId: body.clientId, requestId: body.requestId, goal: body.goal, variant: body.variant,
        rounds: body.rounds.map((round) => ({ selected: round.selected.map((item) => ({ ...item })), note: round.note })) };
      return data as CueResponse;
    },
    acceptResult(requestId) {
      if (!pendingAccepted || pendingAccepted.requestId !== requestId) throw bridgeError('联想响应已过期，未替换当前记录。');
      accepted = pendingAccepted;
      pendingAccepted = null;
    },
    async cancel(body) {
      const { clientId, requestId, version } = body;
      await tool('cancel_prethink', { clientId, requestId, version });
    },
    async handoff(body, signal) {
      await ready();
      const messageCapability = capabilities.message;
      const contextCapability = capabilities.updateModelContext;
      if (!object(messageCapability) || !messageCapability.text || !object(contextCapability) || !contextCapability.text) {
        throw bridgeError('当前 ChatGPT 尚未提供文字交接能力，已保留你的联想记录。');
      }
      if (!lastClientId) throw bridgeError('尚未开始当前问题，请先输入问题。');
      const data = await tool('prepare_prethink_handoff', { clientId: lastClientId, goal: body.goal, ...deltaFor(body.goal, body.rounds) }, signal);
      if (typeof data.summary !== 'string' || data.goal !== body.goal || !Array.isArray(data.rounds)) {
        throw bridgeError('交接内容不完整，尚未发送。');
      }
      const context: RecordValue = { content: [{ type: 'text', text: data.summary }] };
      if (contextCapability.structuredContent) context.structuredContent = { goal: data.goal, rounds: data.rounds };
      await rpc('ui/update-model-context', context, signal);
      try {
        await rpc('ui/message', {
          role: 'user',
          content: [{ type: 'text', text: `请根据以下预思考记录回答我的原问题。结合已选方向和我自己的补充；已选方向只是值得考虑，不是已证实事实。\n${data.summary}` }],
        }, signal);
      } catch (error) {
        if (!(error instanceof Error && (error as BridgeError).definiteRejection)) {
          const diagnostic = error instanceof Error ? (error as BridgeError).diagnostic : undefined;
          throw bridgeError(`发送交接消息：发送结果尚未确认${diagnostic?.code !== undefined ? `（错误码 ${diagnostic.code}）` : ''}，请先查看 ChatGPT 正文，避免重复发送。`, { uncertain: true, ...(diagnostic ? { diagnostic } : {}) });
        }
        throw error;
      }
    },
  };
}
