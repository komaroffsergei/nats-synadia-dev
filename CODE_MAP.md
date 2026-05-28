# Карта Кода

Этот документ объясняет, как устроен текущий runtime
`YouTrack webhook -> JetStream -> Codex worker -> yt-mcp-ruby -> YouTrack comments`.

Если нужен короткий обзор и команды запуска, сначала читай
[README.md](README.md). Здесь собрана подробная карта файлов, алгоритм и
диаграммы.

<a id="toc"></a>
## Содержание

- [Проверенный вывод про `/youtrack/agent-messages`](#agent-messages)
- [Общая архитектура](#architecture)
- [Пошаговый алгоритм](#algorithm)
- [Файлы runtime](#runtime-files)
- [Web UI](#web-ui)
- [JetStream](#jetstream)
- [Deploy](#deploy)
- [Переменные окружения](#env)
- [Интеграция с yt-mcp-ruby](docs/YOUTRACK_MCP_INTEGRATION.md)
- [Что удалено из старой версии](#removed)

<a id="agent-messages"></a>
## Проверенный Вывод Про `/youtrack/agent-messages`

`/youtrack/agent-messages` можно не поддерживать и не добавлять.

Проверка live runtime показала, что route отсутствует и gateway возвращает
ожидаемый `404 not_found` со списком реальных endpoint-ов:

- `GET /healthz`
- `GET /youtrack/api-check`
- `POST /youtrack/webhook`
- `GET /youtrack/webhooks/last`
- `GET /youtrack/jobs/last`
- `GET /youtrack/dry-run-state`

"Agent messages" в этом проекте - это NATS subject, а не HTTP endpoint:

```text
youtrack.messages.giscloud.codex
```

Кодовая цепочка такая:

1. Gateway вызывает `publishWebhookChatMessage()` в
   [src/youtrack-gateway.js](src/youtrack-gateway.js).
2. Сообщение публикуется в NATS subject `youtrack.messages.giscloud.codex`.
3. Bun bridge подписывается на этот subject в
   [examples/agent-web-ui/server/bridge.ts](examples/agent-web-ui/server/bridge.ts).
4. UI добавляет webhook JSON как сообщение в чат выбранного YouTrack/Codex
   agent-а.

HTTP endpoint `/youtrack/agent-messages` в этой схеме лишний: он дублировал бы
NATS-подписку и создавал бы еще один источник состояния.

<a id="architecture"></a>
## Общая Архитектура

![Общая архитектура](docs/diagrams/architecture.png)

Что происходит на схеме:

- YouTrack отправляет webhook в публичный `app` service.
- Внутри `app` работают Web UI и gateway-агент.
- Gateway публикует полный JSON webhook-а в NATS subject для UI.
- Gateway ставит Codex job в JetStream.
- `codex_worker` отдельно читает job, запускает или продолжает Codex thread и
  пишет result event.
- Gateway читает result event и пишет поле/комментарии через `yt-mcp-ruby`.

<a id="algorithm"></a>
## Пошаговый Алгоритм

### 1. YouTrack Делает POST

YouTrack отправляет:

```text
POST /youtrack/webhook
```

Публичный request приходит в Bun UI server, потому что наружу опубликован только
порт `3300`. Bun server прокидывает все `/youtrack/*` запросы в локальный
gateway на `127.0.0.1:3401`.

Код:

- [examples/agent-web-ui/server/index.ts](examples/agent-web-ui/server/index.ts)
  - `proxyYouTrackRequest()`;
- [src/youtrack-gateway.js](src/youtrack-gateway.js) - `handleWebhook()`.

### 2. Gateway Нормализует Payload

Gateway приводит разные формы webhook payload-а к одному виду:

```js
{
  issueId,
  event,
  changedFields,
  summary,
  description
}
```

Код: `normalizeWebhookPayload()` в
[src/youtrack-gateway.js](src/youtrack-gateway.js).

### 3. Gateway Всегда Публикует JSON В Чат

Любой принятый webhook публикуется в:

```text
youtrack.messages.giscloud.codex
```

Это нужно только для видимости в Web UI. Это не job для Codex.

Код:

- `publishWebhookChatMessage()` в
  [src/youtrack-gateway.js](src/youtrack-gateway.js);
- `startYouTrackMessageWatch()` в
  [examples/agent-web-ui/server/bridge.ts](examples/agent-web-ui/server/bridge.ts).

### 4. Gateway Решает, Нужен Ли Codex Job

Job создается только для:

- `issueCreated`;
- `issueUpdated`.

Job не создается для:

- `commentAdded`;
- `issueUpdated`, где изменилось только поле `Codex Session ID`.

Это защищает от webhook loop: gateway сам пишет комментарии и поле
`Codex Session ID`, но эти изменения не должны повторно запускать Codex.

Код:

- `shouldEnqueueCodexJob()`;
- `isCodexSessionFieldOnlyUpdate()`;
- `enqueueCodexJob()`.

### 5. Gateway Ставит Job В JetStream

Перед постановкой job gateway читает задачу из YouTrack через `yt-mcp-ruby`
или прямой REST fallback и достает текущее
значение custom field:

```text
Codex Session ID
```

Если значение есть, worker сможет продолжить существующий Codex thread. Если
значения нет, worker начнет новый thread.

Job публикуется в:

```text
youtrack.codex.jobs.giscloud
```

### 6. Worker Читает Job

Worker запускается отдельным процессом:

```bash
node src/codex-worker.js
```

Он читает jobs durable consumer-ом:

```text
codex-worker
```

В MVP concurrency равен `1`, чтобы по одной задаче не было параллельных turns в
одном Codex thread.

### 7. Worker Запускает Или Продолжает Codex Thread

Если в job есть `sessionId`, worker делает resume thread. Если `sessionId` нет,
worker начинает новый thread.

Worker читает skill:

```text
skills/youtrack-task-analysis/SKILL.md
```

И добавляет его в prompt вместе с issue data и полным webhook JSON.

### 8. Worker Публикует Result Events

Worker пишет события в:

```text
youtrack.codex.results.giscloud
```

Типы result events:

- `session_started` - thread создан или продолжен;
- `analysis_completed` - Codex вернул итоговый анализ;
- `analysis_failed` - Codex или worker завершился ошибкой.

### 9. Gateway Пишет Результаты В YouTrack Через MCP

Gateway читает results durable consumer-ом:

```text
youtrack-gateway-results
```

В production gateway вызывает MCP tools на `yt-mcp-ruby`:

- `update_custom_fields` - записать `Codex Session ID`;
- `add_issue_comment` - добавить комментарий с результатом;
- `get_issue`, `get_issue_comments`, `get_custom_fields` - чтение и
  диагностика.

Прямой REST с `YOUTRACK_TOKEN` оставлен в коде только как локальный fallback,
если `YOUTRACK_MCP_URL` не задан. Production stack этот token не прокидывает.
Дальше:

- `session_started` -> записывает `Codex Session ID` и добавляет стартовый
  комментарий;
- `analysis_completed` -> добавляет комментарий с результатом анализа;
- `analysis_failed` -> добавляет комментарий с ошибкой.

Код: `handleResultEvent()` в
[src/youtrack-gateway.js](src/youtrack-gateway.js).

<a id="runtime-files"></a>
## Файлы Runtime

| Файл | Назначение |
| --- | --- |
| [src/common.js](src/common.js) | `.env`, `NATS_URL`, подключение к NATS, JSON helpers, форматирование ошибок. |
| [src/jetstream.js](src/jetstream.js) | Создание stream `YT_CODEX`, subjects и durable consumers. |
| [src/youtrack-gateway.js](src/youtrack-gateway.js) | HTTP webhook, Synadia AgentService, YouTrack MCP/REST integration, enqueue jobs, обработка results. |
| [src/youtrack-mcp-client.js](src/youtrack-mcp-client.js) | Минимальный MCP Streamable HTTP client: `initialize`, `tools/list`, `tools/call`, JSON/SSE parsing. |
| [src/codex-worker.js](src/codex-worker.js) | Отдельный worker для Codex jobs. |
| [src/monitor.js](src/monitor.js) | Локальный монитор NATS traffic. |
| [skills/youtrack-task-analysis/SKILL.md](skills/youtrack-task-analysis/SKILL.md) | Инструкция анализа YouTrack задачи для Codex. |

<a id="web-ui"></a>
## Web UI

![Последовательность webhook](docs/diagrams/webhook-sequence.png)

Web UI не подключается к NATS из браузера. Схема такая:

```text
Browser Vue UI
  -> WebSocket /ws
  -> Bun bridge
  -> @synadia-ai/agents
  -> NATS
```

Файлы:

| Файл | Назначение |
| --- | --- |
| [examples/agent-web-ui/server/config.ts](examples/agent-web-ui/server/config.ts) | Читает `NATS_URL` и опциональный `NATS_URLS_JSON`. |
| [examples/agent-web-ui/server/index.ts](examples/agent-web-ui/server/index.ts) | Bun HTTP/WebSocket server, proxy `/youtrack/*`, `/healthz`. |
| [examples/agent-web-ui/server/bridge.ts](examples/agent-web-ui/server/bridge.ts) | Discovery, prompt streaming, heartbeat tracking, подписка на `youtrack.messages.giscloud.codex`. |
| [examples/agent-web-ui/src/composables/useBridge.ts](examples/agent-web-ui/src/composables/useBridge.ts) | Browser WebSocket client. |
| [examples/agent-web-ui/src/stores/agents.ts](examples/agent-web-ui/src/stores/agents.ts) | Список agents и группировка YouTrack/Other. |
| [examples/agent-web-ui/src/components/AgentGrid.vue](examples/agent-web-ui/src/components/AgentGrid.vue) | Карточки agents. |
| [examples/agent-web-ui/src/components/ChatPanel.vue](examples/agent-web-ui/src/components/ChatPanel.vue) | Чат выбранного agent-а. |

<a id="jetstream"></a>
## JetStream

![Поток данных JetStream](docs/diagrams/jetstream-data-flow.png)

На диаграмме показано, что jobs и results лежат в одном stream `YT_CODEX`, но
читаются разными durable consumers.

| Константа | Значение по умолчанию | Где используется |
| --- | --- | --- |
| `YT_CODEX_STREAM` | `YT_CODEX` | Stream для jobs и results. |
| `YT_CODEX_JOB_SUBJECT` | `youtrack.codex.jobs.giscloud` | Gateway publish, worker consume. |
| `YT_CODEX_RESULT_SUBJECT` | `youtrack.codex.results.giscloud` | Worker publish, gateway consume. |
| `CODEX_WORKER_DURABLE` | `codex-worker` | Durable consumer worker-а. |
| `GATEWAY_RESULTS_DURABLE` | `youtrack-gateway-results` | Durable consumer gateway-а. |

`/healthz` и `/youtrack/api-check` показывают состояние stream и consumers.

<a id="deploy"></a>
## Deploy

![Деплой](docs/diagrams/deployment.png)

Deploy описан в:

- [docker/Dockerfile](docker/Dockerfile) - один runtime image с Node, Bun и
  собранным UI;
- [scripts/start-production.js](scripts/start-production.js) - entrypoint
  service-а `app`;
- [stack/nats-synadia-dev.drs](stack/nats-synadia-dev.drs) - Docker Swarm
  services;
- [.gitlab-ci.yml](.gitlab-ci.yml) - build/deploy pipeline.

Service-и:

- `nats` - NATS с `-js`;
- `app` - публичный service, UI + gateway, получает `YOUTRACK_MCP_URL`; прямой
  `YOUTRACK_TOKEN` в stack не прокидывается;
- `codex_worker` - отдельный worker, получает OpenAI/Codex env, но не получает
  `YOUTRACK_TOKEN`.

Как `acodex` попадает в worker:

1. [docker/Dockerfile](docker/Dockerfile) копирует репозиторий в image через
   `COPY . .`, поэтому [scripts/acodex](scripts/acodex) становится
   `/app/scripts/acodex`.
2. [stack/nats-synadia-dev.drs](stack/nats-synadia-dev.drs) задает
   `CODEX_PATH_OVERRIDE=/app/scripts/acodex` для service-а `codex_worker`.
3. [src/codex-worker.js](src/codex-worker.js) передает этот путь в
   `new Codex({ codexPathOverride })`.
4. SDK запускает `/app/scripts/acodex`, wrapper готовит runtime auth/proxy/CA и
   затем делает `exec codex "$@"`.

Локальный файл `/home/komaroff/.local/bin/acodex` в image не копируется.
Секреты передаются только через CI/Vault/runtime env: `CODEX_PROXY_URL`,
`CODEX_MITM_CA_B64`, `CODEX_AUTH_JSON_B64`.

<a id="env"></a>
## Переменные Окружения

| Переменная | Для кого | Назначение |
| --- | --- | --- |
| `NATS_URL` | все процессы | Основная NATS-шина. |
| `NATS_URLS_JSON` | UI | Дополнительные NATS-шины только для discovery. |
| `YOUTRACK_BASE_URL` | gateway | База YouTrack API. |
| `YOUTRACK_MCP_URL` | gateway | Внутренний URL `yt-mcp-ruby`, например `http://agents_yt_mcp_ruby:9292`. Если задан, прямой YouTrack token не нужен. |
| `YOUTRACK_MCP_EXTERNAL_NETWORK` | deploy | Имя внешней Swarm overlay network, общей для `synadia-nats-agents` и `yt-mcp-ruby`. |
| `YOUTRACK_API_CHECK_PROJECT` | gateway | Project shortName для проверки custom fields, например `CS`. |
| `YOUTRACK_TOKEN` | gateway | Локальный direct REST fallback. Production stack его не прокидывает; worker его тоже не получает. |
| `YOUTRACK_WEBHOOK_TOKEN` | gateway | Опциональная проверка webhook request-а. |
| `YOUTRACK_CODEX_SESSION_FIELD` | gateway | Название text custom field для Codex thread id. |
| `YOUTRACK_AGENT_MESSAGE_SUBJECT` | gateway и UI | NATS subject для webhook bubbles. |
| `OPENAI_API_KEY` / `CODEX_API_KEY` | worker | Auth для Codex. Не нужен gateway-у. |
| `CODEX_PATH_OVERRIDE` | worker | Путь к wrapper-у Codex CLI. В production: `/app/scripts/acodex`. |
| `CODEX_PROXY_URL` | worker | Proxy URL для `scripts/acodex`; хранить только в CI/Vault/env. |
| `CODEX_MITM_CA_B64` | worker | Base64 PEM CA для proxy/MITM; хранить только в CI/Vault/env. |
| `CODEX_AUTH_JSON_B64` | worker | Base64 `~/.codex/auth.json`, если worker работает через Codex CLI auth вместо API key. Хранить только в CI/Vault/env. |
| `CODEX_DRY_RUN` | worker, gateway | Локальный smoke без реального Codex. |
| `YOUTRACK_DRY_RUN` | gateway | Локальный smoke без записи в YouTrack. |
| `CODEX_SANDBOX_MODE` | worker | По умолчанию `read-only`. |
| `CODEX_APPROVAL_POLICY` | worker | По умолчанию `never`. |
| `CODEX_NETWORK_ACCESS` | worker | По умолчанию `false`. |
| `CODEX_WEB_SEARCH` | worker | По умолчанию `disabled`. |

<a id="removed"></a>
## Что Удалено Из Старой Версии

В текущем runtime нет:

- basic agents;
- controller/group sessions;
- personas;
- OpenClaw plugins/scripts;
- Ollama config;
- query-param выбора NATS через `?nats=...`;
- HTTP endpoint-а `/youtrack/agent-messages`.

Это намеренное упрощение. В проекте остался один основной сценарий:
YouTrack webhook ставит job, worker анализирует задачу, gateway пишет результат
в YouTrack.
