# Codex automation pattern

Документ фиксирует решение для YouTrack/NATS automation: как запускать Codex из
worker-а и где уместен `codex exec --json` через локальный wrapper.

## Решение

Для постоянного NATS worker-а используем `@openai/codex-sdk`.

`codex exec --json` через `acodex` оставляем как отладочный, fallback и
one-shot интерфейс. Он полезен для ручной проверки и CI, но не должен быть
основным control plane для долгоживущего worker-а.

Причина: SDK лучше соответствует модели сервиса. Worker уже живет в Node.js,
читает NATS/JetStream, публикует результаты и должен уметь стримить события,
отменять turn, продолжать thread и ограничивать окружение дочернего процесса.

Важно: SDK не является отдельным удаленным API. Локальный `@openai/codex-sdk`
оборачивает Codex CLI, запускает его как дочерний процесс и общается с ним через
JSONL по `stdin`/`stdout`. Поэтому требования к auth, `CODEX_HOME`, sandbox,
рабочему каталогу и установленному Codex остаются актуальными.

## Сравнение

| Подход | Где использовать | Преимущества | Недостатки |
| --- | --- | --- | --- |
| `codex exec --json` через `acodex` | Ручная проверка, CI, cron, простой one-shot webhook, аварийный fallback | Минимальная интеграция, легко повторить из shell, отдельный процесс на каждый запуск, wrapper централизует CA/proxy | Нужно самому парсить JSONL, stderr и exit code; сложнее cancellation/resume; выше риск ошибок quoting; холодный старт на каждый запрос |
| `@openai/codex-sdk` | Долгоживущий NATS/JetStream worker | Typed events, `runStreamed()`, `AbortSignal`, thread/resume, structured output, явное управление env и working directory | Все равно зависит от CLI; нужно управлять concurrency, timeout и cleanup; при низкоуровневых сбоях иногда проще смотреть raw `codex exec --json` |
| `app-server`/daemon | Интерактивный remote control, websocket/JSON-RPC управление Codex | Долгоживущий server surface | Требует installer-managed standalone Codex по фиксированному пути; это отдельный режим, не замена worker-а |

## Практическое правило

1. Production worker вызывает Codex через `@openai/codex-sdk`.
2. Worker публикует в NATS только нормализованные события и итоговый результат.
3. `acodex exec --json` используется для диагностики тем же prompt-ом, который
   worker отправляет через SDK.
4. Если нужен CA/proxy wrapper, сначала предпочитаем явный `env` в SDK. Wrapper
   подключаем через `codexPathOverride` только осознанно и после локальной
   проверки.
5. Для YouTrack задач sandbox по умолчанию должен быть read-only, approval -
   `never`, network - выключен, если анализу не нужны внешние запросы.

## Минимальная форма SDK worker-а

```js
import { Codex } from "@openai/codex-sdk";

const codexEnv = {};
for (const key of ["PATH", "HOME", "CODEX_HOME", "OPENAI_API_KEY"]) {
  if (process.env[key]) codexEnv[key] = process.env[key];
}

const codex = new Codex({
  env: codexEnv,
});

const thread = codex.startThread({
  workingDirectory: "/path/to/repo",
  sandboxMode: "read-only",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  webSearchMode: "disabled",
});

const { events } = await thread.runStreamed("Analyze this YouTrack issue");

for await (const event of events) {
  if (event.type === "item.completed") {
    // Publish normalized progress to NATS here.
  }
  if (event.type === "turn.completed") {
    // Publish usage and final state here.
  }
}
```

## Диагностическая форма через CLI

```sh
/home/komaroff/.local/bin/acodex exec --json \
  --sandbox read-only \
  --ask-for-approval never \
  --cd /home/komaroff/dev/monitorsoft/synadia-nats-agents \
  'Analyze this YouTrack issue'
```

Правила для CLI fallback:

- запускать через `spawn(command, args)`, не через shell string;
- читать JSONL построчно;
- считать exit code транспортным статусом;
- ограничивать время выполнения внешним timeout;
- не передавать YouTrack token, webhook token и другие секреты в env Codex.

## Standalone/daemon caveat

`acodex` является wrapper-ом вокруг доступного в `PATH` `codex`. Он может
подготовить CA/proxy окружение и вызвать CLI, но не создает installer-managed
standalone install.

Если команда требует:

```text
/home/komaroff/.codex/packages/standalone/current/codex
```

то это daemon/app-server режим. Его чинят установкой standalone Codex через
официальный installer, а не правками wrapper-а.

## Итог

Для этого проекта основной путь такой:

```text
YouTrack webhook
  -> gateway
  -> NATS JetStream job
  -> Codex SDK worker
  -> NATS result event
  -> UI / gateway / downstream consumer
```

`codex exec --json` остается рядом как воспроизводимый shell-инструмент для
debug, smoke checks и аварийного one-shot запуска.
