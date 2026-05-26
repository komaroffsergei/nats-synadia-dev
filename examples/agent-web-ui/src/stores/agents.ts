import { reactive, computed } from "vue";
import type { DiscoveredAgentDTO } from "../wire.ts";

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
  if (agentsState.selectedInstanceId === instanceId) agentsState.selectedInstanceId = null;
}

export const BUCKETS = {
  YOUTRACK: "youtrack",
  OTHER: "other",
} as const;

export type Bucket = (typeof BUCKETS)[keyof typeof BUCKETS];

export function bucketOf(agent: DiscoveredAgentDTO): Bucket {
  if (agent.agent === "youtrack") return BUCKETS.YOUTRACK;
  return BUCKETS.OTHER;
}

function byOwnerThenName(a: DiscoveredAgentDTO, b: DiscoveredAgentDTO): number {
  const o = a.owner.localeCompare(b.owner);
  if (o !== 0) return o;
  return a.name.localeCompare(b.name);
}

export const agentSections = computed<
  { id: string; label: string; agents: DiscoveredAgentDTO[] }[]
>(() => {
  const youtrack = agentsState.list.filter((agent) => bucketOf(agent) === BUCKETS.YOUTRACK);
  const other = agentsState.list.filter((agent) => bucketOf(agent) === BUCKETS.OTHER);
  const out: { id: string; label: string; agents: DiscoveredAgentDTO[] }[] = [];
  if (youtrack.length > 0) out.push({ id: "youtrack", label: "YouTrack / Codex", agents: [...youtrack].sort(byOwnerThenName) });
  if (other.length > 0) out.push({ id: "other", label: "Other agents", agents: [...other].sort(byOwnerThenName) });
  return out;
});
