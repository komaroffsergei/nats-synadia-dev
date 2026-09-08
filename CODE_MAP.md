# Codex Monitor — code map

Active architecture: Codex proxy → outbox → NATS CODEX_TRACE → projector → SQLite → Bun/Vue → portfolio.

| Function | Screen/API | Source | Data / checks |
|---|---|---|---|
| Trace ingestion | private transport | server/monitor/ingest.ts, contracts.ts | outbox; stable eventId; JetStream ACK |
| Sessions, source labels, usage | /api/v1/monitor/ | server/monitor/store.ts, service.ts | SQLite; store.test.ts, session-controls.test.ts |
| Broadcasts, replay and access | /api/public/, /monitor/ws, /public/ws | server/monitor/broadcasts.ts | snapshots; broadcasts.test.ts, broadcast-range.test.ts |
| Console and timeline | /console/ | src/MonitorApp.vue, components/MonitorTimelineItem.vue | readonly proxy sessions; source title / owner override |
| Broadcast controls | console broadcast tab | src/components/BroadcastManager.vue | owner-managed publication; no automatic publication |
| Static UI and YouTrack proxy | /, /console/youtrack, /youtrack/ | server/index.ts, src/YouTrackStatus.vue | Nginx owner authentication; /ws returns 410 |
| Native NATS connection | service startup | src/nats-options.js, src/common.js | credentials kept out of endpoint; nats-options.test.js |
| YouTrack gateway | webhook, status and jobs | src/youtrack-gateway.js, src/jetstream.js | durable jobs/results; no AgentService or discovery |
| YouTrack execution | internal consumer | src/codex-worker.js | original Codex SDK; per-job ACK, retry and results |

UI-relative paths are under examples/agent-web-ui. Root src paths refer to gateway and worker.
Before changing a feature, trace its API, storage and consumers; update this map and corresponding checks after editing.
Legacy Synadia protocol, prompt/discovery bridge and UI are available in Git history. They are not part of the current build.
Existing streams, credentials, monitor DB, sessions and publication settings are preserved during the migration.
