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
bun run server/index.ts --nats-url nats://host:4222 --dev
bun run server/index.ts --servers nats://host:4222 --dev
bun run server/index.ts --context current --dev
```

Env alias-ы тоже поддерживаются:

```bash
NATS_SERVERS=nats://host:4222 bun run dev
NATS_SERVICE_URL=nats://host:4222 bun run dev
```

Если URL содержит token или `user:password`, `/healthz` и server log показывают
адрес с redaction, без secret material.

## Несколько NATS

Для демонстрации agents из разных независимых NATS-шин:

```bash
NATS_CONNECTIONS='demo=nats://127.0.0.1:4222;weather=nats://host:4222;mytest=nats://test-host:4222' bun run dev
```

Каждая запись `name=url` создаёт отдельный NATS client. Discovery объединяется,
карточки получают badge `name`, а prompt уходит обратно в тот connection, где
agent был найден.

## Weather adapter

Для external agent-а `agents.prompt.weather.dev.h100` UI показывает поля
`lat/lon` и примеры запросов. Prompt отправляется как обычный текст, а
координаты уходят в NATS envelope отдельными top-level fields:

```json
{
  "prompt": "как погода в йошкар оле",
  "lat": 56.6328,
  "lon": 47.8951
}
```

Примеры из интерфейса:

```text
Йошкар-Ола: 56.6328, 47.8951
Омск:       54.9885, 73.3242
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

Удаление идёт тем же маршрутом, только через `basic-group-stop`:

```text
кнопка × на карточке BASIC GROUP
  -> basicGroupStop(control.instanceId, group.metadata.group_id)
  -> basic-group-stop через Bun bridge
  -> agents.group.stop.basic.demo.control
  -> controller останавливает group-N
  -> UI убирает карточку и чистит local chat state
```

Это ровно тот механизм, который нужен для учебного сценария:
один вопрос уходит нескольким persona agents, а разные ответы появляются из-за
разных `systemPrompt` в `src/personas.js`.
