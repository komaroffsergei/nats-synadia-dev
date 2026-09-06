import { dryAnalysis } from "./dry-analysis.js";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Codex } from "@openai/codex-sdk";
import {
  CODEX_WORKER_DURABLE,
  YT_CODEX_RESULT_SUBJECT,
  YT_CODEX_STREAM,
  openJetStream,
} from "./jetstream.js";
import {
  compactText,
  connectNats,
  encodeJson,
  env,
  envAny,
  envFlag,
  formatError,
  nowIso,
  safeJson,
} from "./common.js";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..");
const SKILL_PATH = resolve(rootDir, env("CODEX_YOUTRACK_SKILL_PATH", "skills/youtrack-task-analysis/SKILL.md"));
const DEFAULT_CODEX_PATH_OVERRIDE = resolve(rootDir, "scripts/acodex");
const CODEX_PATH_OVERRIDE = envAny(["CODEX_PATH_OVERRIDE", "ACODEX_PATH", "CODEX_CLI_PATH"], DEFAULT_CODEX_PATH_OVERRIDE);
const CODEX_DRY_RUN = envFlag("CODEX_DRY_RUN", false);
const CODEX_MODEL = env("CODEX_MODEL", "");
const CODEX_REASONING_EFFORT = env("CODEX_REASONING_EFFORT", "medium");
const CODEX_WORKING_DIRECTORY = env("CODEX_WORKING_DIRECTORY", rootDir);
const CODEX_WORKER_CONCURRENCY = Number(env("CODEX_WORKER_CONCURRENCY", "1"));
const CODEX_SKIP_GIT_REPO_CHECK = envFlag("CODEX_SKIP_GIT_REPO_CHECK", false);
const CODEX_WEBHOOK_MAX_CHARS = Number(env("CODEX_WEBHOOK_MAX_CHARS", "12000"));
const CODEX_APPROVAL_POLICY = env("CODEX_APPROVAL_POLICY", "never");
const CODEX_SANDBOX_MODE = env("CODEX_SANDBOX_MODE", "read-only");
const CODEX_NETWORK_ACCESS = envFlag("CODEX_NETWORK_ACCESS", false);
const CODEX_WEB_SEARCH = env("CODEX_WEB_SEARCH", "disabled");
const HEARTBEAT_MS = Number(env("CODEX_WORKER_HEARTBEAT_MS", "30000"));

async function main() {
  const nc = await connectNats("youtrack-codex-worker");
  const { js } = await openJetStream(nc);
  const consumer = await js.consumers.get(YT_CODEX_STREAM, CODEX_WORKER_DURABLE);
  const messages = await consumer.consume({ max_messages: 1 });
  const skill = await readFile(SKILL_PATH, "utf8");
  const codex = CODEX_DRY_RUN ? null : createCodexClient();

  console.log(`[codex:worker] durable=${CODEX_WORKER_DURABLE} stream=${YT_CODEX_STREAM}`);
  console.log(`[codex:worker] dryRun=${CODEX_DRY_RUN} workingDirectory=${CODEX_WORKING_DIRECTORY}`);
  console.log(`[codex:worker] codexPath=${CODEX_PATH_OVERRIDE}`);
  if (CODEX_WORKER_CONCURRENCY !== 1) {
    console.warn("[codex:worker] CODEX_WORKER_CONCURRENCY is forced to 1 in this MVP");
  }

  for await (const msg of messages) {
    let heartbeat = null;
    try {
      heartbeat = startHeartbeat(msg);
      const job = msg.json();
      await processJob(js, codex, skill, job);
      msg.ack();
    } catch (error) {
      console.error(`[codex:worker] job failed: ${formatError(error)}`);
      let failurePublished = false;
      try {
        const job = safeMsgJson(msg);
        if (job?.issueId) {
          await publishResult(js, {
            type: "analysis_failed",
            jobId: job.id || "",
            issueId: job.issueId,
            sessionId: job.sessionId || "",
            error: formatError(error),
            failedAt: nowIso(),
          });
          failurePublished = true;
        }
      } catch (publishError) {
        console.error(`[codex:worker] failed to publish failure result: ${formatError(publishError)}`);
      }
      if (failurePublished) msg.ack();
      else msg.nak(30_000);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}

function createCodexClient() {
  const apiKey = envAny(["CODEX_API_KEY", "OPENAI_API_KEY"], "");
  return new Codex({
    codexPathOverride: CODEX_PATH_OVERRIDE,
    ...(apiKey ? { apiKey } : {}),
    ...(env("CODEX_BASE_URL", "") ? { baseUrl: env("CODEX_BASE_URL") } : {}),
    env: codexChildEnv(),
    config: {
      ...(env("CODEX_CONFIG_PROFILE", "") ? { profile: env("CODEX_CONFIG_PROFILE") } : {}),
    },
  });
}

function codexChildEnv() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isAllowedCodexEnv(key)) {
      out[key] = value;
    }
  }
  delete out.YOUTRACK_TOKEN;
  delete out.YT_TOKEN;
  return out;
}

function isAllowedCodexEnv(key) {
  return [
    "PATH",
    "HOME",
    "OPENAI_API_KEY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "GIT_SSL_CAINFO",
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "npm_config_cafile",
  ].includes(key) || key.startsWith("CODEX_");
}

