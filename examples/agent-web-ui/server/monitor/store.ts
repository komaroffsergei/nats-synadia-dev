import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateEvent, usageQuality, type MonitorEvent } from './contracts.ts';

export class MonitorStore {
  db: Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO schema_version VALUES(1);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id,seq);
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, connection TEXT NOT NULL, correlation TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', model TEXT, first_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'quiet', partial INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, request_id TEXT NOT NULL, session_id TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, model TEXT, transport TEXT, response_id TEXT, http_status INTEGER, duration_ms INTEGER, error TEXT, retry INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS attempts_session ON attempts(session_id,started_at);
      CREATE TABLE IF NOT EXISTS items(session_id TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session_id,id));
      CREATE INDEX IF NOT EXISTS items_at ON items(at);
      CREATE TABLE IF NOT EXISTS usage(attempt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at TEXT NOT NULL, revision INTEGER NOT NULL, epoch TEXT NOT NULL, quality TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,start_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,scope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS producers(key TEXT PRIMARY KEY,sequence INTEGER NOT NULL);
    `);
  }

  apply(event: MonitorEvent) {
    validateEvent(event);
    return this.db.transaction(() => {
      const exists = this.db.query('SELECT seq FROM events WHERE event_id=?').get(event.eventId);
      if (exists) return false;
      const sid = this.scopeId(event);
      const d = event.data;
      this.db.query(`INSERT INTO sessions(id,tenant,connection,correlation,first_at,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET updated_at=MAX(updated_at,excluded.updated_at)`).run(sid, event.tenantId, event.connectionId, event.correlation, event.at, event.at);
      const producerKey = `${event.producer}:${event.epoch}`;
      const prev = this.db.query('SELECT sequence FROM producers WHERE key=?').get(producerKey) as any;
      if (prev && event.sequence > prev.sequence + 1) {
        this.db.query('UPDATE sessions SET partial=1 WHERE id=?').run(sid);
        this.setState('sequenceGap', { at: event.at, from: prev.sequence, to: event.sequence });
      }
      this.db.query('INSERT INTO producers VALUES(?,?) ON CONFLICT(key) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)').run(producerKey, event.sequence);
      const result = this.db.query('INSERT INTO events(event_id,session_id,at,type,body) VALUES(?,?,?,?,?)').run(event.eventId, sid, event.at, event.type, JSON.stringify(event));
      const seq = Number(result.lastInsertRowid);
      if (event.type === 'delivery.gap') this.db.query('UPDATE sessions SET partial=1 WHERE id=?').run(sid);
      if (event.type === 'source.status') {
        this.setState('source', { ...d, at: event.at });
        if (d.deliveryDropped > 0) this.db.query('UPDATE sessions SET partial=1 WHERE tenant=?').run(event.tenantId);
      }
      if (event.type === 'request.started' && event.attemptId && event.requestId) {
        this.db.query(`INSERT OR IGNORE INTO attempts(id,request_id,session_id,started_at,updated_at,status,model,transport,retry) VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(event.attemptId,event.requestId,sid,event.at,event.at,'streaming',d.model ?? null,d.transport ?? null,d.retry ? 1 : 0);
        this.db.query('UPDATE sessions SET status=?,model=COALESCE(?,model) WHERE id=?').run('streaming',d.model ?? null,sid);
      }
      if (event.type === 'request.updated' && event.attemptId) {
        this.db.query(`UPDATE attempts SET updated_at=?,status=COALESCE(?,status),model=COALESCE(?,model),response_id=COALESCE(?,response_id),http_status=COALESCE(?,http_status),duration_ms=COALESCE(?,duration_ms),error=COALESCE(?,error) WHERE id=? AND session_id=?`)
          .run(event.at,d.status ?? null,d.model ?? null,d.responseId ?? null,d.httpStatus ?? null,d.durationMs ?? null,d.error ?? null,event.attemptId,sid);
        if (d.model) this.db.query('UPDATE sessions SET model=? WHERE id=?').run(d.model,sid);
        const active = this.db.query("SELECT COUNT(*) n FROM attempts WHERE session_id=? AND status='streaming'").get(sid) as any;
        this.db.query('UPDATE sessions SET status=? WHERE id=?').run(active.n ? 'streaming' : 'quiet', sid);
      }
      if (event.type === 'item.snapshot' && typeof d.text === 'string' && typeof d.itemId === 'string') {
        // Context in subsequent requests does not replace the original streamed item.
        const previous = this.db.query('SELECT body,seq,at FROM items WHERE session_id=? AND id=?').get(sid,d.itemId) as any;
        const old = previous ? JSON.parse(previous.body) : null;
        if (!old || !d.context && (event.epoch === old.epoch ? d.revision >= old.revision : event.at >= previous.at)) {
          const item = { ...d, epoch: event.epoch, requestId: event.requestId, attemptId: event.attemptId };
          this.db.query(`INSERT INTO items VALUES(?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET body=excluded.body`)
            .run(sid,d.itemId,seq,event.at,JSON.stringify(item));
          if (d.complete && d.groupId && Number.isInteger(d.segments)) this.db.query("DELETE FROM items WHERE session_id=? AND json_extract(body,'$.groupId')=? AND json_extract(body,'$.segment')>=?").run(sid,d.groupId,d.segments);
        }
        if (d.role === 'user' && !d.segment) this.db.query("UPDATE sessions SET title=? WHERE id=? AND title=''").run(d.text.replace(/\s+/g,' ').slice(0,140),sid);
        if (d.truncated) this.db.query('UPDATE sessions SET partial=1 WHERE id=?').run(sid);
      }
      if (event.type === 'usage.snapshot' && event.attemptId) {
        const previous = this.db.query('SELECT * FROM usage WHERE attempt_id=?').get(event.attemptId) as any;
        const quality = usageQuality(d);
        if (!previous || event.epoch !== previous.epoch || d.revision > previous.revision) {
          this.db.query(`INSERT INTO usage VALUES(?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET revision=excluded.revision,epoch=excluded.epoch,quality=excluded.quality,body=excluded.body`)
            .run(event.attemptId,sid,event.at,d.revision ?? 1,event.epoch,quality,JSON.stringify(d));
        } else if (d.revision === previous.revision && JSON.stringify(d) !== previous.body) this.db.query("UPDATE usage SET quality='conflict' WHERE attempt_id=?").run(event.attemptId);
      }
      this.setState('projector', { at: new Date().toISOString(), lastEventAt: event.at, seq });
      return true;
    })();
  }

  scopeId(event: MonitorEvent) { return createHash('sha256').update(`${event.tenantId}/${event.connectionId}/${event.sessionId}`).digest('hex').slice(0,32); }
  cursor() { return Number((this.db.query('SELECT COALESCE(MAX(seq),0) n FROM events').get() as any).n); }
  setState(key: string, value: unknown) { this.db.query('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key,JSON.stringify(value)); }
  state(key: string) { const r = this.db.query('SELECT body FROM state WHERE key=?').get(key) as any; return r ? JSON.parse(r.body) : null; }

  usage(sessionId?: string, from?: string, detail = true) {
    const rows = this.db.query(`SELECT u.*,a.model FROM usage u LEFT JOIN attempts a ON a.id=u.attempt_id WHERE (? IS NULL OR u.session_id=?) AND (? IS NULL OR u.at>=?) ORDER BY u.at`)
      .all(sessionId ?? null,sessionId ?? null,from ?? null,from ?? null) as any[];
    const total = { input: 0, output: 0, cached: 0, reasoning: 0, total: 0, unknown: 0, conflicts: 0, partial: 0 };
    const buckets: Record<string, any> = {};
    for (const row of rows) {
      const d = JSON.parse(row.body);
      if (row.quality === 'conflict') { total.conflicts++; continue; }
      if (row.quality === 'partial') total.partial++;
      for (const key of ['input','output','cached','reasoning'] as const) total[key] += d[key] ?? 0;
      const t = d.input != null && d.output != null ? d.input + d.output : d.total ?? 0;
      total.total += t;
      const key = row.at.slice(0,13) + ':00:00Z';
      const bucket = buckets[key] ||= { at: key, input: 0, output: 0, total: 0 };
      bucket.input += d.input ?? 0; bucket.output += d.output ?? 0; bucket.total += t;
    }
    total.unknown = Number((this.db.query(`SELECT COUNT(*) n FROM attempts a LEFT JOIN usage u ON a.id=u.attempt_id WHERE u.attempt_id IS NULL AND (? IS NULL OR a.session_id=?) AND (? IS NULL OR a.started_at>=?)`)
      .get(sessionId ?? null,sessionId ?? null,from ?? null,from ?? null) as any).n);
    return { ...total, quality: total.conflicts ? 'conflict' : total.partial || total.unknown ? 'partial' : 'complete', buckets: Object.values(buckets),
      attempts: detail ? rows.slice(-1000).reverse().map(r => ({ attemptId:r.attempt_id, at:r.at, model:r.model, quality:r.quality,...JSON.parse(r.body) })) : [], attemptsTotal:rows.length };
  }

  sessions(search = '', before = '', limit = 100) {
    return (this.db.query(`SELECT * FROM sessions WHERE (title LIKE ? OR model LIKE ?) AND (?='' OR updated_at||id < ?) ORDER BY updated_at DESC,id DESC LIMIT ?`)
      .all(`%${search}%`,`%${search}%`,before,before,Math.min(limit,100)) as any[]).map(s => ({ ...s, usage: this.usage(s.id,undefined,false), shared: this.shares(s.id).some(x => !x.revoked_at && x.expires_at > new Date().toISOString()) }));
  }
  session(id: string, from?: string, before = Number.MAX_SAFE_INTEGER) {
    const s = this.db.query('SELECT * FROM sessions WHERE id=?').get(id) as any;
    if (!s) return null;
    const items = (this.db.query('SELECT * FROM items WHERE session_id=? AND (? IS NULL OR at>=?) AND seq<? ORDER BY seq DESC LIMIT 80').all(id,from ?? null,from ?? null,before) as any[]).reverse()
      .map(r => ({ ...JSON.parse(r.body), at:r.at, seq:r.seq }));
    const attempts = this.db.query('SELECT * FROM attempts WHERE session_id=? AND (? IS NULL OR started_at>=?) ORDER BY started_at DESC LIMIT 300').all(id,from ?? null,from ?? null);
    const oldest=items[0]?.seq;
    const hasOlder=oldest ? !!this.db.query('SELECT 1 FROM items WHERE session_id=? AND (? IS NULL OR at>=?) AND seq<? LIMIT 1').get(id,from ?? null,from ?? null,oldest) : false;
    return { ...s, items, hasOlder, oldest, attempts, usage:this.usage(id,from,false), cursor:this.cursor() };
  }
  events(id: string, after = 0, from?: string) {
    return (this.db.query('SELECT * FROM events WHERE session_id=? AND seq>? AND (? IS NULL OR at>=?) ORDER BY seq LIMIT 500').all(id,after,from ?? null,from ?? null) as any[])
      .map(r => ({ seq:r.seq,...JSON.parse(r.body) }));
  }
  shares(id: string) { return this.db.query('SELECT id,session_id,start_at,expires_at,revoked_at,created_at FROM shares WHERE session_id=? ORDER BY created_at DESC').all(id) as any[]; }
  createShare(sessionId: string, from: string, hours: number, actor: string) {
    if (!this.session(sessionId)) throw Error('not_found');
    if (!Number.isFinite(hours) || hours < 1 || hours > 168 || !Number.isFinite(Date.parse(from)) || Date.parse(from) > Date.now()) throw Error('invalid_share');
    const token = randomBytes(32).toString('base64url'); const id = randomBytes(16).toString('hex');
    const now = new Date().toISOString(), expiry = new Date(Date.now()+hours*3_600_000).toISOString();
    this.db.query('INSERT INTO shares VALUES(?,?,?,?,?,?,?)').run(id,this.hash(token),sessionId,from,expiry,null,now);
    this.audit(actor,'share.create',id);
    return { id,token,expiresAt:expiry };
  }
  hash(token:string) { return createHash('sha256').update(token).digest('hex'); }
  share(token:string) { return this.db.query('SELECT * FROM shares WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(this.hash(token),new Date().toISOString()) as any; }
  revoke(id:string,actor:string) { this.db.query('UPDATE shares SET revoked_at=? WHERE id=?').run(new Date().toISOString(),id);this.audit(actor,'share.revoke',id); }
  audit(actor:string,action:string,scope:string) { this.db.query('INSERT INTO audit(at,actor,action,scope) VALUES(?,?,?,?)').run(new Date().toISOString(),actor,action,scope); }
  publicSessions() {
    const rows = this.db.query('SELECT s.id,s.title,s.model,s.updated_at FROM sessions s WHERE EXISTS(SELECT 1 FROM shares sh WHERE sh.session_id=s.id AND sh.revoked_at IS NULL AND sh.expires_at>?) ORDER BY s.updated_at DESC').all(new Date().toISOString()) as any[];
    // Public discovery uses safe share IDs, never raw tokens or private session IDs.
    return rows.map(s => {
      const share = this.db.query('SELECT id,start_at FROM shares WHERE session_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1').get(s.id,new Date().toISOString()) as any;
      return { id:share.id,title:this.publicTitle(s.id,share.start_at),model:s.model,updatedAt:s.updated_at };
    });
  }
  publicShareById(id:string) { return this.db.query('SELECT * FROM shares WHERE id=? AND revoked_at IS NULL AND expires_at>?').get(id,new Date().toISOString()) as any; }
  publicTitle(id:string,from:string) {
    const r=this.db.query("SELECT body FROM items WHERE session_id=? AND at>=? AND json_extract(body,'$.role')='user' ORDER BY seq LIMIT 1").get(id,from) as any;
    return r ? JSON.parse(r.body).text.replace(/\s+/g,' ').slice(0,140) : 'Рабочая сессия Codex';
  }
  publicSnapshot(share:any,before = Number.MAX_SAFE_INTEGER) {
    const s = this.session(share.session_id,share.start_at,before);
    if (!s) return null;
    const { model,status,updated_at,items,usage,partial,cursor,oldest,hasOlder } = s;
    return { title:this.publicTitle(share.session_id,share.start_at),model,status,updated_at,partial,cursor,oldest,hasOlder,expiresAt:share.expires_at,
      items:items.map(({ kind,role,name,text,at,complete,truncated,segment,groupId }:any) => ({ kind,role,name,text,at,complete,truncated,segment,groupId })),
      usage:{ input:usage.input,output:usage.output,total:usage.total,cached:usage.cached,reasoning:usage.reasoning,quality:usage.quality,buckets:usage.buckets } };
  }
  prune(now=Date.now()) {
    const textCutoff = new Date(now-24*3_600_000).toISOString(), ledgerCutoff = new Date(now-90*86400_000).toISOString();
    this.db.transaction(() => {
      this.db.query('UPDATE sessions SET partial=1 WHERE id IN (SELECT DISTINCT session_id FROM items WHERE at<?)').run(textCutoff);
      this.db.query('DELETE FROM events WHERE at<?').run(textCutoff);
      this.db.query('DELETE FROM items WHERE at<?').run(textCutoff);
      this.db.query('DELETE FROM usage WHERE at<?').run(ledgerCutoff);
      this.db.query('DELETE FROM attempts WHERE updated_at<?').run(ledgerCutoff);
      this.db.query('DELETE FROM sessions WHERE updated_at<?').run(ledgerCutoff);
    })();
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }
}
