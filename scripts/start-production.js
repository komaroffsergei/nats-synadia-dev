import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");
const uiDir = join(rootDir, "examples", "agent-web-ui");

const natsUrl = process.env.NATS_URL || "nats://nats-synadia-dev_nats:4222";
const natsUrlsJson = process.env.NATS_URLS_JSON || "";
const port = process.env.PORT || "3300";
const youtrackWebhookPort = process.env.YOUTRACK_WEBHOOK_PORT || "3401";

const childEnv = {
  ...process.env,
  NATS_URL: natsUrl,
  NATS_URLS_JSON: natsUrlsJson,
  PORT: port,
  YOUTRACK_BASE_URL: process.env.YOUTRACK_BASE_URL || "https://yt.giscloud.ru",
  YOUTRACK_OWNER: process.env.YOUTRACK_OWNER || "giscloud",
  YOUTRACK_AGENT_NAME: process.env.YOUTRACK_AGENT_NAME || "codex",
  YOUTRACK_WEBHOOK_HOST: process.env.YOUTRACK_WEBHOOK_HOST || "127.0.0.1",
  YOUTRACK_WEBHOOK_PORT: youtrackWebhookPort,
  YOUTRACK_WEBHOOK_PROXY_TARGET: process.env.YOUTRACK_WEBHOOK_PROXY_TARGET || `http://127.0.0.1:${youtrackWebhookPort}`,
  YOUTRACK_PUBLIC_WEBHOOK_URL:
    process.env.YOUTRACK_PUBLIC_WEBHOOK_URL ||
    "https://nats-synadia-dev.gis-master.ru/youtrack/webhook",
  YOUTRACK_AGENT_MESSAGE_SUBJECT: process.env.YOUTRACK_AGENT_MESSAGE_SUBJECT || "youtrack.messages.giscloud.codex",
};

const children = new Map();
let shuttingDown = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTcpEndpoint(urlValue) {
  const parsed = new URL(firstNatsUrl(urlValue));
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 4222),
  };
}

function firstNatsUrl(urlValue) {
  return String(urlValue).split(",")[0].trim();
}

function redactNatsUrl(value) {
  return String(value).replace(/((?:nats|tls|ws|wss)(?:\+[^:]+)?:\/\/)([^@,\/]+)@/g, "$1<redacted>@");
}

function natsUrlsForWait() {
  return unique([natsUrl, ...parseNatsUrlsJson(natsUrlsJson)]);
}

function parseNatsUrlsJson(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => item?.url || item?.servers || "")
      .map(String)
      .filter(Boolean);
  }
  if (parsed && typeof parsed === "object") {
    return Object.values(parsed).map(String).filter(Boolean);
  }
  return [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function waitForTcp(urlValue, timeoutMs = 60_000) {
  const startedAt = Date.now();
  const endpoint = parseTcpEndpoint(urlValue);

  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection(endpoint);
      socket.setTimeout(1000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });

    if (ok) return;
    console.log(`[prod] waiting for NATS ${endpoint.host}:${endpoint.port}`);
    await sleep(1000);
  }

  throw new Error(`NATS is not reachable after ${timeoutMs}ms: ${redactNatsUrl(urlValue)}`);
}

function start(label, command, args, options = {}) {
  console.log(`[prod] starting ${label}: ${command} ${args.map(redactNatsUrl).join(" ")}`);
  const child = spawn(command, args, {
    cwd: options.cwd || rootDir,
    env: childEnv,
    stdio: "inherit",
  });

  children.set(label, child);

  child.once("exit", (code, signal) => {
    children.delete(label);
    if (shuttingDown) return;

    console.error(`[prod] ${label} exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
    stopAll("SIGTERM");
    process.exitCode = code || 1;
  });

  return child;
}

function stopAll(signal) {
  shuttingDown = true;
  for (const [label, child] of children.entries()) {
    if (child.killed) continue;
    console.log(`[prod] stopping ${label} with ${signal}`);
    child.kill(signal);
  }
}

process.once("SIGINT", () => stopAll("SIGINT"));
process.once("SIGTERM", () => stopAll("SIGTERM"));

await Promise.all(natsUrlsForWait().map((url) => waitForTcp(url)));

start("youtrack-gateway", "node", ["src/youtrack-gateway.js"]);
start("ui", "bun", ["run", "server/index.ts", "--host", process.env.HOST || "0.0.0.0", "--port", port], {
  cwd: uiDir,
});
