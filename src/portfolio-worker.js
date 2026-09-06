import { writeFileSync, unlinkSync } from 'node:fs';
import { connectNats, encodeJson } from './common.js';
import { openJetStream, YT_CODEX_STREAM, CODEX_WORKER_DURABLE, YT_CODEX_RESULT_SUBJECT } from './jetstream.js';
import { dryAnalysis } from './dry-analysis.js';
import { db,row,event } from './portfolio-store.js';

// This entry point never imports Codex SDK, child_process, MCP clients or the operational gateway.
const nc=await connectNats('portfolio-demo-worker');const {js}=await openJetStream(nc);
const consumer=await js.consumers.get(YT_CODEX_STREAM,CODEX_WORKER_DURABLE);
const beat=()=>{db.prepare('INSERT INTO heartbeat VALUES(?,?) ON CONFLICT(name) DO UPDATE SET at=excluded.at').run('worker',Date.now());writeFileSync('/tmp/worker-ready',String(Date.now()));};
beat();const timer=setInterval(beat,2000);const messages=await consumer.consume({max_messages:1});
async function stop(){clearInterval(timer);try{unlinkSync('/tmp/worker-ready')}catch{}messages.stop();await nc.drain();process.exit(0)}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
for await(const msg of messages){
 try{
  const job=msg.json(),stored=row(job.id);if(!stored){msg.ack();continue;}
  if(stored.status==='completed'){event(job.id,'duplicate_ignored','Повторное событие подтверждено без повторного применения результата');msg.ack();continue;}
  const events=JSON.parse(stored.events);
  if(job.redelivery&&!events.some(x=>x.type==='delivery_interrupted')){event(job.id,'delivery_interrupted','Контролируемая ошибка до ACK; NATS повторит доставку через 2,5 секунды');db.prepare("UPDATE jobs SET status='retrying' WHERE id=?").run(job.id);msg.nak(2500);continue;}
  event(job.id,'worker_started','Durable consumer получил задание');db.prepare("UPDATE jobs SET status='processing' WHERE id=?").run(job.id);
  await new Promise(resolve=>setTimeout(resolve,700));
  const result={type:'analysis_completed',jobId:job.id,issueId:job.issueId,sessionId:'mock-'+job.id.slice(0,8),finalResponse:dryAnalysis(job),mock:true,completedAt:new Date().toISOString()};
  await js.publish(YT_CODEX_RESULT_SUBJECT,encodeJson(result));event(job.id,'result_published','Результат отправлен в отдельный NATS subject');msg.ack();
 }catch(error){console.error('Demo job failure:',error.message);msg.nak(3000);}
}
