# synadia-nats-agents

Простой учебный pipeline:

```text
YouTrack webhook
  -> app:/youtrack/webhook
  -> YouTrack gateway agent
  -> NATS JetStream job
  -> Codex worker
  -> NATS JetStream result
  -> YouTrack custom field + comments
```

В Web UI виден один agent:

```text
agents.prompt.youtrack.giscloud.codex
```

Он нужен для discovery, chat diagnostics и автоматических webhook bubbles. Сам
Codex запускается не в HTTP handler-е, а отдельным worker-ом из JetStream.

## Что Здесь Есть

- `src/youtrack-gateway.js` - HTTP webhook endpoint, Synadia AgentService,
  YouTrack API client, JetStream enqueue и result consumer.
- `src/codex-worker.js` - последовательный worker для jobs из JetStream.
- `src/jetstream.js` - stream/consumer setup для `YT_CODEX`.
- `skills/youtrack-task-analysis/SKILL.md` - prompt-инструкция для Codex.
- `examples/agent-web-ui/` - Synadia Vue UI с NATS discovery, chat streaming и
  auto-message handling для YouTrack webhook JSON.
- `scripts/start-production.js` - один public app container: UI + gateway.
- `stack/nats-synadia-dev.drs` - `nats`, `app`, `codex_worker`.

Подробная карта кода: [CODE_MAP.md](CODE_MAP.md).

## Runtime Flow

1. YouTrack отправляет `POST /youtrack/webhook`.
2. Gateway нормализует payload: `issueId = payload.id`, `event = payload.event`,
   `changedFields = payload.changedFields`.
3. Gateway всегда публикует полный JSON webhook-а в
   `youtrack.messages.giscloud.codex`, чтобы открытый UI добавил bubble в чат.
4. Для `issueCreated` и `issueUpdated` gateway читает поле `Codex Session ID` и
   публикует job в JetStream subject `youtrack.codex.jobs.giscloud`.
5. `commentAdded` и update только поля `Codex Session ID` игнорируются, чтобы не
   создавать webhook loop.
6. Worker читает jobs durable consumer-ом `codex-worker`, запускает или resume-ит
   Codex thread, читает skill file и публикует result event в
   `youtrack.codex.results.giscloud`.
7. Gateway durable consumer `youtrack-gateway-results` пишет `Codex Session ID`
   в custom field и добавляет комментарии о старте session и результате анализа.

## NATS And JetStream

Локальный NATS:

```bash
npm run nats
```

`nats.conf` включает JetStream и пишет store в `.runtime/nats/jetstream`.

Основные subjects:

```text
agents.prompt.youtrack.giscloud.codex
youtrack.messages.giscloud.codex
youtrack.codex.jobs.giscloud
youtrack.codex.results.giscloud
```

Основная шина задаётся только через `NATS_URL`.

```bash
NATS_URL=nats://127.0.0.1:4222
```

Для UI discovery по нескольким независимым NATS-шинам есть только JSON:

```bash
NATS_URLS_JSON='{"main":"nats://127.0.0.1:4222","extra":"nats://host:4222"}'
```

## Local Run

Установить зависимости:

```bash
npm install
cd examples/agent-web-ui
bun install
```

В отдельных терминалах:

```bash
npm run nats
CODEX_DRY_RUN=true YOUTRACK_DRY_RUN=true npm run gateway
CODEX_DRY_RUN=true npm run worker
npm run ui:bridge
npm run ui:vite
```

UI: `http://localhost:5173`.

Webhook smoke:

```bash
curl -sS http://127.0.0.1:3401/youtrack/webhook \
  -H 'content-type: application/json' \
  -d '{"id":"CS-TEST","event":"issueCreated","summary":"Test issue","description":"Check Codex pipeline","changedFields":["summary"]}' | jq
```

Проверить dry-run state:

```bash
curl -sS http://127.0.0.1:3401/youtrack/dry-run-state | jq
```

## YouTrack API

Production gateway требует permanent token:

```bash
YOUTRACK_TOKEN=<token>
YOUTRACK_BASE_URL=https://yt.giscloud.ru
YOUTRACK_CODEX_SESSION_FIELD='Codex Session ID'
```

`/youtrack/api-check` проверяет:

- bearer token;
- comments API;
- наличие и тип custom field `Codex Session ID`;
- JetStream stream/consumers.

Custom field должен быть text field (`TextIssueCustomField`).

## Codex Worker

Worker не получает `YOUTRACK_TOKEN` и не вызывает YouTrack API. Он читает только
JetStream jobs и пишет JetStream results.

Минимальные env:

```bash
OPENAI_API_KEY=<api-key>
CODEX_WORKER_CONCURRENCY=1
CODEX_SANDBOX_MODE=read-only
CODEX_APPROVAL_POLICY=never
CODEX_NETWORK_ACCESS=false
CODEX_WEB_SEARCH=disabled
```

Для локальной проверки без модели:

```bash
CODEX_DRY_RUN=true npm run worker
```

## Production

Один Docker image используется двумя service-ами:

- `app` - Bun UI + YouTrack gateway.
- `codex_worker` - только `node src/codex-worker.js`.

В `codex_worker` не пробрасывается `YOUTRACK_TOKEN`; в `app` не нужен
`OPENAI_API_KEY`.

## Diagrams

- [architecture.png](docs/diagrams/architecture.png)
- [webhook-sequence.png](docs/diagrams/webhook-sequence.png)
- [jetstream-data-flow.png](docs/diagrams/jetstream-data-flow.png)
- [deployment.png](docs/diagrams/deployment.png)

## Checks

```bash
node --check src/*.js scripts/*.js
cd examples/agent-web-ui && bun run typecheck && bun run build
git diff --check
```
