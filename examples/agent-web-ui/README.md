# agent-web-ui

Локальная копия Synadia `examples/agent-web-ui`, адаптированная для проекта
`synadia-nats-agents`.

```text
Browser (Vue 3)  ->  Bun server /ws  ->  @synadia-ai/agents  ->  NATS  ->  agents
```

SDK `@synadia-ai/agents` работает в Node/Bun, а не в браузере. Поэтому браузер
общается только с Bun bridge по WebSocket `/ws`, а bridge уже держит NATS
connection, делает discovery и стримит ответы.

## Запуск

Из корня проекта удобнее так:

```bash
npm run ui:bridge  # Bun bridge на :3300
npm run ui:vite    # Vite UI на http://localhost:5173
```

Или прямо отсюда:

```bash
bun install
bun run dev
bun run vite
```

Production-like режим:

```bash
bun run build
bun run start      # http://localhost:3300
```

## NATS config

По умолчанию bridge подключается к локальному NATS:

```text
nats://127.0.0.1:4222
```

Можно переопределить:

```bash
NATS_URL=nats://host:4222 bun run dev
bun run server/index.ts --servers nats://host:4222 --dev
bun run server/index.ts --context current --dev
```

## Групповой prompt

Галочки на карточках создают controller-managed group session для `basic`
persona agents.

```text
selected agents
  -> basic-group-create через Bun bridge
  -> agents.group.create.basic.demo.control
  -> новый discoverable NATS agent group-N
  -> prompt уже в group-N
  -> controller собирает ответы persona agents и хранит общий context
```

Это ровно тот механизм, который нужен для учебного сценария:
один вопрос уходит нескольким persona agents, а разные ответы появляются из-за
разных `systemPrompt` в `src/personas.js`.
