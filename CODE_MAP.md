# Code Map

Карта показывает, где лежат ключевые места учебного проекта и что в них важно.

## Runtime

- `src/basic-controller.js` - главный backend process.
  Здесь создаются:
  - controller agent `control`;
  - persona agents `teacher`, `engineer`, `skeptic`, `manager`, `moderator`;
  - динамические group session agents `group-N`.

- `src/basic-controller.js#createControllerAgent()` - место, где описан controller.
  Ключевой marker: `extraMetadata.role = "controller"`.
  Это прикладная metadata для UI, а не отдельный класс NATS.

- `src/basic-controller.js#createGroupSession()` - endpoint `agents.group.create.basic.demo.control`.
  Получает список persona ids и создаёт новый `AgentService` с `role=session`.

- `src/basic-controller.js#streamGroupAnswer()` - основной group-flow.
  Последовательно спрашивает выбранные persona agents, собирает ответы, делает итоговый synthesis и сохраняет turn в `groupSessions`.

- `src/basic-controller.js#groupSessions` - in-memory общий контекст групп.
  После рестарта process он исчезает. Для production это место можно заменить на NATS KV/JetStream.

- `src/common.js` - общая конфигурация и helper-ы:
  `NATS_URL`, alias-ы `NATS_SERVERS`/`NATS_SERVICE_URL`, `BASIC_OWNER`, `OLLAMA_BASE_URL`, `connectNats()`, `streamOllama()`.

- `src/personas.js` - список "личностей".
  Разные ответы получаются не из-за разных моделей, а из-за разных `systemPrompt`.

- `src/monitor.js` - учебный NATS traffic monitor.
  Нужен, чтобы смотреть subjects и payload-ы во время экспериментов.

## Web UI

- `examples/agent-web-ui/server/index.ts` - Bun HTTP/WebSocket server.
  Раздаёт `dist/`, держит `/ws`, отдаёт `/healthz` для deploy-smoke.
  NATS можно задать через `--nats-url`, `--servers`, `NATS_URL`, `NATS_SERVERS`, `NATS_SERVICE_URL`.
  Несколько независимых NATS задаются через `NATS_CONNECTIONS=name=url;name2=url2`.

- `examples/agent-web-ui/server/bridge.ts` - bridge между browser WebSocket и `@synadia-ai/agents`.
  Делает discovery по всем configured NATS connections, prompt streaming,
  cancel/query reply, а также вызывает group endpoints controller-а через тот
  NATS client, где найден agent.
  Для weather adapter-а принимает `extra.lat/lon` и вручную собирает NATS
  envelope, потому публичный `Agent.prompt()` SDK принимает только text/attachments.

- `examples/agent-web-ui/server/wire.ts` - wire-contract между browser и Bun bridge.
  Здесь оставлен только текущий demo surface: discovery, prompt streaming,
  prompt `extra` для adapter-ов и `basic-group-*`.
  `DiscoveredAgentDTO.instanceId` получает prefix connection-а, а raw id хранится
  в `rawInstanceId`.

- `examples/agent-web-ui/src/stores/agents.ts` - классификация найденных agents.
  `bucketOf()` читает metadata и раскладывает карточки на persona/controller/group/openclaw/other.

- `examples/agent-web-ui/src/stores/selection.ts` - состояние галочек.
  Это только `Set<instanceId>`, общий контекст здесь не хранится.

- `examples/agent-web-ui/src/components/MultiSelectBar.vue` - групповой prompt из UI.
  Если выбраны basic personas, компонент просит controller создать group session и отправляет первый prompt уже в `group-N`.

- `examples/agent-web-ui/src/components/AgentCard.vue` - карточка agent-а.
  Для `BASIC GROUP` здесь находится кнопка `×`: она ищет `BASIC CONTROL`, вызывает `basicGroupStop()`, убирает карточку и чистит локальный chat state.

- `examples/agent-web-ui/src/components/ChatPanel.vue` - правый чат выбранного agent-а или group session.
  Здесь включается weather adapter для `agents.prompt.weather.dev.h100`.

- `examples/agent-web-ui/src/components/PromptArea.vue` - ввод prompt-а.
  Для weather agent-а показывает поля `lat/lon` и примеры "Йошкар-Ола",
  "Омск", "Сводка".

- `examples/agent-web-ui/src/composables/promptStreaming.ts` - сборка streaming events в сообщения чата.
  Передаёт prompt `extra` в bridge и показывает lat/lon в истории сообщения.


## OpenClaw

- `plugins/basic-tools/index.js` - локальный OpenClaw plugin.
  Tool `basic_ask` отправляет вопрос в `agents.prompt.basic.demo.control`.

- `plugins/basic-tools/openclaw.plugin.json` - manifest plugin-а.

- `scripts/prepare-openclaw-nats-channel.js` - готовит официальный Synadia NATS channel для OpenClaw.

- `scripts/prepare-openclaw-basic-tools.js` - регистрирует локальный `/basic` command/tool.

## Публикация

- `.gitlab-ci.yml` - build/deploy pipeline по аналогии с `webrtc-komaroff`.

- `docker/Dockerfile` - production image: Node + Bun, UI build, запуск `scripts/start-production.js`.

- `scripts/start-production.js` - один container entrypoint.
  Ждёт NATS TCP, запускает Bun UI server и, если `START_BASIC_AGENTS` не выключен,
  поднимает controller/persona agents рядом.
  Если задан `NATS_CONNECTIONS`, ждёт TCP доступность всех URL из этого списка.

- `docker/docker-compose.yml` - build-labels target для image `trizna/nats-synadia-dev/app/<branch>`.

- `stack/nats-synadia-dev.drs` - dry-stack deployment:
  `nats` service + публичный `app` service на `nats-synadia-dev.gis-master.ru`.
  `NATS_URL` внутри stack-а можно переопределить env-ами `NATS_URL`/`NATS_SERVERS`/`NATS_SERVICE_URL`.
  `NATS_CONNECTIONS` пробрасывается в UI для multi-NATS discovery.
  `NATS_EXTERNAL_NETWORK` дополнительно подключает `app` к уже существующей docker network,
  например `rag-stack_default` для NATS из `nats-agent-ruby`.
  `START_BASIC_AGENTS=false` переводит production container в UI-only режим.

- `stack/deploy.sh` - deploy wrapper с поддержкой GitLab SSH key variables и retry.

- `docs/publishing/2026-05-22-publication-log.md` - журнал публикации, ошибок и решений без секретов.

- `docs/NATS_CONNECTIONS.md` - найденные NATS endpoints:
  local demo, production demo, `voice-chat` `audio_nats` и H100 leafnode endpoint.

- `docs/DEPLOY_SCENARIOS.md` - варианты deploy-а:
  isolated demo, UI-only dashboard поверх чужого NATS, UI + demo agents,
  weather adapter, monitor service и reviewer/controller.
