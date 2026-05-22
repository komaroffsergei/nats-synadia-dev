# NATS Connections

Короткая карта NATS endpoints, которые сейчас важны для этого demo.

## Local Demo

```text
nats://127.0.0.1:4222
```

Используется при локальном запуске:

```sh
npm run nats
npm run controller
npm run ui
```

## Production Demo On Gis-master

```text
nats://nats-synadia-dev_nats:4222
```

Это внутренний NATS service текущего stack-а `nats-synadia-dev`.
Публичный браузер его не видит: browser ходит в `https://nats-synadia-dev.gis-master.ru/ws`,
а Bun bridge внутри app container уже подключается к NATS.

Переопределить NATS для app/container можно через любой из env:

```text
NATS_URL
NATS_SERVERS
NATS_SERVICE_URL
```

Приоритет: `NATS_URL` -> `NATS_SERVERS` -> `NATS_SERVICE_URL` -> default.

Если нужный NATS не находится в default network текущего stack-а, app container
можно подключить к уже существующей docker network:

```text
NATS_EXTERNAL_NETWORK
```

Это не заменяет `NATS_URL`: network только даёт контейнеру маршрут/DNS, а
`NATS_URL` всё равно указывает конкретный NATS server.

## Nats-agent-ruby On Gis-master

Соседний проект `ai-assistant/services/nats-agent-ruby` поднимает web UI на
`gis-master` и подключает его к внутреннему NATS в docker network:

```text
network: rag-stack_default
host:    rag-stack_inference_nats
port:    4222
```

Практический запуск нашего UI к этому NATS делается через deploy variables:

```text
NATS_EXTERNAL_NETWORK=rag-stack_default
NATS_URL=nats://<user>:<password>@rag-stack_inference_nats:4222
START_BASIC_AGENTS=false
```

Credentials намеренно не дублируются в этом репозитории и не должны попадать в
README/логи. Источник правды - deploy config/CI variables проекта
`nats-agent-ruby`.

`START_BASIC_AGENTS=false` оставляет только UI bridge. Без этого наш production
container тоже зарегистрирует учебные `basic.demo.*` agents в чужой NATS-шине.

Ожидаемый внешний agent после подключения:

```text
agents.prompt.weather.dev.h100
agents.hb.weather.dev.h100
agents.status.weather.dev.h100
```

Weather agent в соседнем проекте ожидает координаты. Сейчас в UI добавлен
adapter: для `agents.prompt.weather.dev.h100` показываются поля `lat` и `lon`,
а bridge отправляет их в top-level fields NATS envelope:

```text
{
  "prompt": "как погода в йошкар оле",
  "lat": 56.6328,
  "lon": 47.8951
}
```

Ruby weather agent читает эти поля как `Envelope.extra` и больше не требует
писать координаты прямо в prompt. Старый текстовый smoke вариант тоже остаётся
рабочим:

```text
lat=54.9885 lon=73.3242. Кратко опиши текущую погоду для проверки связи.
```

Проверено после deploy 2026-05-22:

```text
healthz nats: nats://<redacted>@rag-stack_inference_nats:4222
discovery:    agents.prompt.weather.dev.h100
prompt:       ack -> done, ответ получен
```

## Voice-chat Audio NATS

Найден в соседнем Monitorsoft проекте `voice-chat/webrtc-komaroff`.

```text
service name: web-rtc-komaroff_audio_nats
client port: 4222
websocket port: 9222
public websocket route: https://webrtc-komaroff.gis-master.ru/ws
```

Внутри Swarm это основной `audio_nats` service для `webrtc-komaroff`.
Credentials описаны в source stack-е `voice-chat/webrtc-komaroff/stack/webrtc.drs`,
но здесь намеренно не дублируются.

Проверка публичного WebSocket route без upgrade возвращает `HTTP/2 405` и
`sec-websocket-version: 13`, то есть Traefik route живой и ждёт WebSocket
upgrade.

## H100 Inference NATS Leafnode

Найденный endpoint:

```text
nats://192.168.28.134:37422
```

Проверка TCP:

```text
192.168.28.134:37422 -> open
192.168.28.134:4222  -> closed/refused
192.168.28.134:8222  -> closed/refused
```

Важное ограничение: это leafnode endpoint, а не обычный client NATS port.
Проверка обычным NATS client-ом возвращает:

```text
attempted to connect to leaf node port
```

Поэтому UI bridge нельзя просто направить на `nats://192.168.28.134:37422`
как на обычный NATS server. Для работы с H100 inference bus нужно подключаться
к `audio_nats`, который уже настроен как leafnode/import bridge к H100.

Практический вывод:

- для local/dev можно пробовать обычный `NATS_URL=nats://host:4222`;
- для H100 inference напрямую `192.168.28.134:37422` не подходит как client URL;
- для gis-master сценария нужен доступ из app container к `web-rtc-komaroff_audio_nats:4222`
  или отдельный normal-client NATS endpoint, если его откроют.
