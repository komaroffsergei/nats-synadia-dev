import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { AgentService } from "@synadia-ai/agent-service";
import {
  SERVICE_VERSION,
  connectNats,
  encodeJson,
  env,
  envAny,
  envFlag,
  formatError,
  nowIso,
  safeJson,
} from "./common.js";
import {
  GATEWAY_RESULTS_DURABLE,
  YT_CODEX_JOB_SUBJECT,
  YT_CODEX_RESULT_SUBJECT,
  YT_CODEX_STREAM,
  jetStreamReadiness,
  openJetStream,
} from "./jetstream.js";
import { YouTrackMcpClient } from "./youtrack-mcp-client.js";

const YOUTRACK_AGENT = "youtrack";
const YOUTRACK_OWNER = env("YOUTRACK_OWNER", "giscloud");
const YOUTRACK_NAME = env("YOUTRACK_AGENT_NAME", "codex");
const YOUTRACK_BASE_URL = env("YOUTRACK_BASE_URL", "https://yt.giscloud.ru");
const YOUTRACK_TOKEN = envAny(["YOUTRACK_TOKEN", "YT_TOKEN"], "");
const YOUTRACK_TIMEOUT_MS = Number(env("YOUTRACK_TIMEOUT_MS", "15000"));
const YOUTRACK_MCP_URL = envAny(["YOUTRACK_MCP_URL", "YT_MCP_URL"], "");
const YOUTRACK_MCP_TIMEOUT_MS = Number(env("YOUTRACK_MCP_TIMEOUT_MS", String(YOUTRACK_TIMEOUT_MS)));
const YOUTRACK_DRY_RUN = envFlag("YOUTRACK_DRY_RUN", envFlag("CODEX_DRY_RUN", false));
const WEBHOOK_HOST = env("YOUTRACK_WEBHOOK_HOST", "0.0.0.0");
const WEBHOOK_PORT = Number(env("YOUTRACK_WEBHOOK_PORT", env("PORT", "3401")));
const WEBHOOK_TOKEN = envAny(["YOUTRACK_WEBHOOK_TOKEN", "YT_WEBHOOK_TOKEN"], "");
const PUBLIC_WEBHOOK_URL = env("YOUTRACK_PUBLIC_WEBHOOK_URL", "");
const MAX_WEBHOOK_BYTES = Number(env("YOUTRACK_WEBHOOK_MAX_BYTES", "1048576"));
const MAX_EVENTS = Number(env("YOUTRACK_WEBHOOK_MAX_EVENTS", "50"));
const AGENT_MESSAGE_SUBJECT = env("YOUTRACK_AGENT_MESSAGE_SUBJECT", `youtrack.messages.${YOUTRACK_OWNER}.${YOUTRACK_NAME}`);
const CODEX_SESSION_FIELD = env("YOUTRACK_CODEX_SESSION_FIELD", "Codex Session ID");
const API_CHECK_ISSUE = env("YOUTRACK_API_CHECK_ISSUE", "");
const API_CHECK_PROJECT = env("YOUTRACK_API_CHECK_PROJECT", "");
const MUTE_NOTIFICATIONS = envFlag("YOUTRACK_MUTE_NOTIFICATIONS", false);
const PROMPT_SUBJECT = `agents.prompt.${YOUTRACK_AGENT}.${YOUTRACK_OWNER}.${YOUTRACK_NAME}`;
const youtrackMcp = new YouTrackMcpClient({
  url: YOUTRACK_MCP_URL,
  timeoutMs: YOUTRACK_MCP_TIMEOUT_MS,
  clientName: "synadia-nats-agents",
  clientVersion: SERVICE_VERSION,
});

const recentWebhookEvents = [];
const recentJobs = [];
const recentResults = [];
const dryIssues = new Map();

function baseUrl() {
  return YOUTRACK_BASE_URL.replace(/\/+$/, "");
}

function useYouTrackMcp() {
  return !YOUTRACK_DRY_RUN && youtrackMcp.enabled;
}

function youtrackMode() {
  if (YOUTRACK_DRY_RUN) return "dry-run";
  return useYouTrackMcp() ? "mcp" : "rest";
}

function youtrackAccessStatus() {
  if (YOUTRACK_DRY_RUN) return "not_required_dry_run";
  if (useYouTrackMcp()) return "not_required_mcp";
  return YOUTRACK_TOKEN ? "set" : "missing";
}

