import { AgentService } from "@synadia-ai/agent-service";
import {
  SERVICE_VERSION,
  chunkText,
  connectNats,
  env,
  envAny,
  formatError,
  requirePrompt,
} from "./common.js";

// Этот файл - самый простой read-only YouTrack agent для Synadia/NATS demo.
//
// Что он делает:
// - регистрируется как обычный Synadia AgentService;
// - слушает prompt subject вида `agents.prompt.youtrack.<owner>.<name>`;
// - по prompt-у либо читает конкретную задачу (`ABC-123`), либо выполняет
//   YouTrack search query;
// - возвращает краткую текстовую сводку в streaming response.
//
// Что он принципиально НЕ делает:
// - не создаёт пользователей;
// - не меняет поля задач;
// - не добавляет комментарии;
// - не хранит состояние.
//
// Поэтому этот agent удобно держать как безопасную диагностическую точку:
// через него можно быстро проверить токен, доступ к API и содержимое задачи,
// не рискуя случайно изменить YouTrack.
const YOUTRACK_AGENT = "youtrack";
const YOUTRACK_OWNER = env("YOUTRACK_OWNER", "monitorsoft");
const YOUTRACK_NAME = env("YOUTRACK_AGENT_NAME", "triage");
const YOUTRACK_BASE_URL = env("YOUTRACK_BASE_URL", "https://yt.monitorsoft.ru");
const YOUTRACK_TOKEN = envAny(["YOUTRACK_TOKEN", "YT_TOKEN"], "");
const YOUTRACK_TIMEOUT_MS = Number(env("YOUTRACK_TIMEOUT_MS", "15000"));
const SEARCH_LIMIT = Number(env("YOUTRACK_SEARCH_LIMIT", "5"));

// YouTrack REST API требует явно перечислять поля через `fields`.
// Это полезно для стабильности:
// - API не отдаёт лишние большие объекты;
// - формат ответа не зависит от UI;
// - agent получает только те поля, которые реально форматирует ниже.
const ISSUE_FIELDS = [
  "id",
  "idReadable",
  "summary",
  "description",
  "created",
  "updated",
  "resolved",
  "project(shortName,name)",
  "reporter(login,fullName)",
  "updater(login,fullName)",
  "customFields(name,value(name,localizedName,fullName,presentation,text,idReadable))",
  "comments(id,text,textPreview,created,updated,author(login,fullName))",
].join(",");

// Для поиска берём более короткий набор полей, чем для полной карточки задачи.
// Search result должен быть компактным списком: ключ, summary, статус,
// исполнитель и время обновления. Полное описание/комментарии читаются только
// когда пользователь отправил конкретный issue key.
const SEARCH_FIELDS = [
  "id",
  "idReadable",
  "summary",
  "updated",
  "resolved",
  "project(shortName,name)",
  "customFields(name,value(name,localizedName,fullName,presentation,text,idReadable))",
].join(",");

function issueKeyFromText(text) {
  // Ищем ключ задачи в обычном пользовательском тексте:
  // "посмотри DO-2718" -> "DO-2718".
  //
  // Регулярка намеренно консервативная и не привязана к конкретному проекту:
  // YouTrack keys обычно имеют вид `PROJECT-123`, где PROJECT - латиница,
  // цифры или `_`.
  const match = String(text ?? "").match(/\b[A-Z][A-Z0-9_]*-\d+\b/);
  return match?.[0] ?? "";
}

function parsePrompt(envelope) {
  // Synadia AgentService передаёт сюда protocol envelope.
  // Базовый UI обычно присылает только `{ prompt }`, но прямой NATS caller
  // может дополнительно передать `issue`, `issue_id`, `idReadable` или `query`.
  //
  // Приоритет такой:
  // 1. явный issue id из envelope;
  // 2. issue key, найденный внутри prompt;
  // 3. иначе prompt считается YouTrack search query.
  const prompt = requirePrompt(envelope.prompt);
  const explicitIssue = String(envelope.issue ?? envelope.issue_id ?? envelope.idReadable ?? "").trim();
  const explicitQuery = String(envelope.query ?? "").trim();
  const issue = explicitIssue || issueKeyFromText(prompt);

  if (issue) {
    return {
      mode: "issue",
      issue,
      prompt,
    };
  }

  return {
    mode: "search",
    query: explicitQuery || prompt,
    prompt,
  };
}

function requireToken() {
  // Токен проверяем лениво перед реальным HTTP запросом.
  // Так agent может стартовать и быть видимым в discovery даже в окружении,
  // где токен забыли передать; при prompt-е он вернёт понятную ошибку.
  if (!YOUTRACK_TOKEN) {
    throw new Error(
      [
        "YOUTRACK_TOKEN is not set.",
        "Create a YouTrack permanent token and run this local agent with YOUTRACK_TOKEN=<token>.",
        "The agent is read-only and only uses YouTrack GET endpoints.",
      ].join(" "),
    );
  }
}

