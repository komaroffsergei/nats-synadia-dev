import { reactive, computed } from "vue";
import type { DiscoveredAgentDTO } from "../wire.ts";
import { isVirtualId } from "./virtualSessions.ts";

// Единый store для agents, которых bridge нашёл через Synadia discovery.
//
// В этом проекте discovery приходит не из нашего backend API, а из NATS:
// backend services публикуют AgentService metadata, bridge отдаёт их в UI,
// а UI уже решает, какие карточки считать обычными agents, а какие controllers.
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
  // selectedInstanceId управляет правой панелью:
  // - real instanceId -> обычный ChatPanel;
  // - virtual:<uuid> -> VirtualChatPanel;
  // - null -> пустая/intro панель.
  const id = agentsState.selectedInstanceId;
  if (!id) return null;
  return agentsState.list.find((a) => a.instanceId === id) ?? null;
});

export function selectAgent(instanceId: string | null): void {
  agentsState.selectedInstanceId = instanceId;
}

export function setAgents(list: DiscoveredAgentDTO[]): void {
  // setAgents вызывается после полного Refresh/discover.
  // В отличие от add/remove events, тут мы заменяем весь список свежим snapshot-ом.
  agentsState.list = list;
  agentsState.lastDiscoveredAt = Date.now();
  // Если выбранный реальный agent исчез из discovery, чистим single-selection.
  // Но virtual session живёт только в браузере и не приходит из NATS discovery,
  // поэтому id вида `virtual:<uuid>` нельзя стирать при каждом Refresh.
  const sel = agentsState.selectedInstanceId;
  if (sel && !isVirtualId(sel) && !list.some((a) => a.instanceId === sel)) {
    agentsState.selectedInstanceId = null;
  }
}

/** Append an agent if not already present (by instanceId). No-op if dup. */
export function addAgent(dto: DiscoveredAgentDTO): void {
  // Bridge может прислать incremental event "agent-added".
  // Дубликаты отбрасываем по instanceId, потому что это стабильный id конкретного
  // запущенного AgentService instance.
  if (agentsState.list.some((a) => a.instanceId === dto.instanceId)) return;
  agentsState.list = [...agentsState.list, dto];
}

/** Remove an agent by instanceId; also clears selection if it was selected. */
export function removeAgent(instanceId: string): void {
  const before = agentsState.list.length;
  agentsState.list = agentsState.list.filter((a) => a.instanceId !== instanceId);
  if (before === agentsState.list.length) return;
  if (agentsState.selectedInstanceId === instanceId) {
    agentsState.selectedInstanceId = null;
  }
}

/** Стабильная сортировка для служебных списков: agent → owner → name. */
export function sortAgents(list: DiscoveredAgentDTO[]): DiscoveredAgentDTO[] {
  return [...list].sort((a, b) => {
    const byAgent = a.agent.localeCompare(b.agent);
    if (byAgent !== 0) return byAgent;
    const byOwner = a.owner.localeCompare(b.owner);
    if (byOwner !== 0) return byOwner;
    return a.name.localeCompare(b.name);
  });
}

/** Discovered pi-headless controllers (нужно upstream panel-ам spawn/fan-out). */
export const piexecControllers = computed<DiscoveredAgentDTO[]>(() =>
  agentsState.list.filter(
    (a) => a.agent === "pi-headless" && a.metadata?.["role"] === "controller",
  ),
);

/** Discovered pi-headless sessions (обычные promptable карточки). */
export const piexecSessions = computed<DiscoveredAgentDTO[]>(() =>
  agentsState.list.filter(
    (a) => a.agent === "pi-headless" && a.metadata?.["role"] === "session",
  ),
);

/** Discovered claude-code-headless controllers (нужно upstream panel-ам spawn). */
export const ccexecControllers = computed<DiscoveredAgentDTO[]>(() =>
  agentsState.list.filter(
    (a) => a.agent === "cc-headless" && a.metadata?.["role"] === "controller",
  ),
);

