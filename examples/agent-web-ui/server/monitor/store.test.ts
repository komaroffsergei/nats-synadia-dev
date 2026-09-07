import { test,expect,afterEach } from 'bun:test';
import { MonitorStore } from './store.ts';
import type { MonitorEvent } from './contracts.ts';
import { displayParts, userTitle } from '../../shared/monitor-display.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const stores:MonitorStore[]=[];
const create=()=>{const s=new MonitorStore(':memory:');stores.push(s);return s;};
afterEach(()=>{for(const s of stores.splice(0))s.db.close();});
let sequence=0;
const event=(type:string,data:Record<string,any>={},extra:Partial<MonitorEvent>={}):MonitorEvent=>{
 const n=++sequence;return {version:1,eventId:`event-${n}`,epoch:'epoch1',sequence:n,producer:'proxy',tenantId:'owner',connectionId:'proxy',sessionId:'session1',correlation:'explicit',at:new Date().toISOString(),requestId:'request1',attemptId:'attempt1',type,data,...extra};
};
test('redelivery commits once and usage snapshots replace, including downward correction',()=>{
 const s=create();const start=event('request.started',{model:'test'});s.apply(start);
 const u=event('usage.snapshot',{input:100,output:20,cached:40,reasoning:5,total:120,revision:1});s.apply(u);s.apply(u);
 expect(s.usage().total).toBe(120);
 s.apply(event('usage.snapshot',{input:80,output:10,cached:40,reasoning:5,total:90,revision:2}));expect(s.usage().total).toBe(90);
 expect(s.db.query('SELECT COUNT(*) n FROM events').get()).toEqual({n:3});
});
test('retry accounts a separate attempt; cached and reasoning are subsets',()=>{
 const s=create();s.apply(event('request.started'));
 s.apply(event('usage.snapshot',{input:100,output:20,cached:90,reasoning:10,total:120,revision:1}));
 s.apply(event('request.started',{retry:true},{attemptId:'attempt2'}));
 s.apply(event('usage.snapshot',{input:50,output:10,cached:20,reasoning:5,total:60,revision:1},{attemptId:'attempt2'}));
 expect(s.usage().total).toBe(180);expect(s.usage().cached).toBe(110);
});
test('missing usage stays unknown and conflicting revision is reported',()=>{
 const s=create();s.apply(event('request.started'));expect(s.usage().unknown).toBe(1);
 s.apply(event('usage.snapshot',{input:10,output:2,total:12,revision:1}));expect(s.usage().quality).toBe('partial');
 s.apply(event('usage.snapshot',{input:11,output:2,total:13,revision:1}));expect(s.usage().quality).toBe('conflict');
});
test('same session identifier in different tenants remains isolated',()=>{
 const s=create();const a=event('request.started');s.apply(a);
 const b=event('request.started',{},{tenantId:'other',attemptId:'other-attempt'});s.apply(b);
 expect(s.sessions().length).toBe(2);expect(s.scopeId(a)).not.toBe(s.scopeId(b));
});
test('text snapshot replaces and replay does not duplicate output',()=>{
 const s=create();const a=event('item.snapshot',{itemId:'m1',kind:'message',text:'Hello',revision:1});s.apply(a);
 s.apply(event('item.snapshot',{itemId:'m1',kind:'message',text:'Hello world',revision:2}));s.apply(a);
 expect(s.session(s.scopeId(a))?.items.map((i:any)=>i.text)).toEqual(['Hello world']);
});
test('share only selected session; revoke disables token and discoverable link',()=>{
 const s=create();const a=event('item.snapshot',{itemId:'one',kind:'message',role:'user',text:'Allowed',revision:1});s.apply(a);
 s.apply(event('item.snapshot',{itemId:'two',text:'Private',revision:1},{sessionId:'private'}));
 const sh=s.createShare(s.scopeId(a),'1970-01-01T00:00:00.000Z',24,'owner');
 expect(s.publicSessions()).toHaveLength(1);expect(s.share(sh.token)).toBeTruthy();
 const snapshot=JSON.stringify(s.publicSnapshot(s.share(sh.token)));expect(snapshot).toContain('Allowed');expect(snapshot).not.toContain('Private');expect(snapshot).not.toContain('tenant');
 s.revoke(sh.id,'owner');expect(s.share(sh.token)).toBeFalsy();expect(s.publicShareById(sh.id)).toBeFalsy();expect(s.publicSessions()).toHaveLength(0);
});
test('retention deletes text but keeps token ledger with visible partial history',()=>{
 const s=create();const at=new Date(Date.now()-48*3600_000).toISOString();
 const a=event('item.snapshot',{itemId:'old',text:'Must expire',revision:1},{at});s.apply(a);
 s.apply(event('usage.snapshot',{input:10,output:2,total:12,revision:1},{at}));s.prune();
 expect(s.session(s.scopeId(a))?.items).toHaveLength(0);expect(s.session(s.scopeId(a))?.partial).toBe(1);expect(s.usage().total).toBe(12);
});
test('new response completion does not claim agent job completion',()=>{
 const s=create();const a=event('request.started');s.apply(a);s.apply(event('request.updated',{status:'completed'}));
 expect(s.session(s.scopeId(a))?.status).toBe('quiet');
});