async function youtrackGet(path, params = {}) {
  requireToken();

  // URL собираем через стандартный URL API, а не строковой конкатенацией query.
  // Это важно для `fields`, `$top` и пользовательских search queries: пробелы,
  // скобки и `$` должны кодироваться корректно.
  const base = YOUTRACK_BASE_URL.replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      url.searchParams.set(key, String(value));
    }
  }

  const timeoutMs = Number.isFinite(YOUTRACK_TIMEOUT_MS) ? YOUTRACK_TIMEOUT_MS : 15_000;
  // YouTrack API авторизуется обычным bearer token:
  //   Authorization: Bearer <permanent-token>
  //
  // Здесь нет browser cookies и нет перехода через UI login flow. Если внешний
  // auth barrier перехватывает API, response ниже будет не `ok`, и agent вернёт
  // ошибку с HTTP status.
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${YOUTRACK_TOKEN}`,
    },
  });

  const text = await response.text();
  let payload;
  try {
    // У успешного YouTrack REST ответа почти всегда JSON, но при ошибках
    // reverse proxy или auth layer может вернуть plain text/HTML.
    // Поэтому parser не должен падать до формирования понятной ошибки.
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object"
        ? payload.error_description || payload.error || JSON.stringify(payload)
        : String(payload ?? "");
    throw new Error(`YouTrack ${response.status}: ${message.slice(0, 500)}`);
  }

  return payload;
}

function formatDate(value) {
  // YouTrack REST API отдаёт даты как Unix time в миллисекундах.
  // Для agent output используем UTC, чтобы в NATS/логах не было неоднозначности
  // между локальной timezone сервера и timezone пользователя.
  if (!value) return "";
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function valueText(value) {
  // Custom field value в YouTrack бывает:
  // - null;
  // - строка/число;
  // - объект enum/user/state;
  // - массив объектов.
  //
  // Эта функция сводит все варианты к короткому человекочитаемому тексту.
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map(valueText).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    return (
      value.localizedName ||
      value.fullName ||
      value.presentation ||
      value.name ||
      value.text ||
      value.idReadable ||
      value.login ||
      ""
    );
  }
  return String(value);
}

function fieldValue(issue, names) {
  // Названия полей отличаются между инсталляциями и локалями:
  // `State`/`Status`/`Статус`, `Assignee`/`Исполнитель`.
  // Поэтому вызывающий код передаёт список допустимых имён, а поиск делается
  // case-insensitive.
  const fields = Array.isArray(issue.customFields) ? issue.customFields : [];
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const field = fields.find((item) => wanted.has(String(item.name ?? "").toLowerCase()));
  return field ? valueText(field.value) : "";
}

function compactText(text, maxChars = 900) {
  // Описание и комментарии могут быть длинными markdown/html-like текстами.
  // Agent response режется на chunks ниже, но сначала полезно убрать лишние
  // переносы/пробелы и ограничить самые большие блоки.
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}...`;
}

function issueLine(issue) {
  // Одна строка search result. Здесь намеренно нет description/comments:
  // список должен быстро сканироваться глазами и не раздувать NATS response.
  const state = fieldValue(issue, ["State", "Status", "Статус", "Состояние"]);
  const assignee = fieldValue(issue, ["Assignee", "Исполнитель"]);
  const parts = [
    issue.idReadable,
    issue.summary,
    state ? `state=${state}` : "",
    assignee ? `assignee=${assignee}` : "",
    issue.updated ? `updated=${formatDate(issue.updated)}` : "",
  ].filter(Boolean);
  return `- ${parts.join(" | ")}`;
}

function formatIssue(issue) {
  // Полная карточка задачи для prompt-а по конкретному ключу.
  // Формат обычный plain text, а не JSON: этот agent рассчитан на чтение
  // человеком в CLI/UI. Если понадобится машинный contract, лучше добавить
  // отдельный endpoint/agent mode, а не ломать этот текстовый вывод.
  const state = fieldValue(issue, ["State", "Status", "Статус", "Состояние"]) || "не найдено";
  const assignee = fieldValue(issue, ["Assignee", "Исполнитель"]) || "не найдено";
  const priority = fieldValue(issue, ["Priority", "Приоритет"]) || "не найдено";
  const type = fieldValue(issue, ["Type", "Тип"]) || "не найдено";
  const comments = Array.isArray(issue.comments) ? issue.comments.filter((item) => !item.deleted) : [];
  const lastComments = comments.slice(-3);

  return [
    `YouTrack: ${issue.idReadable}`,
    "",
    `Summary: ${issue.summary || "(empty)"}`,
    `Project: ${issue.project?.shortName || issue.project?.name || "не найдено"}`,
    `State: ${state}`,
    `Assignee: ${assignee}`,
    `Priority: ${priority}`,
    `Type: ${type}`,
    `Reporter: ${issue.reporter?.fullName || issue.reporter?.login || "не найдено"}`,
    `Updated: ${formatDate(issue.updated) || "не найдено"}`,
    issue.resolved ? `Resolved: ${formatDate(issue.resolved)}` : "Resolved: no",
    "",
    "Description:",
    compactText(issue.description, 1800) || "(empty)",
    "",
    `Comments: ${comments.length}`,
    ...lastComments.flatMap((comment) => [
      "",
      `- ${comment.author?.fullName || comment.author?.login || "unknown"} at ${formatDate(comment.created) || "unknown"}`,
      compactText(comment.textPreview || comment.text, 700) || "(empty)",
    ]),
    "",
    "Next step:",
    "Проверь описание, статус, исполнителя и последние комментарии. Агент ничего не менял в YouTrack.",
  ].join("\n");
}