/** Discovered claude-code-headless sessions (обычные promptable карточки). */
export const ccexecSessions = computed<DiscoveredAgentDTO[]>(() =>
  agentsState.list.filter(
    (a) => a.agent === "cc-headless" && a.metadata?.["role"] === "session",
  ),
);

/**
 * Грубая классификация карточек.
 * Она нужна сразу в двух местах:
 * 1. цвет/label в `AgentCard`;
 * 2. раскладка по секциям: обычные promptable agents отдельно от controllers.
 *
 * Важно для этого учебного проекта:
 * наши роли публикуются как `agent="basic"` и различаются через metadata.role.
 * Поэтому `basic + role=controller` должен уйти в секцию Controllers,
 * `basic + role=persona` должен остаться selectable для group prompt,
 * а `basic + role=session + session_type=group` - это уже созданная
 * controller-managed group session.
 */
export const BUCKETS = {
  PI_EXEC_SESSION: "pi-exec-session",
  PI_EXEC_CONTROL: "pi-exec-control",
  CC_EXEC_SESSION: "cc-exec-session",
  CC_EXEC_CONTROL: "cc-exec-control",
  PI_AGENT: "pi-agent",
  CC_AGENT: "cc-agent",
  OPENCLAW: "openclaw",
  BASIC_PERSONA: "basic-persona",
  BASIC_GROUP_SESSION: "basic-group-session",
  BASIC_CONTROL: "basic-control",
  HERMES: "hermes",
  OPEN_AGENT: "open-agent",
  OTHER: "other",
} as const;

export type Bucket = (typeof BUCKETS)[keyof typeof BUCKETS];

export function bucketOf(agent: DiscoveredAgentDTO): Bucket {
  // Это ключевая UI-точка, где определяется роль нашего controller-а.
  //
  // Backend задаёт metadata.role="controller" в src/basic-controller.js.
  // Здесь UI читает это поле и относит карточку в BASIC_CONTROL.
  //
  // Если metadata.role="persona", карточка становится BASIC_PERSONA:
  // её можно выбрать галочкой и включить в групповой prompt.
  const role = agent.metadata?.["role"];
  if (agent.agent === "pi-headless") {
    return role === "controller" ? BUCKETS.PI_EXEC_CONTROL : BUCKETS.PI_EXEC_SESSION;
  }
  if (agent.agent === "cc-headless") {
    return role === "controller" ? BUCKETS.CC_EXEC_CONTROL : BUCKETS.CC_EXEC_SESSION;
  }
  if (agent.agent === "basic") {
    if (role === "controller") return BUCKETS.BASIC_CONTROL;
    if (role === "session" && agent.metadata?.["session_type"] === "group") {
      return BUCKETS.BASIC_GROUP_SESSION;
    }
    return BUCKETS.BASIC_PERSONA;
  }
  // Для неизвестных future agents тоже уважаем metadata.role=controller:
  // так controller не получит галочку multi-select и не смешается с "людьми".
  if (role === "controller") return BUCKETS.BASIC_CONTROL;
  // `agent.agent` carries the value of `metadata.agent` (per Appendix C of
  // the spec). Each runtime publishes its own canonical token — match the
  // actual values the runtimes set, plus the legacy short aliases that
  // some deployments still use (cc/ccc/oc).
  if (agent.agent === "pi") return BUCKETS.PI_AGENT;
  if (agent.agent === "claude-code" || agent.agent === "cc" || agent.agent === "ccc") {
    return BUCKETS.CC_AGENT;
  }
  if (agent.agent === "openclaw" || agent.agent === "oc") return BUCKETS.OPENCLAW;
  if (agent.agent === "hermes") return BUCKETS.HERMES;
  if (agent.agent === "open-agent") return BUCKETS.OPEN_AGENT;
  return BUCKETS.OTHER;
}

