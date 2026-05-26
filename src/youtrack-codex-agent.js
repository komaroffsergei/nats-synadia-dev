import { createServer } from "node:http";
import { AgentService } from "@synadia-ai/agent-service";
import {
  SERVICE_VERSION,
  chunkText,
  connectNats,
  decodeUtf8,
  encodeJson,
  env,
  envAny,
  formatError,
  requirePrompt,
  tryDecodeJson,
} from "./common.js";

// Этот файл специально держит две роли в одном маленьком процессе:
//
// 1. Synadia AgentService (`agents.prompt.youtrack.giscloud.codex`).
//    Его видно в discovery UI, и через него можно спросить "health" или
//    "hooks" обычным NATS prompt-ом.
//
// 2. HTTP receiver для YouTrack webhook-ов.
//    YouTrack сам не умеет говорить NATS Agent Protocol, поэтому его POST
//    сначала приходит в `/youtrack/webhook`, а уже этот endpoint отправляет
//    событие во внутренний NATS callback subject агента.
//
// Важно: webhook callback сделан через NATS request/reply, а не через прямой
// вызов JS-функции. Так мы проверяем боевую связку "HTTP -> NATS -> agent"
// и сразу видим, если NATS недоступен или агент не слушает свой inbox.
const YOUTRACK_AGENT = "youtrack";
const YOUTRACK_OWNER = env("YOUTRACK_OWNER", "giscloud");
const YOUTRACK_NAME = env("YOUTRACK_AGENT_NAME", "codex");
const YOUTRACK_BASE_URL = env("YOUTRACK_BASE_URL", "https://yt.giscloud.ru");
const YOUTRACK_TOKEN = envAny(["YOUTRACK_TOKEN", "YT_TOKEN"], "");
const YOUTRACK_TIMEOUT_MS = Number(env("YOUTRACK_TIMEOUT_MS", "15000"));
const WEBHOOK_HOST = env("YOUTRACK_WEBHOOK_HOST", "0.0.0.0");
const WEBHOOK_PORT = Number(env("YOUTRACK_WEBHOOK_PORT", env("PORT", "3401")));
const WEBHOOK_TOKEN = envAny(["YOUTRACK_WEBHOOK_TOKEN", "YT_WEBHOOK_TOKEN"], "");
const PUBLIC_WEBHOOK_URL = env("YOUTRACK_PUBLIC_WEBHOOK_URL", "");
const MAX_WEBHOOK_BYTES = Number(env("YOUTRACK_WEBHOOK_MAX_BYTES", "1048576"));
const MAX_EVENTS = Number(env("YOUTRACK_WEBHOOK_MAX_EVENTS", "50"));
const HOOK_CALLBACK_SUBJECT = env("YOUTRACK_HOOK_CALLBACK_SUBJECT", `youtrack.hooks.${YOUTRACK_OWNER}.${YOUTRACK_NAME}`);
const AGENT_MESSAGE_SUBJECT = env("YOUTRACK_AGENT_MESSAGE_SUBJECT", `youtrack.messages.${YOUTRACK_OWNER}.${YOUTRACK_NAME}`);
const PROMPT_SUBJECT = `agents.prompt.${YOUTRACK_AGENT}.${YOUTRACK_OWNER}.${YOUTRACK_NAME}`;
const HOOK_CALLBACK_TIMEOUT_MS = Number(env("YOUTRACK_HOOK_CALLBACK_TIMEOUT_MS", "3000"));

// `recentWebhookEvents` - сырые нормализованные HTTP события.
// Это журнал входа: сюда событие попадает сразу после POST от YouTrack.
const recentWebhookEvents = [];

// `recentAgentMessages` - сообщения, которые уже прошли через NATS callback
// subject и были обработаны самим агентом. Именно этот список отвечает на
// пользовательскую формулировку "hook должен писать сообщение в агент".
const recentAgentMessages = [];

// Функция callback-а назначается в `main()`, когда NATS connection уже открыт.
// До этого HTTP server не стартует, но guard оставлен, чтобы ошибка была
// понятной, если порядок запуска когда-нибудь поменяют.
let sendHookCallback = async () => {
  throw new Error("YouTrack hook callback is not initialized yet.");
};

function requireYouTrackToken() {
  if (!YOUTRACK_TOKEN) {
    throw new Error("YOUTRACK_TOKEN is not set.");
  }
}

function baseUrl() {
  return YOUTRACK_BASE_URL.replace(/\/+$/, "");
}

