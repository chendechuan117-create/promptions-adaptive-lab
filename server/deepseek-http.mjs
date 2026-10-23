// This module returns final answer JSON only. Reasoning text is consumed in
// bounded stream buffers and is never returned, logged, or written to disk.
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_CHARS = 256 * 1024;
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_REASONING_CHARS = 128 * 1024;

function problem(code, message) {
  return Object.assign(new Error(message), { code, deepseekTransport: true });
}

function endpointFor(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw problem('INVALID_ENDPOINT', 'DeepSeek 服务地址无效。'); }
  const official = url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && !url.port;
  const testLocal = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!official && !testLocal) || url.username || url.password || url.search || url.hash || !['/', '/responses'].includes(url.pathname)) {
    throw problem('INVALID_ENDPOINT', 'DeepSeek 仅允许官方 HTTPS 地址或明确指定的本机测试服务。');
  }
  return new URL('/responses', url);
}

// Provider errors and arbitrary response fields may contain sensitive content;
// retain only documented numeric usage fields and short identifier strings.
function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const result = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) result[key] = usage[key];
  }
  for (const [key, fields] of [['input_tokens_details', ['cached_tokens']], ['output_tokens_details', ['reasoning_tokens']]]) {
    const details = {};
    for (const field of fields) {
      const value = usage[key]?.[field];
      if (Number.isSafeInteger(value) && value >= 0) details[field] = value;
    }
    if (Object.keys(details).length) result[key] = details;
  }
  return result;
}

function safeIdentifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(value) ? value : null;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(problem('ABORTED', '请求已终止。'));
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export async function requestStructured({
  prompt, schema, signal, timeoutMs = 20000, model = 'deepseek-flash',
  reasoning = 'low', maxOutputTokens = 3000,
  apiKey = process.env.DEEPSEEK_API_KEY, fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.deepseek.com',
} = {}) {
  const endpoint = endpointFor(baseUrl);
  if (typeof prompt !== 'string' || !prompt.trim() || !schema || typeof schema !== 'object' || Array.isArray(schema)
    || !safeIdentifier(model) || !['none', 'low', 'medium', 'high'].includes(reasoning)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000
    || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768
    || typeof fetchImpl !== 'function') {
    throw problem('INVALID_REQUEST', 'DeepSeek 请求参数无效。');
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw problem('MISSING_API_KEY', '尚未配置 DeepSeek API 密钥。');
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const controller = new AbortController();
  let abortKind, reader;
  const abort = kind => { if (!controller.signal.aborted) { abortKind = kind; controller.abort(); } };
  const cancel = () => abort('CANCELLED');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => abort('TIMEOUT'), timeoutMs);
  timer.unref?.();
  let text = '', firstTextMs = null, reasoningChars = 0, completed = null;
  const boundReasoning = value => {
    if (typeof value !== 'string') throw problem('PROTOCOL_ERROR', 'DeepSeek 返回了无效的流式数据。');
    reasoningChars += value.length;
    if (reasoningChars > MAX_REASONING_CHARS) throw problem('OUTPUT_LIMIT', 'DeepSeek 响应超过长度限制，未采用本次结果。');
  };
  const inspectPart = part => {
    if (!part || typeof part !== 'object') throw problem('PROTOCOL_ERROR', 'DeepSeek 返回了无效的内容片段。');
    if (part.type === 'reasoning_text' || part.type === 'summary_text') { if (part.text !== undefined) boundReasoning(part.text); return; }
    if (part.type !== 'output_text') throw problem('TOOL_OUTPUT', 'DeepSeek 返回了非文本内容，未采用本次结果。');
  };
  const inspectItem = (item, final = false) => {
    if (!item || !['message', 'reasoning'].includes(item.type)) throw problem('TOOL_OUTPUT', 'DeepSeek 返回了工具或未知输出，未采用本次结果。');
    if (final && item.status && item.status !== 'completed') throw problem('INCOMPLETE', 'DeepSeek 未完整生成结果，请重试。');
    if (item.type === 'message') {
      if (item.role && item.role !== 'assistant') throw problem('PROTOCOL_ERROR', 'DeepSeek 返回了无效的消息角色。');
      if (!Array.isArray(item.content)) throw problem('PROTOCOL_ERROR', 'DeepSeek 返回了无效的消息内容。');
      for (const part of item.content) {
        if (part?.type !== 'output_text') throw problem('TOOL_OUTPUT', 'DeepSeek 返回了非文本内容，未采用本次结果。');
        if (typeof part.text !== 'string') throw problem('PROTOCOL_ERROR', 'DeepSeek 返回了无效的文本内容。');
      }
    } else {
      for (const parts of [item.content, item.summary]) {
        if (parts !== undefined && !Array.isArray(parts)) throw problem('PROTOCOL_ERROR', 'DeepSeek 返回了无效的流式数据。');
        for (const part of parts || []) {
          if (!['reasoning_text', 'summary_text'].includes(part?.type)) throw problem('TOOL_OUTPUT', 'DeepSeek 返回了未知输出，未采用本次结果。');
          inspectPart(part);
        }
      }
    }
  };
  const consume = raw => {
    if (!raw.trim() || raw.trim() === '[DONE]') return;
    let event;
    try { event = JSON.parse(raw); } catch { throw problem('PROTOCOL_ERROR', 'DeepSeek 返回了无法解析的流式数据。'); }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw problem('PROTOCOL_ERROR', 'DeepSeek 返回了无效的流式事件。');
    const type = event.type;
    if (type === 'error' || type === 'response.failed') throw problem('PROVIDER_ERROR', 'DeepSeek 未能完成这次生成，请重试。');
    if (type === 'response.incomplete') throw problem('INCOMPLETE', 'DeepSeek 未完整生成结果，请重试。');
    if (/function_call|tool|web_search|file_search|computer_call|mcp|code_interpreter|custom_call/.test(type)) {
      throw problem('TOOL_OUTPUT', 'DeepSeek 返回了工具调用，未采用本次结果。');
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') inspectItem(event.item, type.endsWith('.done'));
    if (type === 'response.content_part.added' || type === 'response.content_part.done') inspectPart(event.part);
    if (type !== 'response.completed' && event.response?.output !== undefined) {
      if (!Array.isArray(event.response.output)) throw problem('PROTOCOL_ERROR', 'DeepSeek 返回了无效的输出列表。');
      for (const item of event.response.output) inspectItem(item);
    }
    if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') boundReasoning(event.delta);
    if (type === 'response.output_text.delta') {
      if (typeof event.delta !== 'string') throw problem('PROTOCOL_ERROR', 'DeepSeek 返回了无效的文本片段。');
      if (event.delta) firstTextMs ??= elapsed();
      text += event.delta;
      if (text.length > MAX_TEXT_CHARS) throw problem('OUTPUT_LIMIT', 'DeepSeek 响应超过长度限制，未采用本次结果。');
    }
    if (type === 'response.completed') {
      const response = event.response;
      if (!response || response.status !== 'completed' || response.error || response.incomplete_details) throw problem('INCOMPLETE', 'DeepSeek 未完整生成结果，请重试。');
      if (!Array.isArray(response.output)) throw problem('PROTOCOL_ERROR', 'DeepSeek 完成事件缺少结果。');
      for (const item of response.output) inspectItem(item, true);
      const finalText = response.output.filter(item => item.type === 'message').flatMap(item => item.content).map(part => part.text).join('');
      if (!finalText.trim() || (text && text !== finalText)) throw problem('PROTOCOL_ERROR', 'DeepSeek 完成结果与流式内容不一致。');
      if (finalText.length > MAX_TEXT_CHARS) throw problem('OUTPUT_LIMIT', 'DeepSeek 响应超过长度限制，未采用本次结果。');
      firstTextMs ??= elapsed();
      let value;
      try { value = JSON.parse(finalText); } catch { throw problem('INVALID_JSON', 'DeepSeek 结果不是完整 JSON，未采用本次结果。'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('INVALID_JSON', 'DeepSeek 结果不是 JSON 对象，未采用本次结果。');
      completed = { value, metrics: { elapsedMs: elapsed(), firstTextMs, model: safeIdentifier(response.model) || model, usage: safeUsage(response.usage), responseId: safeIdentifier(response.id) } };
    }
  };
  try {
    if (controller.signal.aborted) throw problem('ABORTED', '请求已终止。');
    const response = await abortable(fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${apiKey.trim()}` },
      body: JSON.stringify({ model, reasoning: { effort: reasoning }, input: prompt, text: { format: { type: 'json_schema', name: 'promptions_result', schema } }, max_output_tokens: maxOutputTokens, temperature: 0.2, stream: true }),
    }), controller.signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const error = problem('HTTP_ERROR', `DeepSeek 服务返回错误（HTTP ${response.status}），请重试。`);
      error.status = response.status;
      throw error;
    }
    if (!response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) {
      void response.body?.cancel().catch(() => {});
      throw problem('PROTOCOL_ERROR', 'DeepSeek 未返回预期的流式响应。');
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '', parts = [], eventChars = 0, bytes = 0;
    const line = raw => {
      const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!value) {
        if (parts.length) consume(parts.join('\n'));
        parts = []; eventChars = 0;
      } else if (value.startsWith('data:')) {
        const data = value.slice(5).replace(/^ /, '');
        eventChars += data.length;
        if (eventChars > MAX_EVENT_CHARS) throw problem('OUTPUT_LIMIT', 'DeepSeek 流式事件超过长度限制。');
        parts.push(data);
      }
    };
    const drain = final => {
      let newline;
      while ((newline = buffer.search(/[\r\n]/)) !== -1) {
        if (!final && buffer[newline] === '\r' && newline === buffer.length - 1) break;
        const separatorSize = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1;
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + separatorSize);
        if (completed) break;
      }
      if (buffer.length > MAX_EVENT_CHARS) throw problem('OUTPUT_LIMIT', 'DeepSeek 流式事件超过长度限制。');
    };
    while (!completed) {
      const chunk = await abortable(reader.read(), controller.signal);
      if (chunk.done) {
        buffer += decoder.decode();
        drain(true);
        if (completed) break;
        if (buffer) line(buffer);
        if (parts.length) consume(parts.join('\n'));
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw problem('OUTPUT_LIMIT', 'DeepSeek 响应超过长度限制，未采用本次结果。');
      buffer += decoder.decode(chunk.value, { stream: true });
      drain(false);
    }
    if (!completed) throw problem('INCOMPLETE', 'DeepSeek 连接在结果完成前结束，请重试。');
    return completed;
  } catch (error) {
    if (abortKind === 'CANCELLED') throw problem('CANCELLED', '请求已取消。');
    if (abortKind === 'TIMEOUT') throw problem('TIMEOUT', 'DeepSeek 响应超时，已确认条件仍保留，请重试。');
    if (error?.deepseekTransport) throw error;
    // Never expose fetch/provider error messages, causes, headers, or payloads.
    throw problem('NETWORK_ERROR', '暂时无法完整接收 DeepSeek 响应，已确认条件仍保留。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (reader) void reader.cancel().catch(() => {});
  }
}
