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
  decodeChunk,
  encodeBase64,
  AttachmentsNotSupportedError,
  DEFAULT_PROMPT_MAX_WAIT_MS,
  PayloadTooLargeError,
  ServiceError,
  StreamMaxWaitExceededError,
  StreamStalledError,
  type NatsConnection,
  type QueryEvent,
  type RequestAttachment,
  type StreamMessage,
} from "@synadia-ai/agents";
import type {
  BasicGroupSessionDescriptor,
  ClientMessage,
  DiscoveredAgentDTO,
  PromptExtra,
  ServerMessage,
} from "./wire.ts";

type ActiveStream = { controller: AbortController };
export type BridgeConnection = {
  id: string;
  label: string;
  context?: string;
  servers?: string;
  nc: NatsConnection;
  agents: Agents;
};
type AgentRef = {
  agent: Agent;
  connection: BridgeConnection;
  rawInstanceId: string;
};
type NatsStreamMsg = {
  data: Uint8Array;
  headers?: { has?: (key: string) => boolean; get?: (key: string) => string | null };
};
type StoppableAsyncIterable<T> = AsyncIterable<T> & { stop(): void };
type DecodedQueryLike = {
  type: "query";
  id: string;
  replySubject: string;
  prompt: string;
  attachments?: { filename: string; content: string }[];
};

export type BridgeWsData = { bridge: Bridge };

export class Bridge {
  private ws: ServerWebSocket<BridgeWsData> | null = null;
  private agentsByInstanceId = new Map<string, AgentRef>();
  private activeStreams = new Map<string, ActiveStream>();
  private activeQueries = new Map<string, QueryEvent>();
  private heartbeatSubs = new Map<string, () => void>();
  private heartbeatTrackers = new Map<string, HeartbeatTracker>();
  private heartbeatWatchUnsubs = new Map<string, () => void>();
  private pendingInstanceLookups = new Set<string>();
  private lastHeartbeatAt = new Map<string, { atMs: number; intervalS: number }>();
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private static readonly STALE_SWEEP_INTERVAL_MS = 5_000;
  private static readonly STALE_MISS_FACTOR = 3;
  private static readonly DEFAULT_HB_INTERVAL_S = 30;

  constructor(
    private readonly connections: BridgeConnection[],
    private readonly sdkProtocolVersion: string,
  ) {}

  open(ws: ServerWebSocket<BridgeWsData>): void {
    this.ws = ws;
    const natsServer = this.connections
      .map((connection) => `${connection.label}:${connection.nc.getServer() || "unknown"}`)
      .join(", ");
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
    for (const unsub of this.heartbeatWatchUnsubs.values()) unsub();
    this.heartbeatWatchUnsubs.clear();
    for (const tracker of this.heartbeatTrackers.values()) void tracker.stop();
    this.heartbeatTrackers.clear();
    if (this.staleSweepTimer) clearInterval(this.staleSweepTimer);
    this.staleSweepTimer = null;
    this.lastHeartbeatAt.clear();
    this.pendingInstanceLookups.clear();
    this.ws = null;
  }

  private async handleDiscover(): Promise<void> {
    try {
      this.agentsByInstanceId.clear();
      const dto: DiscoveredAgentDTO[] = [];
      const seenIds = new Set<string>();
      const errors: string[] = [];

      for (const connection of this.connections) {
        let discovered: Agent[];
        try {
          discovered = await connection.agents.discover();
        } catch (err) {
          if (isNoRespondersError(err)) discovered = [];
          else {
            errors.push(`${connection.label}: ${(err as Error).message}`);
            console.warn(`[bridge] discover failed on ${connection.label}:`, (err as Error).message);
            continue;
          }
        }

        for (const agent of discovered) {
          const instanceId = wireInstanceId(connection, agent.instanceId);
          this.agentsByInstanceId.set(instanceId, { agent, connection, rawInstanceId: agent.instanceId });
          seenIds.add(instanceId);
          dto.push(toDTO(agent, connection, instanceId));
        }
      }

      if (dto.length === 0 && errors.length === this.connections.length) {
        throw new Error(errors.join("; "));
      }

      this.send({ kind: "agents", agents: dto });

      for (const instanceId of seenIds) {
        if (this.heartbeatSubs.has(instanceId)) continue;
        const ref = this.agentsByInstanceId.get(instanceId);
        if (!ref) continue;
        const unsub = ref.connection.agents.onHeartbeat(ref.rawInstanceId, (hb) => {
          this.lastHeartbeatAt.set(instanceId, {
            atMs: Date.now(),
            intervalS: hb.intervalS || Bridge.DEFAULT_HB_INTERVAL_S,
          });
          this.send({ kind: "heartbeat", instanceId, ts: hb.ts, intervalS: hb.intervalS });
        });
        this.heartbeatSubs.set(instanceId, unsub);
      }
      for (const [instanceId, unsub] of this.heartbeatSubs) {
        if (seenIds.has(instanceId)) continue;
        unsub();
        this.heartbeatSubs.delete(instanceId);
      }
    } catch (err) {
      this.sendError(null, "discover_failed", (err as Error).message);
    }
  }

