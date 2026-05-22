import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Production entrypoint для Docker image.
//
// В локальном учебном запуске процессы стартуют отдельными командами:
//   npm run nats
//   npm run controller
//   npm run ui
//
// В Docker/Swarm нам нужен один browser-facing container, поэтому здесь
// аккуратно поднимаем один или два процесса рядом:
//
// 1. `node src/basic-controller.js` (можно выключить START_BASIC_AGENTS=false)
//    Создаёт controller/persona/group-session agents и подключается к NATS.
//
// 2. `bun run server/index.ts`
//    Раздаёт Vue UI из dist/ и держит WebSocket bridge `/ws`.
//
// NATS остаётся отдельным service в `stack/nats-synadia-dev.drs`.
// Это важно: NATS - транспортная шина, а app container - только demo agents + UI.

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");
const uiDir = join(rootDir, "examples", "agent-web-ui");

const natsUrl =
  process.env.NATS_URL ||
  process.env.NATS_SERVERS ||
  process.env.NATS_SERVICE_URL ||
  "nats://nats-synadia-dev_nats:4222";
const natsConnections = process.env.NATS_CONNECTIONS || "";
const port = process.env.PORT || "3300";
const startBasicAgents = !["0", "false", "no", "off"].includes(
  String(process.env.START_BASIC_AGENTS || "true").toLowerCase(),
);

const childEnv = {
  ...process.env,
  NATS_URL: natsUrl,
  PORT: port,
};

const children = new Map();
let shuttingDown = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTcpEndpoint(urlValue) {
  // Для ожидания NATS нам достаточно host/port.
  // Если NATS_URL содержит user:pass или token, URL parser их проигнорирует
  // для TCP check-а, но сами credentials останутся в NATS_URL и будут прочитаны
  // SDK уже при реальном подключении.
  const parsed = new URL(firstNatsUrl(urlValue));
  const host = parsed.hostname;
  const portNumber = Number(parsed.port || 4222);
  return { host, port: portNumber };
}

function redactNatsUrl(value) {
  return String(value).replace(/((?:nats|tls|ws|wss)(?:\+[^:]+)?:\/\/)([^@,\/]+)@/g, "$1<redacted>@");
}

function firstNatsUrl(urlValue) {
  // NATS clients могут принимать список servers через запятую. TCP wait check
  // проверяет только первый endpoint: этого достаточно, чтобы не стартовать UI
  // до доступности хотя бы одного явно указанного NATS service.
  return String(urlValue).split(",")[0].trim();
}

function natsUrlsForWait() {
  const urls = parseNatsConnections(natsConnections);
  if (startBasicAgents) urls.unshift(natsUrl);
  return unique(urls.length > 0 ? urls : [natsUrl]);
}

function unique(values) {
  return [...new Set(values)];
}

function parseNatsConnections(raw) {
  return String(raw)
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eqAt = entry.indexOf("=");
      return eqAt >= 0 ? entry.slice(eqAt + 1).trim() : entry;
    })
    .filter((value) => value && !value.startsWith("context:"));
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
  const safeArgs = args.map((arg) => redactNatsUrl(arg));
  console.log(`[prod] starting ${label}: ${command} ${safeArgs.join(" ")}`);
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

if (startBasicAgents) {
  start("controller", "node", ["src/basic-controller.js"]);
} else {
  console.log("[prod] START_BASIC_AGENTS=false, starting UI bridge only");
}

start("ui", "bun", ["run", "server/index.ts", "--host", process.env.HOST || "0.0.0.0", "--port", port], {
  cwd: uiDir,
});
