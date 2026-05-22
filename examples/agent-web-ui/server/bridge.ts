// One Bridge per browser WebSocket.
//
// The Bun process owns one shared @synadia-ai/agents client and NATS
// connection. Each browser connection gets its own Bridge instance with:
// - last discovery snapshot;
// - active prompt streams;
// - pending controller requests.

import type { ServerWebSocket } from "bun";
import {
  Agent,
  Agents,
  HeartbeatTracker,
  decodeBase64,
  AttachmentsNotSupportedError,
  PayloadTooLargeError,
  ServiceError,
  StreamMaxWaitExceededError,
  StreamStalledError,
  type NatsConnection,
  type QueryEvent,
  type RequestAttachment,
} from "@synadia-ai/agents";
import type {
  BasicGroupSessionDescriptor,
  ClientMessage,
  DiscoveredAgentDTO,
  ServerMessage,
} from "./wire.ts";

type ActiveStream = { controller: AbortController };

export type BridgeWsData = { bridge: Bridge };

export class Bridge {
  private ws: ServerWebSocket<BridgeWsData> | null = null;
  private agentsByInstanceId = new Map<string, Agent>();
  private activeStreams = new Map<string, ActiveStream>();
  private activeQueries = new Map<string, QueryEvent>();
  private heartbeatSubs = new Map<string, () => void>();
  private heartbeatTracker: HeartbeatTracker | null = null;
  private heartbeatWatchUnsub: (() => void) | null = null;
  private pendingInstanceLookups = new Set<string>();
  private lastHeartbeatAt = new Map<string, { atMs: number; intervalS: number }>();
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private static readonly STALE_SWEEP_INTERVAL_MS = 5_000;
  private static readonly STALE_MISS_FACTOR = 3;
  private static readonly DEFAULT_HB_INTERVAL_S = 30;

  constructor(
    private readonly agents: Agents,
    private readonly nc: NatsConnection,
    private readonly sdkProtocolVersion: string,
  ) {}

  open(ws: ServerWebSocket<BridgeWsData>): void {
    this.ws = ws;
    const natsServer = this.nc.getServer() || undefined;
    this.send({
      kind: "ready",
      sdkProtocolVersion: this.sdkProtocolVersion,
      ...(natsServer ? { natsServer } : {}),
    });
    this.startHeartbeatWatch();
    this.startStaleSweep();
  }