function requireYouTrackToken() {
  if (!YOUTRACK_TOKEN) throw new Error("YOUTRACK_TOKEN is not set.");
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function verifyWebhookRequest(req) {
  if (!WEBHOOK_TOKEN) return true;
  if (req.headers["x-youtrack-token"] === WEBHOOK_TOKEN) return true;
  return String(req.headers.authorization || "") === `Bearer ${WEBHOOK_TOKEN}`;
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_WEBHOOK_BYTES) throw new Error(`webhook body is larger than ${MAX_WEBHOOK_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseWebhookBody(text) {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function normalizeWebhookPayload(payload) {
  const issue = payload?.issue || payload?.entity || payload?.targetIssue || payload?.target || {};
  const issueId = String(payload?.id || issue.idReadable || issue.id || "").trim();
  const event = String(payload?.event || payload?.eventType || payload?.type || payload?.name || "").trim();
  const changedFields = normalizeChangedFields(payload?.changedFields ?? payload?.changes ?? payload?.updates);
  return {
    issueId,
    event,
    changedFields,
    summary: stringOrEmpty(payload?.summary ?? issue.summary),
    description: stringOrEmpty(payload?.description ?? issue.description),
  };
}

function normalizeChangedFields(value) {
  if (!value) return [];
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map(changedFieldName).filter(Boolean);
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([key, item]) => changedFieldName(item) || key).filter(Boolean);
  }
  return [];
}

function changedFieldName(item) {
  if (item == null) return "";
  if (typeof item === "string") return item.trim();
  if (typeof item !== "object") return String(item);
  return String(item.name ?? item.field?.name ?? item.field ?? item.id ?? "").trim();
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function eventKey(event) {
  return String(event || "").replace(/[^a-z]/gi, "").toLowerCase();
}

function isCodexSessionFieldOnlyUpdate(normalized) {
  if (eventKey(normalized.event) !== "issueupdated") return false;
  if (normalized.changedFields.length === 0) return false;
  const fieldName = CODEX_SESSION_FIELD.toLowerCase();
  return normalized.changedFields.every((field) => field.toLowerCase() === fieldName);
}

function shouldEnqueueCodexJob(normalized) {
  const key = eventKey(normalized.event);
  if (key === "commentadded") return false;
  if (isCodexSessionFieldOnlyUpdate(normalized)) return false;
  return key === "issuecreated" || key === "issueupdated";
}

function remember(list, value) {
  list.unshift(value);
  const maxEvents = Number.isFinite(MAX_EVENTS) && MAX_EVENTS > 0 ? MAX_EVENTS : 50;
  list.splice(maxEvents);
  return value;
}

async function publishWebhookChatMessage(nc, event) {
  const normalized = event.normalized;
  const issue = normalized.issueId ? ` ${normalized.issueId}` : "";
  const type = normalized.event ? ` ${normalized.event}` : "";
  const fields = normalized.changedFields.length ? ` fields=${normalized.changedFields.join(",")}` : "";
  const title = `YouTrack webhook${type}${issue}${fields}`.trim();
  const text = [
    title,
    "",
    "```json",
    safeJson(event.payload, Number(env("YOUTRACK_CHAT_JSON_MAX_CHARS", "20000"))),
    "```",
  ].join("\n");

  nc.publish(AGENT_MESSAGE_SUBJECT, encodeJson({
    type: "youtrack.agent_message",
    promptSubject: PROMPT_SUBJECT,
    agent: {
      agent: YOUTRACK_AGENT,
      owner: YOUTRACK_OWNER,
      name: YOUTRACK_NAME,
      promptSubject: PROMPT_SUBJECT,
    },
    message: {
      receivedAt: nowIso(),
      kind: "youtrack_webhook",
      sourceReceivedAt: event.receivedAt,
      title,
      text,
      event,
    },
  }));
  await nc.flush();
}

