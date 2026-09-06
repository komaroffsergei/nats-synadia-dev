import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const db = new DatabaseSync(process.env.PORTFOLIO_DB || '/data/demo.sqlite');
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=4000;
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, events TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner);
 CREATE TABLE IF NOT EXISTS heartbeat(name TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
export const FIXTURES = [
 {id:'forms',summary:'Проверить валидацию формы заказа',description:'Синтетическая задача: пустое название не должно сохраняться. Ожидается сообщение у поля и сохранение введённых данных.'},
 {id:'table',summary:'Добавить сортировку в таблицу',description:'Синтетическая задача: сортировка по дате и названию, сохранение выбранного направления при смене страницы.'},
 {id:'context',summary:'Ошибка без шагов воспроизведения',description:''},
];
export function cleanup(){db.prepare('DELETE FROM jobs WHERE expires < ?').run(Date.now());}
export function row(id){return db.prepare('SELECT * FROM jobs WHERE id=? AND expires>?').get(id,Date.now());}
export function owned(id,owner){const value=row(id);return value?.owner===owner?value:null;}
export function serialize(value){return {id:value.id,status:value.status,job:JSON.parse(value.payload),events:JSON.parse(value.events),result:value.result?JSON.parse(value.result):null,createdAt:new Date(value.created).toISOString(),expiresAt:new Date(value.expires).toISOString()};}
export function event(id,type,detail){db.prepare("UPDATE jobs SET events=json_insert(events,'$[#]',json(?)) WHERE id=? AND expires>?").run(JSON.stringify({type,detail,at:new Date().toISOString()}),id,Date.now());}
export function create(owner,fixture,redelivery){
 cleanup();db.exec('BEGIN IMMEDIATE');
 try{
  if(db.prepare('SELECT count(*) n FROM jobs WHERE owner=?').get(owner).n>=20||db.prepare('SELECT count(*) n FROM jobs').get().n>=1000)throw Object.assign(new Error('Лимит: 20 заданий на сессию. Сбросьте свой пример.'),{status:429});
  const id=randomUUID(),created=Date.now(),payload={id,issueId:'DEMO-'+fixture.id,issue:{summary:fixture.summary,description:fixture.description},event:'IssueCreated',changedFields:[],sessionId:'',redelivery,expires:created+3600000};
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)').run(id,owner,JSON.stringify(payload),'queued',JSON.stringify([{type:'webhook_mock',detail:'YouTrack/MCP заменены фиксированным событием',at:new Date().toISOString()}]),null,created,created+3600000);db.exec('COMMIT');return payload;
 }catch(error){db.exec('ROLLBACK');throw error;}
}
