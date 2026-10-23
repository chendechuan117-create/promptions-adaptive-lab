import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { generatePrethink, validatePrethinkRequest } from '../server/prethink.mjs';

export class LiveError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => new LiveError(code, message);
export const CLIENT_ID_PATTERN = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|[a-zA-Z0-9_-]{32,100})$/;
export function assertClientId(clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) throw fail('INVALID_INPUT', '客户端标识必须由安全随机数生成。');
}
const cueOption = z.strictObject({ label: z.string().trim().min(1).max(80), hint: z.string().trim().min(1).max(240) });
const inputGoal = z.string().trim().min(1).max(4000);
const clientIdSchema = z.string().regex(CLIENT_ID_PATTERN);
const requestIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const draft = { clientId: clientIdSchema, goal: inputGoal, parentRequestId: requestIdSchema.nullable(), selected: z.array(cueOption).max(24), note: z.string().max(2000) };
export const liveDeltaSchema = z.strictObject({ ...draft, requestId: requestIdSchema, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), mode: z.literal('cues'), variant: z.enum(['baseline', 'scoped']) });
export const handoffDeltaSchema = z.strictObject(draft);
export function validateLiveRequest(value) {
  if (value?.mode !== 'cues') throw fail('INVALID_INPUT', '此接口只生成联想方向，不生成正式答案。');
  const result = liveDeltaSchema.safeParse(value);
  if (!result.success) throw fail('INVALID_INPUT', '问题或本轮增量格式不正确，或内容过长。');
  return result.data;
}
function formatHandoff({ goal, rounds }) {
  let validated;
  try { validated = validatePrethinkRequest({ clientId: 'handoff', requestId: 'handoff', version: 1, mode: 'cues', variant: 'baseline', goal, rounds }); }
  catch { throw fail('INVALID_INPUT', '问题或联想记录格式不正确，或内容过长。'); }
  const ordered = validated.rounds.map((round, i) => `第${i + 1}轮：待考虑方向（不是事实）：${round.selected.length ? round.selected.map(item => `${item.label}（${item.hint}）`).join('；') : '无'}
用户补充（仅限该轮原本作用范围）：${round.note || '（无）'}`).join('\n');
  return { goal: validated.goal, rounds: validated.rounds, summary: `原目标：${validated.goal}
${ordered || '尚无选择或补充。'}
以上按轮次保留用户关注。selected仅表示待考虑方向，未经核实，不是事实、承诺或排他条件；未选择不等于排除。note是用户补充，请保留其原本作用范围。请根据当前信息回答原问题，区分用户补充与待核实事项。` };
}

