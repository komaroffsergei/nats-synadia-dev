# Codex Monitor UI

Vue console, Bun static server and native NATS connectivity. No Synadia runtime dependencies. `/console/` is owner-only; `/` and `/live/<token>` expose published sessions only. `/console/youtrack` is a read-only operations page. The former `/ws` discovery/prompt endpoint returns 410. Monitor WebSockets remain `/monitor/ws` and `/public/ws`.

See the root README and docs/PROXY-MONITOR.md. Upstream styling attribution: LICENSE and NOTICE.