async function enqueueCodexJob(js, event) {
  const normalized = event.normalized;
  if (!normalized.issueId) throw new Error("webhook payload must contain issue id in payload.id");

  const issue = await readIssueForJob(normalized.issueId, event.payload);
  const sessionId = readCodexSessionIdFromIssue(issue);
  const job = {
    type: "youtrack_codex_job",
    id: randomUUID(),
    createdAt: nowIso(),
    issueId: normalized.issueId,
    event: normalized.event,
    changedFields: normalized.changedFields,
    sessionId,
    issue: {
      id: issue.id,
      idReadable: issue.idReadable || normalized.issueId,
      summary: issue.summary || normalized.summary,
      description: issue.description || normalized.description,
    },
    webhook: event.payload,
  };

  await js.publish(YT_CODEX_JOB_SUBJECT, encodeJson(job), { msgID: job.id });
  return remember(recentJobs, {
    id: job.id,
    issueId: job.issueId,
    event: job.event,
    sessionId: job.sessionId || null,
    createdAt: job.createdAt,
    subject: YT_CODEX_JOB_SUBJECT,
  });
}

async function readIssueForJob(issueId, webhookPayload) {
  if (YOUTRACK_DRY_RUN) return dryIssue(issueId, webhookPayload);
  if (useYouTrackMcp()) return youtrackMcp.callTool("get_issue", { issue_id: issueId });
  const fields = [
    "id",
    "idReadable",
    "summary",
    "description",
    "customFields(name,$type,value(text,presentation,name,id,login,idReadable))",
  ].join(",");
  return youtrackJson(`/api/issues/${encodeURIComponent(issueId)}`, { params: { fields } });
}

function dryIssue(issueId, webhookPayload = {}) {
  let issue = dryIssues.get(issueId);
  if (!issue) {
    issue = {
      id: issueId,
      idReadable: issueId,
      summary: webhookPayload.summary || webhookPayload.issue?.summary || "",
      description: webhookPayload.description || webhookPayload.issue?.description || "",
      customFields: [],
      comments: [],
    };
    dryIssues.set(issueId, issue);
  } else {
    issue.summary = webhookPayload.summary || webhookPayload.issue?.summary || issue.summary;
    issue.description = webhookPayload.description || webhookPayload.issue?.description || issue.description;
  }
  return issue;
}

function readCodexSessionIdFromIssue(issue) {
  const fields = Array.isArray(issue.customFields) ? issue.customFields : [];
  const field = fields.find((item) => String(item.name || "").toLowerCase() === CODEX_SESSION_FIELD.toLowerCase());
  if (!field) return "";
  const value = field.value;
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    return String(value.text ?? value.presentation ?? value.name ?? "").trim();
  }
  return "";
}

async function writeCodexSessionId(issueId, sessionId) {
  if (!sessionId) return;
  if (YOUTRACK_DRY_RUN) {
    const issue = dryIssue(issueId);
    const existing = issue.customFields.find((item) => item.name === CODEX_SESSION_FIELD);
    const value = { text: sessionId, $type: "TextFieldValue" };
    if (existing) existing.value = value;
    else issue.customFields.push({ name: CODEX_SESSION_FIELD, $type: "TextIssueCustomField", value });
    return;
  }
  if (useYouTrackMcp()) {
    await youtrackMcp.callTool("update_custom_fields", {
      issue_id: issueId,
      custom_fields: {
        [CODEX_SESSION_FIELD]: sessionId,
      },
    });
    return;
  }

  await youtrackJson(`/api/issues/${encodeURIComponent(issueId)}`, {
    method: "POST",
    params: {
      fields: "id,idReadable,customFields(name,$type,value(text))",
    },
    body: {
      customFields: [
        {
          name: CODEX_SESSION_FIELD,
          $type: "TextIssueCustomField",
          value: {
            text: sessionId,
            $type: "TextFieldValue",
          },
        },
      ],
    },
  });
}

async function addIssueComment(issueId, text) {
  const bodyText = truncateText(text, Number(env("YOUTRACK_COMMENT_MAX_CHARS", "25000")));
  if (YOUTRACK_DRY_RUN) {
    dryIssue(issueId).comments.push({
      id: `dry-comment-${Date.now()}`,
      text: bodyText,
      created: Date.now(),
    });
    return;
  }
  if (useYouTrackMcp()) {
    await youtrackMcp.callTool("add_issue_comment", {
      issue_id: issueId,
      text: bodyText,
    });
    return;
  }

  await youtrackJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, {
    method: "POST",
    params: {
      fields: "id,text,author(login,fullName),created",
      ...(MUTE_NOTIFICATIONS ? { muteUpdateNotifications: "true" } : {}),
    },
    body: { text: bodyText },
  });
}

