import { computed, reactive } from "vue";
import { agentsState } from "./agents.ts";
import type { Message } from "./chat.ts";
import type { DiscoveredAgentDTO, WireAttachment } from "../wire.ts";
import { randomUUID } from "../uuid.ts";

/**
 * UI-only "virtual sessions" — это синтетические чаты в правой панели.
 * Они не создают новый NATS service и не меняют protocol.
 * UI просто запоминает выбранные instanceId, а каждый prompt отправляет
 * всем этим реальным agents отдельными `bridge.prompt` вызовами.
 *
 *  - Создаётся из панели multi-select, когда включён "Общий virtual session".
 *  - Живёт только пока открыта страница; reload очищает эти synthetic sessions.
 *  - Targets фиксируются при создании, чтобы "группа людей" не менялась случайно.
 *  - Если target исчез из discovery, следующий prompt просто пропустит его.
 *
 * Prefix `virtual:` позволяет хранить real agent selection и virtual chat
 * в одном поле `agentsState.selectedInstanceId`. Правая панель смотрит на
 * prefix и решает, показать обычный ChatPanel или VirtualChatPanel.
 */

export type VirtualMessage = Message & {
  /** instanceId реального agent-а, который создал этот bubble. */
  sourceInstanceId?: string;
  /** Display label кэшируем сразу, чтобы старая история читалась даже после ухода agent-а. */
  sourceLabel?: string;
  /** Общий id одного turn: все bubbles от одного Send имеют одинаковый turnId. */
  turnId?: string;
};

export type VirtualSession = {
  id: string;
  label: string;
  /** instanceIds реальных agents, на которых fan-out идёт каждый раз. */
  targets: string[];
  messages: VirtualMessage[];
  /** Активные promptIds: Stop в virtual chat отменяет все streams текущего turn. */
  activePromptIds: Map<string, string>;
};

type VirtualSessionsState = {
  sessions: Map<string, VirtualSession>;
  counter: number;
};

export const virtualSessionsState = reactive<VirtualSessionsState>({
  // Map удобен, потому что selectedInstanceId хранит конкретный id,
  // и по нему надо быстро найти session для правой панели.
  sessions: new Map(),
  // counter нужен только для короткого display label "Группа #1".
  // Он не участвует в protocol и может сброситься при reload.
  counter: 0,
});

const VIRTUAL_PREFIX = "virtual:";

export function isVirtualId(id: string | null | undefined): boolean {
  // Маленький discriminator для правой панели.
  // Real agents имеют настоящие UUID/instanceId от discovery, а virtual session
  // всегда начинается с `virtual:`.
  return typeof id === "string" && id.startsWith(VIRTUAL_PREFIX);
}

export const virtualSessionsList = computed<VirtualSession[]>(() =>
  Array.from(virtualSessionsState.sessions.values()),
);

export const selectedVirtualSession = computed<VirtualSession | null>(() => {
  // Если пользователь выбрал virtual session в списке, selectedInstanceId
  // указывает на неё точно так же, как раньше указывал на real agent.
  const id = agentsState.selectedInstanceId;
  if (!id || !isVirtualId(id)) return null;
  return virtualSessionsState.sessions.get(id) ?? null;
});

/** Делаем короткий label источника ответа: "@demo · BASIC Учитель". */
export function virtualTargetLabel(agent: DiscoveredAgentDTO): string {
  // Label сохраняем в message при записи, а не вычисляем каждый раз заново.
  // Тогда старая история продолжит показывать понятное имя даже если agent
  // исчез из discovery или перезапустился с другим instanceId.
  const a = agent.agent;
  let display = a.toUpperCase();
  if (a === "claude-code" || a === "cc" || a === "ccc") display = "CLAUDE CODE";
  else if (a === "openclaw" || a === "oc") display = "OPENCLAW";
  else if (a === "pi") display = "PI";
  else if (a === "hermes") display = "HERMES";
  else if (a === "open-agent") display = "OPEN AGENT";
  else if (a === "pi-headless") display = "PI HEADLESS";
  else if (a === "cc-headless") display = "CC HEADLESS";
  else if (a === "basic" && agent.metadata?.["role"] === "persona") display = "BASIC";
  else if (a === "basic" && agent.metadata?.["role"] === "controller") display = "BASIC CONTROL";
  const session = agent.session && agent.session !== agent.name ? ` ${agent.session}` : "";
  const persona = agent.metadata?.["persona_name"];
  return `@${agent.owner} · ${display}${persona ? ` ${persona}` : session}`;
}