  onMessage(raw: string): void {
    if (this.closed) return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch (e) {
      this.sendError(null, "bad_json", `could not parse message: ${(e as Error).message}`);
      return;
    }

    switch (msg.kind) {
      case "discover":
        void this.handleDiscover();
        break;
      case "prompt":
        void this.handlePrompt(msg);
        break;
      case "cancel":
        this.handleCancel(msg.id);
        break;
      case "query-reply":
        void this.handleQueryReply(msg.id, msg.queryId, msg.answer);
        break;
      case "basic-group-create":
        void this.handleBasicGroupCreate(msg.id, msg.controllerInstanceId, msg.spec);
        break;
      case "basic-group-stop":
        void this.handleBasicGroupStop(msg.id, msg.controllerInstanceId, msg.sessionId);
        break;
      case "basic-group-list":
        void this.handleBasicGroupList(msg.id, msg.controllerInstanceId);
        break;
      default: {
        const anyMsg = msg as { kind?: string };
        this.sendError(null, "unknown_kind", `unknown message kind: ${anyMsg.kind ?? "(none)"}`);
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const stream of this.activeStreams.values()) stream.controller.abort();
    this.activeStreams.clear();
    this.activeQueries.clear();
    for (const unsub of this.heartbeatSubs.values()) unsub();
    this.heartbeatSubs.clear();
    if (this.heartbeatWatchUnsub) this.heartbeatWatchUnsub();
    this.heartbeatWatchUnsub = null;
    if (this.heartbeatTracker) void this.heartbeatTracker.stop();
    this.heartbeatTracker = null;
    if (this.staleSweepTimer) clearInterval(this.staleSweepTimer);
    this.staleSweepTimer = null;
    this.lastHeartbeatAt.clear();
    this.pendingInstanceLookups.clear();
    this.ws = null;
  }

  private async handleDiscover(): Promise<void> {
    try {
      let discovered: Agent[];
      try {
        discovered = await this.agents.discover();
      } catch (err) {
        if (isNoRespondersError(err)) discovered = [];
        else throw err;
      }

      this.agentsByInstanceId.clear();
      const dto: DiscoveredAgentDTO[] = [];
      const seenIds = new Set<string>();
      for (const agent of discovered) {
        this.agentsByInstanceId.set(agent.instanceId, agent);
        seenIds.add(agent.instanceId);
        dto.push(toDTO(agent));
      }
      this.send({ kind: "agents", agents: dto });

      for (const id of seenIds) {
        if (this.heartbeatSubs.has(id)) continue;
        const unsub = this.agents.onHeartbeat(id, (hb) => {
          this.lastHeartbeatAt.set(id, {
            atMs: Date.now(),
            intervalS: hb.intervalS || Bridge.DEFAULT_HB_INTERVAL_S,
          });
          this.send({ kind: "heartbeat", instanceId: id, ts: hb.ts, intervalS: hb.intervalS });
        });
        this.heartbeatSubs.set(id, unsub);
      }
      for (const [id, unsub] of this.heartbeatSubs) {
        if (seenIds.has(id)) continue;
        unsub();
        this.heartbeatSubs.delete(id);
      }
    } catch (err) {
      this.sendError(null, "discover_failed", (err as Error).message);
    }
  }

  private async handlePrompt(msg: Extract<ClientMessage, { kind: "prompt" }>): Promise<void> {
    const agent = this.agentsByInstanceId.get(msg.instanceId);
    if (!agent) {
      this.sendError(
        msg.id,
        "agent_not_found",
        `no agent with instance id ${msg.instanceId} in last discovery result — click Refresh`,
      );
      this.send({ kind: "done", id: msg.id });
      return;
    }

    const controller = new AbortController();
    this.activeStreams.set(msg.id, { controller });
    const attachments: RequestAttachment[] | undefined = msg.attachments?.map((a) => ({
      filename: a.filename,
      content: decodeBase64(a.base64),
    }));

    try {
      const stream = await agent.prompt(msg.text, {
        attachments,
        signal: controller.signal,
      });

      for await (const ev of stream) {
        if (this.closed) break;
        switch (ev.type) {
          case "response":
            this.send({
              kind: "response",
              id: msg.id,
              text: ev.text,
              attachments: ev.attachments?.map((a) => ({
                filename: a.filename,
                base64: a.content,
              })),
            });
            break;
          case "status": {
            const structured = parseStructuredStatus(msg.id, ev.status);
            this.send(structured ?? { kind: "status", id: msg.id, status: ev.status });
            break;
          }
          case "query": {
            const key = queryKey(msg.id, ev.id);
            this.activeQueries.set(key, ev);
            this.send({
              kind: "query",
              id: msg.id,
              queryId: ev.id,
              prompt: ev.prompt,
              attachments: ev.attachments?.map((a) => ({
                filename: a.filename,
                base64: a.content,
              })),
            });
            break;
          }
        }
      }

      this.send({ kind: "done", id: msg.id });
    } catch (err) {
      this.mapAndSendError(msg.id, err);
      this.send({ kind: "done", id: msg.id });
    } finally {
      this.activeStreams.delete(msg.id);
      for (const key of [...this.activeQueries.keys()]) {
        if (key.startsWith(`${msg.id}:`)) this.activeQueries.delete(key);
      }
    }
  }

  private handleCancel(id: string): void {
    this.activeStreams.get(id)?.controller.abort();
  }

  private async handleQueryReply(id: string, queryId: string, answer: string): Promise<void> {
    const key = queryKey(id, queryId);
    const query = this.activeQueries.get(key);
    if (!query) {
      this.sendError(id, "query_not_found", `query ${queryId} is not awaiting a reply`);
      return;
    }
    try {
      await query.reply(answer);
      this.activeQueries.delete(key);
    } catch (err) {
      this.sendError(id, "query_reply_failed", (err as Error).message);
    }
  }

  private async handleBasicGroupCreate(id: string, controllerInstanceId: string, spec: unknown): Promise<void> {
    const subject = this.resolveBasicControllerSubject(id, controllerInstanceId, "group.create");
    if (!subject) return;
    try {
      const rep = await this.nc.request(subject, JSON.stringify(spec ?? {}), { timeout: 20_000 });
      const errHeader = rep.headers?.get("Nats-Service-Error-Code");
      if (errHeader) {
        this.sendError(id, errHeader, rep.headers?.get("Nats-Service-Error") ?? "basic group create error");
        return;
      }
      const descriptor = JSON.parse(rep.string()) as BasicGroupSessionDescriptor;
      await this.ensureAgentKnown(descriptor.instance_id);
      this.send({ kind: "basic-group-created", id, descriptor });
    } catch (err) {
      this.sendError(id, "basic_group_create_failed", (err as Error).message);
    }
  }

  private async handleBasicGroupStop(id: string, controllerInstanceId: string, sessionId: string): Promise<void> {
    const subject = this.resolveBasicControllerSubject(id, controllerInstanceId, "group.stop");
    if (!subject) return;
    try {
      const rep = await this.nc.request(subject, JSON.stringify({ session_id: sessionId }), { timeout: 10_000 });
      const errHeader = rep.headers?.get("Nats-Service-Error-Code");
      if (errHeader) {
        this.sendError(id, errHeader, rep.headers?.get("Nats-Service-Error") ?? "basic group stop error");
        return;
      }
      for (const [instanceId, agent] of this.agentsByInstanceId) {
        if (
          agent.agent === "basic" &&
          agent.metadata["role"] === "session" &&
          agent.metadata["session_type"] === "group" &&
          agent.name === sessionId
        ) {
          this.forgetAgent(instanceId);
          break;
        }
      }
      this.send({ kind: "basic-group-stopped", id, sessionId });
    } catch (err) {
      this.sendError(id, "basic_group_stop_failed", (err as Error).message);
    }
  }

  private async handleBasicGroupList(id: string, controllerInstanceId: string): Promise<void> {
    const subject = this.resolveBasicControllerSubject(id, controllerInstanceId, "group.list");
    if (!subject) return;
    try {
      const rep = await this.nc.request(subject, "", { timeout: 10_000 });
      const errHeader = rep.headers?.get("Nats-Service-Error-Code");
      if (errHeader) {
        this.sendError(id, errHeader, rep.headers?.get("Nats-Service-Error") ?? "basic group list error");
        return;
      }
      const body = JSON.parse(rep.string()) as { groups?: BasicGroupSessionDescriptor[] };
      this.send({
        kind: "basic-group-listed",
        id,
        controllerInstanceId,
        groups: body.groups ?? [],
      });
    } catch (err) {
      this.sendError(id, "basic_group_list_failed", (err as Error).message);
    }
  }

  private resolveBasicControllerSubject(
    id: string,
    controllerInstanceId: string,
    endpoint: "group.create" | "group.stop" | "group.list",
  ): string | null {
    const agent = this.agentsByInstanceId.get(controllerInstanceId);
    if (!agent) {
      this.sendError(id, "agent_not_found", `no basic controller with instance id ${controllerInstanceId}`);
      return null;
    }
    if (agent.agent !== "basic" || agent.metadata["role"] !== "controller") {
      this.sendError(id, "not_a_basic_controller", `instance ${controllerInstanceId} is not a basic controller`);
      return null;
    }
    const tokens = agent.promptEndpoint.subject.split(".");
    if (tokens.length !== 5 || tokens[0] !== "agents" || tokens[1] !== "prompt") {
      this.sendError(id, "bad_prompt_subject", `bad controller prompt subject: ${agent.promptEndpoint.subject}`);
      return null;
    }
    return `${tokens[0]}.${endpoint}.${tokens[2]}.${tokens[3]}.${tokens[4]}`;
  }

  private startHeartbeatWatch(): void {
    if (this.heartbeatTracker) return;
    const tracker = new HeartbeatTracker(this.nc);
    this.heartbeatTracker = tracker;
    void tracker.start().catch((e) => {
      console.warn("[bridge] heartbeat watch failed to start:", (e as Error).message);
    });
    this.heartbeatWatchUnsub = tracker.onAnyHeartbeat((hb) => {
      if (this.closed) return;
      this.lastHeartbeatAt.set(hb.instanceId, {
        atMs: Date.now(),
        intervalS: hb.intervalS || Bridge.DEFAULT_HB_INTERVAL_S,
      });
      if (this.agentsByInstanceId.has(hb.instanceId)) return;
      void this.ensureAgentKnown(hb.instanceId);
    });
  }

  private startStaleSweep(): void {
    if (this.staleSweepTimer) return;
    this.staleSweepTimer = setInterval(() => this.evictStaleAgents(), Bridge.STALE_SWEEP_INTERVAL_MS);
    this.staleSweepTimer.unref?.();
  }

  private evictStaleAgents(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const [instanceId, last] of this.lastHeartbeatAt) {
      const cutoffMs = last.intervalS * 1000 * Bridge.STALE_MISS_FACTOR;
      if (now - last.atMs <= cutoffMs) continue;
      this.forgetAgent(instanceId);
    }
  }

