import { randomBytes } from 'node:crypto';
import type { MonitorStore } from './store.ts';
import { sanitizePublicTitle } from './privacy.ts';

const ID = /^[a-f0-9]{32}$/;
const WAIT_MS = 90_000;
const STALE_MS = 5 * 60_000;
const FINISH_MS = 15_000;

type Phase = 'started' | 'answering' | 'tool_started' | 'tool_finished' | 'completed' | 'failed';

/** Public activity is deliberately assembled from fixed labels, never from event text. */
export class ActivityStore {
  constructor(private readonly monitor: MonitorStore) {
    monitor.db.exec(`
      CREATE TABLE IF NOT EXISTS site_activity_settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO site_activity_settings VALUES ('enabled', '0');
      CREATE TABLE IF NOT EXISTS auto_activity (
        session_id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
        hidden INTEGER NOT NULL DEFAULT 0, label TEXT,
        created_at TEXT NOT NULL);
    `);
  }

  enabled() {
    return (this.monitor.db.query("SELECT value FROM site_activity_settings WHERE key='enabled'").get() as any)?.value === '1';
  }

  setEnabled(value: unknown, actor: string) {
    if (typeof value !== 'boolean') throw Error('invalid_activity');
    this.monitor.db.query("UPDATE site_activity_settings SET value=? WHERE key='enabled'").run(value ? '1' : '0');
    this.monitor.audit(actor, value ? 'activity.enable' : 'activity.pause', 'site');
    return { enabled: value };
  }

  // Run after projection and on startup so an already-running chat appears without a new event.
  reconcile(at = Date.now()) {
    const cutoff = new Date(at - STALE_MS).toISOString();
    const recent = this.monitor.db.query(`
      SELECT DISTINCT session_id FROM attempts
      WHERE status='streaming' OR updated_at>=?`).all(cutoff) as any[];
    const insert = this.monitor.db.query(
      'INSERT OR IGNORE INTO auto_activity(session_id,public_id,created_at) VALUES(?,?,?)',
    );
    for (const row of recent) {
      if (!this.phase(row.session_id, at)) continue;
      insert.run(row.session_id, randomBytes(16).toString('hex'), new Date(at).toISOString());
    }
  }

  private phase(sessionId: string, at = Date.now()) {
    const session = this.monitor.db.query('SELECT updated_at FROM sessions WHERE id=?').get(sessionId) as any;
    const last = this.monitor.db.query(
      'SELECT started_at,status FROM attempts WHERE session_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1',
    ).get(sessionId) as any;
    const running = this.monitor.db.query(
      "SELECT started_at FROM attempts WHERE session_id=? AND status='streaming' ORDER BY started_at DESC,rowid DESC LIMIT 1",
    ).get(sessionId) as any;
    if (!session || !last) return null;
    const age = at - Date.parse(session.updated_at);
    if (!Number.isFinite(age)) return null;
    const status = this.monitor.sessionStatus(sessionId, at);
    if (status === 'streaming' || status === 'waiting')
      return age <= STALE_MS ? { status: age > WAIT_MS ? 'waiting' : 'streaming', startedAt: running?.started_at || last.started_at } : null;
    if (age <= FINISH_MS)
      return { status: status === 'failed' ? 'failed' : 'completed', startedAt: last.started_at };
    return null;
  }

  private manualLive(sessionId: string) {
    return !!this.monitor.db.query(
      "SELECT 1 FROM broadcasts WHERE session_id=? AND visible=1 AND mode='live' LIMIT 1",
    ).get(sessionId);
  }

  private row(id: string) {
    return ID.test(id)
      ? this.monitor.db.query(`SELECT a.*,s.updated_at FROM auto_activity a
          JOIN sessions s ON s.id=a.session_id WHERE a.public_id=?`).get(id) as any
      : null;
  }

  private metadata(row: any, at = Date.now()) {
    const phase = this.phase(row.session_id, at);
    if (!phase) return null;
    return {
      id: row.public_id,
      kind: 'activity' as const,
      title: row.label ? sanitizePublicTitle(row.label) : `Сессия ${row.public_id.slice(0, 6)}`,
      customLabel: !!row.label,
      mode: 'live' as const,
      status: phase.status,
      startedAt: phase.startedAt,
      lastEventAt: row.updated_at,
      updatedAt: row.updated_at,
      durationMs: 0,
      loop: false,
      speed: 1,
      skipPauses: true,
      position: 0,
    };
  }