  private async handlePrompt(msg: Extract<ClientMessage, { kind: "prompt" }>): Promise<void> {
    const ref = this.agentsByInstanceId.get(msg.instanceId);
    if (!ref) {
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
      const stream = await this.openPromptStream(ref, msg.text, attachments, msg.extra, controller.signal);

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

  private async openPromptStream(
    ref: AgentRef,
    text: string,
    attachments: RequestAttachment[] | undefined,
    extra: PromptExtra | undefined,
    signal: AbortSignal,
  ): Promise<AsyncIterable<StreamMessage>> {
    // Обычный путь оставляем через официальный SDK: он сам проверяет payload,
    // attachments_ok и timeout-ы. Этот путь используется всеми generic agents.
    if (!extra || Object.keys(extra).length === 0) {
      return ref.agent.prompt(text, { attachments, signal });
    }

    // Weather adapter: SDK Agent.prompt() пока не принимает произвольные extra
    // fields, поэтому формируем protocol envelope вручную и отправляем его в
    // тот же prompt subject. Это ровно тот формат, который Ruby weather agent
    // декодирует как Envelope.extra.
    return this.promptWithExtra(ref, text, attachments, normalizePromptExtra(extra), signal);
  }

  private async *promptWithExtra(
    ref: AgentRef,
    text: string,
    attachments: RequestAttachment[] | undefined,
    extra: PromptExtra,
    signal: AbortSignal,
  ): AsyncIterable<StreamMessage> {
    if (attachments && attachments.length > 0 && ref.agent.promptEndpoint.attachmentsOk === false) {
      throw new AttachmentsNotSupportedError();
    }

    const payload = encodePromptEnvelope(text, attachments, extra);
    const maxPayloadBytes = effectiveMaxPayloadBytes(ref.agent, ref.connection.nc);
    if (maxPayloadBytes !== undefined && payload.byteLength > maxPayloadBytes) {
      throw new PayloadTooLargeError(maxPayloadBytes, payload.byteLength);
    }

    const iter = (await ref.connection.nc.requestMany(ref.agent.promptSubject, payload, {
      strategy: "sentinel",
      maxWait: DEFAULT_PROMPT_MAX_WAIT_MS,
    })) as StoppableAsyncIterable<NatsStreamMsg>;

    const onAbort = (): void => iter.stop();
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const msg of iter) {
        if (signal.aborted) throw abortError(signal);
        if (isServiceErrorSignal(msg)) throw serviceErrorFromMsg(msg);
        if (isTerminator(msg)) {
          yield { type: "status", status: "done" };
          return;
        }

        let decoded: ReturnType<typeof decodeChunk>;
        try {
          decoded = decodeChunk(msg.data);
        } catch {
          continue;
        }
        if (!decoded) continue;
        yield this.decodedChunkToStreamMessage(ref.connection, decoded);
      }

      if (signal.aborted) throw abortError(signal);
      throw new StreamMaxWaitExceededError(DEFAULT_PROMPT_MAX_WAIT_MS);
    } finally {
      signal.removeEventListener("abort", onAbort);
      iter.stop();
    }
  }

  private decodedChunkToStreamMessage(
    connection: BridgeConnection,
    decoded: NonNullable<ReturnType<typeof decodeChunk>>,
  ): StreamMessage {
    switch (decoded.type) {
      case "response":
        return decoded.attachments !== undefined
          ? { type: "response", text: decoded.text, attachments: decoded.attachments }
          : { type: "response", text: decoded.text };
      case "status":
        return { type: "status", status: decoded.status };
      case "query":
        return this.buildQueryEvent(connection, decoded as DecodedQueryLike);
    }
  }

