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
// аккуратно поднимаем два процесса рядом:
//
// 1. `node src/basic-controller.js`
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

const natsUrl = process.env.NATS_URL || "nats://nats-synadia-dev_nats:4222";
const port = process.env.PORT || "3300";

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
  const parsed = new URL(urlValue);
  const host = parsed.hostname;
  const portNumber = Number(parsed.port || 4222);
  return { host, port: portNumber };
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

  throw new Error(`NATS is not reachable after ${timeoutMs}ms: ${urlValue}`);
}

function start(label, command, args, options = {}) {
  console.log(`[prod] starting ${label}: ${command} ${args.join(" ")}`);
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

await waitForTcp(natsUrl);

start("controller", "node", ["src/basic-controller.js"]);
start("ui", "bun", ["run", "server/index.ts", "--host", process.env.HOST || "0.0.0.0", "--port", port, "--servers", natsUrl], {
  cwd: uiDir,
});