  list(at = Date.now()) {
    if (!this.enabled()) return [];
    const cutoff = new Date(at - FINISH_MS).toISOString();
    const rows = this.monitor.db.query(`SELECT a.*,s.updated_at FROM auto_activity a
      JOIN sessions s ON s.id=a.session_id
      WHERE a.hidden=0 AND (s.updated_at>=? OR EXISTS
        (SELECT 1 FROM attempts t WHERE t.session_id=a.session_id AND t.status='streaming'))
      ORDER BY s.updated_at DESC`).all(cutoff) as any[];
    return rows.filter(row => !this.manualLive(row.session_id))
      .map(row => this.metadata(row, at)).filter(Boolean);
  }

  public(id: string, at = Date.now()) {
    if (!this.enabled()) return null;
    const row = this.row(id);
    if (!row || row.hidden || this.manualLive(row.session_id)) return null;
    const metadata = this.metadata(row, at);
    if (!metadata) return null;
    const raw = this.monitor.db.query(`SELECT seq,at,type,body FROM events
      WHERE session_id=? AND at>=? ORDER BY seq DESC LIMIT 120`).all(row.session_id, metadata.startedAt) as any[];
    const events: { id: string; phase: Phase; at: string }[] = [];
    for (const event of raw.reverse()) {
      let phase: Phase | null = null;
      if (event.type === 'request.started') phase = 'started';
      else if (event.type === 'request.updated') {
        const status = JSON.parse(event.body).data?.status;
        if (status === 'completed') phase = 'completed';
        else if (['failed', 'cancelled', 'incomplete'].includes(status)) phase = 'failed';
      } else if (event.type === 'item.snapshot') {
        const data = JSON.parse(event.body).data;
        if (data?.kind === 'tool_call') phase = 'tool_started';
        else if (data?.kind === 'tool_result') phase = 'tool_finished';
        else if (data?.role === 'assistant') phase = 'answering';
      }
      if (phase && events.at(-1)?.phase !== phase)
        events.push({ id: this.monitor.hash(`${id}/${event.seq}`).slice(0, 16), phase, at: event.at });
    }
    const last = raw.at(-1)?.seq || 0;
    return {
      ...metadata,
      activity: events.slice(-20),
      items: [],
      cursor: this.monitor.hash(`${id}/${last}/${metadata.status}`),
    };
  }

  ownerList() {
    const rows = this.monitor.db.query(`SELECT a.*,s.updated_at FROM auto_activity a
      JOIN sessions s ON s.id=a.session_id ORDER BY s.updated_at DESC LIMIT 100`).all() as any[];
    return {
      enabled: this.enabled(),
      sessions: rows.map(row => ({
        sessionId: row.session_id,
        publicId: row.public_id,
        hidden: !!row.hidden,
        label: row.label,
        status: this.phase(row.session_id)?.status || 'quiet',
        lastEventAt: row.updated_at,
      })),
    };
  }

  updateSession(sessionId: string, body: any, actor: string) {
    if (!ID.test(sessionId) || !this.monitor.db.query('SELECT 1 FROM sessions WHERE id=?').get(sessionId))
      throw Error('not_found');
    if (body.hidden !== undefined && typeof body.hidden !== 'boolean') throw Error('invalid_activity');
    if (body.label !== undefined && body.label !== null &&
      (typeof body.label !== 'string' || body.label.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(body.label)))
      throw Error('invalid_activity');
    if (body.hidden === undefined && body.label === undefined) throw Error('invalid_activity');
    this.monitor.db.query('INSERT OR IGNORE INTO auto_activity(session_id,public_id,created_at) VALUES(?,?,?)')
      .run(sessionId, randomBytes(16).toString('hex'), new Date().toISOString());
    const row = this.monitor.db.query('SELECT * FROM auto_activity WHERE session_id=?').get(sessionId) as any;
    this.monitor.db.query('UPDATE auto_activity SET hidden=?,label=? WHERE session_id=?').run(
      body.hidden === undefined ? row.hidden : Number(body.hidden),
      body.label === undefined ? row.label : body.label?.trim() || null,
      sessionId,
    );
    this.monitor.audit(actor, 'activity.session.update', sessionId);
    return this.ownerList().sessions.find(row => row.sessionId === sessionId);
  }

  hideSession(sessionId: string, actor: string) {
    this.updateSession(sessionId, { hidden: true }, actor);
  }
}