async function youtrackFetch(path, { auth = true, method = "GET", body, headers = {} } = {}) {
  if (auth) requireYouTrackToken();

  // `redirect: "manual"` здесь принципиален: если перед API стоит внешний
  // auth barrier вроде slimauth/oauth_slim, мы не хотим молча проследовать за
  // HTML login redirect-ом и принять его за "здоровый" API. Healthcheck должен
  // увидеть Location/HTML и явно пометить `authBarrier=true`.
  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(Number.isFinite(YOUTRACK_TIMEOUT_MS) ? YOUTRACK_TIMEOUT_MS : 15_000),
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(auth ? { authorization: `Bearer ${YOUTRACK_TOKEN}` } : {}),
      ...headers,
    },
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type") || "",
    location: response.headers.get("location"),
    redirected: response.redirected,
    payload,
  };
}

function isAuthBarrier(result) {
  // Нормальный YouTrack REST API без bearer token отвечает JSON 401:
  //   {"error":"Unauthorized","error_description":"You are not logged in."}
  //
  // Если вместо этого прилетает redirect на oauth_slim, /hub/login или HTML
  // login page, значит токен может быть правильным, но до YouTrack API запрос
  // не дошёл из-за внешнего слоя авторизации. Это отдельный класс проблемы.
  const location = result.location || "";
  const text = typeof result.payload === "string" ? result.payload : "";
  return /oauth_slim|\/hub\/login|login/i.test(location) || /oauth_slim|\/hub\/login/i.test(text);
}

function summarizeUser(payload) {
  if (!payload || typeof payload !== "object") return null;
  return {
    id: payload.id,
    login: payload.login,
    fullName: payload.fullName,
    name: payload.name,
    email: payload.email,
    guest: payload.guest,
    banned: payload.banned,
    ringId: payload.ringId,
  };
}

function summarizeApiResult(label, result) {
  return {
    label,
    status: result.status,
    ok: result.ok,
    contentType: result.contentType,
    redirected: result.redirected,
    location: result.location,
    authBarrier: isAuthBarrier(result),
  };
}

async function checkYouTrackApi() {
  // Проверяем две вещи одновременно:
  // - bearer token реально авторизует REST API и Hub API;
  // - перед API нет внешнего auth barrier-а, который ломает machine-to-machine
  //   интеграцию редиректом или HTML login form.
  const unauthMe = await youtrackFetch("/api/users/me?fields=id,login", { auth: false });
  const authMe = await youtrackFetch("/api/users/me?fields=id,login,fullName,email,ringId,guest,banned");
  const hubMe = await youtrackFetch("/hub/api/rest/users/me?fields=id,login,name,email,guest,banned");
  const issues = await youtrackFetch("/api/issues?fields=id,idReadable,summary&$top=1");

  return {
    ok: authMe.ok && hubMe.ok && issues.ok && !isAuthBarrier(authMe) && !isAuthBarrier(hubMe) && !isAuthBarrier(issues),
    baseUrl: YOUTRACK_BASE_URL,
    token: YOUTRACK_TOKEN ? "set" : "missing",
    checks: [
      {
        ...summarizeApiResult("unauth_api_me", unauthMe),
        expected: "401 JSON Unauthorized, no external auth barrier",
      },
      {
        ...summarizeApiResult("auth_api_me", authMe),
        user: summarizeUser(authMe.payload),
      },
      {
        ...summarizeApiResult("auth_hub_me", hubMe),
        user: summarizeUser(hubMe.payload),
      },
      {
        ...summarizeApiResult("auth_issues_top1", issues),
        issueCount: Array.isArray(issues.payload) ? issues.payload.length : null,
      },
    ],
  };
}

function verifyWebhookRequest(req) {
  // YouTrack Webhook Triggers App обычно умеет отправлять статический token
  // в заголовке. Мы поддерживаем два простых варианта:
  // - X-YouTrack-Token: <shared secret>
  // - Authorization: Bearer <shared secret>
  //
  // Если WEBHOOK_TOKEN пустой, endpoint работает без проверки. Это удобно для
  // локального smoke-теста curl-ом, но для публичного URL нужно включить token.
  if (!WEBHOOK_TOKEN) return true;
  const headerToken = req.headers["x-youtrack-token"];
  if (headerToken === WEBHOOK_TOKEN) return true;
  const authorization = String(req.headers.authorization || "");
  return authorization === `Bearer ${WEBHOOK_TOKEN}`;
}