async function processJob(js, codex, skill, job) {
  validateJob(job);

  if (CODEX_DRY_RUN) {
    const sessionId = job.sessionId || drySessionId(job.issueId);
    if (!job.sessionId) {
      await publishResult(js, {
        type: "session_started",
        jobId: job.id,
        issueId: job.issueId,
        sessionId,
        startedAt: nowIso(),
      });
    }
    await publishResult(js, {
      type: "analysis_completed",
      jobId: job.id,
      issueId: job.issueId,
      sessionId,
      finalResponse: dryAnalysis(job),
      usage: null,
      items: [],
      completedAt: nowIso(),
    });
    return;
  }

  if (job.sessionId) {
    try {
      await runCodexThread(js, codex, skill, job);
      return;
    } catch (error) {
      if (!isMissingCodexThreadError(error)) throw error;
      console.warn(`[codex:worker] cannot resume ${job.sessionId}; starting a new thread`);
    }
  }

  await runCodexThread(js, codex, skill, { ...job, sessionId: "" });
}

async function runCodexThread(js, codex, skill, job) {
  const thread = job.sessionId
    ? codex.resumeThread(job.sessionId, threadOptions())
    : codex.startThread(threadOptions());

  let sessionId = job.sessionId || "";
  let usage = null;
  const items = [];
  const agentMessages = [];
  const { events } = await thread.runStreamed(buildPrompt(skill, job));

  for await (const event of events) {
    if (event.type === "thread.started") {
      sessionId = event.thread_id;
      await publishResult(js, {
        type: "session_started",
        jobId: job.id,
        issueId: job.issueId,
        sessionId,
        startedAt: nowIso(),
      });
      continue;
    }

    if (event.type === "item.completed") {
      items.push(event.item);
      if (event.item.type === "agent_message" && event.item.text) {
        agentMessages.push(event.item.text);
      }
      continue;
    }

    if (event.type === "turn.completed") {
      usage = event.usage;
      continue;
    }

    if (event.type === "turn.failed") {
      throw new Error(event.error?.message || "Codex turn failed");
    }

    if (event.type === "error") {
      throw new Error(event.message || "Codex stream error");
    }
  }

  sessionId ||= thread.id || "";
  const finalResponse = agentMessages.at(-1) || summarizeCompletedItems(items);
  await publishResult(js, {
    type: "analysis_completed",
    jobId: job.id,
    issueId: job.issueId,
    sessionId,
    finalResponse,
    usage,
    items: summarizeItemsForResult(items),
    completedAt: nowIso(),
  });
}

function isMissingCodexThreadError(error) {
  const message = formatError(error).toLowerCase();
  return message.includes("thread/resume failed") && message.includes("no rollout found");
}

function validateJob(job) {
  if (!job || typeof job !== "object") throw new Error("job must be a JSON object");
  if (!job.id) throw new Error("job.id is required");
  if (!job.issueId) throw new Error("job.issueId is required");
}

function threadOptions() {
  const options = {
    sandboxMode: CODEX_SANDBOX_MODE,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    workingDirectory: CODEX_WORKING_DIRECTORY,
    skipGitRepoCheck: CODEX_SKIP_GIT_REPO_CHECK,
    networkAccessEnabled: CODEX_NETWORK_ACCESS,
    webSearchMode: CODEX_WEB_SEARCH,
  };
  if (CODEX_MODEL) options.model = CODEX_MODEL;
  if (CODEX_REASONING_EFFORT) options.modelReasoningEffort = CODEX_REASONING_EFFORT;
  return options;
}

function buildPrompt(skill, job) {
  const issue = job.issue || {};
  return [
    "You are analyzing a YouTrack issue for a Codex automation pipeline.",
    "Do not modify files. Do not call YouTrack. Return only a concise task analysis in Russian.",
    "",
    "# Project skill",
    skill.trim(),
    "",
    "# YouTrack issue",
    `Issue ID: ${job.issueId}`,
    `Event: ${job.event || "(unknown)"}`,
    `Existing Codex session: ${job.sessionId || "(new session)"}`,
    `Changed fields: ${(job.changedFields || []).join(", ") || "(none)"}`,
    "",
    "## Summary",
    issue.summary || "(empty)",
    "",
    "## Description",
    compactText(issue.description || "", 8000) || "(empty)",
    "",
    "## Full webhook JSON",
    "```json",
    safeJson(job.webhook || {}, CODEX_WEBHOOK_MAX_CHARS),
    "```",
  ].join("\n");
}


function drySessionId(issueId) {
  return `dry-${hashText(issueId).slice(0, 16)}`;
}

function hashText(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function summarizeCompletedItems(items) {
  const messages = items
    .filter((item) => item.type === "agent_message" && item.text)
    .map((item) => item.text);
  if (messages.length > 0) return messages.at(-1);
  return "Codex completed without a final agent message.";
}

function summarizeItemsForResult(items) {
  return items.map((item) => {
    if (item.type === "agent_message") {
      return { type: item.type, text: compactText(item.text, 2000) };
    }
    if (item.type === "command_execution") {
      return {
        type: item.type,
        command: item.command,
        status: item.status,
        exitCode: item.exit_code,
      };
    }
    if (item.type === "file_change") {
      return {
        type: item.type,
        status: item.status,
        changes: item.changes,
      };
    }
    if (item.type === "error") {
      return { type: item.type, message: item.message };
    }
    return { type: item.type };
  });
}

async function publishResult(js, payload) {
  await js.publish(YT_CODEX_RESULT_SUBJECT, encodeJson({
    id: randomUUID(),
    publishedAt: nowIso(),
    ...payload,
  }));
}

function safeMsgJson(msg) {
  try {
    return msg.json();
  } catch {
    return null;
  }
}

function startHeartbeat(msg) {
  if (!Number.isFinite(HEARTBEAT_MS) || HEARTBEAT_MS <= 0) return null;
  return setInterval(() => {
    try {
      msg.working();
    } catch {
      /* noop */
    }
  }, HEARTBEAT_MS);
}

main().catch((error) => {
  console.error(`[codex:worker] failed: ${formatError(error)}`);
  process.exitCode = 1;
});