/**
 * Создаёт virtual session с зафиксированным списком targetIds.
 * Возвращаем id с prefix `virtual:`; caller сам выбирает эту session в правой панели.
 */
export function createVirtualSession(targetIds: string[]): string {
  // targetIds фиксируются один раз при создании.
  // Это осознанно: если потом пользователь отметит другие галочки, старая группа
  // не должна внезапно менять состав.
  virtualSessionsState.counter += 1;
  const id = `${VIRTUAL_PREFIX}${randomUUID()}`;
  const n = targetIds.length;
  const label = `Группа #${virtualSessionsState.counter} (${n} agent${n === 1 ? "" : "s"})`;
  virtualSessionsState.sessions.set(id, {
    id,
    label,
    targets: [...targetIds],
    messages: [],
    activePromptIds: new Map(),
  });
  return id;
}

export function deleteVirtualSession(id: string): void {
  // Удаление virtual session удаляет только локальный UI transcript.
  // Никакие NATS services и реальные agents при этом не останавливаются.
  virtualSessionsState.sessions.delete(id);
  if (agentsState.selectedInstanceId === id) {
    agentsState.selectedInstanceId = null;
  }
}

export function getVirtualSession(id: string): VirtualSession | undefined {
  return virtualSessionsState.sessions.get(id);
}

export function appendVirtualMessage(
  virtualId: string,
  msg: VirtualMessage,
): VirtualMessage | undefined {
  // Все записи в общий transcript проходят через этот helper.
  // Он возвращает фактически вставленный объект, если caller хочет дальше
  // мутировать streaming/content поля.
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return undefined;
  vs.messages.push(msg);
  return vs.messages[vs.messages.length - 1];
}

export function findVirtualMessage(
  virtualId: string,
  messageId: string,
): VirtualMessage | undefined {
  // Streaming callbacks приходят позже и должны найти уже созданный bubble.
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return undefined;
  return vs.messages.find((m) => m.id === messageId);
}

export function findVirtualMessageByToolId(
  virtualId: string,
  toolUseId: string,
): VirtualMessage | undefined {
  // Tool result ищется по tool id, потому что текстовый bubble к этому времени
  // может быть уже другим.
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return undefined;
  return vs.messages.find((m) => m.role === "tool" && m.tool?.id === toolUseId);
}

/** true, если хотя бы один stream внутри virtual session ещё отвечает. */
export function isVirtualSessionActive(virtualId: string): boolean {
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return false;
  return vs.activePromptIds.size > 0;
}

/** Snapshot активных promptIds, чтобы Stop мог отменить весь group turn. */
export function activePromptIdsOf(virtualId: string): string[] {
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return [];
  return [...vs.activePromptIds.values()];
}

/** Регистрируем stream одного source-agent внутри общего virtual turn. */
export function trackVirtualPrompt(
  virtualId: string,
  turnId: string,
  sourceInstanceId: string,
  promptId: string,
): void {
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return;
  vs.activePromptIds.set(`${turnId}:${sourceInstanceId}`, promptId);
}

export function untrackVirtualPrompt(
  virtualId: string,
  turnId: string,
  sourceInstanceId: string,
): void {
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return;
  vs.activePromptIds.delete(`${turnId}:${sourceInstanceId}`);
}

/** Re-export для prompt-area: ей нужно знать shape attachments. */
export type { WireAttachment };
