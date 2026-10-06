import { afterEach, expect, test } from 'bun:test';
import { MonitorStore } from './store.ts';
import { ActivityStore } from './activity.ts';
import { BroadcastStore } from './broadcasts.ts';
import type { MonitorEvent } from './contracts.ts';

const stores: MonitorStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });
let sequence = 0;
const now = Date.now();

function event(type: string, data: Record<string, unknown>, at = now, sessionId = 'chat-a'): MonitorEvent {
  const n = ++sequence;
  return {
    version: 1, eventId: `activity-${n}`, producer: 'proxy', epoch: 'epoch-1', sequence: n,
    at: new Date(at).toISOString(), type, tenantId: 'private-tenant',
    connectionId: 'private-connection', sessionId, correlation: 'explicit',
    requestId: `request-${sessionId}`, attemptId: `attempt-${sessionId}`, data,
  };
}

function fixture() {
  const store = new MonitorStore(':memory:');
  stores.push(store);
  new BroadcastStore(store);
  const activity = new ActivityStore(store);
  const start = event('request.started', { model: 'private-model' }, now - 1000);
  store.apply(start);
  const sessionId = store.scopeId(start);
  activity.reconcile(now);
  return { store, activity, sessionId };
}

test('existing running chat appears after enable, but no text or private IDs are published', () => {
  const { store, activity, sessionId } = fixture();
  store.apply(event('item.snapshot', {
    itemId: 'raw-id', kind: 'message', role: 'user', text: 'PRIVATE_PROMPT_MARKER', revision: 1, complete: true,
  }, now - 500));
  store.apply(event('item.snapshot', {
    itemId: 'raw-answer', kind: 'message', role: 'assistant', text: 'PRIVATE_ANSWER_MARKER', revision: 1, complete: false,
  }, now - 100));
  activity.reconcile(now);
  expect(activity.list(now)).toEqual([]);
  activity.setEnabled(true, 'owner');
  const list = activity.list(now);
  expect(list).toHaveLength(1);
  expect(list[0]?.kind).toBe('activity');
  const snapshot = activity.public(list[0]!.id, now);
  expect(snapshot?.activity?.some(row => row.phase === 'answering')).toBe(true);
  expect(snapshot?.items).toEqual([]);
  const publicPayload = JSON.stringify({ list, snapshot });
  for (const privateText of ['PRIVATE_PROMPT_MARKER', 'PRIVATE_ANSWER_MARKER', 'private-model', 'private-tenant', sessionId, 'raw-id'])
    expect(publicPayload).not.toContain(privateText);
});

test('new chat appears on first request and disappears after completion grace period', () => {
  const { store, activity } = fixture();
  activity.setEnabled(true, 'owner');
  store.apply(event('request.started', { model: 'gpt' }, now, 'chat-b'));
  activity.reconcile(now);
  expect(activity.list(now)).toHaveLength(2);
  store.apply(event('request.updated', { status: 'completed' }, now + 1000, 'chat-b'));
  expect(activity.list(now + 2000)).toHaveLength(2);
  expect(activity.list(now + 20_000)).toHaveLength(1);
});

test('owner hiding and global pause revoke the same stable public ID', () => {
  const { activity, sessionId } = fixture();
  activity.setEnabled(true, 'owner');
  const id = activity.list(now)[0]!.id;
  activity.updateSession(sessionId, { hidden: true }, 'owner');
  expect(activity.list(now)).toEqual([]);
  expect(activity.public(id, now)).toBeNull();
  activity.updateSession(sessionId, { hidden: false, label: 'Public work' }, 'owner');
  expect(activity.list(now)[0]?.id).toBe(id);
  expect(activity.list(now)[0]?.title).toBe('Public work');
  activity.setEnabled(false, 'owner');
  expect(activity.public(id, now)).toBeNull();
});

test('silent streaming request eventually leaves the active list', () => {
  const { activity } = fixture();
  activity.setEnabled(true, 'owner');
  expect(activity.list(now + 2 * 60_000)[0]?.status).toBe('waiting');
  expect(activity.list(now + 6 * 60_000)).toEqual([]);
});