function truncateText(text, maxChars) {
  const value = String(text ?? "").trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}...`;
}

async function handleResultEvent(result) {
  remember(recentResults, {
    type: result.type,
    jobId: result.jobId,
    issueId: result.issueId,
    sessionId: result.sessionId || null,
    receivedAt: nowIso(),
  });

  if (result.type === "session_started") {
    await writeCodexSessionId(result.issueId, result.sessionId);
    await addIssueComment(
      result.issueId,
      [
        `Codex session started: ${result.sessionId}`,
        "",
        `JetStream job: ${result.jobId}`,
      ].join("\n"),
    );
    return;
  }

  if (result.type === "analysis_completed") {
    await addIssueComment(
      result.issueId,
      [
        `Codex analysis completed for session ${result.sessionId || "(unknown)"}.`,
        "",
        result.finalResponse || "(empty result)",
      ].join("\n"),
    );
    return;
  }

  if (result.type === "analysis_failed") {
    await addIssueComment(
      result.issueId,
      [
        `Codex analysis failed for session ${result.sessionId || "(unknown)"}.`,
        "",
        result.error || "Unknown error",
      ].join("\n"),
    );
  }
}

async function startResultConsumer(js) {
  const consumer = await js.consumers.get(YT_CODEX_STREAM, GATEWAY_RESULTS_DURABLE);
  const messages = await consumer.consume({ max_messages: 1 });
  void (async () => {
    for await (const msg of messages) {
      try {
        const result = msg.json();
        await handleResultEvent(result);
        msg.ack();
      } catch (error) {
        console.error(`[youtrack:gateway] result failed: ${formatError(error)}`);
        msg.nak(30_000);
      }
    }
  })().catch((error) => {
    console.error(`[youtrack:gateway] result consumer stopped: ${formatError(error)}`);
  });
  return () => void messages.close();
}

async function handleWebhook(req, context) {
  if (!verifyWebhookRequest(req)) {
    return jsonResponse({ ok: false, error: "bad_webhook_token" }, 401);
  }

  const text = await readRequestBody(req);
  const payload = parseWebhookBody(text);
  const normalized = normalizeWebhookPayload(payload);
  const event = remember(recentWebhookEvents, {
    receivedAt: nowIso(),
    method: req.method,
    url: req.url,
    contentType: req.headers["content-type"] || "",
    userAgent: req.headers["user-agent"] || "",
    youtrackEventHeader: req.headers["x-youtrack-event"] || "",
    normalized,
    payload,
  });

  await publishWebhookChatMessage(context.nc, event);

  let job = null;
  let ignoredReason = "";
  if (shouldEnqueueCodexJob(normalized)) {
    job = await enqueueCodexJob(context.js, event);
  } else {
    ignoredReason = normalized.event ? `ignored_${normalized.event}` : "ignored_unknown_event";
    if (eventKey(normalized.event) === "commentadded") ignoredReason = "ignored_comment_added";
    if (isCodexSessionFieldOnlyUpdate(normalized)) ignoredReason = "ignored_codex_session_field_update";
  }

  return jsonResponse({
    ok: true,
    event: {
      issueId: normalized.issueId,
      event: normalized.event,
      changedFields: normalized.changedFields,
    },
    chatSubject: AGENT_MESSAGE_SUBJECT,
    job,
    ignoredReason: job ? "" : ignoredReason,
  });
}

async function handleHttp(req, context) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/healthz") {
      const jetstreamStatus = await jetStreamReadiness(context.nc);
      return jsonResponse({
        ok: jetstreamStatus.ok,
        service: "youtrack-codex-gateway",
        agent: {
          promptSubject: PROMPT_SUBJECT,
          messageSubject: AGENT_MESSAGE_SUBJECT,
        },
        webhook: {
          endpoint: "/youtrack/webhook",
          publicUrl: PUBLIC_WEBHOOK_URL || null,
          tokenRequired: Boolean(WEBHOOK_TOKEN),
          receivedEvents: recentWebhookEvents.length,
          jobs: recentJobs.length,
          results: recentResults.length,
        },
        jetstream: jetstreamStatus,
        youtrack: {
          mode: youtrackMode(),
          baseUrl: YOUTRACK_BASE_URL,
          mcpUrl: YOUTRACK_MCP_URL || null,
          access: youtrackAccessStatus(),
        },
        dryRun: YOUTRACK_DRY_RUN,
      }, jetstreamStatus.ok ? 200 : 503);
    }

    if (url.pathname === "/youtrack/api-check") {
      return jsonResponse(await checkYouTrackApi(context.nc));
    }

    if (url.pathname === "/youtrack/webhook" && req.method === "POST") {
      return handleWebhook(req, context);
    }

    if (url.pathname === "/youtrack/webhooks/last" && req.method === "GET") {
      return jsonResponse({ events: recentWebhookEvents });
    }

    if (url.pathname === "/youtrack/jobs/last" && req.method === "GET") {
      return jsonResponse({ jobs: recentJobs, results: recentResults });
    }

    if (url.pathname === "/youtrack/dry-run-state" && req.method === "GET") {
      return jsonResponse({ dryRun: YOUTRACK_DRY_RUN, issues: Object.fromEntries(dryIssues) });
    }

    return jsonResponse({
      ok: false,
      error: "not_found",
      endpoints: [
        "GET /healthz",
        "GET /youtrack/api-check",
        "POST /youtrack/webhook",
        "GET /youtrack/webhooks/last",
        "GET /youtrack/jobs/last",
        "GET /youtrack/dry-run-state",
      ],
    }, 404);
  } catch (error) {
    return jsonResponse({ ok: false, error: formatError(error) }, 500);
  }
}

async function checkYouTrackApi(nc) {
  const checks = [];
  const jetstreamStatus = await jetStreamReadiness(nc);
  checks.push({ label: "jetstream", ok: jetstreamStatus.ok, details: jetstreamStatus });

  if (YOUTRACK_DRY_RUN) {
    return {
      ok: jetstreamStatus.ok,
      mode: youtrackMode(),
      baseUrl: YOUTRACK_BASE_URL,
      mcpUrl: YOUTRACK_MCP_URL || null,
      token: youtrackAccessStatus(),
      dryRun: true,
      checks,
    };
  }

  async function check(label, fn) {
    try {
      const details = await fn();
      checks.push({ label, ok: true, details });
      return details;
    } catch (error) {
      checks.push({ label, ok: false, error: formatError(error) });
      return null;
    }
  }

  if (useYouTrackMcp()) {
    await checkYouTrackMcp(checks, check);
    return {
      ok: checks.every((item) => item.ok),
      mode: "mcp",
      baseUrl: YOUTRACK_BASE_URL,
      mcpUrl: YOUTRACK_MCP_URL,
      token: "not_required_mcp",
      dryRun: false,
      checks,
    };
  }

  await check("auth_api_me", () => youtrackJson("/api/users/me", {
    params: { fields: "id,login,fullName,email,guest,banned" },
  }));

  const issues = await check("issues_top1", () => youtrackJson("/api/issues", {
    params: {
      fields: "id,idReadable,summary,customFields(name,$type,value(text,presentation))",
      "$top": 1,
    },
  }));

  const targetIssue = API_CHECK_ISSUE || (Array.isArray(issues) && issues[0] ? (issues[0].idReadable || issues[0].id) : "");
  if (!targetIssue) {
    checks.push({ label: "comments_api", ok: false, error: "no accessible issue to check comments API" });
    checks.push({ label: "codex_session_field", ok: false, error: "no accessible issue to check custom field" });
  } else {
    await check("comments_api", () => youtrackJson(`/api/issues/${encodeURIComponent(targetIssue)}/comments`, {
      params: { fields: "id,text", "$top": 1 },
    }));

    const issue = await check("codex_session_field", () => youtrackJson(`/api/issues/${encodeURIComponent(targetIssue)}`, {
      params: {
        fields: "id,idReadable,customFields(name,$type,value(text,presentation))",
      },
    }));
    if (issue) {
      const field = (issue.customFields || []).find((item) => item.name === CODEX_SESSION_FIELD);
      if (!field) {
        checks.push({ label: "codex_session_field_exists", ok: false, error: `${CODEX_SESSION_FIELD} is missing` });
      } else if (field.$type !== "TextIssueCustomField") {
        checks.push({
          label: "codex_session_field_type",
          ok: false,
          error: `${CODEX_SESSION_FIELD} must be TextIssueCustomField, got ${field.$type || "(unknown)"}`,
        });
      } else {
        checks.push({ label: "codex_session_field_type", ok: true, details: { type: field.$type } });
      }
    }
  }

  return {
    ok: checks.every((item) => item.ok),
    mode: "rest",
    baseUrl: YOUTRACK_BASE_URL,
    token: YOUTRACK_TOKEN ? "set" : "missing",
    dryRun: false,
    checks,
  };
}

async function checkYouTrackMcp(checks, check) {
  await check("mcp_tools", async () => {
    const result = await youtrackMcp.listTools();
    const names = Array.isArray(result?.tools) ? result.tools.map((tool) => tool.name).filter(Boolean) : [];
    const required = [
      "get_current_user",
      "search_issues",
      "get_issue",
      "get_issue_comments",
      "get_custom_fields",
      "update_custom_fields",
      "add_issue_comment",
    ];
    const missing = required.filter((name) => !names.includes(name));
    if (missing.length) throw new Error(`yt-mcp-ruby tools are disabled: ${missing.join(", ")}`);
    return { count: names.length, required };
  });

  await check("mcp_current_user", () => youtrackMcp.callTool("get_current_user"));
  const issues = await check("mcp_search_top1", () => youtrackMcp.callTool("search_issues", {
    query: "",
    top: 1,
  }));
  const targetIssue = API_CHECK_ISSUE || firstIssueId(issues);
  if (!targetIssue) {
    checks.push({ label: "mcp_comments_api", ok: false, error: "no accessible issue to check comments API" });
    checks.push({ label: "mcp_codex_session_field", ok: false, error: "no accessible issue to check custom field" });
    return;
  }

  await check("mcp_comments_api", () => youtrackMcp.callTool("get_issue_comments", {
    issue_id: targetIssue,
    top: 1,
  }));

  const issue = await check("mcp_codex_session_field", () => youtrackMcp.callTool("get_issue", {
    issue_id: targetIssue,
  }));
  if (issue) checkCodexSessionField(checks, issue);

  const project = API_CHECK_PROJECT || issue?.project?.shortName || projectFromIssueId(targetIssue);
  if (project) {
    await check("mcp_custom_fields", () => youtrackMcp.callTool("get_custom_fields", { project }));
  } else {
    checks.push({ label: "mcp_custom_fields", ok: false, error: "project is unknown" });
  }
}

function firstIssueId(value) {
  const issue = Array.isArray(value) ? value[0] : null;
  return issue ? String(issue.idReadable || issue.id || "") : "";
}

function projectFromIssueId(issueId) {
  const match = String(issueId || "").match(/^([A-Z][A-Z0-9_]*)-/i);
  return match ? match[1] : "";
}

function checkCodexSessionField(checks, issue) {
  const field = (issue.customFields || []).find((item) => item.name === CODEX_SESSION_FIELD);
  if (!field) {
    checks.push({ label: "codex_session_field_exists", ok: false, error: `${CODEX_SESSION_FIELD} is missing` });
  } else if (field.$type !== "TextIssueCustomField") {
    checks.push({
      label: "codex_session_field_type",
      ok: false,
      error: `${CODEX_SESSION_FIELD} must be TextIssueCustomField, got ${field.$type || "(unknown)"}`,
    });
  } else {
    checks.push({ label: "codex_session_field_type", ok: true, details: { type: field.$type } });
  }
}

async function youtrackJson(path, { method = "GET", params = {}, body } = {}) {
  const result = await youtrackRequest(path, { method, params, body });
  if (!result.ok) {
    const message =
      result.payload && typeof result.payload === "object"
        ? result.payload.error_description || result.payload.error || JSON.stringify(result.payload)
        : String(result.payload ?? "");
    throw new Error(`YouTrack ${result.status}: ${message.slice(0, 500)}`);
  }
  return result.payload;
}

async function youtrackRequest(path, { method = "GET", params = {}, body } = {}) {
  requireYouTrackToken();
  const url = new URL(`${baseUrl()}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(Number.isFinite(YOUTRACK_TIMEOUT_MS) ? YOUTRACK_TIMEOUT_MS : 15_000),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${YOUTRACK_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
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
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    location: response.headers.get("location") || "",
    payload,
  };
}