  private async ensureAgentKnown(instanceId: string): Promise<void> {
    if (this.agentsByInstanceId.has(instanceId)) return;
    if (this.pendingInstanceLookups.has(instanceId)) return;
    this.pendingInstanceLookups.add(instanceId);
    try {
      const agent = await this.agents.lookupInstance(instanceId);
      if (!agent || this.agentsByInstanceId.has(instanceId)) return;
      this.registerAgent(agent);
    } catch (e) {
      console.warn(`[bridge] lookup for ${instanceId} failed:`, (e as Error).message);
    } finally {
      this.pendingInstanceLookups.delete(instanceId);
    }
  }

  private registerAgent(agent: Agent): void {
    this.agentsByInstanceId.set(agent.instanceId, agent);
    if (!this.lastHeartbeatAt.has(agent.instanceId)) {
      this.lastHeartbeatAt.set(agent.instanceId, {
        atMs: Date.now(),
        intervalS: Bridge.DEFAULT_HB_INTERVAL_S,
      });
    }
    if (!this.heartbeatSubs.has(agent.instanceId)) {
      const unsub = this.agents.onHeartbeat(agent.instanceId, (hb) => {
        this.lastHeartbeatAt.set(agent.instanceId, {
          atMs: Date.now(),
          intervalS: hb.intervalS || Bridge.DEFAULT_HB_INTERVAL_S,
        });
        this.send({ kind: "heartbeat", instanceId: agent.instanceId, ts: hb.ts, intervalS: hb.intervalS });
      });
      this.heartbeatSubs.set(agent.instanceId, unsub);
    }
    this.send({ kind: "agent-added", agent: toDTO(agent) });
  }