// Single-process budget ledger. Only a numeric count is persisted, never request text.
export function createLiveRuntime({ generate = generatePrethink, maxCalls = 0, ledgerPath, deadlineMs = 30_000, cacheTtlMs = 60_000, now = Date.now } = {}) {
  if (!Number.isInteger(maxCalls) || maxCalls < 0 || maxCalls > 100) throw fail('CONFIGURATION', '调用预算须为0到100的整数。');
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) throw fail('CONFIGURATION', '超时设置无效。');
  let used = 0;
  if (ledgerPath && existsSync(ledgerPath)) {
    try {
      if (!lstatSync(ledgerPath).isFile() || lstatSync(ledgerPath).size > 128) throw new Error();
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      if (!Number.isSafeInteger(ledger.used) || ledger.used < 0) throw new Error();
      used = ledger.used;
    } catch { throw fail('LEDGER_UNAVAILABLE', '预算账本无效，已停止模型调用。'); }
  }
  const clients = new Map(), cache = new Map(), inFlight = new Set(), snapshots = new Map();
  const snapshotTtlMs = 2 * 60 * 60 * 1000;
  function prune() {
    for (const [key, item] of cache) if (item.expires <= now() && item.settled) cache.delete(key);
    for (const [key, item] of snapshots) if (item.expires <= now()) snapshots.delete(key);
    for (const [key, item] of clients) if (!item.active && item.expires <= now()) clients.delete(key);
  }
  const cleanupTimer = setInterval(prune, 30_000);
  cleanupTimer.unref();
  function reconstruct(delta, variant) {
    const parent = delta.parentRequestId === null ? null : snapshots.get(`${delta.clientId}:${delta.parentRequestId}`);
    if (delta.parentRequestId !== null && (!parent || parent.expires <= now() || parent.goal !== delta.goal || (variant && parent.variant !== variant))) throw fail('PARENT_UNAVAILABLE', '当前任务的上轮记录不存在、已过期或不匹配，请重新开始。');
    if (delta.selected.length && (!parent || delta.selected.some(item => !parent.options.some(option => option.label === item.label && option.hint === item.hint)))) throw fail('INVALID_SELECTION', '所选方向不属于本任务的上轮结果，自由补充请填写备注。');
    const rounds = structuredClone(parent?.rounds ?? []);
    if (delta.selected.length || delta.note.trim()) rounds.push({ selected: delta.selected, note: delta.note });
    const request = { clientId: delta.clientId, requestId: delta.requestId ?? 'handoff', version: delta.version ?? 1, mode: 'cues', variant: variant ?? parent?.variant ?? 'baseline', goal: delta.goal, rounds };
    try { return validatePrethinkRequest(request); }
    catch { throw fail('INVALID_INPUT', '当前任务内容过长或轮次过多，请重新开始。'); }
  }
  function prepareHandoff(value) {
    prune();
    const parsed = handoffDeltaSchema.safeParse(value);
    if (!parsed.success) throw fail('INVALID_INPUT', '交接增量格式不正确。');
    return formatHandoff(reconstruct(parsed.data));
  }
  function debit() {
    if (used >= maxCalls) throw fail('BUDGET_EXHAUSTED', '本次试验的模型调用预算已用尽或未启用。');
    const next = used + 1;
    if (ledgerPath) {
      const temp = `${ledgerPath}.${randomUUID()}.tmp`;
      try {
        mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
        writeFileSync(temp, JSON.stringify({ used: next }) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(temp, ledgerPath);
      } catch { throw fail('LEDGER_UNAVAILABLE', '无法保存预算，已停止模型调用。'); }
    }
    used = next;
  }
  function cancel({ clientId, requestId, version }) {
    assertClientId(clientId);
    const client = clients.get(clientId);
    const active = client?.active;
    const cancelled = Boolean(active && active.requestId === requestId && active.version === version);
    if (cancelled) active.controller.abort('cancelled');
    return { ok: true, cancelled };
  }
  function run(value) {
    const delta = validateLiveRequest(value);
    prune();
    const key = `${delta.clientId}:${delta.requestId}:${delta.version}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(delta)).digest('hex');
    const prior = cache.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return Promise.reject(fail('REQUEST_CONFLICT', '同一请求标识不能用于不同内容。'));
      return prior.promise;
    }
    let request;
    try { request = reconstruct(delta, delta.variant); } catch (error) { return Promise.reject(error); }
    if (snapshots.has(`${request.clientId}:${request.requestId}`)) return Promise.reject(fail('REQUEST_CONFLICT', '已完成的请求标识不能再次使用。'));
    const ownSnapshots = [...snapshots.keys()].filter(key => key.startsWith(`${request.clientId}:`)).length;
    if (snapshots.size + inFlight.size >= 100 || ownSnapshots >= 32) return Promise.reject(fail('CAPACITY', '当前任务记录容量已满，请稍后重试或重新开始。'));
    let client = clients.get(request.clientId);
    if (client && request.version <= client.version) return Promise.reject(fail('STALE_REQUEST', '请求已过期，请使用新的版本。'));
    if (!client && clients.size >= 100) return Promise.reject(fail('CAPACITY', '当前客户端较多，请稍后重试。'));
    if (cache.size >= 100 || inFlight.size >= 2) return Promise.reject(fail('BUSY', '当前请求较多，请稍后重试。'));
    try { debit(); } catch (error) { return Promise.reject(error); }
    if (!client) { client = {}; clients.set(request.clientId, client); }
    client.active?.controller.abort('superseded');
    const controller = new AbortController();
    const active = { controller, requestId: request.requestId, version: request.version };
    client.version = request.version; client.active = active; client.expires = now() + snapshotTtlMs;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(fail(controller.signal.reason === 'deadline' ? 'TIMEOUT' : 'CANCELLED', controller.signal.reason === 'deadline' ? '生成超时，输入和联想已保留。' : '请求已取消或替换。')); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
    const timer = setTimeout(() => controller.abort('deadline'), deadlineMs);
    const token = {}; inFlight.add(token);
    // Keep the concurrency slot until the provider actually settles, even if it ignores abort.
    const provider = Promise.resolve().then(() => generate(request, { signal: controller.signal }));
    provider.then(() => inFlight.delete(token), () => inFlight.delete(token));
    const item = { fingerprint, expires: Infinity, settled: false };
    item.promise = Promise.race([provider, aborted]).then(result => {
      if (controller.signal.aborted || client.active !== active) throw fail('STALE_REQUEST', '请求已过期，未采用结果。');
      if (!result || !Array.isArray(result.options)) throw fail('GENERATION_FAILED', '未能生成完整联想方向；输入和联想已保留。');
      snapshots.set(`${request.clientId}:${request.requestId}`, { goal: request.goal, variant: request.variant, rounds: structuredClone(request.rounds), options: structuredClone(result.options), expires: now() + snapshotTtlMs });
      return result;
    }).catch(error => {
      if (error instanceof LiveError) throw error;
      throw fail('GENERATION_FAILED', '未能生成完整联想方向；输入和联想已保留。');
    }).finally(() => {
      clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAbort);
      if (client.active === active) client.active = null;
      item.settled = true; item.expires = now() + cacheTtlMs;
    });
    cache.set(key, item);
    return item.promise;
  }
  return { run, cancel, prepareHandoff, stats: () => ({ used, maxCalls, inFlight: inFlight.size }), close: () => {
    clearInterval(cleanupTimer);
    for (const client of clients.values()) client.active?.controller.abort('cancelled');
    clients.clear(); cache.clear(); snapshots.clear();
  } };
}
