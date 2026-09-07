import { connect } from '@nats-io/transport-node';
import { jetstream } from '@nats-io/jetstream';
import { readFile } from 'node:fs/promises';
import { MonitorStore } from './store.ts';

const store = new MonitorStore(process.env.MONITOR_DB || '/data/monitor.sqlite');
const ingressKey=process.env.MONITOR_INGRESS_KEY || '';
if (!ingressKey && process.env.MONITOR_TEST !== 'true') throw Error('MONITOR_INGRESS_KEY required');
const port=Number(process.env.MONITOR_PORT || 3310);
const publicOrigin=process.env.MONITOR_ORIGIN || 'https://agents.komaroff-dev.ru';
let natsConnected=false, ingestionError=false;
const peers=new Set<any>();
let notifyTimer:ReturnType<typeof setTimeout>|null=null;
const headers={ 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff' };
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
const rate=new Map<string,{at:number,n:number}>();

function notify() {
  if (notifyTimer) return;
  notifyTimer=setTimeout(()=>{
    notifyTimer=null;
    for (const ws of peers) {
      if (ws.getBufferedAmount()>2_097_152) {ws.close(1013,'resync_required');continue;}
      const d=ws.data;
      if (d.share) {
        const share=store.publicShareById(d.share);
        if (!share) {ws.send(JSON.stringify({kind:'revoked'}));ws.close(1008,'share_unavailable');continue;}
        if (d.cursor!==store.cursor()) ws.send(JSON.stringify({kind:'snapshot',data:store.publicSnapshot(share)}));
      } else if (d.session) {
        const cursor=store.cursor();
        if (d.cursor!==cursor) ws.send(JSON.stringify({kind:'snapshot',data:store.session(d.session)}));
      } else if (d.cursor!==store.cursor()) ws.send(JSON.stringify({kind:'changed',cursor:store.cursor()}));
      d.cursor=store.cursor();
    }
  },80);
}

function owner(req:Request) {
  return ingressKey && req.headers.get('x-monitor-key')===ingressKey && req.headers.get('x-monitor-owner');
}
function mutationAllowed(req:Request) {
  return req.headers.get('origin')===publicOrigin && req.headers.get('content-type')?.startsWith('application/json');
}
function publicShare(id:string) {
  return /^[a-f0-9]{32}$/.test(id) ? store.publicShareById(id) : store.share(id);
}
function connectionState() {
  return { nats:natsConnected?'connected':'reconnecting',ingestionError,source:store.state('source'),projector:store.state('projector'),
    gap:store.state('sequenceGap'),ingest:store.state('ingest'),retentionHours:24,ledgerDays:90,sourceLabel:'Codex proxy', legacy:store.state('legacy') };
}

type PeerData={owner:string|false|null;share?:string;session:string|null;cursor:number};
const server=Bun.serve<PeerData>({
  hostname:process.env.MONITOR_HOST || '0.0.0.0',port,
  maxRequestBodySize:32_768,
  async fetch(req,srv) {
    const url=new URL(req.url), path=url.pathname;
    if (path==='/healthz') return json({ok:natsConnected || process.env.MONITOR_TEST==='true',kind:'proxy-monitor',revision:process.env.MONITOR_REVISION},natsConnected || process.env.MONITOR_TEST==='true'?200:503);
    const isPrivate=path.startsWith('/api/v1/monitor/') || path==='/monitor/ws';
    const actor=isPrivate?owner(req):null;
    if (isPrivate && !actor) return json({error:'unauthorized'},401);
    if (!['GET','HEAD'].includes(req.method) && (!actor || !mutationAllowed(req))) return json({error:'forbidden'},403);
    if (!isPrivate) {
      const ip=req.headers.get('x-real-ip') || 'local',now=Date.now();
      const bucket=rate.get(ip);
      if (!bucket || now-bucket.at>60_000) rate.set(ip,{at:now,n:1});
      else if (++bucket.n>300) return json({error:'rate_limited'},429);
    }
    try {
      if (path==='/monitor/ws' || path==='/public/ws') {
        if (req.headers.get('origin')!==publicOrigin) return json({error:'origin'},403);
        if (peers.size>=100) return json({error:'viewer_limit'},429);
        const requested=path==='/public/ws'?publicShare(url.searchParams.get('share') || ''):null;
        if (path==='/public/ws'&&!requested) return json({error:'share_unavailable'},410);
        if (srv.upgrade(req,{data:{owner:actor,share:requested?.id,session:null,cursor:-1}})) return;
        return json({error:'websocket_required'},400);
      }
      if (path==='/api/public/sessions' && req.method==='GET') return json(store.publicSessions());
      const publicMatch=path.match(/^\/api\/public\/sessions\/([A-Za-z0-9_-]+)$/);
      if (publicMatch && req.method==='GET') {
        const share=publicShare(publicMatch[1]);
        return share?json(store.publicSnapshot(share,Number(url.searchParams.get('before'))||undefined)):json({error:'share_unavailable'},410);
      }
      if (path==='/api/v1/monitor/sessions' && req.method==='GET') return json({sessions:store.sessions(url.searchParams.get('q') || '',url.searchParams.get('before') || ''),cursor:store.cursor()});
      if (path==='/api/v1/monitor/usage' && req.method==='GET') return json(store.usage());
      if (path==='/api/v1/monitor/connections' && req.method==='GET') return json(connectionState());
      const match=path.match(/^\/api\/v1\/monitor\/sessions\/([a-f0-9]{32})(?:\/(events|shares|preview))?$/);
      if (match) {
        const [,id,section]=match;
        if (!store.session(id)) return json({error:'not_found'},404);
        if (req.method==='GET') {
          if (section==='events') return json({events:store.events(id,Math.max(0,Number(url.searchParams.get('after'))||0)),cursor:store.cursor()});
          if (section==='shares') return json(store.shares(id));
          if (section==='preview') return json(store.publicSnapshot({session_id:id,start_at:url.searchParams.get('from')||'1970-01-01T00:00:00.000Z',expires_at:null}));
          return json(store.session(id,undefined,Number(url.searchParams.get('before'))||undefined));
        }
        if (section==='shares' && req.method==='POST') {
          const body=await req.json();
          return json(store.createShare(id,body.from || new Date().toISOString(),body.hours ?? 24,String(actor)),201);
        }
      }
      const revoke=path.match(/^\/api\/v1\/monitor\/shares\/([a-f0-9]{32})$/);
      if (revoke && req.method==='DELETE') {
        store.revoke(revoke[1],String(actor));notify();return json({ok:true});
      }
      return json({error:'not_found'},404);
    } catch (error) {
      const code=(error as Error).message;
      return json({error:code==='invalid_share'?'invalid_share':'request_failed'},400);
    }
  },
  websocket:{
    open(ws) {peers.add(ws);ws.send(JSON.stringify({kind:'ready',cursor:store.cursor()}));notify();},
    message(ws,message) {
      try {
        if (String(message).length>4096) throw Error();
        const data=JSON.parse(String(message));
        if (data.kind!=='subscribe') throw Error();
        if (ws.data.share) {notify();return;}
        if (data.sessionId && !/^[a-f0-9]{32}$/.test(data.sessionId)) throw Error();
        ws.data.session=data.sessionId || null;
        ws.data.cursor=-1;
        if (data.sessionId) {
          const session=store.session(data.sessionId);
          if (!session) throw Error();
          ws.send(JSON.stringify({kind:'snapshot',data:session}));
          ws.data.cursor=store.cursor();
        } else ws.send(JSON.stringify({kind:'changed',cursor:store.cursor()}));
      } catch {ws.close(1008,'invalid_subscription');}
    },
    close(ws) {peers.delete(ws);},
    drain() {},
    maxPayloadLength:4096,
    idleTimeout:90,
    backpressureLimit:2_097_152,
    closeOnBackpressureLimit:true,
  }
});

async function project() {
  while (true) {
    let nc;
    try {
      nc=await connect({servers:process.env.NATS_TRACE_URL,name:'codex-trace-projector',maxReconnectAttempts:-1});
      void (async()=>{for await(const s of nc!.status()){if(s.type==='disconnect')natsConnected=false;if(s.type==='reconnect')natsConnected=true;}})();
      const js=jetstream(nc);
      const consumer=await js.consumers.get('CODEX_TRACE','console-projector');
      const messages=await consumer.consume({max_messages:100});natsConnected=true;
      for await (const msg of messages) {
        try {if(store.apply(msg.json() as any))notify();msg.ack();ingestionError=false;}
        catch {ingestionError=true;msg.nak(5000);}
      }
    } catch {natsConnected=false;}
    finally {await nc?.close();natsConnected=false;}
    await Bun.sleep(1000);
  }
}
if (process.env.MONITOR_TEST!=='true') void project();
setInterval(()=>{
  notify();
  for(const ws of peers)ws.ping();
},2000).unref();
setInterval(()=>{store.prune();for(const [key,value] of rate)if(Date.now()-value.at>120_000)rate.delete(key);},60_000).unref();
setInterval(async()=>{
  for(const key of ['ingest','legacy']) {
    try {store.setState(key,JSON.parse(await readFile(`/status/${key}.json`,'utf8')));} catch {/* No fabricated state when unavailable. */}
  }
},2000).unref();
process.on('SIGTERM',()=>{for(const ws of peers)ws.close(1012,'restart');server.stop();store.db.close();process.exit(0);});
console.log(`[monitor] port=${port} read-only source=codex-proxy`);