test('history pages preserve every item and start-time publication excludes old title',()=>{
 const s=create();const old=new Date(Date.now()-3600_000).toISOString();
 const a=event('item.snapshot',{itemId:'private-title',role:'user',text:'EARLIER PRIVATE TITLE',revision:1},{at:old});s.apply(a);
 for(let i=0;i<100;i++)s.apply(event('item.snapshot',{itemId:`new-${i}`,kind:'message',text:`Line ${i}`,revision:1}));
 const id=s.scopeId(a),page=s.session(id)!;
 expect(page.items).toHaveLength(80);expect(page.hasOlder).toBe(true);
 const earlier=s.session(id,undefined,page.oldest)!;expect(earlier.items).toHaveLength(21);expect(earlier.hasOlder).toBe(false);
 const sh=s.createShare(id,new Date(Date.now()-600_000).toISOString(),24,'owner');
 expect(JSON.stringify(s.publicSnapshot(s.share(sh.token)))).not.toContain('EARLIER PRIVATE TITLE');
 expect(JSON.stringify(s.publicSessions())).not.toContain('EARLIER PRIVATE TITLE');
});
test('proxy restart ends orphan request status without inventing task completion',()=>{
 const s=create();const old=event('request.started',{}, {at:'2026-09-07T10:00:00.000Z'});s.apply(old);
 s.apply(event('source.status',{epochStartedAt:'2026-09-07T11:00:00.000Z'},{epoch:'epoch2',at:'2026-09-07T11:00:01.000Z'}));
 const session=s.session(s.scopeId(old))!;
 expect(session.status).toBe('quiet');expect(session.partial).toBe(1);expect((session.attempts[0] as any).status).toBe('incomplete');
});
test('public cursor does not expose activity from a private session',()=>{
 const s=create();const a=event('item.snapshot',{itemId:'m',text:'Public',revision:1});s.apply(a);
 const sh=s.createShare(s.scopeId(a),'1970-01-01T00:00:00.000Z',1,'owner'),share=s.share(sh.token);
 const before=s.publicCursor(share);
 s.apply(event('item.snapshot',{itemId:'secret',text:'Private',revision:1},{sessionId:'private'}));
 expect(s.publicCursor(share)).toBe(before);
 s.apply(event('item.snapshot',{itemId:'m',text:'New public text',revision:2}));
 expect(s.publicCursor(share)).not.toBe(before);
});

