# synadia-nats-agents

Минимальный учебный проект вокруг Synadia Agent Protocol for NATS.

```text
Synadia Vue UI
  -> WebSocket /ws
  -> Bun bridge из examples/agent-web-ui
  -> @synadia-ai/agents
  -> NATS
  -> controller + persona agents
  -> Ollama
  -> streaming responses
```

## Документация и схемы

- [CODE_MAP.md](CODE_MAP.md) - карта ключевых файлов и мест, где реализован функционал.
- [docs/diagrams/architecture.png](docs/diagrams/architecture.png) - связь UI, Bun bridge, NATS, controller, persona agents, group sessions и OpenClaw.
- [docs/diagrams/group-session-sequence.png](docs/diagrams/group-session-sequence.png) - последовательность вызовов при групповом вопросе.
- [docs/diagrams/deployment.png](docs/diagrams/deployment.png) - публикация через GitLab CI, Docker registry и dry-stack на `gis-master.ru`.
- [docs/publishing/2026-05-22-publication-log.md](docs/publishing/2026-05-22-publication-log.md) - журнал публикации и ошибок без секретов.

![Архитектура](docs/diagrams/architecture.png)

## Что здесь есть

- `src/basic-controller.js` - запускает controller и пять persona agents.
- `src/personas.js` - русские роли: `teacher`, `engineer`, `skeptic`, `manager`, `moderator`.
- `examples/agent-web-ui/` - перенесенный Synadia `examples/agent-web-ui` с локальными правками.
- `plugins/basic-tools/` - OpenClaw command `/basic` и tool `basic_ask`.
- `scripts/prepare-openclaw-nats-channel.js` - подключает официальный `@synadia-ai/nats-channel`.
- `src/monitor.js` - печатает NATS traffic для обучения.

## Где описан controller

Главное место:

- `src/basic-controller.js`, функция `createControllerAgent()`.

Именно там создаётся `new AgentService({ ... })` для `control`:

```js
name: CONTROL_NAME,
session: CONTROL_NAME,
extraMetadata: {
  role: "controller",
  platform: "synadia-agent-web-ui-demo",
},
extraEndpoints: [
  addJsonEndpoint("list", controlSubject("list"), ...),
  addJsonEndpoint("personas", controlSubject("personas"), ...),
  addJsonEndpoint("review", controlSubject("review"), ...),
],
```

По-простому: controller - это не специальная магия Synadia, а обычный
`AgentService`, которому мы дали имя `control` и metadata `role=controller`.
UI видит это поле и кладёт карточку в отдельную секцию `Контроллеры`.

Связанные места:

- `src/common.js` - задаёт константу `CONTROL_NAME = "control"` и общую subject-схему.
- `src/basic-controller.js` - `controlSubject("list" | "personas" | "review")` создаёт служебные subjects controller-а.
- `examples/agent-web-ui/src/stores/agents.ts` - `bucketOf()` читает `metadata.role` и относит `basic/control` к `BASIC_CONTROL`.
- `examples/agent-web-ui/src/components/AgentCard.vue` - controller-карточка получает badge `CONTROLLER` и не получает checkbox для group prompt.
- `plugins/basic-tools/index.js` - OpenClaw `/basic` ищет именно `agent=basic`, `owner=demo`, `name=control`.

Полезная команда, чтобы увидеть controller вживую:

```sh
nats req agents.list.basic.demo.control '{}'
```

## Установка

```sh
cd /home/komaroff/dev/monitorsoft/synadia-nats-agents
npm install
cd examples/agent-web-ui
bun install
```

Настройки смотри в `.env.example`. По умолчанию проект ждёт:

```text
NATS_URL=nats://127.0.0.1:4222
BASIC_OWNER=demo
OLLAMA_BASE_URL=http://ollama.h100.local
OLLAMA_MODEL=qwen3.5:9b
```

## Запуск

В отдельных терминалах:

```sh
npm run nats
npm run controller
npm run monitor
```

UI в dev-режиме:

```sh
npm run ui:bridge
npm run ui:vite
```

Открыть:

```text
http://localhost:5173
```

Production-like режим:

```sh
npm run ui:build
npm run ui
```

Открыть:

```text
http://localhost:3300
```

Healthcheck production server-а:

```sh
curl --noproxy '*' http://localhost:3300/healthz
```

## Как работает UI

Браузер не подключается к NATS напрямую.

```text
Browser -> /ws -> Bun bridge -> @synadia-ai/agents -> NATS
```

Bun bridge держит один NATS client, делает discovery через `$SRV.INFO.agents`,
слушает heartbeats и стримит ответы обратно в браузер по WebSocket.

После запуска controller UI должен показать:

- `teacher` - Учитель.
- `engineer` - Инженер.
- `skeptic` - Скептик.
- `manager` - Менеджер.
- `moderator` - Модератор, сравнивает ответы других agents.
- `control` - controller, отдельная секция `Контроллеры`.

Один вопрос одному агенту:

```text
Открой карточку teacher -> напиши prompt -> ответит только Учитель.
```

Один вопрос нескольким агентам:

```text
1. Отметь галочками teacher, engineer, skeptic.
2. В нижней панели включи "Controller group session".
3. Напиши prompt и отправь.
4. UI попросит control создать настоящую group session, например group-1.
5. UI откроет карточку group-1 и отправит туда первый prompt.
```

Важно: для `basic` persona agents группа создаётся controller-ом как настоящий
NATS agent. Именно эта session хранит общий контекст прошлых групповых сообщений
в памяти controller process.

