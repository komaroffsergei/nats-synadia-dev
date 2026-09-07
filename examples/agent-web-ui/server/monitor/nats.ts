/** NATS JS expects authentication separately from the server address. */
export function traceConnection() {
  const url=new URL(process.env.NATS_TRACE_URL || 'nats://127.0.0.1:4222');
  return {servers:`${url.protocol}//${url.host}`,user:url.username?decodeURIComponent(url.username):undefined,pass:url.password?decodeURIComponent(url.password):undefined,maxReconnectAttempts:-1};
}
