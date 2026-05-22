# Deploy Scenarios

Здесь зафиксировано, что именно имеет смысл деплоить вокруг текущего
`examples/agent-web-ui`, что это даст в текущем кейсе `nats-agent-ruby`, и куда
это можно развивать дальше.

## Текущий кейс: подключить UI к NATS nats-agent-ruby

Цель: открыть наш `https://nats-synadia-dev.gis-master.ru` как dashboard поверх
той же NATS-шины, где живёт weather agent из
`ai-assistant/services/nats-agent-ruby`.

Практический deploy:

```text
NATS_EXTERNAL_NETWORK=rag-stack_default
NATS_URL=nats://<user>:<password>@rag-stack_inference_nats:4222
START_BASIC_AGENTS=false
```

Что это даст сразу:

- UI bridge подключится к чужому NATS изнутри `gis-master` swarm network.
- Discovery должен увидеть agent `weather/dev/h100`, если он реально доступен
  через `rag-stack_inference_nats`.
- Наши учебные `basic.demo.*` agents не будут зарегистрированы в чужой шине,
  потому что `START_BASIC_AGENTS=false`.
- `/healthz` покажет, к какому NATS подключён UI, с замазанными credentials.

Ограничение текущего формата: weather agent ожидает координаты. Обычный prompt
из нашего generic UI отправляет только `prompt`, без `extra.lat` и `extra.lon`.
Текущий Ruby agent умеет вытащить координаты из текста, поэтому smoke prompt
работает, если написать их явно: `lat=54.9885 lon=73.3242 ...`.

Для нормального UX всё равно полезен маленький adapter или form: пользователь
будет заполнять координаты отдельными полями, а bridge будет отправлять их как
`extra.lat` и `extra.lon`.

## Что можно деплоить сейчас

### 1. Isolated demo

Параметры:

```text
NATS_URL=nats://nats-synadia-dev_nats:4222
START_BASIC_AGENTS=true
```

Что получаем:

- полностью самостоятельный учебный стенд;
- controller, persona agents, group sessions;
- OpenClaw `/basic` поверх local NATS;
- безопасное место для экспериментов без влияния на чужие agents.

### 2. UI-only dashboard поверх чужого NATS

Параметры:

```text
NATS_EXTERNAL_NETWORK=<external docker network>
NATS_URL=<internal NATS url>
START_BASIC_AGENTS=false
```

Что получаем:

- один web-интерфейс для discovery чужих Synadia-compatible agents;
- проверку heartbeat/status/prompt endpoints;
- быструю диагностику "видит ли UI agent-а";
- минимальное вмешательство в чужую NATS-шину.

### 3. UI + наши demo agents в общей NATS-шине

Параметры:

```text
NATS_EXTERNAL_NETWORK=<external docker network>
NATS_URL=<internal NATS url>
START_BASIC_AGENTS=true
```

Что получаем:

- можно сравнивать чужих agents и наших persona agents в одном UI;
- можно демонстрировать group controller рядом с внешними agents;
- можно тестировать совместимость discovery/status/prompt на одной шине.

Минус: мы регистрируем `basic.demo.*` services в чужом NATS. Для аккуратного
первого подключения лучше начинать с `START_BASIC_AGENTS=false`.

## Что стоит добавить дальше

### Weather adapter

Зачем: generic prompt не знает про `extra.lat/lon`, а weather agent умеет
работать с координатами.

Варианты:

- UI form для выбранного `weather` agent-а: prompt + lat + lon.
- Server-side adapter: если agent `weather/dev/h100`, bridge добавляет `extra`
  в envelope.
- Controller command: `ask_weather(prompt, lat, lon)` как отдельный endpoint.

Польза: можно не просто увидеть weather agent в discovery, а реально дергать
его из общего dashboard.

### Monitor service

Зачем: для эксплуатации важнее не только чат, но и состояние agents.

Что можно собирать:

- `$SRV.INFO.agents` - какие agents и endpoints зарегистрированы;
- `$SRV.STATS.agents` - сколько requests/errors у endpoints;
- `agents.hb.*` - живые heartbeats и пропавшие instances;
- `/healthz` нашего bridge - к какому NATS он подключён.

Польза: dashboard становится не только demo-chat, но и обзором здоровья
agent-сети.

### Reviewer/controller поверх группы agents

Зачем: пользователь хочет один вопрос отправить нескольким agents, а потом
получить итоговую оценку/сравнение.

Как правильно: controller должен быть тем, кто сам вызывает agents и получает
их ответы на свои reply subjects. Просто "подслушать все ответы" нельзя
надёжно, потому что ответы в Synadia protocol идут в private reply inbox
requester-а, а не broadcast-ом.

Польза: можно строить judge/reviewer agent-а, который видит все ответы именно
потому, что он организовал этот group prompt.

### Format bridge

Зачем: не все сервисы будут строго совпадать с нашим текущим UI contract.

Что может делать bridge:

- преобразовывать внешний API/service в Synadia-compatible agent;
- добавлять domain-specific `extra`;
- нормализовать metadata для UI buckets;
- прятать credentials и внутренние hostnames.

Польза: dashboard сможет подключать не только "идеальные" Synadia agents, но и
прикладные сервисы с близким, но не полностью одинаковым форматом.

## Почему это вообще полезно

- Один UI для разных agents вместо отдельного интерфейса на каждый сервис.
- Быстрая проверка "agent живой, discoverable, отвечает, stream не ломается".
- Сравнение нескольких реализаций одного навыка на одной NATS-шине.
- Отладка protocol compatibility между Ruby/JS/другими SDK.
- Основа для monitoring plane: discovery, heartbeat, stats, errors.
- Основа для orchestration plane: controller, group sessions, reviewer,
  routing, adapters.
