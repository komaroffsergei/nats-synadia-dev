import { test, expect } from 'bun:test';
import { privacyMarkers, redactPublicText, redactStoredText, sanitizeEventForStorage, sanitizePublicItem, sanitizePublicTitle } from './privacy.ts';

test('structured event redaction preserves schema and token usage counters', () => {
  const event:any={version:1,eventId:'e1',producer:'proxy',epoch:'epoch',sequence:1,at:new Date().toISOString(),type:'item.snapshot',tenantId:'tenant',connectionId:'proxy',sessionId:'session',correlation:'explicit',data:{text:JSON.stringify({access_token:'token-value-123',input_tokens:12,enabled:true})}};
  const safe=sanitizeEventForStorage(event),value=JSON.parse(safe.data.text);
  expect(value.access_token).toBe(privacyMarkers.REDACTED);
  expect(value.input_tokens).toBe(12);
  expect(value.enabled).toBe(true);
  expect(JSON.stringify(safe)).not.toContain('token-value-123');
});

test('escaped nested JSON is parsed recursively before it reaches NATS', () => {
  const source=JSON.stringify({payload:JSON.stringify({client_secret:'nested-secret-value',enabled:true})});
  const outer=JSON.parse(redactStoredText(source)),inner=JSON.parse(outer.payload);
  expect(inner.client_secret).toBe(privacyMarkers.REDACTED);
  expect(inner.enabled).toBe(true);
});

test('storage redaction handles credentials in headers, URLs, CLI and private keys', () => {
  const source=['Authorization: Bearer bearer-value-123','redis://admin:db-pass@example.test/0','curl -u demo:pass --api-key api-value-123 https://example.test/?token=query-value','-----BEGIN PRIVATE KEY-----\nPRIVATE-CONTENT\n-----END PRIVATE KEY-----'].join('\n');
  const safe=redactStoredText(source);
  for(const value of ['bearer-value-123','admin:db-pass','demo:pass','api-value-123','query-value','PRIVATE-CONTENT']) expect(safe).not.toContain(value);
});

test('public projection anonymizes paths, service links and embedded identities', () => {
  const source='C:\\Users\\Owner\\Documents\\repo /home/deploy/app /srv/portfolio/monitor https://cp.vdsina.ru/vds/view/123 userLabel=owner configId=config-a';
  const safe=redactPublicText(source);
  for(const value of ['Owner','deploy','/srv/portfolio','cp.vdsina.ru','userLabel=owner','configId=config-a']) expect(safe).not.toContain(value);
  expect(safe).toContain('[РАБОЧАЯ ПАПКА]');
  expect(safe).toContain('[СЕРВЕРНЫЙ ПУТЬ]');
  expect(safe).toContain('[СЛУЖЕБНАЯ ССЫЛКА]');
});

test('credential-reading tool operations are summarized in public output', () => {
  const item=sanitizePublicItem({kind:'tool_call',name:'exec_command',text:'Get-Content /opt/codex-proxy/secrets/client.env'});
  expect(item.text).toBe(privacyMarkers.PRIVATE_OPERATION);
  expect(sanitizePublicItem({kind:'tool_result',text:'source /service/runtime.env.production'}).text).toBe(privacyMarkers.PRIVATE_OPERATION);
});

test('titles receive the same public protection', () => {
  expect(sanitizePublicTitle('Работа в C:\\Users\\Owner\\Secret password=plain-value')).not.toContain('Owner');
  expect(sanitizePublicTitle('Работа в C:\\Users\\Owner\\Secret password=plain-value')).not.toContain('plain-value');
});
