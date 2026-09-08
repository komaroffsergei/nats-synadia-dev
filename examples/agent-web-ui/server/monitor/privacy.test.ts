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

test('public projection handles paths embedded as escaped command text', () => {
  const source=String.raw`{"cmd":"Get-Content C:\\Users\\RealOwner\\project\\settings.json"}`;
  const safe=redactPublicText(source);
  expect(safe).not.toContain('RealOwner');
  expect(safe).toContain('[РАБОЧАЯ ПАПКА]');
});

test('public projection anonymizes contacts, network addresses and embedded IDs', () => {
  const source='owner@example.test +7 (999) 123-45-67 62.113.112.185 127.0.0.1 account_id=acct-42 sessionId=session-42';
  const safe=redactPublicText(source);
  for(const value of ['owner@example.test','999','62.113.112.185','acct-42','session-42']) expect(safe).not.toContain(value);
  expect(safe).toContain('127.0.0.1');
});

test('public projection replaces complete quoted and structured identity values', () => {
  const lexical='userLabel="Real Owner Name" config_id=owner-production session_id:\'private session value\'';
  const safe=redactPublicText(lexical);
  for(const value of ['Real Owner Name','owner-production','private session value']) expect(safe).not.toContain(value);
  expect(safe).toContain('[ПОЛЬЗОВАТЕЛЬ]');
  expect(safe).toContain('[КОНФИГУРАЦИЯ]');
  expect(safe).toContain('[ИДЕНТИФИКАТОР]');

  const structured=JSON.parse(redactPublicText(JSON.stringify({userLabel:'Real Owner Name',nested:{configId:'private config',session_id:'private session'}})));
  expect(structured.userLabel).toBe('[ПОЛЬЗОВАТЕЛЬ]');
  expect(structured.nested.configId).toBe('[КОНФИГУРАЦИЯ]');
  expect(structured.nested.session_id).toBe('[ИДЕНТИФИКАТОР]');
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
