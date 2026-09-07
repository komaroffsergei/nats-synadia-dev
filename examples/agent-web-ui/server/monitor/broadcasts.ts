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
  metadata(row: any, owner = false) {
    const recording = JSON.parse(row.summary || '{}');
    const session =
      row.mode === 'live'
        ? (this.monitor.db
            .query('SELECT model,status,updated_at FROM sessions WHERE id=?')
            .get(row.session_id) as any)
        : null;
    return {
      id: row.id,
      title: row.title,
      mode: row.mode,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...JSON.parse(row.options),
      model: row.mode === 'replay' ? recording?.model : session?.model,
      status: row.mode === 'replay' ? 'recorded' : session?.status || 'quiet',
      lastEventAt: row.mode === 'replay' ? row.end_at : session?.updated_at,
      recordedAt: row.mode === 'replay' ? row.start_at : null,
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
    if (row.mode === 'replay')
      return {
        ...this.metadata(row),
        ...JSON.parse(row.recording),
        cursor: row.updated_at,
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
      cursor: this.monitor.hash(`${row.updated_at}/${snapshot?.cursor || ''}`),
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
    for (const key of ['loop', 'skipPauses'])
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
        loop: body.loop !== false,
        speed,
        skipPauses: body.skipPauses !== false,
      }),
      recording: null,
      summary: '{}',
    };
    if (to) {
      const recorded = this.record(row);
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
    };
  }
  record(row: any) {
    const frames: any[] = [],
      seen = new Map<string, any>();
    let bytes = 0,
      offset = 0;
    for (const raw of this.monitor.db
      .query(
        "SELECT at,body FROM events WHERE session_id=? AND at>=? AND at<=? AND type='item.snapshot' ORDER BY seq",
      )
      .iterate(row.session_id, row.start_at, row.end_at) as Iterable<any>) {
      const event = JSON.parse(raw.body),
        d = event.data;
      if (typeof d.text !== 'string' || typeof d.itemId !== 'string') continue;
      const old = seen.get(d.itemId);
      if (
        old &&
        (d.context || (event.epoch === old.epoch && d.revision < old.revision))
      )
        continue;
      if (old?.text === d.text && old?.complete === d.complete) continue;
      seen.set(d.itemId, { ...d, epoch: event.epoch });
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
    for (const key of ['loop', 'skipPauses'])
      if (body[key] !== undefined && typeof body[key] !== 'boolean')
        throw Error('invalid_broadcast');
    for (const key of ['loop', 'speed', 'skipPauses'])
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
