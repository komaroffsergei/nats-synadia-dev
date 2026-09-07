import { connect } from '@nats-io/transport-node';
import { jetstreamManager,StorageType,RetentionPolicy,AckPolicy,DeliverPolicy } from '@nats-io/jetstream';
const nc=await connect({servers:process.env.NATS_TRACE_URL,name:'monitor-setup'});
const jsm=await jetstreamManager(nc);
try { await jsm.streams.info('CODEX_TRACE'); }
catch {await jsm.streams.add({name:'CODEX_TRACE',subjects:['codex.trace.>'],storage:StorageType.File,retention:RetentionPolicy.Limits,max_age:24*3600*1e9,max_bytes:1073741824,duplicate_window:120*1e9});}
try { await jsm.consumers.info('CODEX_TRACE','console-projector'); }
catch {await jsm.consumers.add('CODEX_TRACE',{durable_name:'console-projector',ack_policy:AckPolicy.Explicit,deliver_policy:DeliverPolicy.All,ack_wait:30e9,max_ack_pending:1000});}
await nc.drain();console.log('CODEX_TRACE and durable projector ready');
