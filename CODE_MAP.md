# Code Map

## Runtime

- `src/common.js` - `.env` loading, `NATS_URL`, NATS connect helper, JSON/UTF-8
  helpers, small formatting helpers.
- `src/jetstream.js` - owns JetStream names and setup:
  - stream `YT_CODEX`;
  - job subject `youtrack.codex.jobs.giscloud`;
  - result subject `youtrack.codex.results.giscloud`;
  - durable consumers `codex-worker` and `youtrack-gateway-results`.
- `src/youtrack-gateway.js` - public-facing gateway:
  - registers `agents.prompt.youtrack.giscloud.codex`;
  - serves `/youtrack/webhook`, `/youtrack/api-check`, `/healthz`;
  - publishes full webhook JSON to `youtrack.messages.giscloud.codex`;
  - enqueues Codex jobs into JetStream;
  - consumes worker results and writes YouTrack custom field/comments.
- `src/codex-worker.js` - worker process:
  - consumes `youtrack.codex.jobs.giscloud`;
  - starts or resumes Codex SDK threads;
  - reads `skills/youtrack-task-analysis/SKILL.md`;
  - publishes `session_started`, `analysis_completed`, `analysis_failed`.
- `src/monitor.js` - optional local NATS traffic monitor.

## Step-By-Step Algorithm

1. YouTrack sends `POST /youtrack/webhook`.
   Code: `src/youtrack-gateway.js#handleWebhook`.

2. Gateway normalizes payload.
   Code: `normalizeWebhookPayload()` extracts `issueId`, `event`,
   `changedFields`, `summary`, `description`.

3. Gateway publishes full chat JSON.
   Code: `publishWebhookChatMessage()` publishes to
   `youtrack.messages.giscloud.codex`; UI bridge subscribes in
   `examples/agent-web-ui/server/bridge.ts#startYouTrackMessageWatch`.

4. Gateway enqueues a JetStream job.
   Code: `enqueueCodexJob()` reads `Codex Session ID` from YouTrack, then
   publishes a job to `youtrack.codex.jobs.giscloud`.

5. Worker runs or resumes Codex.
   Code: `src/codex-worker.js#processJob`.
   If `job.sessionId` exists, it calls `codex.resumeThread(sessionId)`;
   otherwise it calls `codex.startThread()`.

6. Worker publishes result events.
   Code: `publishResult()` sends results to `youtrack.codex.results.giscloud`.

7. Gateway writes back to YouTrack.
   Code: `handleResultEvent()`:
   - `session_started` -> update text custom field `Codex Session ID` and add a
     start comment;
   - `analysis_completed` -> add result comment;
   - `analysis_failed` -> add failure comment.

## Web UI

- `examples/agent-web-ui/server/config.ts` - parses `NATS_URL` and optional
  `NATS_URLS_JSON`.
- `examples/agent-web-ui/server/index.ts` - Bun HTTP/WebSocket server:
  - serves `/ws`;
  - proxies `/youtrack/*` to the local gateway;
  - `/healthz` reports UI, NATS, gateway and JetStream readiness.
- `examples/agent-web-ui/server/bridge.ts` - server-side NATS bridge:
  discovery, prompt streaming, cancel/query reply, heartbeat tracking and
  YouTrack auto-message forwarding.
- `examples/agent-web-ui/src/composables/useBridge.ts` - browser WebSocket
  client.
- `examples/agent-web-ui/src/stores/agents.ts` - agent list and simple
  YouTrack/other grouping.
- `examples/agent-web-ui/src/components/AgentGrid.vue` - cards list.
- `examples/agent-web-ui/src/components/ChatPanel.vue` - selected agent chat.
- `examples/agent-web-ui/src/composables/promptStreaming.ts` - builds chat
  messages from streaming events.

## Deployment

- `docker/Dockerfile` - one image with Node, Bun, root dependencies and built UI.
- `scripts/start-production.js` - app service entrypoint; waits for NATS, starts
  `src/youtrack-gateway.js` and Bun UI server.
- `stack/nats-synadia-dev.drs` - dry-stack definition:
  - `nats` service with JetStream enabled;
  - `app` service with `YOUTRACK_TOKEN`;
  - `codex_worker` service with OpenAI/Codex env but without YouTrack token.
- `.gitlab-ci.yml` - build/deploy wrapper and env forwarding.

## Important Env

- `NATS_URL` - main NATS bus for app, gateway and worker.
- `NATS_URLS_JSON` - optional UI-only multi-NATS discovery.
- `YOUTRACK_BASE_URL`, `YOUTRACK_TOKEN`, `YOUTRACK_CODEX_SESSION_FIELD`.
- `YOUTRACK_AGENT_MESSAGE_SUBJECT`.
- `YT_CODEX_STREAM`, `YT_CODEX_JOB_SUBJECT`, `YT_CODEX_RESULT_SUBJECT`.
- `OPENAI_API_KEY` or `CODEX_API_KEY`.
- `CODEX_DRY_RUN=true` for local smoke without a live model.
- `YOUTRACK_DRY_RUN=true` for local smoke without YouTrack writes.
