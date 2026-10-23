import type { AnswerResponse, CancellationBody, CueResponse, HandoffBody, Health, RequestBody } from './prethink-types';

export interface PrethinkTransport {
  health(signal: AbortSignal): Promise<Health>;
  request(body: RequestBody, signal: AbortSignal): Promise<CueResponse | AnswerResponse>;
  acceptResult?(requestId: string): void;
  cancel(body: CancellationBody): Promise<void>;
  handoff?(body: HandoffBody, signal: AbortSignal): Promise<void>;
  initialGoal?(): Promise<string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createHttpTransport(): PrethinkTransport {
  return {
    async health(signal) {
      const response = await fetch('/api/health', { signal });
      const value: unknown = await response.json();
      if (!response.ok || !isObject(value) || typeof value.provider !== 'string' || typeof value.model !== 'string' || typeof value.dataMode !== 'string') {
        throw new Error('接口暂不可用');
      }
      return { provider: value.provider, model: value.model, dataMode: value.dataMode };
    },
    async request(body, signal) {
      const response = await fetch('/api/prethink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(isObject(value) && typeof value.error === 'string' ? value.error : '暂时无法完成请求');
      // The shared UI verifies the response shape and request identity before committing it.
      return value as CueResponse | AnswerResponse;
    },
    async cancel(body) {
      await fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      });
    },
  };
}
