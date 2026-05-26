// Shared WebSocket message types between the Bun bridge and browser UI.
//
// This project intentionally keeps only the current demo surface:
// - discovery of NATS agents;
// - prompt/cancel/query streaming;
// - automatic YouTrack webhook messages.
//
// Upstream-only control messages that are not part of this educational demo
// were removed so the wire contract matches this project.

/** Fields the UI needs from a discovered Synadia Agent. */
export type DiscoveredAgentDTO = {
  instanceId: string;
  rawInstanceId: string;
  connectionId: string;
  connectionLabel: string;
  agent: string;
  owner: string;
  name: string;
  session?: string;
  protocolVersion: string;
  description: string;
  version: string;
  metadata: Record<string, string>;
  promptEndpoint: {
    subject: string;
    maxPayloadBytes?: number;
    attachmentsOk?: boolean;
    metadata: Record<string, string>;
  };
};

/** Inline attachment in either direction, RFC 4648 base64. */
export type WireAttachment = {
  filename: string;
  base64: string;
};

/** Extra JSON fields added to the prompt envelope for domain-specific agents. */
export type PromptExtra = Record<string, string | number | boolean | null>;

// Client -> Server.
export type ClientMessage =
  | { kind: "discover" }
  | {
      kind: "prompt";
      id: string;
      instanceId: string;
      text: string;
      attachments?: WireAttachment[];
      extra?: PromptExtra;
    }
  | { kind: "cancel"; id: string }
  | { kind: "query-reply"; id: string; queryId: string; answer: string };

// Server -> Client.
export type ServerMessage =
  | {
      kind: "ready";
      sdkProtocolVersion: string;
      natsServer?: string;
    }
  | { kind: "agents"; agents: DiscoveredAgentDTO[] }
  | {
      kind: "response";
      id: string;
      text: string;
      attachments?: WireAttachment[];
    }
  | { kind: "status"; id: string; status: string }
  | {
      kind: "query";
      id: string;
      queryId: string;
      prompt: string;
      attachments?: WireAttachment[];
    }
  | {
      kind: "tool-use";
      id: string;
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "tool-result";
      id: string;
      toolUseId: string;
      output: string;
      isError: boolean;
    }
  | {
      kind: "cost";
      id: string;
      turnCostUsd: number;
      totalCostUsd: number;
    }
  | { kind: "done"; id: string }
  | {
      kind: "heartbeat";
      instanceId: string;
      ts: string;
      intervalS: number;
    }
  | {
      kind: "agent-message";
      id: string;
      instanceId: string;
      text: string;
      timestamp: string;
      title?: string;
      autoOpen?: boolean;
    }
  | {
      kind: "error";
      id: string | null;
      code?: string | number;
      name?: string;
      message: string;
      details?: Record<string, unknown>;
    }
  | {
      kind: "agent-added";
      agent: DiscoveredAgentDTO;
    }
  | {
      kind: "agent-removed";
      instanceId: string;
    };