async function handlePrompt(envelope, response, nc) {
  const prompt = String(envelope.prompt || "").toLowerCase();
  if (prompt.includes("health") || prompt.includes("status")) {
    const readiness = await jetStreamReadiness(nc);
    await response.send(JSON.stringify({
      service: "youtrack-codex-gateway",
      promptSubject: PROMPT_SUBJECT,
      messageSubject: AGENT_MESSAGE_SUBJECT,
      jetstream: readiness,
      recentJobs: recentJobs.slice(0, 5),
      recentResults: recentResults.slice(0, 5),
      youtrack: {
        mode: youtrackMode(),
        baseUrl: YOUTRACK_BASE_URL,
        mcpUrl: YOUTRACK_MCP_URL || null,
        access: youtrackAccessStatus(),
      },
      dryRun: YOUTRACK_DRY_RUN,
    }, null, 2));
    return;
  }

  if (prompt.includes("hook") || prompt.includes("job")) {
    await response.send(JSON.stringify({
      webhooks: recentWebhookEvents.slice(0, 5),
      jobs: recentJobs.slice(0, 10),
      results: recentResults.slice(0, 10),
    }, null, 2));
    return;
  }

  await response.send([
    "YouTrack/Codex gateway is running.",
    `Webhook: ${PUBLIC_WEBHOOK_URL || "/youtrack/webhook"}`,
    `JetStream stream: ${YT_CODEX_STREAM}`,
    `Jobs: ${YT_CODEX_JOB_SUBJECT}`,
    `Results: ${YT_CODEX_RESULT_SUBJECT}`,
    "",
    "Try: health, hooks, jobs",
  ].join("\n"));
}

