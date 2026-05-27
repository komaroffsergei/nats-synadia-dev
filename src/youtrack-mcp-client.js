export class YouTrackMcpClient {
  constructor({ url, timeoutMs = 15_000, clientName = "synadia-nats-agents", clientVersion = "0.1.0" } = {}) {
    this.url = normalizeMcpUrl(url);
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 15_000;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.nextId = 1;
    this.sessionId = "";
    this.initialized = false;
  }

  get enabled() {
    return Boolean(this.url);
  }

  async listTools() {
    return this.request("tools/list", {});
  }

  async callTool(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result?.isError || result?.is_error) {
      throw new Error(`YouTrack MCP tool ${name} failed: ${toolErrorMessage(result)}`);
    }
    return decodeToolPayload(result);
  }

  async request(method, params = {}, { skipInitialize = false, notification = false } = {}) {
    if (!this.enabled) throw new Error("YOUTRACK_MCP_URL is not set.");
    if (!skipInitialize && !notification && !this.initialized) await this.initialize();

    const body = {
      jsonrpc: "2.0",
      method,
      params,
      ...(notification ? {} : { id: this.nextId++ }),
    };
    const payload = await this.post(body);
    if (notification) return null;
    if (!payload) throw new Error(`YouTrack MCP ${method} returned an empty response.`);
    if (payload.error) {
      throw new Error(`YouTrack MCP ${method} failed: ${jsonRpcErrorMessage(payload.error)}`);
    }
    return payload.result;
  }

  async initialize() {
    if (this.initialized) return;
    await this.request(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: this.clientName,
          version: this.clientVersion,
        },
      },
      { skipInitialize: true },
    );
    this.initialized = true;
    await this.request("notifications/initialized", {}, { notification: true });
  }

  async post(body) {
    const response = await fetch(this.url, {
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
    });

    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId) this.sessionId = nextSessionId;

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`YouTrack MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    if (!text.trim()) return null;
    return parseMcpResponse(text);
  }
}

export function normalizeMcpUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.endsWith("/") ? text : `${text}/`;
}

export function parseMcpResponse(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:") || trimmed.startsWith("event:")) {
    return parseSseResponse(trimmed);
  }
  return JSON.parse(trimmed);
}

function parseSseResponse(text) {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) continue;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") continue;
    return JSON.parse(data);
  }
  throw new Error("YouTrack MCP SSE response did not contain a JSON data event.");
}

function decodeToolPayload(result) {
  const structured = result?.structuredContent ?? result?.structured_content;
  if (structured !== undefined) return structured;

  const text = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text
    : "";
  if (!text) return result ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toolErrorMessage(result) {
  const payload = decodeToolPayload(result);
  if (payload && typeof payload === "object") {
    return payload.message || payload.error || JSON.stringify(payload);
  }
  return String(payload || "unknown MCP tool error");
}

function jsonRpcErrorMessage(error) {
  if (!error || typeof error !== "object") return String(error || "unknown JSON-RPC error");
  return error.message || JSON.stringify(error);
}