async function readRequestBody(req) {
  // Webhook body может быть произвольным JSON, который задаётся настройками
  // YouTrack Webhook Triggers App. Ограничение по размеру защищает локальный
  // процесс от случайного большого payload-а или неправильной настройки hook-а.
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_WEBHOOK_BYTES) throw new Error(`webhook body is larger than ${MAX_WEBHOOK_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeWebhookSummary(payload) {
  // В документации YouTrack webhook shape зависит от конкретного trigger-а и
  // template-а. Поэтому summary не полагается на один фиксированный формат,
  // а пробует несколько типичных мест: issue/entity/targetIssue/target и
  // changes/changedFields/updates.
  //
  // Полный payload намеренно не отдаём в prompt: в нём могут быть приватные
  // поля, лишний markdown или пользовательские данные. Для агента достаточно
  // компактного сообщения: тип события, задача и список изменённых полей.
  if (!payload || typeof payload !== "object") return { type: typeof payload };
  const issue = payload.issue || payload.entity || payload.targetIssue || payload.target;
  const changes = payload.changes || payload.changedFields || payload.updates;
  return {
    keys: Object.keys(payload).slice(0, 30),
    eventType: payload.eventType || payload.type || payload.name || null,
    issue: issue && typeof issue === "object"
      ? {
          id: issue.id,
          idReadable: issue.idReadable,
          summary: issue.summary,
        }
      : null,
    changes: Array.isArray(changes)
      ? changes.slice(0, 20).map((item) => item?.field?.name || item?.name || item?.field || item?.id || String(item))
      : null,
  };
}

function rememberWebhookEvent(req, payload) {
  // Это "журнал приёма HTTP". Он полезен для отладки: можно увидеть, что
  // YouTrack действительно достучался до endpoint-а, даже если дальнейший NATS
  // callback по какой-то причине не сработал.
  const event = {
    receivedAt: new Date().toISOString(),
    method: req.method,
    url: req.url,
    contentType: req.headers["content-type"] || "",
    userAgent: req.headers["user-agent"] || "",
    youtrackEvent: req.headers["x-youtrack-event"] || "",
    summary: safeWebhookSummary(payload),
    // Храним полный JSON body от YouTrack, а не только краткий summary. Именно
    // этот объект попадает в chat bubble, чтобы при создании/редактировании
    // задачи было видно все поля webhook-а без дополнительного GET запроса.
    payload,
  };
  recentWebhookEvents.unshift(event);
  const maxEvents = Number.isFinite(MAX_EVENTS) && MAX_EVENTS > 0 ? MAX_EVENTS : 50;
  recentWebhookEvents.splice(maxEvents);
  return event;
}

function rememberAgentMessage(message) {
  // Это уже "сообщение в агенте": оно создаётся callback consumer-ом после
  // получения события из NATS. Prompt `hooks` и HTTP `/youtrack/agent-messages`
  // читают именно этот список.
  recentAgentMessages.unshift(message);
  const maxEvents = Number.isFinite(MAX_EVENTS) && MAX_EVENTS > 0 ? MAX_EVENTS : 50;
  recentAgentMessages.splice(maxEvents);
  return message;
}

function webhookEventToAgentMessage(event) {
  const issue = event.summary.issue?.idReadable ? ` ${event.summary.issue.idReadable}` : "";
  const type = event.summary.eventType ? ` ${event.summary.eventType}` : "";
  const changes = Array.isArray(event.summary.changes) && event.summary.changes.length
    ? ` fields=${event.summary.changes.join(",")}`
    : "";
  const title = `YouTrack hook${type}${issue}${changes}`.trim();
  return {
    receivedAt: new Date().toISOString(),
    kind: "youtrack_hook",
    sourceReceivedAt: event.receivedAt,
    title,
    text: [
      title,
      "",
      "````json",
      JSON.stringify(event, null, 2),
      "````",
    ].join("\n"),
    event,
  };
}

async function publishAgentMessage(nc, message) {
  // Это fan-out событие для UI bridge.
  //
  // Callback subject (`youtrack.hooks...`) остаётся request/reply inbox-ом:
  // HTTP handler ждёт ack и понимает, что агент событие обработал. А этот
  // subject (`youtrack.messages...`) - обычная broadcast-лента для открытых
  // браузерных чатов. Bridge слушает её и сразу рисует bubble без ручного
  // prompt-а `hooks`.
  nc.publish(AGENT_MESSAGE_SUBJECT, encodeJson({
    type: "youtrack.agent_message",
    promptSubject: PROMPT_SUBJECT,
    agent: {
      agent: YOUTRACK_AGENT,
      owner: YOUTRACK_OWNER,
      name: YOUTRACK_NAME,
      promptSubject: PROMPT_SUBJECT,
    },
    message,
  }));
  await nc.flush();
}

function fallbackCallbackEvent(envelope) {
  // Если callback subject кто-то вызвал руками и прислал не наш envelope
  // `{ type, event }`, агент всё равно должен записать понятное сообщение,
  // а не падать. Такой fallback удобен при ручной проверке через `nats req`.
  return {
    receivedAt: new Date().toISOString(),
    method: "NATS",
    url: HOOK_CALLBACK_SUBJECT,
    contentType: "application/json",
    userAgent: "nats",
    youtrackEvent: "",
    summary: {
      keys: envelope && typeof envelope === "object" ? Object.keys(envelope).slice(0, 30) : [],
      eventType: "manualCallback",
      issue: null,
      changes: null,
    },
  };
}

function startHookCallbackConsumer(nc) {
  // Это inbox агента для webhook callback-ов.
  //
  // Поток:
  //   YouTrack -> POST /youtrack/webhook
  //   HTTP handler -> nc.request(HOOK_CALLBACK_SUBJECT, ...)
  //   subscription below -> rememberAgentMessage(...)
  //   prompt "hooks" -> показывает сохранённые agent messages
  //
  // Используем request/reply, чтобы HTTP handler получил подтверждение, что
  // сообщение не просто отправлено в NATS, а реально обработано agent process-ом.
  const sub = nc.subscribe(HOOK_CALLBACK_SUBJECT);
  void (async () => {
    for await (const msg of sub) {
      const decoded = tryDecodeJson(msg.data);
      const envelope = decoded.ok ? decoded.value : { type: "raw", text: decodeUtf8(msg.data) };
      const event = envelope && typeof envelope === "object" && envelope.event
        ? envelope.event
        : fallbackCallbackEvent(envelope);
      const message = rememberAgentMessage(webhookEventToAgentMessage(event));
      await publishAgentMessage(nc, message);

      if (msg.reply) {
        nc.publish(msg.reply, encodeJson({
          ok: true,
          receivedAt: message.receivedAt,
          storedMessages: recentAgentMessages.length,
          agentMessageSubject: AGENT_MESSAGE_SUBJECT,
        }));
      }
    }
  })().catch((error) => {
    console.error(`[youtrack:codex] hook callback consumer failed: ${formatError(error)}`);
  });

  return () => sub.unsubscribe();
}

function createHookCallbackRequester(nc) {
  return async (event) => {
    const timeout = Number.isFinite(HOOK_CALLBACK_TIMEOUT_MS) ? HOOK_CALLBACK_TIMEOUT_MS : 3000;
    const response = await nc.request(
      HOOK_CALLBACK_SUBJECT,
      encodeJson({
        type: "youtrack.webhook",
        event,
      }),
      { timeout },
    );
    const decoded = tryDecodeJson(response.data);
    if (!decoded.ok || !decoded.value?.ok) {
      throw new Error(`bad hook callback ack on ${HOOK_CALLBACK_SUBJECT}`);
    }
    return decoded.value;
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handleWebhook(req) {
  if (!verifyWebhookRequest(req)) {
    return jsonResponse({ ok: false, error: "bad_webhook_token" }, 401);
  }

  // Сначала сохраняем факт HTTP-получения, затем синхронно отправляем callback
  // в NATS agent inbox. Если NATS callback не подтвердился, endpoint вернёт 500:
  // это честный сигнал для YouTrack retry/monitoring, что агент событие не принял.
  const text = await readRequestBody(req);
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text };
    }
  }
  const event = rememberWebhookEvent(req, payload);
  const callback = await sendHookCallback(event);
  return jsonResponse({
    ok: true,
    event,
    callbackSubject: HOOK_CALLBACK_SUBJECT,
    callback,
    storedEvents: recentWebhookEvents.length,
    storedAgentMessages: recentAgentMessages.length,
  });
}

async function handleHttp(req) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/healthz" || url.pathname === "/youtrack/api-check") {
      return jsonResponse({
        service: "youtrack-giscloud-codex-agent",
        webhook: {
          endpoint: "/youtrack/webhook",
          publicUrl: PUBLIC_WEBHOOK_URL || null,
          tokenRequired: Boolean(WEBHOOK_TOKEN),
          callbackSubject: HOOK_CALLBACK_SUBJECT,
          agentMessageSubject: AGENT_MESSAGE_SUBJECT,
          receivedEvents: recentWebhookEvents.length,
          agentMessages: recentAgentMessages.length,
        },
        youtrack: await checkYouTrackApi(),
      });
    }

    if (url.pathname === "/youtrack/webhook" && req.method === "POST") {
      return handleWebhook(req);
    }

    if (url.pathname === "/youtrack/webhooks/last" && req.method === "GET") {
      return jsonResponse({ events: recentWebhookEvents });
    }

    if (url.pathname === "/youtrack/agent-messages" && req.method === "GET") {
      return jsonResponse({ messages: recentAgentMessages });
    }

    return jsonResponse({
      ok: false,
      error: "not_found",
      endpoints: [
        "GET /healthz",
        "GET /youtrack/api-check",
        "POST /youtrack/webhook",
        "GET /youtrack/webhooks/last",
        "GET /youtrack/agent-messages",
      ],
    }, 404);
  } catch (error) {
    return jsonResponse({ ok: false, error: formatError(error) }, 500);
  }
}

function formatApiCheckForPrompt(result) {
  return [
    `YouTrack API: ${result.ok ? "OK" : "FAILED"}`,
    `Base URL: ${result.baseUrl}`,
    `Token: ${result.token}`,
    "",
    ...result.checks.map((check) => {
      const user = check.user?.login ? ` user=${check.user.login}` : "";
      const issues = check.issueCount !== undefined && check.issueCount !== null ? ` issues=${check.issueCount}` : "";
      return `- ${check.label}: status=${check.status} ok=${check.ok} barrier=${check.authBarrier}${user}${issues}`;
    }),
  ].join("\n");
}

function formatHooksForPrompt() {
  if (recentAgentMessages.length === 0) return "No YouTrack hook messages received by the agent yet.";
  return recentAgentMessages
    .slice(0, 10)
    .map((message) => {
      const issue = message.event.summary.issue?.idReadable ? ` issue=${message.event.summary.issue.idReadable}` : "";
      const type = message.event.summary.eventType ? ` type=${message.event.summary.eventType}` : "";
      const keys = message.event.summary.keys.join(",");
      return `- ${message.receivedAt}${type}${issue} text="${message.title || message.text}" keys=${keys}`;
    })
    .join("\n");
}

async function handlePrompt(envelope, response) {
  const prompt = requirePrompt(envelope.prompt).toLowerCase();
  if (prompt.includes("hook")) {
    await response.send(formatHooksForPrompt());
    return;
  }

  const result = await checkYouTrackApi();
  for (const chunk of chunkText(formatApiCheckForPrompt(result), 1200)) {
    await response.send(chunk);
  }
}

async function main() {
  const nc = await connectNats("youtrack-giscloud-codex-agent");
  const stopHookCallbackConsumer = startHookCallbackConsumer(nc);
  sendHookCallback = createHookCallbackRequester(nc);

  const service = new AgentService({
    nc,
    agent: YOUTRACK_AGENT,
    owner: YOUTRACK_OWNER,
    name: YOUTRACK_NAME,
    session: YOUTRACK_NAME,
    version: SERVICE_VERSION,
    attachmentsOk: false,
    description: "Minimal yt.giscloud.ru webhook listener and API health-check agent.",
    extraMetadata: {
      role: "youtrack",
      mode: "webhook-api-check",
      base_url: YOUTRACK_BASE_URL,
      webhook_path: "/youtrack/webhook",
      webhook_url: PUBLIC_WEBHOOK_URL,
      hook_callback_subject: HOOK_CALLBACK_SUBJECT,
    },
  });

  service.onPrompt(async (envelope, response) => {
    try {
      await handlePrompt(envelope, response);
    } catch (error) {
      await response.send(`YouTrack Codex agent error: ${formatError(error)}`);
    }
  });

  await service.start();

  const httpServer = createServer((req, res) => {
    void handleHttp(req).then(async (response) => {
      res.statusCode = response.status;
      for (const [key, value] of response.headers) res.setHeader(key, value);
      res.end(Buffer.from(await response.arrayBuffer()));
    });
  });

  await new Promise((resolve) => httpServer.listen(WEBHOOK_PORT, WEBHOOK_HOST, resolve));

  console.log(`[youtrack:codex] ${service.subject.prompt}`);
  console.log(`[youtrack:codex] hook callback subject=${HOOK_CALLBACK_SUBJECT}`);
  console.log(`[youtrack:codex] agent message subject=${AGENT_MESSAGE_SUBJECT}`);
  console.log(`[youtrack:codex] http=http://${WEBHOOK_HOST}:${WEBHOOK_PORT}`);
  console.log(`[youtrack:codex] base=${YOUTRACK_BASE_URL} token=${YOUTRACK_TOKEN ? "set" : "missing"}`);

  const stop = async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    stopHookCallbackConsumer();
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
  console.error(`[youtrack:codex] failed: ${formatError(error)}`);
  process.exitCode = 1;
});