  private buildQueryEvent(connection: BridgeConnection, decoded: DecodedQueryLike): QueryEvent {
    let replied = false;
    return {
      type: "query",
      id: decoded.id,
      prompt: decoded.prompt,
      ...(decoded.attachments !== undefined ? { attachments: decoded.attachments } : {}),
      reply: async (answer) => {
        if (replied) throw new Error(`query ${decoded.id} already replied`);
        replied = true;
        const payload =
          typeof answer === "string"
            ? new TextEncoder().encode(answer)
            : encodePromptEnvelope(answer.prompt, answer.attachments as RequestAttachment[] | undefined, {});
        connection.nc.publish(decoded.replySubject, payload);
        await connection.nc.flush();
      },
    };
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
    const target = this.resolveBasicControllerSubject(id, controllerInstanceId, "group.create");
    if (!target) return;
    try {
      const rep = await target.connection.nc.request(target.subject, JSON.stringify(spec ?? {}), { timeout: 20_000 });
      const errHeader = rep.headers?.get("Nats-Service-Error-Code");
      if (errHeader) {
        this.sendError(id, errHeader, rep.headers?.get("Nats-Service-Error") ?? "basic group create error");
        return;
      }
      const descriptor = JSON.parse(rep.string()) as BasicGroupSessionDescriptor;
      await this.ensureAgentKnown(descriptor.instance_id, target.connection);
      this.send({
        kind: "basic-group-created",
        id,
        descriptor: {
          ...descriptor,
          instance_id: wireInstanceId(target.connection, descriptor.instance_id),
        },
      });
    } catch (err) {
      this.sendError(id, "basic_group_create_failed", (err as Error).message);
    }
  }