async function main() {
  const nc = await connectNats("youtrack-codex-gateway");
  const { js } = await openJetStream(nc);
  const stopResultConsumer = await startResultConsumer(js);

  const service = new AgentService({
    nc,
    agent: YOUTRACK_AGENT,
    owner: YOUTRACK_OWNER,
    name: YOUTRACK_NAME,
    session: YOUTRACK_NAME,
    version: SERVICE_VERSION,
    attachmentsOk: false,
    description: "YouTrack webhook gateway for Codex task analysis.",
    extraMetadata: {
      role: "youtrack-codex-gateway",
      youtrack_mode: youtrackMode(),
      youtrack_base_url: YOUTRACK_BASE_URL,
      youtrack_mcp_url: YOUTRACK_MCP_URL || "",
      webhook_path: "/youtrack/webhook",
      message_subject: AGENT_MESSAGE_SUBJECT,
      job_subject: YT_CODEX_JOB_SUBJECT,
      result_subject: YT_CODEX_RESULT_SUBJECT,
    },
  });

  service.onPrompt(async (envelope, response) => {
    try {
      await handlePrompt(envelope, response, nc);
    } catch (error) {
      await response.send(`YouTrack/Codex gateway error: ${formatError(error)}`);
    }
  });
  await service.start();

  const context = { nc, js };
  const httpServer = createServer((req, res) => {
    void handleHttp(req, context).then(async (response) => {
      res.statusCode = response.status;
      for (const [key, value] of response.headers) res.setHeader(key, value);
      res.end(Buffer.from(await response.arrayBuffer()));
    });
  });
  await new Promise((resolve) => httpServer.listen(WEBHOOK_PORT, WEBHOOK_HOST, resolve));

  console.log(`[youtrack:gateway] ${service.subject.prompt}`);
  console.log(`[youtrack:gateway] webhook=http://${WEBHOOK_HOST}:${WEBHOOK_PORT}/youtrack/webhook`);
  console.log(`[youtrack:gateway] message subject=${AGENT_MESSAGE_SUBJECT}`);
  console.log(`[youtrack:gateway] jobs=${YT_CODEX_JOB_SUBJECT} results=${YT_CODEX_RESULT_SUBJECT}`);
  console.log(`[youtrack:gateway] mode=${youtrackMode()} base=${YOUTRACK_BASE_URL} mcp=${YOUTRACK_MCP_URL || "(unset)"} access=${youtrackAccessStatus()} dryRun=${YOUTRACK_DRY_RUN}`);

  const stop = async () => {
    stopResultConsumer();
    await new Promise((resolve) => httpServer.close(resolve));
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
  console.error(`[youtrack:gateway] failed: ${formatError(error)}`);
  process.exitCode = 1;
});
