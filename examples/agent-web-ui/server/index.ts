// Codex Monitor: static Vue UI, native NATS readiness and YouTrack HTTP ingress.
import { resolve, extname, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { connect, type NatsConnection } from '@nats-io/transport-node';
// @ts-ignore Shared ESM helper also used by the Node gateway and worker.
import { natsOptions } from '../../../src/nats-options.js';
import { parseConfig } from './config.ts';
const config=parseConfig(Bun.argv),dist=resolve(import.meta.dir,'../dist');
const gateway=(process.env.YOUTRACK_WEBHOOK_PROXY_TARGET||'http://127.0.0.1:3401').replace(/\/+$/,'');
let connection:Promise<NatsConnection>|undefined;
function getConnection(){
  connection??=connect({...natsOptions(config.connections[0]!.servers),name:'codex-monitor-ui'}).catch(e=>{connection=undefined;throw e;});return connection;
}
async function health(){
  try {
    const nc=await getConnection();await nc.flush();
    const r=await fetch(gateway+'/healthz',{signal:AbortSignal.timeout(5000)});
    const g=await r.json() as {ok:boolean};const ok=r.ok&&g.ok&&!nc.isClosed();
    return Response.json({ok,service:'codex-monitor',nats:{connected:!nc.isClosed()},gateway:g},{status:ok?200:503});
  } catch { return Response.json({ok:false,service:'codex-monitor',error:'dependency_unavailable'},{status:503}); }
}
const server=Bun.serve({hostname:config.host,port:config.port,
  async fetch(req){
    const u=new URL(req.url);
    if(u.pathname==='/healthz')return health();
    if(u.pathname==='/ws')return Response.json({error:'agent_protocol_removed',console:'/console/'},{status:410});
    if(u.pathname.startsWith('/youtrack/')){
      const readPaths=['/youtrack/api-check','/youtrack/jobs/last','/youtrack/webhooks/last','/youtrack/dry-run-state'];
      if(u.pathname==='/youtrack/status'){
        if(req.method!=='GET')return new Response(null,{status:405});return health();
      }
      const allowed=req.method==='GET'&&readPaths.includes(u.pathname) || req.method==='POST'&&u.pathname==='/youtrack/webhook';
      if(!allowed)return Response.json({error:'not_found'},{status:404});
      try{return await fetch(gateway+u.pathname+u.search,{method:req.method,headers:req.headers,body:req.method==='POST'?req.body:undefined,redirect:'manual',signal:AbortSignal.timeout(15000)});}
      catch{return Response.json({error:'gateway_unavailable'},{status:502});}
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return new Response(null,{status:405});
    let path:string;try{path=resolve(dist,'.'+decodeURIComponent(u.pathname));}catch{return new Response(null,{status:400});}
    if(path!==dist&&!path.startsWith(dist+sep))return new Response(null,{status:403});
    if(existsSync(path)&&statSync(path).isFile())return new Response(Bun.file(path));
    if(!extname(u.pathname)&&existsSync(resolve(dist,'index.html')))return new Response(Bun.file(resolve(dist,'index.html')));
    return new Response('Not found',{status:404});
  },
});
console.log(`[codex-monitor] listening on ${config.port}`);
async function stop(){server.stop();await (await connection?.catch(()=>undefined))?.drain();process.exit(0);}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
