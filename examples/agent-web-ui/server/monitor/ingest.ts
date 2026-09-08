import { readdir, readFile, unlink, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '@nats-io/transport-node';
import { jetstream } from '@nats-io/jetstream';
import { validateEvent } from './contracts.ts';
import { traceConnection } from './nats.ts';
import { sanitizeEventForStorage } from './privacy.ts';

const outbox = process.env.MONITOR_OUTBOX || '/outbox';
const healthPath = process.env.MONITOR_INGEST_HEALTH || '/status/ingest.json';
const url = process.env.NATS_TRACE_URL;
if (!url) throw Error('NATS_TRACE_URL required');
const nc = await connect({ ...traceConnection(), name:'codex-trace-publisher' });
const js = jetstream(nc);
let sent=0, errors=0, lastEventAt:string|null=null;
let connected=true;
void (async()=>{for await(const s of nc.status()){if(s.type==='disconnect')connected=false;if(s.type==='reconnect')connected=true;}})();
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});
while (!stopping) {
  const files = (await readdir(outbox).catch(()=>[])).filter(n=>/^\d+-[a-f0-9-]+\.json$/.test(n)).sort();
  for (const file of files.slice(0,200)) {
    try {
      const bytes=await readFile(join(outbox,file));
      const event=sanitizeEventForStorage(JSON.parse(bytes.toString()));validateEvent(event);
      const safeBytes=Buffer.from(JSON.stringify(event));
      await js.publish(`codex.trace.${event.tenantId}.${event.sessionId}`,safeBytes,{msgID:event.eventId,timeout:1500});
      await unlink(join(outbox,file));sent++;lastEventAt=event.at;
    } catch { errors++;break; }
  }
  const source=JSON.parse(await readFile(join(outbox,'health.state'),'utf8').catch(()=>'{}'));
  await writeFile(healthPath+'.tmp',JSON.stringify({at:new Date().toISOString(),connected:connected&&!nc.isClosed(),sent,errors,pending:files.length,lastEventAt,source}));
  await rename(healthPath+'.tmp',healthPath);
  await Bun.sleep(files.length ? 30 : 100);
}
await nc.drain();
