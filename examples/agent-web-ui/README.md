# Web UI для YouTrack/Codex Agent

Это локальная копия Synadia `examples/agent-web-ui`, оставленная как простой UI
для одного основного agent-а:

```text
agents.prompt.youtrack.giscloud.codex
```

Полный runtime описан в корневом [README](../../README.md), а карта кода - в
[CODE_MAP.md](../../CODE_MAP.md).

## Как UI подключается к NATS

Браузер не подключается к NATS напрямую:

```text
Browser Vue UI
  -> WebSocket /ws
  -> Bun bridge
  -> @synadia-ai/agents
  -> NATS
```

Bun bridge держит server-side NATS connections, делает discovery, стримит prompt
responses и слушает webhook bubbles.

## Сообщения agent-а

Webhook bubbles приходят не через HTTP endpoint, а через NATS subject:

```text
youtrack.messages.giscloud.codex
```

Gateway публикует туда полный JSON webhook-а. Bridge подписывается на subject и
добавляет сообщение в чат найденного `agents.prompt.youtrack.giscloud.codex`.

Endpoint-а `/youtrack/agent-messages` в этой схеме нет.

## Запуск

Из корня проекта:

```bash
npm run ui:bridge  # Bun bridge на http://localhost:3300
npm run ui:vite    # Vite UI на http://localhost:5173
```

Режим, близкий к production:

```bash
bun run build
bun run start      # http://localhost:3300
```

## NATS

Одна основная шина:

```bash
NATS_URL=nats://127.0.0.1:4222 bun run dev
```

Несколько шин только для UI discovery:

```bash
NATS_URLS_JSON='{"main":"nats://127.0.0.1:4222","extra":"nats://host:4222"}' bun run dev
```

Каждая запись создает отдельный NATS client. Discovery объединяется, карточки
получают badge connection-а, а prompt уходит в тот connection, где найден agent.

## Основные файлы

- [server/index.ts](server/index.ts) - Bun HTTP/WebSocket server, proxy
  `/youtrack/*`, `/healthz`.
- [server/bridge.ts](server/bridge.ts) - NATS bridge, discovery, chat streaming,
  подписка на `youtrack.messages.giscloud.codex`.
- [server/config.ts](server/config.ts) - `NATS_URL` и `NATS_URLS_JSON`.
- [src/stores/agents.ts](src/stores/agents.ts) - список agents и группировка.
- [src/components/ChatPanel.vue](src/components/ChatPanel.vue) - чат выбранного
  agent-а.