test('service wrappers stay intact, while a mixed user request supplies the title',()=>{
 const text='<recommended_plugins>\nPlugin list\n</recommended_plugins>\n<environment_context>cwd</environment_context>\n\n## My request:\nПроверь связь';
 const parts=displayParts({role:'user',text});
 expect(parts.map(p=>p.text).join('')).toBe(text);
 expect(parts.filter(p=>p.context)).toHaveLength(2);
 expect(userTitle(text)).toBe('Проверь связь');
 expect(displayParts({role:'assistant',text})).toEqual([{text,context:false}]);
 const s=create(),a=event('item.snapshot',{itemId:'ctx',role:'user',text:'<environment_context>cwd</environment_context>'});s.apply(a);
 s.apply(event('item.snapshot',{itemId:'request',role:'user',text,context:true}));
 expect(s.session(s.scopeId(a))?.requestPreview).toBe('Проверь связь');
 expect(s.session(s.scopeId(a))?.items.map((i:any)=>i.text)).toContain(text);
});

test('title generation is a labelled service activity, never inferred from a model or merged by title',()=>{
 const prompt='You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task. The title you generate will be shown in the UI to represent the prompt.';
 const s=create(),a=event('item.snapshot',{itemId:'ctx',role:'user',text:'<environment_context>cwd</environment_context>'});s.apply(a);
 s.apply(event('item.snapshot',{itemId:'prompt',role:'user',text:prompt}));
 s.apply(event('item.snapshot',{itemId:'reply',role:'assistant',text:'{"title":"Проверить связь"}',complete:true}));
 expect(s.session(s.scopeId(a))?.activity).toBe('title_generation');
 expect(s.session(s.scopeId(a))?.requestPreview).toBe('Название чата: Проверить связь');
 expect(displayParts({role:'user',text:prompt})).toEqual([{text:prompt,context:true}]);
 const other=event('item.snapshot',{itemId:'prompt',role:'user',text:'Проверь связь'},{sessionId:'other'});s.apply(other);
 expect(s.sessions()).toHaveLength(2);expect(s.session(s.scopeId(other))?.activity).toBe('conversation');
});

test('public title skips service context and respects publication start time',()=>{
 const s=create(),old='2026-09-07T10:00:00.000Z',now='2026-09-07T11:00:00.000Z';
 const a=event('item.snapshot',{itemId:'old',role:'user',text:'Private title'},{at:old});s.apply(a);
 s.apply(event('item.snapshot',{itemId:'ctx',role:'user',text:'<environment_context>Private workspace</environment_context>'},{at:now}));
 s.apply(event('item.snapshot',{itemId:'current',role:'user',text:'Публичный вопрос'},{at:now}));
 const snapshot=s.publicSnapshot({session_id:s.scopeId(a),start_at:now});
 expect(snapshot!.title).toBe('Чат без названия');
 expect(JSON.stringify(snapshot)).not.toContain('Private title');
 expect(JSON.stringify(snapshot)).toContain('Публичный вопрос');
});

