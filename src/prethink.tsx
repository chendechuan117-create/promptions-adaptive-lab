import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './prethink.css';

type CueOption = { label: string; hint: string };
type Round = { selected: CueOption[]; note: string };
type Metrics = { elapsedMs?: number; [key: string]: unknown };
type Mode = 'cues' | 'answer';
type Variant = 'baseline' | 'scoped';
type RequestPayload = { mode: Mode; variant: Variant; goal: string; rounds: Round[] };
type RequestBody = RequestPayload & { clientId: string; requestId: string; version: number };
type CueResponse = RequestBody & { options: CueOption[]; scope?: string; metrics?: Metrics };
type AnswerResponse = RequestBody & { answer: string; usedAssociations: string[]; metrics?: Metrics };
type ResultRecord = {
  mode: Mode;
  variant: Variant;
  scope?: string;
  requestId: string;
  receivedAt: string;
  metrics: Metrics | null;
  options?: CueOption[];
  answer?: string;
  usedAssociations?: string[];
  browserRequestMs: number;
};
type RetryRecord = { payload: RequestPayload; committedRounds: Round[] };
type ActiveRequest = { controller: AbortController; requestId: string; version: number; clientId: string; mode: Mode };
type Health = { provider: string; model: string; dataMode: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCueResponse(value: unknown): value is CueResponse {
  if (!isObject(value) || value.mode !== 'cues' || !Array.isArray(value.options)) return false;
  return value.options.every((option) => isObject(option) && typeof option.label === 'string' && typeof option.hint === 'string');
}

function isAnswerResponse(value: unknown): value is AnswerResponse {
  return isObject(value) && value.mode === 'answer' && typeof value.answer === 'string' && Array.isArray(value.usedAssociations) && value.usedAssociations.every((item) => typeof item === 'string');
}

function draftHasContent(draft: Round): boolean {
  return draft.selected.length > 0 || draft.note.trim().length > 0;
}

function withDraft(rounds: Round[], draft: Round): Round[] {
  return draftHasContent(draft) ? [...rounds, { selected: [...draft.selected], note: draft.note.trim() }] : rounds;
}

function App() {
  const [variant] = useState<Variant>(() => new URLSearchParams(window.location.search).get('variant') === 'scoped' ? 'scoped' : 'baseline');
  const clientId = useMemo(() => window.crypto.randomUUID(), []);
  const versionRef = useRef(0);
  const activeRef = useRef<ActiveRequest | null>(null);
  const firstCueStartedAt = useRef<number | null>(null);
  const [phase, setPhase] = useState<'input' | 'cues' | 'answer'>('input');
  const [goalDraft, setGoalDraft] = useState('');
  const [goal, setGoal] = useState('');
  const [rounds, setRounds] = useState<Round[]>([]);
  const [{ options, scope }, setCues] = useState<{ options: CueOption[]; scope: string }>({ options: [], scope: '' });
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>([]);
  const [note, setNote] = useState('');
  const [multiSelect, setMultiSelect] = useState(false);
  const [answer, setAnswer] = useState<AnswerResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [retryRecord, setRetryRecord] = useState<RetryRecord | null>(null);
  const [results, setResults] = useState<ResultRecord[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [firstCueRenderMs, setFirstCueRenderMs] = useState<number | null>(null);
  const [cueRenderReady, setCueRenderReady] = useState(false);
  const [editingExisting, setEditingExisting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        const value: unknown = await response.json();
        if (!response.ok || !isObject(value) || typeof value.provider !== 'string' || typeof value.model !== 'string' || typeof value.dataMode !== 'string') {
          throw new Error('接口暂不可用');
        }
        setHealth({ provider: value.provider, model: value.model, dataMode: value.dataMode });
        setHealthFailed(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setHealthFailed(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (phase !== 'cues' || !cueRenderReady || !options.length || firstCueRenderMs !== null || firstCueStartedAt.current === null) return;
    const frame = window.requestAnimationFrame(() => {
      if (firstCueStartedAt.current !== null) setFirstCueRenderMs(performance.now() - firstCueStartedAt.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phase, options, firstCueRenderMs, cueRenderReady]);

  function cancelActive(sendCancellation: boolean, statusText = '已取消，当前内容还在。') {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    if (active.mode === 'cues') firstCueStartedAt.current = null;
    versionRef.current += 1;
    active.controller.abort();
    if (sendCancellation) {
      void fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: active.clientId, requestId: active.requestId, version: active.version, variant }),
        keepalive: true,
      }).catch(() => undefined);
    }
    setBusy(false);
    setStatus(statusText);
  }

  async function sendRequest(payload: RequestPayload, committedRounds: Round[]) {
    if (activeRef.current) cancelActive(true, '正在切换方向…');
    const version = ++versionRef.current;
    const requestId = window.crypto.randomUUID();
    const body: RequestBody = { ...payload, clientId, requestId, version };
    const controller = new AbortController();
    const requestStart = performance.now();
    if (payload.mode === 'cues' && firstCueStartedAt.current === null) firstCueStartedAt.current = requestStart;
    if (payload.mode === 'cues') setCueRenderReady(false);
    activeRef.current = { controller, requestId, version, clientId, mode: payload.mode };
    setBusy(true);
    setErrorMessage('');
    setRetryRecord(null);
    setStatus(payload.mode === 'cues' ? '正在整理下一层联想方向…' : '正在把这些方向整理成回答…');

    try {
      const response = await fetch('/api/prethink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const value: unknown = await response.json();
      if (versionRef.current !== version || activeRef.current?.version !== version) return;
      if (!response.ok) {
        const message = isObject(value) && typeof value.error === 'string' ? value.error : '暂时无法完成请求';
        throw new Error(message);
      }
      if (!isObject(value) || value.requestId !== requestId || value.version !== version || value.mode !== payload.mode) {
        throw new Error('返回内容与本次请求不匹配');
      }
      let cueValue: CueResponse | null = null;
      let answerValue: AnswerResponse | null = null;
      if (payload.mode === 'cues') {
        if (!isCueResponse(value) || (variant === 'scoped' && (typeof value.scope !== 'string' || !value.scope.trim()))) throw new Error('这次没有收到可显示的联想线索');
        cueValue = value;
      } else {
        if (!isAnswerResponse(value)) throw new Error('这次没有收到可显示的回答');
        answerValue = value;
      }
      activeRef.current = null;
      setBusy(false);
      setRetryRecord(null);
      setErrorMessage('');
      setRounds(committedRounds);
      setResults((current) => [...current, {
        mode: payload.mode,
        variant,
        requestId,
        receivedAt: new Date().toISOString(),
        metrics: payload.mode === 'cues' ? cueValue?.metrics ?? null : answerValue?.metrics ?? null,
        ...(payload.mode === 'cues'
          ? { options: cueValue?.options ?? [], ...(variant === 'scoped' ? { scope: cueValue?.scope?.trim() } : {}) }
          : { answer: answerValue?.answer ?? '', usedAssociations: answerValue?.usedAssociations ?? [] }),
        browserRequestMs: performance.now() - requestStart,
      }]);
      if (payload.mode === 'cues') {
        const cues = cueValue?.options ?? [];
        setCues({ options: cues, scope: variant === 'scoped' ? cueValue?.scope?.trim() ?? '' : '' });
        setSelectedIndexes([]);
        setNote('');
        setMultiSelect(false);
        setAnswer(null);
        setPhase('cues');
        setCueRenderReady(true);
        setStatus(cues.length ? '可以点一个方向继续；点选只表示值得想一想。' : '这一层暂时没有新的方向，也可以直接整理成回答。');
      } else {
        setAnswer(answerValue);
        setSelectedIndexes([]);
        setNote('');
        setPhase('answer');
        setStatus('已整理好一版回答。');
      }
    } catch (error) {
      if (versionRef.current !== version || activeRef.current?.version !== version) return;
      activeRef.current = null;
      setBusy(false);
      if (payload.mode === 'cues') firstCueStartedAt.current = null;
      setErrorMessage(error instanceof Error ? error.message : '请求暂时没有完成');
      setRetryRecord({ payload, committedRounds });
      setStatus('刚才没接上，内容还在。');
    }
  }

  function beginWithGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextGoal = goalDraft.trim();
    if (!nextGoal || busy) return;
    if (activeRef.current) cancelActive(true, '正在开始新的问题…');
    setGoal(nextGoal);
    setGoalDraft(nextGoal);
    setRounds([]);
    setCues({ options: [], scope: '' });
    setSelectedIndexes([]);
    setNote('');
    setAnswer(null);
    setResults([]);
    setFirstCueRenderMs(null);
    setCueRenderReady(false);
    firstCueStartedAt.current = null;
    setEditingExisting(false);
    setPhase('cues');
    setStatus('正在整理第一层联想方向…');
    void sendRequest({ mode: 'cues', variant, goal: nextGoal, rounds: [] }, []);
  }

  function currentDraft(): Round {
    return {
      selected: selectedIndexes.map((index) => options[index]).filter((item): item is CueOption => Boolean(item)),
      note: note.trim(),
    };
  }

  function continueWithDraft(draft = currentDraft()) {
    if (busy || phase !== 'cues') return;
    const nextRounds = withDraft(rounds, draft);
    void sendRequest({ mode: 'cues', variant, goal, rounds: nextRounds }, nextRounds);
  }

  function makeAnswer() {
    if (busy || phase !== 'cues') return;
    const nextRounds = withDraft(rounds, currentDraft());
    void sendRequest({ mode: 'answer', variant, goal, rounds: nextRounds }, nextRounds);
  }

  function toggleOption(index: number) {
    if (busy) return;
    if (multiSelect) {
      setSelectedIndexes((current) => current.includes(index) ? current.filter((item) => item !== index) : [...current, index]);
      return;
    }
    const option = options[index];
    if (!option) return;
    setSelectedIndexes([index]);
    continueWithDraft({ selected: [option], note: note.trim() });
  }

  function startEditingGoal() {
    if (activeRef.current) cancelActive(true, '正在返回修改问题…');
    setGoalDraft(goal);
    setEditingExisting(true);
    setErrorMessage('');
    setRetryRecord(null);
    setPhase('input');
    setStatus('修改后会从新问题重新开始。');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function returnToExploration() {
    setGoalDraft(goal);
    setEditingExisting(false);
    setPhase(answer ? 'answer' : 'cues');
    setStatus('回到刚才的联想。');
  }

  function restart() {
    if (activeRef.current) cancelActive(true, '已重新开始。');
    versionRef.current += 1;
    setGoal('');
    setGoalDraft('');
    setRounds([]);
    setCues({ options: [], scope: '' });
    setSelectedIndexes([]);
    setNote('');
    setMultiSelect(false);
    setAnswer(null);
    setResults([]);
    setRetryRecord(null);
    setErrorMessage('');
    setFirstCueRenderMs(null);
    setCueRenderReady(false);
    firstCueStartedAt.current = null;
    setEditingExisting(false);
    setPhase('input');
    setStatus('可以从一个新问题开始。');
  }

  function toggleMultiSelect() {
    if (busy) return;
    setMultiSelect((value) => !value);
    setSelectedIndexes([]);
  }

  function toggleSelectedIndex(index: number) {
    if (busy) return;
    setSelectedIndexes((current) => current.includes(index) ? current.filter((item) => item !== index) : [...current, index]);
  }

  function exportTrial() {
    const draft = phase === 'cues' ? currentDraft() : { selected: [], note: '' };
    const trial = {
      schemaVersion: 1,
      variant,
      clientId,
      exportedAt: new Date().toISOString(),
      goal,
      rounds,
      draft,
      results,
      timing: {
        firstCueOptionsRenderedMs: firstCueRenderMs,
        modelElapsedMs: results.map((result) => ({ requestId: result.requestId, mode: result.mode, elapsedMs: result.metrics?.elapsedMs ?? null })),
        browserRequestMs: results.map((result) => ({ requestId: result.requestId, mode: result.mode, elapsedMs: result.browserRequestMs })),
      },
    };
    const blob = new Blob([JSON.stringify(trial, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'thoughtscout-trial-' + new Date().toISOString().replaceAll(':', '-') + '.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function retry() {
    if (!retryRecord || busy) return;
    void sendRequest(retryRecord.payload, retryRecord.committedRounds);
  }

  const healthLabel = health
    ? 'DeepSeek · 已连接'
    : healthFailed ? '暂时未连接' : '正在连接';
  const canExport = results.length > 0 || rounds.length > 0;
  const draft = currentDraft();
  const hasDraft = draftHasContent(draft);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="联想前哨，预思考原型">
          <div className="brand-mark" aria-hidden="true">思</div>
          <div className="brand-copy">
            <p className="brand-name">联想前哨</p>
            <p className="brand-subtitle">预思考原型</p>
          </div>
        </div>
        <div className={`health ${health ? 'ready' : healthFailed ? 'failed' : ''}`} title={health ? `${health.provider} · ${health.model} · ${health.dataMode}` : undefined}>
          <span className="health-dot" aria-hidden="true" />
          <span>{healthLabel}</span>
        </div>
      </header>

      <section className={`intro ${phase === 'cues' ? 'intro-cues' : ''}`}>
        <p className="eyebrow">先打开几个方向</p>
        <h1>{phase === 'input' ? '你现在想解决什么？' : phase === 'answer' ? '把线索带进回答' : '还有哪些角度值得想？'}</h1>
        <p className="intro-copy">{phase === 'input'
          ? '写下问题或眼前的决定。先看看有哪些相关方向，再由你的联想把思考往前带。'
          : phase === 'answer' ? '这是一版根据原问题和你选过的线索整理的回答。' : '这些方向用来唤起联想，不要求选完，也不代表最终决定。'}
        </p>
      </section>

      <main className="main-card">
        {phase === 'input' ? (
          <form onSubmit={beginWithGoal}>
            <label className="field-label" htmlFor="goal-input">你的问题</label>
            <textarea
              ref={inputRef}
              id="goal-input"
              className="goal-input"
              value={goalDraft}
              onChange={(event) => setGoalDraft(event.target.value)}
              placeholder="写下你想解决的事、要做的决定，或现在卡住的地方……"
              maxLength={4000}
              disabled={busy}
            />
            <p className="helper">一句话也可以。这里先帮你展开思路，不查询实时资料。</p>
            {editingExisting && <p className="edit-note">修改问题后会从头开始；返回当前联想可以保留刚才的方向。</p>}
            {errorMessage && <ErrorBox message={errorMessage} onRetry={retry} busy={busy} />}
            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={busy || !goalDraft.trim()} aria-label="生成联想线索">
                {busy ? '正在想几个方向…' : '生成联想线索'}
              </button>
              {editingExisting && <button className="quiet-button" type="button" onClick={returnToExploration}>返回当前联想</button>}
              {busy && <button className="cancel-button" type="button" onClick={() => cancelActive(true)}>取消生成</button>}
            </div>
          </form>
        ) : (
          <>
            <div className="journey-head">
              <div className="journey-goal">
                <p className="label">你的原问题</p>
                <p className="value">{goal}</p>
              </div>
              <div className="journey-tools">
                <button className="quiet-button" type="button" onClick={startEditingGoal} disabled={busy}>修改问题</button>
                <button className="quiet-button" type="button" onClick={restart}>重新开始</button>
              </div>
            </div>

            {phase === 'cues' ? (
              <>
                <h2 className="section-heading">你可以从这些方向想想</h2>
                <p className="section-copy" data-testid={variant === 'scoped' && scope ? 'cue-scope' : undefined}>{variant === 'scoped' && scope ? scope : '点一个方向继续，也可多选或直接生成答案。'}</p>
                <div className="cue-controls">
                  <div className="choice-tools">
                    <button className="multi-toggle" type="button" aria-pressed={multiSelect} disabled={busy} onClick={toggleMultiSelect}>
                      {multiSelect ? '退出多选' : '开启多选'}
                    </button>
                    <span className="choice-count">{multiSelect ? `已选 ${selectedIndexes.length} 项` : '单选会立即继续'}</span>
                  </div>
                  <div className="next-actions">
                    {(multiSelect || note.trim().length > 0) && (
                      <button className="primary-button" type="button" aria-label="沿所选方向继续" disabled={busy || !hasDraft} onClick={() => continueWithDraft()}>
                        {selectedIndexes.length ? '沿所选方向继续' : '带着这条补充继续'}
                      </button>
                    )}
                    <button className="secondary-button" type="button" aria-label="整理成答案" disabled={busy} onClick={makeAnswer}>直接生成答案</button>
                    {busy && <button className="cancel-button" type="button" onClick={() => cancelActive(true)}>取消生成</button>}
                  </div>
                </div>
                {options.length > 0 ? (
                  <div className="cue-grid" aria-label="联想方向">
                    {options.map((option, index) => {
                      const selected = selectedIndexes.includes(index);
                      return (
                        <button
                          key={`${index}:${option.label}`}
                          type="button"
                          className={`cue-option ${selected ? 'selected' : ''}`}
                          data-testid="cue-option"
                          aria-pressed={selected}
                          aria-label={option.label}
                          aria-describedby={option.hint ? `cue-hint-${index}` : undefined}
                          disabled={busy}
                          onClick={() => toggleOption(index)}
                        >
                          <span className="cue-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                          <span className="cue-copy">
                            <span className="cue-label">{option.label}</span>
                            {option.hint && <span className="cue-hint" id={`cue-hint-${index}`}>{option.hint}</span>}
                          </span>
                          {multiSelect && <span className="cue-selectmark" aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="draft-summary">{busy ? '正在想几个方向…' : '暂时没有新的方向；你可以补充自己的想法，或直接整理成回答。'}</div>
                )}

                <div className="note-box">
                  <label className="field-label" htmlFor="note-input">你还想到什么？</label>
                  <textarea
                    id="note-input"
                    className="note-input"
                    value={note}
                    aria-label="当前补充"
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="可以写一个遗漏的情境、因果联系、例外，或你的直觉……"
                    maxLength={2000}
                    disabled={busy}
                  />
                  <p className="helper">你的补充会作为你的联想带入下一步；不必写得完整。</p>
                </div>

                {selectedIndexes.length > 0 && <div className="draft-summary">已选方向：{selectedIndexes.map((index) => options[index]?.label).filter(Boolean).join('、')}</div>}
                {errorMessage && <ErrorBox message={errorMessage} onRetry={retry} busy={busy} />}
                {busy && <LoadingRow label={status} />}

              </>
            ) : (
              <>
                <div className="answer-panel">
                  <p className="answer-text">{answer?.answer}</p>
                  {answer?.usedAssociations.length ? (
                    <div className="associations">
                      <p className="associations-title">回答中带入的联想</p>
                      <ul className="association-list">{answer.usedAssociations.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
                    </div>
                  ) : null}
                </div>
                {errorMessage && <ErrorBox message={errorMessage} onRetry={retry} busy={busy} />}
                {busy && <LoadingRow label={status} />}
                <div className="next-actions">
                  <button className="primary-button" type="button" disabled={busy} onClick={() => setPhase('cues')}>再补一条联想</button>
                </div>
              </>
            )}

            <HistoryDisclosure rounds={rounds} />
            <div className="status-region" role="status" aria-live="polite">
              {status}{firstCueRenderMs !== null && <span> · 首批线索出现 {firstCueRenderMs.toFixed(0)} ms（浏览器计时）</span>}
            </div>
          </>
        )}
      </main>

      <p className="footnote"><strong>这是预思考原型，不查询实时资料。</strong> 点选只表示值得继续考虑，不是最终承诺；答案仍需你核对。</p>
      {canExport && (
        <div className="footer-actions">
          <button className="quiet-button" type="button" onClick={exportTrial}>导出当前试用 JSON</button>
        </div>
      )}
    </div>
  );
}

function ErrorBox({ message, onRetry, busy }: { message: string; onRetry: () => void; busy: boolean }) {
  return (
    <div className="error-box" role="alert">
      <strong>刚才没接上，内容还在。</strong>
      {message && <span className="error-detail">{message}</span>}
      <div className="error-actions">
        <button className="secondary-button" type="button" disabled={busy} onClick={onRetry}>重试</button>
      </div>
    </div>
  );
}

function LoadingRow({ label }: { label: string }) {
  return (
    <div className="loading-row" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function HistoryDisclosure({ rounds }: { rounds: Round[] }) {
  if (!rounds.length) return null;
  return (
    <details className="history">
      <summary>已选方向与补充（{rounds.length} 步）</summary>
      <div className="history-list">
        {rounds.map((round, index) => (
          <div className="history-item" key={index}>
            <strong>第 {index + 1} 步{round.selected.length ? ` · ${round.selected.map((item) => item.label).join('、')}` : ' · 自由补充'}</strong>
            {round.selected.map((item, selectedIndex) => <p key={`${selectedIndex}:${item.label}`}>{item.hint}</p>)}
            {round.note && <p className="history-note">你的补充：{round.note}</p>}
          </div>
        ))}
      </div>
    </details>
  );
}

const mount = document.getElementById('root');
if (!mount) throw new Error('Missing root element');
createRoot(mount).render(<App />);
