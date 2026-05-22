import { reactive, computed } from "vue";
import type { DiscoveredAgentDTO } from "../wire.ts";

// Discovery state from the Bun bridge. The browser never connects to NATS
// directly; it receives serializable Agent DTOs over WebSocket.
export const agentsState = reactive<{
  list: DiscoveredAgentDTO[];
  selectedInstanceId: string | null;
  lastDiscoveredAt: number | null;
  discovering: boolean;
}>({
  list: [],
  selectedInstanceId: null,
  lastDiscoveredAt: null,
  discovering: false,
});

export const selectedAgent = computed<DiscoveredAgentDTO | null>(() => {
  const id = agentsState.selectedInstanceId;
  if (!id) return null;
  return agentsState.list.find((a) => a.instanceId === id) ?? null;
});

export function selectAgent(instanceId: string | null): void {
  agentsState.selectedInstanceId = instanceId;
}

export function setAgents(list: DiscoveredAgentDTO[]): void {
  agentsState.list = list;
  agentsState.lastDiscoveredAt = Date.now();
  const sel = agentsState.selectedInstanceId;
  if (sel && !list.some((a) => a.instanceId === sel)) {
    agentsState.selectedInstanceId = null;
  }
}

export function addAgent(dto: DiscoveredAgentDTO): void {
  if (agentsState.list.some((a) => a.instanceId === dto.instanceId)) return;
  agentsState.list = [...agentsState.list, dto];
}

export function removeAgent(instanceId: string): void {
  const before = agentsState.list.length;
  agentsState.list = agentsState.list.filter((a) => a.instanceId !== instanceId);
  if (before === agentsState.list.length) return;
  if (agentsState.selectedInstanceId === instanceId) {
    agentsState.selectedInstanceId = null;
  }
}

export const basicController = computed<DiscoveredAgentDTO | null>(
  () =>
    agentsState.list.find(
      (agent) => agent.agent === "basic" && agent.metadata?.["role"] === "controller",
    ) ?? null,
);

export function basicControllerForConnection(connectionId: string): DiscoveredAgentDTO | null {
  return (
    agentsState.list.find(
      (agent) =>
        agent.connectionId === connectionId &&
        agent.agent === "basic" &&
        agent.metadata?.["role"] === "controller",
    ) ?? null
  );
}

export const BUCKETS = {
  BASIC_PERSONA: "basic-persona",
  BASIC_GROUP_SESSION: "basic-group-session",
  BASIC_CONTROL: "basic-control",
  OPENCLAW: "openclaw",
  OTHER: "other",
} as const;

export type Bucket = (typeof BUCKETS)[keyof typeof BUCKETS];

export function bucketOf(agent: DiscoveredAgentDTO): Bucket {
  if (agent.agent === "basic") {
    if (agent.metadata?.["role"] === "controller") return BUCKETS.BASIC_CONTROL;
    if (agent.metadata?.["role"] === "session" && agent.metadata?.["session_type"] === "group") {
      return BUCKETS.BASIC_GROUP_SESSION;
    }
    return BUCKETS.BASIC_PERSONA;
  }
  if (agent.agent === "openclaw" || agent.agent === "oc") return BUCKETS.OPENCLAW;
  return BUCKETS.OTHER;
}

function byOwnerThenName(a: DiscoveredAgentDTO, b: DiscoveredAgentDTO): number {
  const o = a.owner.localeCompare(b.owner);
  if (o !== 0) return o;
  return a.name.localeCompare(b.name);
}

function sortPromptables(list: DiscoveredAgentDTO[]): DiscoveredAgentDTO[] {
  const rank: Record<Bucket, number> = {
    [BUCKETS.BASIC_PERSONA]: 1,
    [BUCKETS.BASIC_GROUP_SESSION]: 2,
    [BUCKETS.OPENCLAW]: 3,
    [BUCKETS.OTHER]: 99,
    [BUCKETS.BASIC_CONTROL]: 100,
  };
  return [...list].sort((a, b) => {
    const ra = rank[bucketOf(a)];
    const rb = rank[bucketOf(b)];
    if (ra !== rb) return ra - rb;
    return byOwnerThenName(a, b);
  });
}

export type AgentSectionId = "promptables" | "controllers";

export const agentSections = computed<
  { id: AgentSectionId; label: string; agents: DiscoveredAgentDTO[] }[]
>(() => {
  const promptables: DiscoveredAgentDTO[] = [];
  const controllers: DiscoveredAgentDTO[] = [];

  for (const agent of agentsState.list) {
    if (bucketOf(agent) === BUCKETS.BASIC_CONTROL) controllers.push(agent);
    else promptables.push(agent);
  }

  const out: { id: AgentSectionId; label: string; agents: DiscoveredAgentDTO[] }[] = [];
  if (promptables.length > 0) {
    out.push({ id: "promptables", label: "Агенты / группы", agents: sortPromptables(promptables) });
  }
  if (controllers.length > 0) {
    out.push({ id: "controllers", label: "Контроллеры", agents: [...controllers].sort(byOwnerThenName) });
  }
  return out;
});
