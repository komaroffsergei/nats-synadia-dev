import { test } from 'node:test';
import assert from 'node:assert/strict';
import { natsOptions } from './nats-options.js';
test('native NATS config separates encoded user credentials and failover endpoints', () => {
  assert.deepEqual(natsOptions('nats://user:p%40ss@one:4222,nats://two:4222'), {
    servers: ['nats://one:4222','nats://two:4222'], user: 'user', pass: 'p@ss',
  });
});
test('token and TLS config remain supported', () => {
  assert.deepEqual(natsOptions('tls://token@one:4222'),{servers:['tls://one:4222'],token:'token',tls:{}});
});
test('invalid or conflicting endpoints fail without exposing credentials', () => {
  for (const s of ['https://secret:pass@one','nats://user:secret@one,nats://user:other@two','secret'])
    assert.throws(()=>natsOptions(s),e=>!e.message.includes('secret'));
});