test('existing history is relabelled once on upgrade without changing items or usage',()=>{
 const dir=mkdtempSync(join(tmpdir(),'monitor-display-test-')),path=join(dir,'test.sqlite');
 let s=new MonitorStore(path);
 try {
  const a=event('item.snapshot',{itemId:'ctx',role:'user',text:'<recommended_plugins>Tools</recommended_plugins>'});s.apply(a);
  s.apply(event('item.snapshot',{itemId:'prompt',role:'user',text:'Проверь связь'}));
  s.apply(event('usage.snapshot',{input:100,output:20,total:120,revision:1}));
  const id=s.scopeId(a),before=s.session(id)!.items;
  s.db.exec("DELETE FROM state WHERE key='displayVersion'; UPDATE sessions SET title='<recommended_plugins>Tools</recommended_plugins>'");
  s.db.close();s=new MonitorStore(path);
  expect(s.session(id)!.requestPreview).toBe('Проверь связь');expect(s.session(id)!.items).toEqual(before);expect(s.usage().total).toBe(120);
  expect(s.state('displayVersion')).toBe(1);
 } finally {s.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('public items have distinct share-scoped identities even at the same timestamp',()=>{
 const s=create(),at=new Date().toISOString();
 const a=event('item.snapshot',{itemId:'original-context',role:'user',text:'<environment_context>cwd</environment_context>'},{at});s.apply(a);
 s.apply(event('item.snapshot',{itemId:'original-request',role:'user',text:'Проверь связь'},{at}));
 const first=s.createShare(s.scopeId(a),'1970-01-01T00:00:00.000Z',1,'owner');
 const second=s.createShare(s.scopeId(a),'1970-01-01T00:00:00.000Z',1,'owner');
 const items=s.publicSnapshot(s.share(first.token))!.items;
 expect(new Set(items.map((i:any)=>i.itemId)).size).toBe(2);
 expect(items[0].itemId).not.toBe(s.publicSnapshot(s.share(second.token))!.items[0].itemId);
 expect(JSON.stringify(items)).not.toContain('original-');
});

test('manual title wins over later proxy events, is searchable and never changes text or usage',()=>{
 const s=create(),a=event('item.snapshot',{itemId:'prompt',role:'user',text:'First prompt'});s.apply(a);
 s.apply(event('usage.snapshot',{input:100,output:20,total:120,revision:1}));
 const id=s.scopeId(a),items=s.session(id)!.items,cursor=s.cursor();
 expect(s.session(id)!.title).toBe('Чат без названия');expect(s.session(id)!.requestPreview).toBe('First prompt');
 s.rename(id,'Проверить связь с Кодексом','owner');
 expect(s.session(id)!.title).toBe('Проверить связь с Кодексом');expect(s.session(id)!.items).toEqual(items);expect(s.usage().total).toBe(120);expect(s.cursor()).toBe(cursor);
 s.apply(event('item.snapshot',{itemId:'next',role:'user',text:'Another prompt'}));
 expect(s.session(id)!.title).toBe('Проверить связь с Кодексом');expect(s.sessions('Проверить связь')).toHaveLength(1);
 s.rename(id,null,'owner');expect(s.session(id)!.title).toBe('Чат без названия');expect(s.session(id)!.customTitle).toBeNull();
 for(const value of ['', ' ', 123, undefined, 'a'.repeat(161), 'line\nbreak'])expect(()=>s.rename(id,value,'owner')).toThrow('invalid_title');
});

test('manual name survives reopening and stays within its session',()=>{
 const dir=mkdtempSync(join(tmpdir(),'monitor-title-test-')),path=join(dir,'test.sqlite');let s=new MonitorStore(path);
 try {
  const a=event('request.started');s.apply(a);const id=s.scopeId(a);
  const b=event('request.started',{},{sessionId:'other',attemptId:'other'});s.apply(b);
  s.rename(id,'Мой чат','owner');s.db.close();s=new MonitorStore(path);
  expect(s.session(id)!.title).toBe('Мой чат');expect(s.session(s.scopeId(b))!.title).toBe('Чат без названия');
 } finally {s.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('publication captures the chosen name and a later private rename does not leak to visitors',()=>{
 const s=create(),a=event('item.snapshot',{itemId:'prompt',role:'user',text:'Some prompt'});s.apply(a);const id=s.scopeId(a);
 s.rename(id,'Название для публикации','owner');const sh=s.createShare(id,'1970-01-01T00:00:00.000Z',1,'owner'),share=s.share(sh.token);
 const cursor=s.publicCursor(share);s.rename(id,'Новое частное название','owner');
 expect(s.publicSnapshot(share)!.title).toBe('Название для публикации');expect(s.publicSessions()[0].title).toBe('Название для публикации');expect(s.publicCursor(share)).toBe(cursor);
 expect(s.publicSnapshot({session_id:id,start_at:'1970-01-01T00:00:00.000Z'})!.title).toBe('Новое частное название');
 expect(JSON.stringify(s.publicSnapshot(share))).not.toContain('Новое частное название');
});
