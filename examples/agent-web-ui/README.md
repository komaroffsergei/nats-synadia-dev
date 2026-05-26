# agent-web-ui

Локальная копия Synadia `examples/agent-web-ui`, оставленная как простой UI для
YouTrack/Codex gateway agent-а.

```text
Browser (Vue 3) -> Bun server /ws -> @synadia-ai/agents -> NATS -> youtrack.giscloud.codex
```

Браузер не подключается к NATS напрямую. Bun bridge держит server-side NATS
connections, делает discovery, стримит prompt responses и слушает
`youtrack.messages.giscloud.codex`, чтобы webhook JSON сразу появлялся в чате.

## Запуск

Из корня проекта:

```bash
npm run ui:bridge  # Bun bridge на :3300
npm run ui:vite    # Vite UI на http://localhost:5173
```

Production-like режим:

```bash
bun run build
bun run start      # http://localhost:3300
```

## NATS

Основная шина задаётся одной переменной:

```bash
NATS_URL=nats://127.0.0.1:4222 bun run dev
```

Для UI discovery по нескольким независимым NATS-шинам используется только JSON:

```bash
NATS_URLS_JSON='{"main":"nats://127.0.0.1:4222","extra":"nats://host:4222"}' bun run dev
```

Каждая запись создаёт отдельный NATS client. Discovery объединяется, карточки
получают badge connection-а, а prompt уходит в тот connection, где найден agent.

## YouTrack Auto Messages

Gateway публикует webhook bubbles в subject:

```text
youtrack.messages.giscloud.codex
```

Bridge подписывается на этот subject и добавляет сообщение в чат найденного
`agents.prompt.youtrack.giscloud.codex`. Если сообщение пришло раньше первого
discovery, bridge обновляет список agents и затем открывает карточку.