Оценить ответы всех agents:

```text
1. Дождись ответа в controller group session.
2. В поле "Как moderator должен оценивать ответы?" напиши критерий:
   "оцени по полноте и практической пользе".
3. Нажми "Оценить ответы".
4. UI соберёт исходный вопрос + ответы всех выбранных agents и отправит их
   отдельному agent-у moderator.
```

Это демонстрирует, как agent получает доступ к ответам других agents:
не через скрытую shared memory, а через явный transcript, переданный в prompt.

## Subjects

Controller:

```text
agents.prompt.basic.demo.control
agents.status.basic.demo.control
agents.hb.basic.demo.control
agents.list.basic.demo.control
agents.personas.basic.demo.control
agents.review.basic.demo.control
agents.group.create.basic.demo.control
agents.group.list.basic.demo.control
agents.group.stop.basic.demo.control
```

Persona agents:

```text
agents.prompt.basic.demo.teacher
agents.prompt.basic.demo.engineer
agents.prompt.basic.demo.skeptic
agents.prompt.basic.demo.manager
agents.prompt.basic.demo.moderator
```

Controller-managed group sessions:

```text
agents.prompt.basic.demo.group-1
agents.status.basic.demo.group-1
agents.hb.basic.demo.group-1
```

Такие sessions создаются динамически через controller. Это настоящие NATS
agents: их видно через discovery, у них есть собственный prompt subject, а общий
контекст группы хранится в controller process.

OpenClaw official channel:

```text
agents.prompt.oc.demo.openclaw
agents.status.oc.demo.openclaw
agents.hb.oc.demo.openclaw
```

## Проверка через NATS CLI

Discovery:

```sh
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s
```

Prompt persona напрямую:

```sh
nats req agents.prompt.basic.demo.teacher \
  '{"prompt":"объясни роль controller как ребенку"}' \
  --wait-for-empty --reply-timeout=180s --timeout=300s --raw
```

Prompt controller:

```sh
nats req agents.prompt.basic.demo.control \
  '{"prompt":"объясни путь запроса за 3 пункта"}' \
  --wait-for-empty --reply-timeout=180s --timeout=300s --raw
```

List demo agents:

```sh
nats req agents.list.basic.demo.control '{}'
```

List personas:

```sh
nats req agents.personas.basic.demo.control '{}'
```

Review через controller endpoint:

```sh
nats req agents.review.basic.demo.control '{
  "original_prompt": "зачем нужен controller?",
  "criteria": "оцени по простоте, точности и практической пользе",
  "answers": [
    {"agent":"teacher","text":"Controller похож на диспетчера..."},
    {"agent":"engineer","text":"Controller даёт стабильную точку входа..."},
    {"agent":"skeptic","text":"Риск в том, что controller станет бутылочным горлом..."}
  ]
}' --timeout=600s
```

Создать динамическую group session через controller:

```sh
nats req agents.group.create.basic.demo.control '{
  "personas": ["teacher", "engineer", "skeptic"],
  "label": "Учебная группа"
}'
```

После ответа появится новый subject вроде:

```text
agents.prompt.basic.demo.group-1
```

Теперь можно писать уже в саму group session:

```sh
nats req agents.prompt.basic.demo.group-1 \
  '{"prompt":"как controller собирает общий контекст?"}' \
  --wait-for-empty --reply-timeout=180s --timeout=600s --raw
```

Посмотреть группы:

```sh
nats req agents.group.list.basic.demo.control '{}'
```

Остановить группу:

```sh
nats req agents.group.stop.basic.demo.control '{"session_id":"group-1"}'
```

## OpenClaw

Подключить официальный NATS channel и локальный `/basic` plugin:

```sh
npm run openclaw:restart
```

Проверить OpenClaw agent через NATS:

```sh
nats req agents.prompt.oc.demo.openclaw \
  '{"prompt":"/basic объясни путь OpenClaw -> NATS -> controller"}' \
  --wait-for-empty --reply-timeout=180s --timeout=300s --raw
```

## Проверки разработки

```sh
node --check src/*.js scripts/*.js plugins/basic-tools/index.js
cd examples/agent-web-ui && bun run typecheck && bun run build
```

Если Ollama недоступна:

```sh
curl --noproxy '*' http://ollama.h100.local/api/tags
```

## Публикация на gis-master.ru

Remote для публикации:

```sh
git remote set-url origin https://git.giscloud.ru/trizna/nats-synadia-dev.git
```

Pipeline устроен по аналогии с `webrtc-komaroff`:

```text
push to GitLab
  -> .gitlab-ci.yml
  -> docker/Dockerfile.build
  -> build-labels + docker buildx
  -> builder-registry.builder.giscloud.ru/trizna/nats-synadia-dev/app/main
  -> stack/Dockerfile.deploy
  -> dry-stack swarm_deploy
  -> https://nats-synadia-dev.gis-master.ru
```

Deployment stack:

- `stack/nats-synadia-dev.drs` - dry-stack описание.
- `Service :nats` - внутренняя NATS шина demo.
- `Service :app` - UI + controller + persona agents.
- `ingress host: 'nats-synadia-dev.*'` - ожидаемый публичный адрес `https://nats-synadia-dev.gis-master.ru`.

После deploy быстрые проверки:

```sh
curl --noproxy '*' https://nats-synadia-dev.gis-master.ru/healthz
curl --noproxy '*' -I https://nats-synadia-dev.gis-master.ru/
```
