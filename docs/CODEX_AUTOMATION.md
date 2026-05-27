# Как Worker Запускает Codex

Этот документ дополняет [README](../README.md) и
[карту кода](../CODE_MAP.md). Он отвечает только на один вопрос: почему
production worker использует `@openai/codex-sdk` и как ограничивается его
окружение.

## Короткое Решение

Для постоянного NATS/JetStream worker-а используется `@openai/codex-sdk`.

Codex CLI внутри SDK запускается не напрямую, а через wrapper:

```text
scripts/acodex
```

Локально можно поставить:

```bash
CODEX_PATH_OVERRIDE=/home/komaroff/.local/bin/acodex
```

В production путь по умолчанию:

```bash
CODEX_PATH_OVERRIDE=/app/scripts/acodex
```

Wrapper выставляет proxy/CA окружение и затем вызывает `codex`.
`codex exec --json` через этот же wrapper остается полезным для ручной
диагностики и аварийного one-shot запуска.

Если worker не получает `OPENAI_API_KEY` или `CODEX_API_KEY`, wrapper может
поднять Codex CLI auth из env:

```bash
CODEX_AUTH_JSON_B64=<base64-encoded-codex-auth-json>
```

Значение не хранится в репозитории: его надо передавать только через
CI/Vault/runtime env.

Причина простая: worker уже живет в Node.js, читает JetStream, должен уметь
продолжать thread, стримить события, отменять turn и явно контролировать env
дочернего процесса. SDK лучше подходит для этой формы.

## Важная Деталь Про SDK

`@openai/codex-sdk` не заменяет локальный Codex CLI отдельным удаленным API.
SDK запускает Codex как дочерний процесс и общается с ним через JSONL.

Поэтому остаются важными:

- auth через `OPENAI_API_KEY`, `CODEX_API_KEY` или `CODEX_AUTH_JSON_B64`;
- доступность Codex CLI в окружении;
- `CODEX_HOME`, proxy/CA и другие настройки рабочего места;
- `workingDirectory`;
- sandbox и approval policy.

## Что Передается В Codex

Worker формирует prompt из четырех частей:

1. системная инструкция worker-а;
2. содержимое [skills/youtrack-task-analysis/SKILL.md](../skills/youtrack-task-analysis/SKILL.md);
3. нормализованные данные YouTrack issue;
4. полный JSON webhook-а.

Worker не получает `YOUTRACK_TOKEN` и не вызывает YouTrack API.

## Настройки Безопасности По Умолчанию

Для YouTrack анализа используются консервативные настройки:

```bash
CODEX_SANDBOX_MODE=read-only
CODEX_APPROVAL_POLICY=never
CODEX_NETWORK_ACCESS=false
CODEX_WEB_SEARCH=disabled
CODEX_WORKER_CONCURRENCY=1
```

`CODEX_WORKER_CONCURRENCY=1` важен для MVP: так один worker не запускает
параллельные turns в одном Codex thread.

## Минимальный SDK Worker

Упрощенная форма того, что делает [src/codex-worker.js](../src/codex-worker.js):

```js
import { Codex } from "@openai/codex-sdk";

const codex = new Codex({
  codexPathOverride: process.env.CODEX_PATH_OVERRIDE || "/app/scripts/acodex",
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_HOME: process.env.CODEX_HOME,
    CODEX_PROXY_URL: process.env.CODEX_PROXY_URL,
    CODEX_MITM_CA_B64: process.env.CODEX_MITM_CA_B64,
    CODEX_AUTH_JSON_B64: process.env.CODEX_AUTH_JSON_B64,
  },
});

const thread = job.sessionId
  ? codex.resumeThread(job.sessionId)
  : codex.startThread({
      workingDirectory: process.cwd(),
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });

const { events } = await thread.runStreamed(prompt);

for await (const event of events) {
  // Worker превращает SDK events в нормализованные JetStream results.
}
```

## Когда Нужен CLI Fallback

`acodex exec --json` полезен, когда надо вручную воспроизвести prompt или
посмотреть raw JSONL тем же сетевым путем, что использует worker:

```bash
/home/komaroff/.local/bin/acodex exec --json \
  --sandbox read-only \
  --ask-for-approval never \
  --cd /home/komaroff/dev/monitorsoft/synadia-nats-agents \
  'Analyze this YouTrack issue'
```

Правила для fallback:

- запускать через `spawn(command, args)`, а не через shell string;
- читать JSONL построчно;
- считать exit code транспортным статусом;
- ограничивать выполнение timeout-ом;
- не передавать YouTrack token, webhook token и другие секреты в env Codex.

## Итоговый Поток

```text
JetStream job
  -> src/codex-worker.js
  -> @openai/codex-sdk
  -> локальный Codex CLI
  -> JetStream result event
```

Gateway и YouTrack остаются по другую сторону JetStream. Это держит секреты и
ответственность раздельно: gateway пишет в YouTrack, worker запускает Codex.
