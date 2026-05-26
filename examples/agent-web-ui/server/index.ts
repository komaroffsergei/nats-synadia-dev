// synadia-nats-agents web UI — Bun server entry point.
//
// Этот процесс держит один или несколько @synadia-ai/agents Client-ов
// (по одному на каждую независимую NATS-шину) и обслуживает:
//   - GET /ws     → WebSocket; each connection gets a fresh Bridge.
//   - everything else → static files from ./dist/ (SPA fallback to index.html).
//
// В --dev режиме static files не раздаются; открывай Vite dev server :5173,
// который proxy-ит /ws обратно сюда на :3300.

import { join, extname } from "node:path";
import { existsSync, statSync } from "node:fs";
import {
  Agents,
  SDK_PROTOCOL_VERSION,
  loadContextOptions,
  parseNatsUrl,
  type NatsConnection,
} from "@synadia-ai/agents";
import {
  connect as natsConnect,
  type NodeConnectionOptions,
} from "@nats-io/transport-node";
import { parseConfig, parseUrlNatsOverride, type NatsConnectionConfig } from "./config.ts";
import { Bridge, formatSdkProtocolVersion, type BridgeConnection, type BridgeWsData } from "./bridge.ts";

const config = parseConfig(Bun.argv);
let defaultConnectionsPromise: Promise<BridgeConnection[]> | null = null;

async function buildConnectOptions(connection: NatsConnectionConfig): Promise<NodeConnectionOptions> {
  if (connection.servers) {
    // `parseNatsUrl` extracts userinfo (token / user:password) — without it
    // a URL like `nats://TOKEN@host:port` would silently drop the token
    // because `@nats-io/transport-node` doesn't parse credentials from URLs.
    // `name` is spread last so the local connection identity wins even if
    // a future `parseNatsUrl` were to start emitting a `name` field.
    return { ...parseNatsUrl(connection.servers), name: `testui-${connection.id}` };
  }
  const contextName = connection.context ?? "current";
  return { ...(await loadContextOptions(contextName)), name: `testui-${connection.id}` };
}

async function openBridgeConnection(connection: NatsConnectionConfig): Promise<BridgeConnection> {
  const connectOpts = await buildConnectOptions(connection);
  const nc: NatsConnection = await natsConnect(connectOpts);
  const agents = new Agents({ nc });
  const serverInfoNote = connection.servers
    ? `servers=${redactNatsUrl(connection.servers)}`
    : `context=${connection.context ?? "current"}`;
  console.log(`[testui] NATS client connected label=${connection.label} (${serverInfoNote})`);
  return { ...connection, nc, agents };
}

const distDir = join(import.meta.dir, "..", "dist");
const sdkVersionString = formatSdkProtocolVersion(SDK_PROTOCOL_VERSION);
const youtrackProxyTarget = (process.env["YOUTRACK_WEBHOOK_PROXY_TARGET"] || "http://127.0.0.1:3401").replace(/\/+$/, "");

async function openConnections(connections: NatsConnectionConfig[]): Promise<BridgeConnection[]> {
  return Promise.all(connections.map(openBridgeConnection));
}

function getDefaultConnections(): Promise<BridgeConnection[]> {
  // Env/CLI/default подключения шарятся между всеми браузерными WebSocket-ами.
  // Это обычный режим работы UI: один Bun process держит один набор NATS
  // clients, а каждое окно браузера получает только свой Bridge state.
  defaultConnectionsPromise ??= openConnections(config.connections);
  return defaultConnectionsPromise;
}

async function openRequestConnections(url: URL): Promise<{ connections: BridgeConnection[]; closeWithBridge: boolean }> {
  const natsOverride = url.searchParams.get("nats");
  if (natsOverride !== null) {
    // URL override намеренно НЕ шарится между пользователями:
    // конкретная вкладка могла быть открыта для временной проверки чужого NATS.
    // Поэтому создаём отдельный NATS client и закрываем его вместе с WebSocket.
    return {
      connections: await openConnections(parseUrlNatsOverride(natsOverride)),
      closeWithBridge: true,
    };
  }

  return {
    connections: await getDefaultConnections(),
    closeWithBridge: false,
  };
}

async function closeConnections(connections: BridgeConnection[]): Promise<void> {
  for (const connection of connections) {
    try {
      await connection.agents.close();
    } catch (e) {
      console.warn(`[testui] agents.close() failed for ${connection.label}:`, (e as Error).message);
    }
    try {
      await connection.nc.close();
    } catch {
      /* noop */
    }
  }
}

function redactNatsUrl(value: string): string {
  // NATS URLs can carry token or user:password before `@`.
  // Health checks and logs should show the endpoint, not secret material.
  return value.replace(/((?:nats|tls|ws|wss)(?:\+[^:]+)?:\/\/)([^@,\/]+)@/g, "$1<redacted>@");
}

