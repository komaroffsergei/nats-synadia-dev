// CLI + env parser. Flags beat env beats defaults.
// Для этого demo default отличается от upstream Synadia example:
// если пользователь ничего не указал, bridge подключается к локальному NATS
// из `npm run nats` (`nats://127.0.0.1:4222`), а не к NATS context `current`.
// Явный `--context` или `NATS_CONTEXT` всё ещё включает context-based connect.
//
//   bun run server/index.ts [--port 3300] [--context current]
//                           [--servers nats://...] [--dev]

export type ServerConfig = {
  port: number;
  context?: string;
  servers?: string;
  dev: boolean;
};

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

  const portRaw = pickFlag("--port") ?? process.env["PORT"];
  const port = portRaw ? Number.parseInt(portRaw, 10) : 3300;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`--port must be 1..65535, got ${portRaw}`);
  }

  const contextFlag = pickFlag("--context");
  const contextEnv = process.env["NATS_CONTEXT"];
  const explicitServers = pickFlag("--servers") ?? process.env["NATS_URL"];
  const dev = hasFlag("--dev");

  // Если raw servers указан явно, он побеждает.
  // Если указан context, используем context.
  // Если не указано ничего, берём локальный NATS этого проекта.
  const servers = explicitServers ?? (contextFlag || contextEnv ? undefined : "nats://127.0.0.1:4222");
  const context = servers
    ? undefined
    : (contextFlag ?? contextEnv ?? "current");

  return { port, context, servers, dev };
}
