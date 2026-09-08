import { test, expect, afterEach } from 'bun:test';
import { MonitorStore } from './store.ts';
import { BroadcastStore } from './broadcasts.ts';
import type { MonitorEvent } from './contracts.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const stores: MonitorStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.db.close();
});
let sequence = 0;
const now = Date.now(),
  from = new Date(now - 60000).toISOString(),
  to = new Date(now - 1000).toISOString();
const evt = (text: string, overrides: any = {}): MonitorEvent => ({
  version: 1,
  eventId: `b-${++sequence}`,
  sequence,
  epoch: 'e1',
  producer: 'proxy',
  tenantId: 'tenant-secret',
  connectionId: 'conn-secret',
  sessionId: 'session-secret',
  correlation: 'explicit',
  at: new Date(now - 30000 + sequence).toISOString(),
  type: 'item.snapshot',
  data: {
    itemId: 'raw-id',
    kind: 'message',
    role: 'assistant',
    text,
    revision: sequence,
    complete: true,
  },
  ...overrides,
});
function fixture() {
  const monitor = new MonitorStore(':memory:');
  stores.push(monitor);
  const event = evt('Visible text');
  monitor.apply(event);
  return {
    monitor,
    b: new BroadcastStore(monitor),
    sid: monitor.scopeId(event),
  };
}
const config = (sid: string, mode = 'replay') => ({
  sessionId: sid,
  title: 'Published name',
  mode,
  from,
  to,
  speed: 1,
  loop: true,
  skipPauses: true,
});

test('available range includes only selected session snapshots that have arrived', () => {
  const { monitor,b,sid } = fixture();
  monitor.apply(evt('OTHER', { sessionId: 'other', at: new Date(now-50000).toISOString() }));
  monitor.apply(evt('future', { at: new Date(now+86400000).toISOString() }));
  const range = b.range(sid);
  expect(range.snapshots).toBe(1);
  expect(Date.parse(range.firstAt)).toBeGreaterThan(now-40000);
  expect(Date.parse(range.lastAt)).toBeLessThan(Date.parse(range.serverNow));
  expect(() => b.range('bad')).toThrow('not_found');
  expect(b.list()).toEqual([]);
});