async function proxyYouTrackRequest(req: Request, url: URL): Promise<Response> {
  // Production ingress у stack-а открыт только на публичный UI service port 3300.
  // Сам YouTrack Codex agent слушает локальный HTTP port 3401 внутри того же
  // container-а, поэтому публичные `/youtrack/*` запросы прокидываем отсюда.
  //
  // Это даёт один внешний URL для YouTrack Webhook Triggers App:
  //   https://nats-synadia-dev.gis-master.ru/youtrack/webhook
  //
  // А локальный agent остаётся недоступен напрямую извне.
  const targetUrl = new URL(`${youtrackProxyTarget}${url.pathname}${url.search}`);
  const headers = new Headers(req.headers);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  return fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });
}

const server = Bun.serve<BridgeWsData>({
  hostname: config.host,
  port: config.port,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/youtrack/")) {
      return proxyYouTrackRequest(req, url);
    }

    if (url.pathname === "/healthz") {
      let opened: Awaited<ReturnType<typeof openRequestConnections>>;
      try {
        // `/healthz?nats=...` использует тот же resolver, что и `/ws?nats=...`.
        // Так можно проверить приоритет адресной строки без открытия браузера.
        opened = await openRequestConnections(url);
      } catch (error) {
        return Response.json(
          {
            ok: false,
            service: "synadia-nats-agents-web-ui",
            error: (error as Error).message,
          },
          { status: 503 },
        );
      }
      const natsConnections = opened.connections;
      const body = {
        ok: true,
        service: "synadia-nats-agents-web-ui",
        nats: {
          mode: natsConnections.length > 1 ? "multi" : (natsConnections[0]?.servers ? "servers" : "context"),
          connections: natsConnections.map((connection) => ({
            id: connection.id,
            label: connection.label,
            value: connection.servers
              ? redactNatsUrl(connection.servers)
              : `context:${connection.context ?? "current"}`,
            server: connection.nc.getServer() || null,
          })),
        },
        sdkProtocolVersion: sdkVersionString,
      };
      if (opened.closeWithBridge) await closeConnections(natsConnections);
      return Response.json({
        ...body,
      });
    }

    if (url.pathname === "/ws") {
      let opened: Awaited<ReturnType<typeof openRequestConnections>>;
      try {
        // Главный switch приоритета NATS для UI:
        // - есть `?nats=...` -> подключаемся туда;
        // - нет query-param -> используем CLI/env/default из parseConfig().
        opened = await openRequestConnections(url);
      } catch (error) {
        return Response.json(
          {
            ok: false,
            error: "nats_connect_failed",
            message: (error as Error).message,
          },
          { status: 502 },
        );
      }
      const bridge = new Bridge(opened.connections, sdkVersionString, opened.closeWithBridge);
      const upgraded = srv.upgrade(req, { data: { bridge } });
      if (upgraded) return undefined;
      bridge.close();
      return new Response("expected WebSocket upgrade on /ws", { status: 400 });
    }

    // Static file serving from dist/ when available.
    if (existsSync(distDir)) {
      const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = join(distDir, decodeURIComponent(safePath));
      // Reject path traversal outside dist/.
      if (!filePath.startsWith(distDir)) {
        return new Response("forbidden", { status: 403 });
      }
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        return new Response(Bun.file(filePath));
      }
      // SPA fallback for extensionless routes.
      if (!extname(url.pathname)) {
        return new Response(Bun.file(join(distDir, "index.html")));
      }
      return new Response("not found", { status: 404 });
    }

    if (config.dev) {
      return new Response(
        "Dev mode: open http://localhost:5173 (run `bun run vite` in another terminal).\nThis port only serves /ws in dev.\n",
        { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response(
      "No dist/ found. Run `bun run build` to produce it, then `bun run start` again.\n",
      { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
  websocket: {
    open(ws) {
      ws.data.bridge.open(ws);
    },
    message(ws, msg) {
      const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
      ws.data.bridge.onMessage(text);
    },
    close(ws) {
      ws.data.bridge.close();
    },
  },
});

console.log(`[testui] listening on http://${config.host}:${server.port} (sdk protocol ${sdkVersionString})`);
if (config.dev) {
  console.log(`[testui] dev mode — open http://localhost:5173 (Vite)`);
} else if (!existsSync(distDir)) {
  console.log(`[testui] no dist/ found; run \`bun run build\` to serve the UI from this port`);
}

async function shutdown(sig: NodeJS.Signals): Promise<void> {
  console.log(`[testui] received ${sig}, shutting down...`);
  try {
    server.stop();
  } catch {
    /* noop */
  }
  const defaultConnections = defaultConnectionsPromise ? await defaultConnectionsPromise.catch(() => []) : [];
  await closeConnections(defaultConnections);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
