export type MonitorEvent = {
  version: 1; eventId: string; producer: string; epoch: string; sequence: number; at: string;
  type: string; tenantId: string; connectionId: string; sessionId: string;
  correlation: 'explicit' | 'unassigned'; requestId?: string; attemptId?: string;
  data: Record<string, any>;
};
export const eventTypes = new Set(['source.status', 'request.started', 'request.updated', 'item.snapshot', 'usage.snapshot', 'delivery.gap']);
export function validateEvent(value: any): asserts value is MonitorEvent {
  if (!value || value.version !== 1 || !eventTypes.has(value.type) || !value.data || typeof value.data !== 'object') throw Error('invalid_event');
  for (const key of ['eventId', 'producer', 'epoch', 'tenantId', 'connectionId', 'sessionId']) {
    if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9:_\-/]{1,160}$/.test(value[key])) throw Error('invalid_identity');
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Number.isFinite(Date.parse(value.at))) throw Error('invalid_sequence');
  if (JSON.stringify(value).length > 240_000) throw Error('event_too_large');
}
export function usageQuality(d: Record<string, any>): 'complete' | 'partial' | 'conflict' {
  const { input: i, output: o, total: t, cached: c, reasoning: r } = d;
  for (const n of [i, o, t, c, r]) if (n != null && (!Number.isSafeInteger(n) || n < 0)) return 'conflict';
  if (i != null && c != null && c > i || o != null && r != null && r > o || i != null && o != null && t != null && t !== i + o) return 'conflict';
  return i == null || o == null || c == null || r == null ? 'partial' : 'complete';
}