test('large recording is shortened only on explicit request, stays inside range and remains private', () => {
  const { monitor,b,sid } = fixture();
  const start = now-120000;
  for (let i=0;i<60;i++) monitor.apply(evt('x'.repeat(180000)+i, {
    at:new Date(start+i*1000).toISOString(),
  }));
  const body = {...config(sid),from:new Date(start).toISOString(),to:new Date(start+60000).toISOString()};
  expect(() => b.prepare(body,'owner')).toThrow('recording_too_large');
  const result = b.prepare({...body,fit:true},'owner');
  expect(result.adjusted).toBe(true);
  expect(result.config.from > body.from).toBe(true);
  expect(result.config.to <= body.to).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.preview.frames))).toBeLessThan(8*1024*1024);
  expect(result.preview.frames.length).toBeGreaterThan(0);
  expect(result.preview.frames.every((f:any) => f.item.at>=result.config.from && f.item.at<=result.config.to)).toBe(true);
  expect(b.list()).toEqual([]);
  const exact = b.prepare({...body,from:result.config.from,to:result.config.to},'owner');
  expect(exact.adjusted).toBe(false);
  expect(exact.preview.frames.map((f:any)=>f.item.text)).toEqual(result.preview.frames.map((f:any)=>f.item.text));
});
test('no implicit publication, preview is private and publish requires the same owner', () => {
  const { b, sid } = fixture();
  expect(b.list()).toEqual([]);
  const draft = b.prepare(config(sid), 'owner');
  expect(b.list()).toEqual([]);
  expect(() => b.publish(draft.draftId, 'other')).toThrow('preview_expired');
  const row = b.publish(draft.draftId, 'owner');
  expect(b.list()).toHaveLength(1);
  expect(() => b.publish(draft.draftId, 'owner')).toThrow('preview_expired');
  expect(b.public(row.id)).toBeTruthy();
});
test('recordings include revisions once and no metadata from another session', () => {
  const { monitor, b, sid } = fixture();
  monitor.apply(evt('Visible update'));
  monitor.apply(evt('SECRET', { sessionId: 'private-other' }));
  const draft = b.prepare(config(sid), 'owner');
  const row = b.publish(draft.draftId, 'owner');
  const text = JSON.stringify(b.public(row.id));
  expect(text).toContain('Visible update');
  for (const value of [
    'SECRET',
    'tenant-secret',
    'conn-secret',
    'session-secret',
    'raw-id',
    sid,
  ])
    expect(text).not.toContain(value);
  expect(b.public(row.id).frames).toHaveLength(2);
});
test('legacy replay recordings are sanitized every time they are served', () => {
  const { monitor,b,sid }=fixture();
  const row=b.publish(b.prepare(config(sid),'owner').draftId,'owner');
  const saved=b.row(row.id)!;
  const recording=JSON.parse(saved.recording);
  recording.frames[0].item.text='C:\\Users\\PrivateUser\\repo password=legacy-cleartext';
  monitor.db.query('UPDATE broadcasts SET recording=? WHERE id=?').run(JSON.stringify(recording),row.id);
  const output=JSON.stringify(b.public(row.id));
  expect(output).not.toContain('PrivateUser');expect(output).not.toContain('legacy-cleartext');
});
test('hiding removes discovery and direct access, retaining a private recording', () => {
  const { b, sid } = fixture();
  const row = b.publish(b.prepare(config(sid), 'owner').draftId, 'owner');
  b.update(row.id, { visible: false }, 'owner');
  expect(b.list()).toEqual([]);
  expect(b.public(row.id)).toBeNull();
  expect(b.list(true)[0].visible).toBe(false);
  b.update(row.id, { visible: true }, 'owner');
  expect(b.public(row.id).frames).toHaveLength(1);
  b.remove(row.id, 'owner');
  expect(b.public(row.id)).toBeNull();
});
test('24h cleanup leaves selected recordings intact and token usage unchanged on repeat', () => {
  const { monitor, b, sid } = fixture();
  const row = b.publish(b.prepare(config(sid), 'owner').draftId, 'owner');
  const expected = b.public(row.id);
  monitor.prune(now + 48 * 3600000);
  expect(monitor.session(sid)?.items).toHaveLength(0);
  for (let i = 0; i < 10; i++) expect(b.public(row.id)).toEqual(expected);
  expect(monitor.usage().total).toBe(0);
});
test('live publication advances only with its session; private renames stay private', () => {
  const { monitor, b, sid } = fixture();
  const row = b.publish(
    b.prepare(config(sid, 'live'), 'owner').draftId,
    'owner',
  );
  const initial = b.public(row.id);
  monitor.apply(evt('SECRET', { sessionId: 'other' }));
  monitor.rename(sid, 'Private rename', 'owner');
  expect(b.public(row.id).cursor).toBe(initial.cursor);
  expect(b.public(row.id).title).toBe('Published name');
  monitor.apply(evt('New text'));
  expect(b.public(row.id).cursor).not.toBe(initial.cursor);
  expect(b.public(row.id).items[0].text).toBe('New text');
});
test('recording range is fixed and context repeats do not overwrite streamed items', () => {
  const { monitor, b, sid } = fixture();
  const context = evt('Duplicate context');
  context.data.context = true;
  monitor.apply(context);
  monitor.apply(evt('OUTSIDE', { at: new Date(now + 1000).toISOString() }));
  const row = b.publish(b.prepare(config(sid), 'owner').draftId, 'owner');
  const text = JSON.stringify(b.public(row.id));
  expect(text).not.toContain('Duplicate context');
  expect(text).not.toContain('OUTSIDE');
  expect(b.public(row.id).frames).toHaveLength(1);
});
test('invalid options, empty range and expired previews cannot publish', () => {
  const { monitor, b, sid } = fixture();
  for (const change of [
    { mode: 'run' },
    { title: ' ' },
    { speed: 100 },
    { from: 'invalid' },
    { position: -1 },
    { from: to, to: from },
  ])
    expect(() => b.prepare({ ...config(sid), ...change }, 'owner')).toThrow();
  expect(() =>
    b.prepare(
      {
        ...config(sid),
        from: new Date(now - 500).toISOString(),
        to: new Date(now - 100).toISOString(),
      },
      'owner',
    ),
  ).toThrow('recording_unavailable');
  const d = b.prepare(config(sid), 'owner');
  monitor.db
    .query('UPDATE broadcast_drafts SET expires_at=?')
    .run('2000-01-01T00:00:00.000Z');
  expect(() => b.publish(d.draftId, 'owner')).toThrow('preview_expired');
});
test('archive works after process restart without the original session history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'broadcast-test-')),
    path = join(dir, 'test.sqlite');
  let monitor = new MonitorStore(path);
  try {
    const e = evt('Survives restart');
    monitor.apply(e);
    let b = new BroadcastStore(monitor);
    const row = b.publish(
      b.prepare(config(monitor.scopeId(e)), 'owner').draftId,
      'owner',
    );
    monitor.prune(now + 91 * 86400000);
    monitor.db.close();
    monitor = new MonitorStore(path);
    b = new BroadcastStore(monitor);
    expect(b.public(row.id).frames[0].item.text).toBe('Survives restart');
    expect(b.list()).toHaveLength(1);
  } finally {
    monitor.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('full live preview includes all pages before publishing', () => {
  const { monitor, b, sid } = fixture();
  for (let n = 0; n < 100; n++) {
    const e = evt('Item ' + n);
    e.data.itemId = 'i-' + n;
    monitor.apply(e);
  }
  const preview = b.prepare(config(sid, 'live'), 'owner').preview;
  expect(preview.items).toHaveLength(101);
  expect(preview.hasOlder).toBe(false);
});