/**
 * Ранг сортировки promptable карточек.
 * Basic persona agents ставим первыми, потому что это главный учебный сценарий:
 * выбрать нескольких "людей" галочками и отправить им один общий prompt.
 *
 *   Claude Code → CC Headless Sessions → Hermes → Open Agent →
 *   OpenClaw → PI → PI Headless Sessions → Other
 *
 * Controller buckets are deliberately absent — they're sorted by the separate
 * `sortControllers` path. `Partial<>` lets us read with a sentinel fallback
 * so a future stray bucket sorts to the end instead of crashing.
 */
const PROMPTABLE_RANK: Partial<Record<Bucket, number>> = {
  [BUCKETS.BASIC_PERSONA]: 1,
  [BUCKETS.BASIC_GROUP_SESSION]: 2,
  [BUCKETS.CC_AGENT]: 3,
  [BUCKETS.CC_EXEC_SESSION]: 4,
  [BUCKETS.HERMES]: 5,
  [BUCKETS.OPEN_AGENT]: 6,
  [BUCKETS.OPENCLAW]: 7,
  [BUCKETS.PI_AGENT]: 8,
  [BUCKETS.PI_EXEC_SESSION]: 9,
  [BUCKETS.OTHER]: 99,
};

function isController(bucket: Bucket): boolean {
  // Контроллеры не исчезают из discovery как особая сущность протокола.
  // Это обычные agents, которые мы классифицировали в controller buckets.
  return (
    bucket === BUCKETS.PI_EXEC_CONTROL ||
    bucket === BUCKETS.CC_EXEC_CONTROL ||
    bucket === BUCKETS.BASIC_CONTROL
  );
}

function byOwnerThenName(a: DiscoveredAgentDTO, b: DiscoveredAgentDTO): number {
  const o = a.owner.localeCompare(b.owner);
  if (o !== 0) return o;
  return a.name.localeCompare(b.name);
}

function sortPromptables(list: DiscoveredAgentDTO[]): DiscoveredAgentDTO[] {
  return [...list].sort((a, b) => {
    const ra = PROMPTABLE_RANK[bucketOf(a)] ?? 99;
    const rb = PROMPTABLE_RANK[bucketOf(b)] ?? 99;
    if (ra !== rb) return ra - rb;
    return byOwnerThenName(a, b);
  });
}

function sortControllers(list: DiscoveredAgentDTO[]): DiscoveredAgentDTO[] {
  // Controllers не участвуют в group prompt, поэтому им не нужен сложный rank.
  // Плоская сортировка owner→name достаточна и предсказуема.
  return [...list].sort(byOwnerThenName);
}

export type AgentSectionId = "promptables" | "controllers";

/**
 * Две секции agent list:
 * - `promptables`: всё, куда можно отправлять prompt и что можно выбирать галочками;
 * - `controllers`: управляющие agents, которые координируют/создают другие agents.
 *
 * Пустые секции скрываем, чтобы свежий экран без агентов не показывал лишние заголовки.
 */
export const agentSections = computed<{ id: AgentSectionId; label: string; agents: DiscoveredAgentDTO[] }[]>(() => {
  // Главная развилка списка:
  // - promptables получают карточки с checkbox-ом;
  // - controllers показываются отдельно и не участвуют в group prompt.
  //
  // Именно здесь пользователь визуально видит "контроллер отдельно от людей".
  const promptables: DiscoveredAgentDTO[] = [];
  const controllers: DiscoveredAgentDTO[] = [];
  for (const agent of agentsState.list) {
    if (isController(bucketOf(agent))) controllers.push(agent);
    else promptables.push(agent);
  }
  const out: { id: AgentSectionId; label: string; agents: DiscoveredAgentDTO[] }[] = [];
  if (promptables.length > 0) {
    out.push({ id: "promptables", label: "Агенты / сессии", agents: sortPromptables(promptables) });
  }
  if (controllers.length > 0) {
    out.push({ id: "controllers", label: "Контроллеры", agents: sortControllers(controllers) });
  }
  return out;
});
