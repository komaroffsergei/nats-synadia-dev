// CLI + env parser. Flags beat env beats defaults.
// Для этого demo default отличается от upstream Synadia example:
// если пользователь ничего не указал, bridge подключается к локальному NATS
// из `npm run nats` (`nats://127.0.0.1:4222`), а не к NATS context `current`.
// Явный `--context` или `NATS_CONTEXT` всё ещё включает context-based connect.
//
//   bun run server/index.ts [--port 3300] [--context current]
//                           [--nats-url nats://...] [--servers nats://...]
//                           [--nats-connections 'demo=nats://...;weather=nats://...']
//                           [--dev]

export type NatsConnectionConfig = {
  id: string;
  label: string;
  context?: string;
  servers?: string;
};

export type ServerConfig = {
  host: string;
  port: number;
  context?: string;
  servers?: string;
  connections: NatsConnectionConfig[];
  dev: boolean;
};

export function parseUrlNatsOverride(raw: string): NatsConnectionConfig[] {
  // Этот parser обслуживает только browser override из адресной строки:
  //
  //   http://localhost:5173/?nats=nats://host1:4222,nats://host2:4222
  //
  // Здесь запятая остаётся внутри одного `servers` значения. Это важно:
  // `parseNatsUrl()` из SDK понимает comma-separated server list как failover
  // одного NATS cluster-а. Если когда-нибудь понадобится несколько независимых
  // шин из URL, для этого лучше добавить отдельный query-param, а не менять
  // смысл `nats=`.
  const value = raw.trim();
  if (!value) throw new Error("nats query parameter must not be empty");

  return [
    {
      id: "url",
      label: "url",
      servers: value,
    },
  ];
}

export function parseConfig(argv: string[]): ServerConfig {
  // `Bun.argv` starts with ["bun", "server/index.ts", ...]; normalize to args only.
  const args = argv.slice(argv.findIndex((a) => a.endsWith("index.ts")) + 1);

  const pickFlag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return v;
  };
  const hasFlag = (name: string): boolean => args.includes(name);

  const host = pickFlag("--host") ?? process.env["HOST"] ?? "0.0.0.0";
  const portRaw = pickFlag("--port") ?? process.env["PORT"];
  const port = portRaw ? Number.parseInt(portRaw, 10) : 3300;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`--port must be 1..65535, got ${portRaw}`);
  }

  const contextFlag = pickFlag("--context");
  const contextEnv = process.env["NATS_CONTEXT"];
  const explicitConnections =
    pickFlag("--nats-connections") ??
    process.env["NATS_CONNECTIONS_JSON"] ??
    process.env["NATS_CONNECTIONS"];
  const explicitServers =
    pickFlag("--nats-url") ??
    pickFlag("--servers") ??
    process.env["NATS_URL"] ??
    process.env["NATS_SERVERS"] ??
    process.env["NATS_SERVICE_URL"];
  const dev = hasFlag("--dev");

  // Если raw servers указан явно, он побеждает.
  // Если указан context, используем context.
  // Если не указано ничего, берём локальный NATS этого проекта.
  const servers = explicitServers ?? (contextFlag || contextEnv ? undefined : "nats://127.0.0.1:4222");
  const context = servers
    ? undefined
    : (contextFlag ?? contextEnv ?? "current");

  const fallbackLabel = servers ? "default" : (context ?? "current");
  const connections: NatsConnectionConfig[] = explicitConnections && explicitConnections.trim()
    ? parseConnections(explicitConnections)
    : [
        {
          id: servers ? "default" : sanitizeConnectionId(fallbackLabel),
          label: fallbackLabel,
          ...(servers ? { servers } : { context }),
        },
      ];

  return { host, port, context, servers, connections, dev };
}

function parseConnections(raw: string): NatsConnectionConfig[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseConnectionsJson(trimmed);

  const out: NatsConnectionConfig[] = [];
  const usedIds = new Set<string>();
  for (const entry of raw.split(";")) {
    const text = entry.trim();
    if (!text) continue;

    const eqAt = text.indexOf("=");
    const label = eqAt >= 0 ? text.slice(0, eqAt).trim() : `nats-${out.length + 1}`;
    const value = eqAt >= 0 ? text.slice(eqAt + 1).trim() : text;
    if (!value) throw new Error(`empty NATS connection value in ${JSON.stringify(text)}`);

    const baseId = sanitizeConnectionId(label);
    const id = uniqueConnectionId(baseId, usedIds);
    usedIds.add(id);

    if (value.startsWith("context:")) {
      const context = value.slice("context:".length).trim();
      if (!context) throw new Error(`empty context in NATS connection ${label}`);
      out.push({ id, label, context });
    } else {
      out.push({ id, label, servers: value });
    }
  }

  if (out.length === 0) {
    throw new Error("NATS_CONNECTIONS did not contain any usable entries");
  }
  return out;
}

function parseConnectionsJson(raw: string): NatsConnectionConfig[] {
  const parsed = JSON.parse(raw) as unknown;
  const entries: { label: string; value: string }[] = [];

  if (Array.isArray(parsed)) {
    for (const [index, item] of parsed.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`NATS_CONNECTIONS_JSON item #${index} must be an object`);
      }
      const record = item as Record<string, unknown>;
      const label = String(record["label"] ?? record["name"] ?? `nats-${index + 1}`);
      if (record["context"]) {
        entries.push({ label, value: `context:${String(record["context"])}` });
      } else {
        entries.push({ label, value: String(record["url"] ?? record["servers"] ?? "") });
      }
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [label, value] of Object.entries(parsed)) {
      entries.push({ label, value: String(value) });
    }
  } else {
    throw new Error("NATS_CONNECTIONS_JSON must be an object or array");
  }

  const usedIds = new Set<string>();
  return entries.map((entry) => {
    if (!entry.value) throw new Error(`empty NATS connection value for ${entry.label}`);
    const baseId = sanitizeConnectionId(entry.label);
    const id = uniqueConnectionId(baseId, usedIds);
    usedIds.add(id);
    if (entry.value.startsWith("context:")) {
      const context = entry.value.slice("context:".length).trim();
      if (!context) throw new Error(`empty context in NATS connection ${entry.label}`);
      return { id, label: entry.label, context };
    }
    return { id, label: entry.label, servers: entry.value };
  });
}

function sanitizeConnectionId(value: string | undefined): string {
  const id = (value || "default").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || "default";
}

function uniqueConnectionId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
