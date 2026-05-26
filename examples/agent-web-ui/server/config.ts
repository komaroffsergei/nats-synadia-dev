// CLI + env parser for the server-side NATS bridge.
//
// NATS_URL is the primary bus used by the app and worker. NATS_URLS_JSON is
// only for UI discovery across several independent NATS buses.

export type NatsConnectionConfig = {
  id: string;
  label: string;
  servers: string;
};

export type ServerConfig = {
  host: string;
  port: number;
  connections: NatsConnectionConfig[];
  dev: boolean;
};

export function parseConfig(argv: string[]): ServerConfig {
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

  const natsUrl = pickFlag("--nats-url") ?? process.env["NATS_URL"] ?? "nats://127.0.0.1:4222";
  const natsUrlsJson = pickFlag("--nats-urls-json") ?? process.env["NATS_URLS_JSON"];
  const connections = natsUrlsJson && natsUrlsJson.trim()
    ? parseNatsUrlsJson(natsUrlsJson)
    : [{ id: "main", label: "main", servers: natsUrl }];

  return { host, port, connections, dev: hasFlag("--dev") };
}

function parseNatsUrlsJson(raw: string): NatsConnectionConfig[] {
  const parsed = JSON.parse(raw) as unknown;
  const entries: { label: string; servers: string }[] = [];

  if (Array.isArray(parsed)) {
    for (const [index, item] of parsed.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`NATS_URLS_JSON item #${index} must be an object`);
      }
      const record = item as Record<string, unknown>;
      entries.push({
        label: String(record["label"] ?? record["name"] ?? `nats-${index + 1}`),
        servers: String(record["url"] ?? record["servers"] ?? ""),
      });
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [label, value] of Object.entries(parsed)) {
      entries.push({ label, servers: String(value) });
    }
  } else {
    throw new Error("NATS_URLS_JSON must be an object or array");
  }

  if (entries.length === 0) throw new Error("NATS_URLS_JSON did not contain any connections");

  const usedIds = new Set<string>();
  return entries.map((entry) => {
    if (!entry.servers) throw new Error(`empty NATS URL for ${entry.label}`);
    const id = uniqueConnectionId(sanitizeConnectionId(entry.label), usedIds);
    usedIds.add(id);
    return { id, label: entry.label, servers: entry.servers };
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
