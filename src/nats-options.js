/** Separate credentials from NATS endpoints using native client options. */
export function natsOptions(value) {
  const urls = String(value).split(',').map(value => {
    try { return new URL(value.trim()); } catch { throw Error('Invalid NATS endpoint'); }
  });
  if (!urls.length || urls.some(u => !['nats:', 'tls:'].includes(u.protocol) || u.pathname || u.search || u.hash))
    throw Error('Expected NATS TCP or TLS endpoints');
  const credentials = urls.map(u => ({ user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) }));
  const auth = credentials.find(c => c.user || c.pass) || { user: '', pass: '' };
  if (credentials.some(c => (c.user || c.pass) && (c.user !== auth.user || c.pass !== auth.pass)))
    throw Error('NATS endpoints must use the same credentials');
  return {
    servers: urls.map(u => `${u.protocol}//${u.host}`),
    ...(auth.pass ? { user: auth.user, pass: auth.pass } : auth.user ? { token: auth.user } : {}),
    ...(urls.some(u => u.protocol === 'tls:') ? { tls: {} } : {}),
  };
}