  private forgetAgent(instanceId: string): void {
    if (!this.agentsByInstanceId.delete(instanceId)) return;
    this.lastHeartbeatAt.delete(instanceId);
    const unsub = this.heartbeatSubs.get(instanceId);
    if (unsub) {
      try {
        unsub();
      } catch {
        /* noop */
      }
      this.heartbeatSubs.delete(instanceId);
    }
    this.send({ kind: "agent-removed", instanceId });
  }

  private mapAndSendError(id: string, err: unknown): void {
    if (err instanceof AttachmentsNotSupportedError) {
      this.sendError(id, "attachments_not_supported", err.message);
      return;
    }
    if (err instanceof PayloadTooLargeError) {
      this.sendError(id, "payload_too_large", err.message, { limit: err.limit, actual: err.actual });
      return;
    }
    if (err instanceof ServiceError) {
      this.sendError(id, err.code, err.description, err.body as Record<string, unknown> | undefined);
      return;
    }
    if (err instanceof StreamStalledError) {
      this.sendError(id, "stream_stalled", err.message, { timeoutMs: err.timeoutMs });
      return;
    }
    if (err instanceof StreamMaxWaitExceededError) {
      this.sendError(id, "stream_max_wait_exceeded", err.message, { maxWaitMs: err.maxWaitMs });
      return;
    }
    if ((err as { name?: string }).name === "AbortError") {
      this.send({ kind: "status", id, status: "stopped" });
      return;
    }
    const e = err as Error;
    this.sendError(id, "internal", e.message || "internal error", { name: e.name });
  }