  private async handleBasicGroupStop(id: string, controllerInstanceId: string, sessionId: string): Promise<void> {
    const target = this.resolveBasicControllerSubject(id, controllerInstanceId, "group.stop");
    if (!target) return;
    try {
      const rep = await target.connection.nc.request(target.subject, JSON.stringify({ session_id: sessionId }), { timeout: 10_000 });
      const errHeader = rep.headers?.get("Nats-Service-Error-Code");
      if (errHeader) {
        this.sendError(id, errHeader, rep.headers?.get("Nats-Service-Error") ?? "basic group stop error");
        return;
      }
      for (const [instanceId, ref] of this.agentsByInstanceId) {
        const agent = ref.agent;
        if (
          ref.connection.id === target.connection.id &&
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
    const target = this.resolveBasicControllerSubject(id, controllerInstanceId, "group.list");
    if (!target) return;
    try {
      const rep = await target.connection.nc.request(target.subject, "", { timeout: 10_000 });
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
  ): { subject: string; connection: BridgeConnection } | null {
    const ref = this.agentsByInstanceId.get(controllerInstanceId);
    if (!ref) {
      this.sendError(id, "agent_not_found", `no basic controller with instance id ${controllerInstanceId}`);
      return null;
    }
    const agent = ref.agent;
    if (agent.agent !== "basic" || agent.metadata["role"] !== "controller") {
      this.sendError(id, "not_a_basic_controller", `instance ${controllerInstanceId} is not a basic controller`);
      return null;
    }
    const tokens = agent.promptEndpoint.subject.split(".");
    if (tokens.length !== 5 || tokens[0] !== "agents" || tokens[1] !== "prompt") {
      this.sendError(id, "bad_prompt_subject", `bad controller prompt subject: ${agent.promptEndpoint.subject}`);
      return null;
    }
    return {
      subject: `${tokens[0]}.${endpoint}.${tokens[2]}.${tokens[3]}.${tokens[4]}`,
      connection: ref.connection,
    };
  }

  private startHeartbeatWatch(): void {
    for (const connection of this.connections) {
      if (this.heartbeatTrackers.has(connection.id)) continue;
      const tracker = new HeartbeatTracker(connection.nc);
      this.heartbeatTrackers.set(connection.id, tracker);
      void tracker.start().catch((e) => {
        console.warn(`[bridge] heartbeat watch failed to start on ${connection.label}:`, (e as Error).message);
      });
      const unsub = tracker.onAnyHeartbeat((hb) => {
        if (this.closed) return;
        const instanceId = wireInstanceId(connection, hb.instanceId);
        this.lastHeartbeatAt.set(instanceId, {
          atMs: Date.now(),
          intervalS: hb.intervalS || Bridge.DEFAULT_HB_INTERVAL_S,
        });
        if (this.agentsByInstanceId.has(instanceId)) return;
        void this.ensureAgentKnown(hb.instanceId, connection);
      });
      this.heartbeatWatchUnsubs.set(connection.id, unsub);
    }
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

  private async ensureAgentKnown(rawInstanceId: string, connection: BridgeConnection): Promise<void> {
    const instanceId = wireInstanceId(connection, rawInstanceId);
    if (this.agentsByInstanceId.has(instanceId)) return;
    if (this.pendingInstanceLookups.has(instanceId)) return;
    this.pendingInstanceLookups.add(instanceId);
    try {
      const agent = await connection.agents.lookupInstance(rawInstanceId);
      if (!agent || this.agentsByInstanceId.has(instanceId)) return;
      this.registerAgent(connection, agent);
    } catch (e) {
      console.warn(`[bridge] lookup for ${instanceId} failed:`, (e as Error).message);
    } finally {
      this.pendingInstanceLookups.delete(instanceId);
    }
  }

  private registerAgent(connection: BridgeConnection, agent: Agent): void {
    const instanceId = wireInstanceId(connection, agent.instanceId);
    this.agentsByInstanceId.set(instanceId, { agent, connection, rawInstanceId: agent.instanceId });
    if (!this.lastHeartbeatAt.has(instanceId)) {
      this.lastHeartbeatAt.set(instanceId, {
        atMs: Date.now(),
        intervalS: Bridge.DEFAULT_HB_INTERVAL_S,
      });
    }
    if (!this.heartbeatSubs.has(instanceId)) {
      const unsub = connection.agents.onHeartbeat(agent.instanceId, (hb) => {
        this.lastHeartbeatAt.set(instanceId, {
          atMs: Date.now(),
          intervalS: hb.intervalS || Bridge.DEFAULT_HB_INTERVAL_S,
        });
        this.send({ kind: "heartbeat", instanceId, ts: hb.ts, intervalS: hb.intervalS });
      });
      this.heartbeatSubs.set(instanceId, unsub);
    }
    this.send({ kind: "agent-added", agent: toDTO(agent, connection, instanceId) });
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

function normalizePromptExtra(extra: PromptExtra): PromptExtra {
  // В wire extra приходит из браузера. Оставляем только простые JSON scalars,
  // чтобы adapter не мог перезаписать protocol fields prompt/attachments.
  const normalized: PromptExtra = {};
  for (const [key, value] of Object.entries(extra)) {
    if (key === "prompt" || key === "attachments") continue;
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      normalized[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) normalized[key] = value;
  }
  return normalized;
}

function encodePromptEnvelope(
  prompt: string,
  attachments: RequestAttachment[] | undefined,
  extra: PromptExtra,
): Uint8Array {
  // SDK encoder currently serializes only prompt/attachments. Для weather
  // adapter-а нужно сохранить top-level lat/lon, поэтому envelope собирается
  // здесь вручную в том же JSON shape, который читает Ruby implementation.
  const payload: Record<string, unknown> = { ...extra, prompt };
  if (attachments && attachments.length > 0) {
    payload["attachments"] = attachments.map((attachment) => ({
      filename: attachment.filename,
      content: encodeBase64(attachment.content),
    }));
  }
  return new TextEncoder().encode(JSON.stringify(payload));
}

function effectiveMaxPayloadBytes(agent: Agent, nc: NatsConnection): number | undefined {
  const endpointLimit = agent.promptEndpoint.maxPayloadBytes;
  const serverLimit = (nc as { info?: { max_payload?: number } }).info?.max_payload;
  if (endpointLimit !== undefined && serverLimit !== undefined && serverLimit > 0) {
    return Math.min(endpointLimit, serverLimit);
  }
  if (endpointLimit !== undefined) return endpointLimit;
  return serverLimit && serverLimit > 0 ? serverLimit : undefined;
}

function isTerminator(msg: { data: Uint8Array; headers?: unknown }): boolean {
  return msg.data.length === 0 && !msg.headers;
}

function isServiceErrorSignal(msg: { headers?: { has?: (key: string) => boolean; get?: (key: string) => string | null } }): boolean {
  const headers = msg.headers;
  if (!headers) return false;
  if (typeof headers.has === "function") return headers.has("Nats-Service-Error-Code");
  if (typeof headers.get === "function") return (headers.get("Nats-Service-Error-Code") ?? "") !== "";
  return false;
}

function serviceErrorFromMsg(msg: {
  data: Uint8Array;
  headers?: { get?: (key: string) => string | null };
}): ServiceError {
  const codeText = msg.headers?.get?.("Nats-Service-Error-Code") ?? "500";
  const code = Number(codeText);
  const description = msg.headers?.get?.("Nats-Service-Error") ?? "";
  let body: Record<string, unknown> | undefined;
  if (msg.data.length > 0) {
    const parsed = safeParse<Record<string, unknown>>(new TextDecoder().decode(msg.data));
    if (parsed) body = parsed;
  }
  return new ServiceError(Number.isFinite(code) ? code : 500, description, body);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const err = new Error("stream aborted");
  err.name = "AbortError";
  return err;
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

function wireInstanceId(connection: BridgeConnection, rawInstanceId: string): string {
  return `${connection.id}:${rawInstanceId}`;
}

function toDTO(agent: Agent, connection: BridgeConnection, instanceId: string): DiscoveredAgentDTO {
  const ep = agent.promptEndpoint;
  const dto: DiscoveredAgentDTO = {
    instanceId,
    rawInstanceId: agent.instanceId,
    connectionId: connection.id,
    connectionLabel: connection.label,
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
