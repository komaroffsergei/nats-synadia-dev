import { randomBytes } from 'node:crypto';
import type { MonitorStore } from './store.ts';

const RECORD_LIMIT = 8 * 1024 * 1024;
const ARCHIVE_LIMIT = 128 * 1024 * 1024;
const idPattern = /^[a-f0-9]{32}$/;
const iso = (value: unknown) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw Error('invalid_range');
  return new Date(value).toISOString();
};

/** Explicit owner publications. No private session is automatically promoted. */
export class BroadcastStore {
  constructor(readonly monitor: MonitorStore) {
    monitor.db.exec(`
      CREATE TABLE IF NOT EXISTS broadcasts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL,
        mode TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
        start_at TEXT NOT NULL, end_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        options TEXT NOT NULL, recording TEXT, summary TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS broadcast_drafts (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, expires_at TEXT NOT NULL, body TEXT NOT NULL);
    `);
    const columns = monitor.db
      .query('PRAGMA table_info(broadcasts)')
      .all() as any[];
    if (!columns.some((column) => column.name === 'summary')) {
      monitor.db.exec(
        "ALTER TABLE broadcasts ADD COLUMN summary TEXT NOT NULL DEFAULT '{}'",
      );
      monitor.db.exec(
        "UPDATE broadcasts SET summary=json_object('model',json_extract(recording,'$.model'),'durationMs',json_extract(recording,'$.durationMs')) WHERE recording IS NOT NULL",
      );
    }
  }
  row(id: string, full = true) {
    return idPattern.test(id)
      ? (this.monitor.db
          .query(
            `SELECT ${full ? '*' : this.columns()} FROM broadcasts WHERE id=?`,
          )
          .get(id) as any)
      : null;
  }
  private columns() {
    return 'id,session_id,title,mode,visible,position,start_at,end_at,created_at,updated_at,options,summary,length(CAST(recording AS BLOB)) AS bytes';
  }
  item(scope: string, item: any) {
    const hash = (value: string) =>
      this.monitor.hash(`${scope}/${value}`).slice(0, 32);
    return {
      itemId: hash(item.itemId),
      kind: item.kind || 'message',
      role: item.role,
      name: item.name,
      text: item.text,
      at: item.at,
      complete: !!item.complete,
      truncated: !!item.truncated,
      groupId: item.groupId ? hash(item.groupId) : undefined,
      segment: item.segment,
    };
  }
  private replayCache = new Map<string, {key:string;row:any}>();
  captureIdle() {
    for(const row of this.monitor.db.query(`SELECT ${this.columns()} FROM broadcasts WHERE mode='live' AND visible=1 AND json_extract(options,'$.repeatWhenIdle')=1`).all() as any[])
      this.refreshReplay(row);
  }
  private idle(row:any) {
    const status=this.monitor.sessionStatus(row.session_id);
    const session=this.monitor.db.query('SELECT updated_at FROM sessions WHERE id=?').get(row.session_id) as any;
    return !['streaming','waiting'].includes(status) && Date.now()-Date.parse(session?.updated_at || '')>=15_000;
  }
  private refreshReplay(row:any) {
    if(!this.row(row.id,false) || row.mode!=='live' || !JSON.parse(row.options).repeatWhenIdle || !this.idle(row)) return row;
    const seq=(this.monitor.db.query('SELECT MAX(seq) seq FROM events WHERE session_id=?').get(row.session_id) as any)?.seq || 0;
    const key=`${row.updated_at}/${seq}`;
    const cached=this.replayCache.get(row.id);
    if(cached?.key===key) return cached.row;
    row=this.row(row.id) || row;
    let summary=JSON.parse(row.summary || '{}');
    if(summary.replayCursor!==seq) {
      try {
        const previous=row.recording ? JSON.parse(row.recording) : null;
        const end=new Date().toISOString();
        const next=this.record({...row,end_at:end,after_seq:summary.replayCursor || 0,prior:previous?.frames});
        if(previous?.frames?.length) {
          const seen=new Map(previous.frames.map((f:any)=>[f.item.itemId,f.item]));
          const extra=next.frames.filter((f:any)=>{
            const old:any=seen.get(f.item.itemId);seen.set(f.item.itemId,f.item);
            return old?.text!==f.item.text || old?.complete!==f.item.complete;
          });
          next.frames=[...previous.frames,...extra];
          next.partial=previous.partial || next.partial;
          next.durationMs=Date.parse(end)-Date.parse(row.start_at);
        }
        const recording=JSON.stringify(next);
        const used=(this.monitor.db.query('SELECT COALESCE(SUM(length(CAST(recording AS BLOB))),0) n FROM broadcasts WHERE id<>?').get(row.id) as any).n;
        if(Buffer.byteLength(recording)>RECORD_LIMIT || next.frames.length>6000) throw Error('recording_too_large');
        if(used+Buffer.byteLength(recording)>ARCHIVE_LIMIT) throw Error('archive_limit');
        row.recording=recording;
        summary={model:next.model,durationMs:next.durationMs,replayCursor:seq,capturedUntil:end};
      } catch(error) {
        const code=(error as Error).message;
        // A request/status event may arrive without a new text frame.
        summary={...summary,replayCursor:seq,replayError:code==='recording_unavailable' && row.recording ? null : code};
      }
      row.summary=JSON.stringify(summary);
      this.monitor.db.query('UPDATE broadcasts SET recording=?,summary=? WHERE id=?').run(row.recording,row.summary,row.id);
    }
    if(this.replayCache.size>=50) this.replayCache.clear();
    this.replayCache.set(row.id,{key,row});return row;
  }
  metadata(row: any, owner = false) {
    const recording = JSON.parse(row.summary || '{}');
    const repeat=!!JSON.parse(row.options).repeatWhenIdle;
    const replaying=row.mode==='live' && repeat && this.idle(row) && !recording.replayError && !!recording.capturedUntil;
    const session =
      row.mode === 'live'
        ? (this.monitor.db
            .query('SELECT model,status,updated_at FROM sessions WHERE id=?')
            .get(row.session_id) as any)
        : null;
    return {
      id: row.id,
      title: row.title,
      mode: !owner && replaying ? 'replay' : row.mode,
      configuredMode:row.mode,
      autoReplay:replaying,
      replayProblem:recording.replayError || null,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...JSON.parse(row.options),
      model: row.mode === 'replay' ? recording?.model : session?.model,
      status: row.mode === 'replay' || replaying ? 'recorded' : this.monitor.sessionStatus(row.session_id),
      lastEventAt: row.mode === 'replay' ? row.end_at : session?.updated_at,
      recordedAt: row.mode === 'replay' || replaying ? row.start_at : null,
      durationMs: recording?.durationMs || 0,
      ...(owner
        ? {
            sessionId: row.session_id,
            visible: !!row.visible,
            from: row.start_at,
            to: row.end_at,
            bytes:
              row.bytes ??
              (row.recording ? Buffer.byteLength(row.recording) : 0),
          }
        : {}),
    };
  }
  list(owner = false) {
    return (
      this.monitor.db
        .query(
          `SELECT ${this.columns()} FROM broadcasts ${owner ? '' : 'WHERE visible=1'} ORDER BY position,created_at,id`,
        )
        .all() as any[]
    ).map((row) => this.metadata(row, owner));
  }
  snapshot(row: any, before = 0) {
    row=this.refreshReplay(row);
    if (row.mode === 'replay' || this.metadata(row).autoReplay)
      return {
        ...this.metadata(row),
        ...JSON.parse(row.recording),
        cursor: this.monitor.hash(`${row.updated_at}/${JSON.parse(row.summary || '{}').replayCursor || ''}/replay`),
      };
    const snapshot = this.monitor.publicSnapshot(
      { session_id: row.session_id, start_at: row.start_at, expires_at: null },
      before,
    );
    return {
      ...this.metadata(row),
      items: snapshot?.items || [],
      partial: snapshot?.partial || false,
      hasOlder: snapshot?.hasOlder || false,
      oldest: snapshot?.oldest || 0,
      usage: snapshot?.usage || null,
      cursor: this.monitor.hash(`${row.updated_at}/${snapshot?.cursor || ''}/live/${this.metadata(row).replayProblem || ''}`),
      source: 'Codex proxy',
      // Re-scope even public item IDs to this publication; source identifiers stay private.
      ...(snapshot
        ? { items: snapshot.items.map((item: any) => this.item(row.id, item)) }
        : {}),
    };
  }
  public(id: string, before = 0) {
    const row = this.row(id);
    return row?.visible ? this.snapshot(row, before) : null;
  }
  range(sessionId: string) {
    if (!idPattern.test(sessionId) || !this.monitor.db.query('SELECT id FROM sessions WHERE id=?').get(sessionId))
      throw Error('not_found');
    const now = new Date().toISOString();
    const range = this.monitor.db.query(
      "SELECT MIN(at) firstAt,MAX(at) lastAt,COUNT(*) snapshots FROM events WHERE session_id=? AND type='item.snapshot' AND at<=?",
    ).get(sessionId, now) as any;
    return { ...range, serverNow: now };
  }
  prepare(body: any, actor: string) {
    if (
      !body ||
      !idPattern.test(body.sessionId || '') ||
      !['live', 'replay'].includes(body.mode)
    )
      throw Error('invalid_broadcast');
    const session = this.monitor.session(body.sessionId);
    if (!session) throw Error('not_found');
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (
      !title ||
      Array.from(title).length > 160 ||
      /[\u0000-\u001f\u007f]/.test(title)
    )
      throw Error('invalid_title');
    const now = new Date().toISOString(),
      from = iso(body.from),
      to = body.mode === 'replay' ? iso(body.to) : null;
    if (from > now || (to && (to <= from || to > now)))
      throw Error('invalid_range');
    if (body.fit !== undefined && (typeof body.fit !== 'boolean' || body.mode !== 'replay'))
      throw Error('invalid_broadcast');
    for (const key of ['loop', 'skipPauses', 'repeatWhenIdle'])
      if (body[key] !== undefined && typeof body[key] !== 'boolean')
        throw Error('invalid_broadcast');
    const speed = Number(body.speed ?? 1),
      position = Number(body.position ?? 0);
    if (
      ![0.5, 1, 2, 4].includes(speed) ||
      !Number.isInteger(position) ||
      position < 0 ||
      position > 999
    )
      throw Error('invalid_broadcast');
    const row: any = {
      id: randomBytes(16).toString('hex'),
      session_id: body.sessionId,
      title,
      mode: body.mode,
      visible: 0,
      position,
      start_at: from,
      end_at: to,
      created_at: now,
      updated_at: now,
      options: JSON.stringify({
        repeatWhenIdle: body.mode === 'live' && body.repeatWhenIdle === true,
        loop: body.loop !== false,
        speed,
        skipPauses: body.skipPauses !== false,
      }),
      recording: null,
      summary: '{}',
    };
    if (to) {
      let recorded;
      while (true) {
        try { recorded = this.record(row); break; }
        catch (error) {
          if (!body.fit || (error as Error).message !== 'recording_too_large') throw error;
          // Only an explicit fit request may shorten the owner's selected range.
          // Remove a quiet tail first, then keep the latter half of the fragment.
          const last = this.monitor.db.query(
            "SELECT MAX(at) at FROM events WHERE session_id=? AND type='item.snapshot' AND at>=? AND at<=?",
          ).get(row.session_id, row.start_at, row.end_at) as any;
          const end = Math.min(Date.parse(row.end_at), Math.ceil(Date.parse(last.at) / 1000) * 1000);
          const start = Date.parse(row.start_at);
          if (!Number.isFinite(end) || end - start <= 1000) throw error;
          row.end_at = new Date(end).toISOString();
          row.start_at = new Date(Math.min(end - 1000, Math.floor((start + end) / 2000) * 1000)).toISOString();
        }
      }
      row.recording = JSON.stringify(recorded);
      row.summary = JSON.stringify({
        model: recorded.model,
        durationMs: recorded.durationMs,
      });
    }
    const preview = this.snapshot(row);
    if (row.mode === 'live') {
      let page = preview;
      while (page.hasOlder) {
        page = this.snapshot(row, page.oldest);
        preview.items = [...page.items, ...preview.items];
        if (Buffer.byteLength(JSON.stringify(preview.items)) > RECORD_LIMIT)
          throw Error('recording_too_large');
      }
      if (Buffer.byteLength(JSON.stringify(preview.items)) > RECORD_LIMIT)
        throw Error('recording_too_large');
      preview.hasOlder = false;
    }
    const draftId = randomBytes(16).toString('hex');
    this.monitor.db
      .query('DELETE FROM broadcast_drafts WHERE expires_at<=?')
      .run(now);
    if (
      (
        this.monitor.db
          .query('SELECT COUNT(*) n FROM broadcast_drafts')
          .get() as any
      ).n >= 12
    )
      throw Error('draft_limit');
    this.monitor.db
      .query('INSERT INTO broadcast_drafts VALUES(?,?,?,?)')
      .run(
        draftId,
        actor,
        new Date(Date.now() + 900_000).toISOString(),
        JSON.stringify(row),
      );
    return {
      draftId,
      expiresInSeconds: 900,
      preview,
      config: this.metadata(row, true),
      adjusted: row.start_at !== from || row.end_at !== to,
    };
  }
  record(row: any) {
    const frames: any[] = [],
      seen = new Map<string, any>((row.prior || []).map((f:any)=>[f.item.itemId,f.item]));
    let bytes = 0,
      offset = 0;
    for (const raw of this.monitor.db
      .query(
        "SELECT at,body FROM events WHERE session_id=? AND at>=? AND at<=? AND seq>? AND type='item.snapshot' ORDER BY seq",
      )
      .iterate(row.session_id, row.start_at, row.end_at, row.after_seq || 0) as Iterable<any>) {
      const event = JSON.parse(raw.body),
        d = event.data;
      if (typeof d.text !== 'string' || typeof d.itemId !== 'string') continue;
      const scopedId=this.item(row.id,d).itemId;
      const old = seen.get(scopedId);
      if (
        old &&
        (d.context || (event.epoch === old.epoch && d.revision < old.revision))
      )
        continue;
      if (old?.text === d.text && old?.complete === d.complete) continue;
      seen.set(scopedId, { ...d, epoch: event.epoch });
      offset = Math.max(offset, Date.parse(raw.at) - Date.parse(row.start_at));
      const frame = {
        offsetMs: offset,
        item: this.item(row.id, { ...d, at: raw.at }),
      };
      bytes += Buffer.byteLength(JSON.stringify(frame));
      if (bytes > RECORD_LIMIT || frames.length >= 6000)
        throw Error('recording_too_large');
      frames.push(frame);
    }
    if (!frames.length) throw Error('recording_unavailable');
    // Record both final state and revisions: a recording survives the 24h text prune.
    const attempts = this.monitor.db
      .query(
        'SELECT DISTINCT model FROM attempts WHERE session_id=? AND started_at>=? AND started_at<=? AND model IS NOT NULL',
      )
      .all(row.session_id, row.start_at, row.end_at) as any[];
    const source = this.monitor.db
      .query('SELECT first_at,partial FROM sessions WHERE id=?')
      .get(row.session_id) as any;
    return {
      frames,
      durationMs: Math.max(
        1000,
        Date.parse(row.end_at) - Date.parse(row.start_at),
      ),
      model: attempts.map((a) => a.model).join(' · ') || null,
      partial: !!source?.partial || row.start_at > source?.first_at,
      source: 'Codex proxy',
      items: [],
    };
  }
  publish(draftId: string, actor: string) {
    return this.monitor.db.transaction(() => {
      const draft = this.monitor.db
        .query(
          'SELECT * FROM broadcast_drafts WHERE id=? AND actor=? AND expires_at>?',
        )
        .get(draftId, actor, new Date().toISOString()) as any;
      if (!draft) throw Error('preview_expired');
      const row = JSON.parse(draft.body);
      const used = Number(
        (
          this.monitor.db
            .query(
              'SELECT COALESCE(SUM(length(CAST(recording AS BLOB))),0) n FROM broadcasts',
            )
            .get() as any
        ).n,
      );
      if (
        used + Buffer.byteLength(row.recording || '') > ARCHIVE_LIMIT ||
        this.list(true).length >= 50
      )
        throw Error('archive_limit');
      this.monitor.db
        .query(
          'INSERT INTO broadcasts (id,session_id,title,mode,visible,position,start_at,end_at,created_at,updated_at,options,recording,summary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          row.id,
          row.session_id,
          row.title,
          row.mode,
          1,
          row.position,
          row.start_at,
          row.end_at,
          row.created_at,
          row.updated_at,
          row.options,
          row.recording,
          row.summary,
        );
      this.monitor.db
        .query('DELETE FROM broadcast_drafts WHERE id=?')
        .run(draftId);
      this.monitor.audit(actor, 'broadcast.publish', row.id);
      return this.metadata(this.row(row.id), true);
    })();
  }
  update(id: string, body: any, actor: string) {
    const row = this.row(id);
    if (!row) throw Error('not_found');
    const options = JSON.parse(row.options);
    if (body.visible !== undefined && typeof body.visible !== 'boolean')
      throw Error('invalid_broadcast');
    if (
      body.position !== undefined &&
      (!Number.isInteger(body.position) ||
        body.position < 0 ||
        body.position > 999)
    )
      throw Error('invalid_broadcast');
    if (body.speed !== undefined && ![0.5, 1, 2, 4].includes(body.speed))
      throw Error('invalid_broadcast');
    for (const key of ['loop', 'skipPauses', 'repeatWhenIdle'])
      if (body[key] !== undefined && typeof body[key] !== 'boolean')
        throw Error('invalid_broadcast');
    if(body.repeatWhenIdle && row.mode!=='live') throw Error('invalid_broadcast');
    for (const key of ['loop', 'speed', 'skipPauses', 'repeatWhenIdle'])
      if (body[key] !== undefined) options[key] = body[key];
    this.monitor.db
      .query(
        'UPDATE broadcasts SET visible=?,position=?,options=?,updated_at=? WHERE id=?',
      )
      .run(
        body.visible === undefined ? row.visible : Number(body.visible),
        body.position ?? row.position,
        JSON.stringify(options),
        new Date().toISOString(),
        id,
      );
    this.monitor.audit(
      actor,
      body.visible === false ? 'broadcast.hide' : 'broadcast.update',
      id,
    );
    return this.metadata(this.row(id), true);
  }
  remove(id: string, actor: string) {
    this.monitor.db.query('DELETE FROM broadcasts WHERE id=?').run(id);
    this.monitor.audit(actor, 'broadcast.delete', id);
  }
  prune() {
    this.monitor.db
      .query('DELETE FROM broadcast_drafts WHERE expires_at<=?')
      .run(new Date().toISOString());
  }
}
