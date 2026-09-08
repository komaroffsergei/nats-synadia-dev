import {test,expect} from 'bun:test';
import {MonitorStore} from './store';
import {BroadcastStore} from './broadcasts';

test('session status follows concurrent attempts, errors and silence without claiming task completion',()=>{
 const s=new MonitorStore(':memory:');let n=0;
 const push=(type:string,data:any={},attemptId='a',at=new Date().toISOString())=>{
  const e:any={version:1,eventId:`e${++n}`,sequence:n,epoch:'epoch',producer:'proxy',tenantId:'user',connectionId:'proxy',sessionId:'session',correlation:'explicit',requestId:attemptId,attemptId,at,type,data};s.apply(e);return s.scopeId(e);
 };
 try {
  const id=push('request.started');push('request.started',{},'b');
  expect(s.session(id)!.status).toBe('streaming');
  push('request.updated',{status:'failed'});expect(s.session(id)!.status).toBe('streaming');
  push('request.updated',{status:'completed'},'b');expect(s.session(id)!.status).toBe('completed');
  push('request.started',{},'c');expect(s.sessionStatus(id,Date.now()+91_000)).toBe('waiting');
  push('request.updated',{status:'incomplete'},'c');expect(s.session(id)!.status).toBe('incomplete');
 } finally {s.db.close();}
});

test('owner sees proxy user/config; default first message and rename persist; public does not leak sources',()=>{
 const s=new MonitorStore(':memory:');let n=0;
 const push=(type:string,data:any)=>{const e:any={version:1,eventId:`e${++n}`,sequence:n,epoch:'e',producer:'proxy',tenantId:'tenant',connectionId:'proxy',sessionId:'session',correlation:'explicit',at:new Date().toISOString(),type,data};s.apply(e);return s.scopeId(e);};
 try {
  const id=push('source.status',{userLabel:'owner-example',configId:'config-example'});
  push('item.snapshot',{itemId:'first',role:'user',text:'Проверь импорт',revision:1});
  push('item.snapshot',{itemId:'second',role:'user',text:'Теперь проверь карту',revision:1});
  expect(s.session(id)!.title).toBe('Проверь импорт');expect(s.session(id)!.sourceUser).toBe('owner-example');expect(s.session(id)!.sourceConfig).toBe('config-example');
  s.rename(id,'Мой заголовок','owner');expect(s.session(id)!.title).toBe('Мой заголовок');s.rename(id,null,'owner');expect(s.session(id)!.title).toBe('Проверь импорт');
  const share=s.createShare(id,'1970-01-01T00:00:00.000Z',1,'owner');
  const serialized=JSON.stringify(s.publicSnapshot(s.share(share.token)));
  expect(serialized).not.toContain('owner-example');expect(serialized).not.toContain('config-example');expect(serialized).not.toContain('sourceUser');
 } finally {s.db.close();}
});

test('live publication repeats when idle, new request preempts, history survives prune, hide revokes',()=>{
 const s=new MonitorStore(':memory:'),b=new BroadcastStore(s);let n=0;const now=Date.now(),old=new Date(now-60_000).toISOString();
 const push=(type:string,data:any,at=old)=>{const e:any={version:1,eventId:`e${++n}`,sequence:n,epoch:'e',producer:'proxy',tenantId:'tenant',connectionId:'proxy',sessionId:'session',requestId:'req',attemptId:'attempt',correlation:'explicit',at,type,data};s.apply(e);return s.scopeId(e);};
 try {
  const sid=push('request.started',{});push('item.snapshot',{itemId:'first',role:'user',kind:'message',text:'Visible first',complete:true,revision:1});push('request.updated',{status:'completed'});
  const prepared=b.prepare({sessionId:sid,title:'Public title',mode:'live',from:new Date(now-70_000).toISOString(),repeatWhenIdle:true},'owner');
  expect(b.list()).toHaveLength(0);
  const row=b.publish(prepared.draftId,'owner');b.captureIdle();
  const first=b.public(row.id)!;expect(first.mode).toBe('replay');expect(first.autoReplay).toBe(true);expect(first.frames[0].item.text).toBe('Visible first');
  expect(JSON.stringify(first)).not.toContain('tenant');
  const firstCursor=first.cursor;
  push('request.started',{},new Date().toISOString());
  const live=b.public(row.id)!;expect(live.mode).toBe('live');expect(live.cursor).not.toBe(firstCursor);
  push('item.snapshot',{itemId:'second',role:'assistant',kind:'message',text:'New live text',complete:true,revision:1},new Date().toISOString());
  expect(b.public(row.id)!.items.some((i:any)=>i.text==='New live text')).toBe(true);
  push('request.updated',{status:'completed'},new Date().toISOString());
  expect(b.public(row.id)!.mode).toBe('live');
  // Simulate the idle grace elapsing; no fake model/task execution.
  s.db.query('UPDATE sessions SET updated_at=? WHERE id=?').run(old,sid);
  b.captureIdle();const replay=b.public(row.id)!;
  expect(replay.mode).toBe('replay');expect(replay.frames.some((f:any)=>f.item.text==='New live text')).toBe(true);
  s.db.exec('DELETE FROM events; DELETE FROM items');b.captureIdle();expect(b.public(row.id)!.frames.length).toBe(replay.frames.length);
  b.update(row.id,{visible:false},'owner');expect(b.public(row.id)).toBeNull();
 } finally {s.db.close();}
});
