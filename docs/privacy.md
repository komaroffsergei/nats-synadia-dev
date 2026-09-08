# Privacy boundary

Codex Monitor applies two independent transformations. They are part of the
server contract and are not UI-only hiding.

```text
Codex proxy response
  -> observer structured/stream-aware secret redaction
  -> outbox
  -> publisher event redaction and schema validation
  -> NATS JetStream
  -> SQLite owner history
  -> public projection and pseudonymisation
  -> live WebSocket / HTTP history / replay / preview
```

## Before outbox and NATS

`docker/monitor/observer.rb` recursively sanitizes structured values before a
file is accepted by the outbox. Complete JSON strings are parsed and serialized
again so that sensitive fields are removed without corrupting JSON. Lexical
rules cover authorization headers, common provider tokens, JWTs, PEM private
keys, environment assignments, command-line credential options, query
credentials and URL userinfo for HTTP, database, Redis and NATS schemes.

The proxy registers successfully verified proxy passwords and the current
upstream access token in an in-memory bounded exact-match set. The values are
never written by the monitor. Tool-call argument deltas remain buffered until a
complete value can be parsed and sanitized. Other streamed text retains an
unpublished tail to prevent a credential split across chunks from appearing in
an early snapshot.

`server/monitor/ingest.ts` repeats recursive event sanitization before publishing
to JetStream. `MonitorStore.apply` applies the same transformation for events
delivered through another authorized NATS publisher.

## Public projection

`server/monitor/privacy.ts` is called while building every public session item,
broadcast frame and publication title. It masks local user paths, selected
server paths, provider-panel links, contacts, non-loopback IP addresses and
embedded user/config/session/account identifiers. Tool
operations that read known credential files are replaced by a short operation
summary. Item and group IDs are scoped to the publication.

The transformation runs when data is served. It therefore also protects replay
recordings and session rows created before this version. Owner-only session
history retains non-secret operational detail such as paths and source labels;
credentials have already been removed by the ingestion boundary.

Collapsing an element in CSS is not a privacy control. Public text is sanitized
before it is serialized into HTTP or WebSocket output.

## Verification

Tests use synthetic credentials only. They cover recursive JSON, encoded nested
JSON, headers, CLI flags, URL credentials, PEM blocks, exact known secrets,
stream splits, public paths and identities, tool summaries, titles, legacy
SQLite items and legacy replay recordings. The original value must be absent
from every generated public payload.

Pattern matching cannot classify arbitrary prose perfectly. Publication still
requires the existing owner preview and explicit publication action. When a
tool operation accesses credential storage, the public representation favors a
summary over raw output.