function formatSearch(query, issues) {
  // Ответ на произвольный search query. Даже если YouTrack вернул пустой
  // список, agent даёт next step: отправить конкретный ключ задачи.
  return [
    `YouTrack search: ${query}`,
    "",
    issues.length ? issues.map(issueLine).join("\n") : "No issues found.",
    "",
    "Tip: отправь конкретный ключ задачи, например ABC-123, чтобы получить подробную сводку.",
  ].join("\n");
}

async function handlePrompt(envelope, response) {
  const request = parsePrompt(envelope);

  if (request.mode === "issue") {
    // Режим "конкретная задача": читаем `/api/issues/{idReadable}` и просим
    // максимум полей, которые нужны для triage-сводки.
    await response.send(`Reading ${request.issue} from YouTrack...\n\n`);
    const issue = await youtrackGet(`/api/issues/${encodeURIComponent(request.issue)}`, {
      fields: ISSUE_FIELDS,
    });
    for (const chunk of chunkText(formatIssue(issue), 1200)) {
      await response.send(chunk);
    }
    return;
  }

  // Режим "поиск": prompt трактуется как YouTrack search query.
  // Примеры:
  //   project: ABC unresolved
  //   assignee: me State: Open
  //   #Unresolved sort by: updated
  await response.send(`Searching YouTrack: ${request.query}\n\n`);
  const issues = await youtrackGet("/api/issues", {
    query: request.query,
    fields: SEARCH_FIELDS,
    "$top": Number.isFinite(SEARCH_LIMIT) ? SEARCH_LIMIT : 5,
  });
  for (const chunk of chunkText(formatSearch(request.query, Array.isArray(issues) ? issues : []), 1200)) {
    await response.send(chunk);
  }
}

async function main() {
  // Все backend agents проекта используют общий `connectNats()` из common.js.
  // Он читает `NATS_URL`, затем alias-ы `NATS_SERVERS`/`NATS_SERVICE_URL`,
  // и только потом локальный default.
  const nc = await connectNats("youtrack-triage-agent");
  // AgentService сам публикует discovery/status/heartbeat subjects и создаёт
  // prompt endpoint `agents.prompt.youtrack.<owner>.<name>`.
  const service = new AgentService({
    nc,
    agent: YOUTRACK_AGENT,
    owner: YOUTRACK_OWNER,
    name: YOUTRACK_NAME,
    session: YOUTRACK_NAME,
    version: SERVICE_VERSION,
    attachmentsOk: false,
    description: "Read-only local YouTrack triage agent.",
    extraMetadata: {
      role: "youtrack",
      mode: "read-only",
      base_url: YOUTRACK_BASE_URL,
      platform: "synadia-agent-web-ui-demo",
    },
  });

  service.onPrompt(async (envelope, response) => {
    // Любая ошибка YouTrack API превращается в обычный response chunk.
    // Это делает agent удобным для CLI: caller увидит текст ошибки в том же
    // `nats req`, а процесс не упадёт из-за одной проблемной задачи.
    try {
      await handlePrompt(envelope, response);
    } catch (error) {
      await response.send(`YouTrack agent error: ${formatError(error)}`);
    }
  });

  await service.start();
  console.log(`[youtrack] ${service.subject.prompt}`);
  console.log(`[youtrack] base=${YOUTRACK_BASE_URL} token=${YOUTRACK_TOKEN ? "set" : "missing"}`);

  const stop = async () => {
    // Graceful shutdown: сначала останавливаем service subscriptions/timers,
    // затем drain-им NATS connection, чтобы pending publishes ушли в шину.
    await service.stop();
    await nc.drain();
  };
  process.once("SIGINT", () => {
    void stop().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void stop().finally(() => process.exit(0));
  });

  setInterval(() => {}, 60_000);
}

main().catch((error) => {
  console.error(`[youtrack] failed: ${formatError(error)}`);
  process.exitCode = 1;
});
