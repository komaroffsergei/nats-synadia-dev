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
  `NATS_URL`, `BASIC_OWNER`, `OLLAMA_BASE_URL`, `connectNats()`, `streamOllama()`.

- `src/personas.js` - список "личностей".
  Разные ответы получаются не из-за разных моделей, а из-за разных `systemPrompt`.

- `src/monitor.js` - учебный NATS traffic monitor.
  Нужен, чтобы смотреть subjects и payload-ы во время экспериментов.

## Web UI

- `examples/agent-web-ui/server/index.ts` - Bun HTTP/WebSocket server.
  Раздаёт `dist/`, держит `/ws`, отдаёт `/healthz` для deploy-smoke.

- `examples/agent-web-ui/server/bridge.ts` - bridge между browser WebSocket и `@synadia-ai/agents`.
  Делает discovery, prompt streaming, cancel/query reply, а также вызывает group endpoints controller-а.

- `examples/agent-web-ui/server/wire.ts` - wire-contract между browser и Bun bridge.
  Здесь оставлен только текущий demo surface: discovery, prompt streaming и `basic-group-*`.

- `examples/agent-web-ui/src/stores/agents.ts` - классификация найденных agents.
  `bucketOf()` читает metadata и раскладывает карточки на persona/controller/group/openclaw/other.

- `examples/agent-web-ui/src/stores/selection.ts` - состояние галочек.
  Это только `Set<instanceId>`, общий контекст здесь не хранится.

- `examples/agent-web-ui/src/components/MultiSelectBar.vue` - групповой prompt из UI.
  Если выбраны basic personas, компонент просит controller создать group session и отправляет первый prompt уже в `group-N`.

- `examples/agent-web-ui/src/components/ChatPanel.vue` - правый чат выбранного agent-а или group session.

- `examples/agent-web-ui/src/composables/promptStreaming.ts` - сборка streaming events в сообщения чата.

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
  Ждёт NATS TCP, запускает controller и Bun UI server.

- `docker/docker-compose.yml` - build-labels target для image `trizna/nats-synadia-dev/app/<branch>`.

- `stack/nats-synadia-dev.drs` - dry-stack deployment:
  `nats` service + публичный `app` service на `nats-synadia-dev.gis-master.ru`.

- `stack/deploy.sh` - deploy wrapper с поддержкой GitLab SSH key variables и retry.

- `docs/publishing/2026-05-22-publication-log.md` - журнал публикации, ошибок и решений без секретов.