  private send(msg: ServerMessage): void {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      console.warn("[bridge] ws.send failed:", (e as Error).message);
    }
  }

  private sendError(id: string | null, code: string | number, message: string, details?: Record<string, unknown>): void {
    const payload: ServerMessage = { kind: "error", id, code, message };
    if (details) payload.details = details;
    this.send(payload);
  }
}

function queryKey(promptId: string, queryId: string): string {
  return `${promptId}:${queryId}`;
}

function isNoRespondersError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === "NoResponders") return true;
  return typeof e.message === "string" && e.message.includes("no responders");
}

function parseStructuredStatus(promptId: string, status: string): ServerMessage | null {
  const colonAt = status.indexOf(":");
  if (colonAt < 0) return null;
  const prefix = status.slice(0, colonAt);
  const rest = status.slice(colonAt + 1);

  switch (prefix) {
    case "tool_use": {
      const parsed = safeParse<{ id?: string; name?: string; input?: Record<string, unknown> }>(rest);
      if (!parsed || typeof parsed.id !== "string" || typeof parsed.name !== "string") return null;
      return {
        kind: "tool-use",
        id: promptId,
        toolUseId: parsed.id,
        toolName: parsed.name,
        input: parsed.input ?? {},
      };
    }
    case "tool_result": {
      const parsed = safeParse<{ tool_use_id?: string; output?: string; is_error?: boolean }>(rest);
      if (!parsed || typeof parsed.tool_use_id !== "string") return null;
      return {
        kind: "tool-result",
        id: promptId,
        toolUseId: parsed.tool_use_id,
        output: typeof parsed.output === "string" ? parsed.output : "",
        isError: parsed.is_error === true,
      };
    }
    case "cost": {
      const parsed = safeParse<{ turn_cost_usd?: number; total_cost_usd?: number }>(rest);
      if (!parsed) return null;
      return {
        kind: "cost",
        id: promptId,
        turnCostUsd: typeof parsed.turn_cost_usd === "number" ? parsed.turn_cost_usd : 0,
        totalCostUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
      };
    }
    default:
      return null;
  }
}

function safeParse<T>(text: string): T | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return parsed as T;
    return null;
  } catch {
    return null;
  }
}

function toDTO(agent: Agent): DiscoveredAgentDTO {
  const ep = agent.promptEndpoint;
  const dto: DiscoveredAgentDTO = {
    instanceId: agent.instanceId,
    agent: agent.agent,
    owner: agent.owner,
    name: agent.name,
    protocolVersion: agent.protocolVersion,
    description: agent.description,
    version: agent.version,
    metadata: { ...agent.metadata },
    promptEndpoint: {
      subject: ep.subject,
      metadata: { ...ep.metadata },
    },
  };
  if (agent.session !== undefined) dto.session = agent.session;
  if (ep.maxPayloadBytes !== undefined) dto.promptEndpoint.maxPayloadBytes = ep.maxPayloadBytes;
  if (ep.attachmentsOk !== undefined) dto.promptEndpoint.attachmentsOk = ep.attachmentsOk;
  return dto;
}

export function formatSdkProtocolVersion(v: { readonly major: number; readonly minor: number }): string {
  return `${v.major}.${v.minor}`;
}
