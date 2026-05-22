// Shared WebSocket message types between the Bun bridge and browser UI.
//
// This project intentionally keeps only the current demo surface:
// - discovery of NATS agents;
// - prompt/cancel/query streaming;
// - basic controller-managed group sessions.
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

/** Spec for controller-managed basic group sessions. */
export type BasicGroupCreateSpec = {
  personas: string[];
  label?: string;
};

/** Descriptor returned by `agents.group.create.basic.<owner>.control`. */
export type BasicGroupSessionDescriptor = {
  group_id: string;
  session_id: string;
  label: string;
  subject: string;
  heartbeat_subject: string;
  status_subject: string;
  target_personas: string[];
  summary_chars: number;
  turn_count: number;
  active_request: boolean;
  created_at: string;
  last_activity: string;
  instance_id: string;
};

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
  | { kind: "query-reply"; id: string; queryId: string; answer: string }
  | {
      kind: "basic-group-create";
      id: string;
      controllerInstanceId: string;
      spec: BasicGroupCreateSpec;
    }
  | {
      kind: "basic-group-stop";
      id: string;
      controllerInstanceId: string;
      sessionId: string;
    }
  | {
      kind: "basic-group-list";
      id: string;
      controllerInstanceId: string;
    };

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
    }
  | {
      kind: "basic-group-created";
      id: string;
      descriptor: BasicGroupSessionDescriptor;
    }
  | {
      kind: "basic-group-stopped";
      id: string;
      sessionId: string;
    }
  | {
      kind: "basic-group-listed";
      id: string;
      controllerInstanceId: string;
      groups: BasicGroupSessionDescriptor[];
    };
