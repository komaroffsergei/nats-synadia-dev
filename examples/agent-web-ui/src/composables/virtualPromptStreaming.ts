import {
  appendMessage,
  findMessage,
  findMessageByToolId,
  getSession,
} from "../stores/chat.ts";
import { agentsState } from "../stores/agents.ts";
import { bumpCcSessionCost } from "../stores/ccexec.ts";
import {
  appendVirtualMessage,
  findVirtualMessage,
  findVirtualMessageByToolId,
  getVirtualSession,
  trackVirtualPrompt,
  untrackVirtualPrompt,
  virtualTargetLabel,
} from "../stores/virtualSessions.ts";
import { useBridge } from "./useBridge.ts";
import { randomUUID } from "../uuid.ts";
import type { DiscoveredAgentDTO, WireAttachment } from "../wire.ts";

// Логика "один prompt -> несколько agents".
//
// Это frontend orchestration, а не новая сущность Synadia protocol.
// UI просто делает несколько обычных prompt calls и склеивает их streams
// в один общий transcript.
//
// Поэтому эту часть удобно читать как маленький fan-out router:
// - startVirtualTurn создаёт общий turnId и user bubble;
// - fanoutOneTarget запускает один реальный prompt;
// - callbacks bridge.prompt пишут stream сразу в два места.
export type VirtualTurnReport = {
  /** Сколько реальных prompt вызовов отправили: один bridge.prompt на один свободный online target. */
  ok: number;
  /** Сколько targets пропустили, потому что они уже отвечают на другой prompt. */
  busy: number;
  /** Сколько targets исчезли из discovery и были пропущены. */
  offline: number;
  /** Общий id одного group turn: все bubbles от этого Send имеют один turnId. */
  turnId: string;
};

/**
 * Отправляет один prompt всем target-ам virtual session.
 *
 * Важный момент для понимания архитектуры:
 * backend не знает про "групповой prompt" как отдельный endpoint.
 * Здесь UI сам делает fan-out: для каждого выбранного agent вызывает
 * `bridge.prompt(instanceId, text)`, а затем зеркалит stream в общий transcript.
 *
 * Поэтому:
 * - каждый agent получает тот же user prompt отдельно;
 * - ответы стримятся независимо;
 * - общий экран только агрегирует эти независимые ответы рядом.
 */
export function startVirtualTurn(
  virtualId: string,
  text: string,
  attachments: WireAttachment[] | undefined,
): VirtualTurnReport {
  const turnId = randomUUID();
  const report: VirtualTurnReport = { ok: 0, busy: 0, offline: 0, turnId };

  const vs = getVirtualSession(virtualId);
  if (!vs) return report;

  // 1. Сам user prompt: один bubble в начале общего turn.
  // turnId потом связывает этот user bubble со всеми ответами targets.
  const userMsgId = randomUUID();
  appendVirtualMessage(virtualId, {
    id: userMsgId,
    role: "user",
    content: text,
    streaming: false,
    timestamp: Date.now(),
    attachments: attachments?.map((a) => ({ filename: a.filename, base64: a.base64 })),
    turnId,
  });

  // 2. Каждый target классифицируем как online/offline/busy.
  //    Online+free получает реальный bridge.prompt, остальные только placeholder.
  //
  // Placeholder важен UX-но: пользователь видит, почему ответов меньше,
  // чем выбранных agents.
  for (const targetId of vs.targets) {
    const agent = agentsState.list.find((a) => a.instanceId === targetId);
    if (!agent) {
      appendVirtualMessage(virtualId, {
        id: randomUUID(),
        role: "agent",
        content: "",
        streaming: false,
        timestamp: Date.now(),
        statusNote: "(offline — пропущен)",
        sourceInstanceId: targetId,
        sourceLabel: `instanceId ${targetId.slice(0, 8)}…`,
        turnId,
      });
      report.offline += 1;
      continue;
    }

    if (getSession(targetId).activePromptId !== null) {
      appendVirtualMessage(virtualId, {
        id: randomUUID(),
        role: "agent",
        content: "",
        streaming: false,
        timestamp: Date.now(),
        statusNote: "(занят — пропущен)",
        sourceInstanceId: targetId,
        sourceLabel: virtualTargetLabel(agent),
        turnId,
      });
      report.busy += 1;
      continue;
    }

    fanoutOneTarget(virtualId, agent, text, attachments, turnId);
    report.ok += 1;
  }

  // report нужен только для короткого "отправлено N, занято M, offline K".
  // Реальные ответы приходят позже через callbacks bridge.prompt.
  return report;
}

/**
 * Один target внутри fan-out.
 * Каждый wire event пишем в два места:
 * 1. обычный chat конкретного agent-а, чтобы история agent-а не терялась;
 * 2. virtual transcript, где пользователь сравнивает ответы выбранной группы.
 */
function fanoutOneTarget(
  virtualId: string,
  agent: DiscoveredAgentDTO,
  text: string,
  attachments: WireAttachment[] | undefined,
  turnId: string,
): void {
  const bridge = useBridge();
  const instanceId = agent.instanceId;
  const sourceLabel = virtualTargetLabel(agent);
  const session = getSession(instanceId);
  const isCcSession =
    agent.agent === "cc-headless" && agent.metadata?.["role"] === "session";

  // ----- обычный chat agent-а: user bubble + пустой streaming bubble ответа -----
  // Даже если пользователь смотрит общий virtual transcript, отдельная история
  // каждого agent-а тоже должна остаться полной. Поэтому сначала пишем user/agent
  // bubbles в обычный per-instance chat.
  const userMsg = appendMessage(instanceId, {
    id: randomUUID(),
    role: "user",
    content: text,
    streaming: false,
    timestamp: Date.now(),
  });
  if (attachments && attachments.length > 0) {
    userMsg.attachments = attachments.map((a) => ({ filename: a.filename, base64: a.base64 }));
  }

  let currentAgentMsgId = randomUUID();
  appendMessage(instanceId, {
    id: currentAgentMsgId,
    role: "agent",
    content: "",
    streaming: true,
    timestamp: Date.now(),
  });

  // ----- общий virtual transcript: отдельный streaming bubble этого source -----
  // Второй bubble с тем же sourceLabel идёт в общий чат группы.
  // Так один stream одновременно виден в личном чате agent-а и в сравнительной панели.
  let currentVirtualMsgId = randomUUID();
  appendVirtualMessage(virtualId, {
    id: currentVirtualMsgId,
    role: "agent",
    content: "",
    streaming: true,
    timestamp: Date.now(),
    sourceInstanceId: instanceId,
    sourceLabel,
    turnId,
  });

  function newPerInstanceAgentBubble(): void {
    // Query/tool events разрывают поток ответа: старый bubble закрывается,
    // затем создаётся новый bubble для следующего текстового chunk-а.
    currentAgentMsgId = randomUUID();
    appendMessage(instanceId, {
      id: currentAgentMsgId,
      role: "agent",
      content: "",
      streaming: true,
      timestamp: Date.now(),
    });
  }
  function newVirtualAgentBubble(): void {
    // То же самое делаем в virtual transcript, чтобы структура двух историй
    // оставалась синхронной.
    currentVirtualMsgId = randomUUID();
    appendVirtualMessage(virtualId, {
      id: currentVirtualMsgId,
      role: "agent",
      content: "",
      streaming: true,
      timestamp: Date.now(),
      sourceInstanceId: instanceId,
      sourceLabel,
      turnId,
    });
  }

  let syncErrored = false;
  let promptId = "";
  promptId = bridge.prompt(instanceId, text, attachments, {
    onResponse(chunk, responseAttachments) {
      // Каждый response chunk зеркалим:
      // 1. в личный chat agent-а;
      // 2. в общий virtual transcript.
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) {
        m.content += chunk;
        if (responseAttachments && responseAttachments.length > 0) {
          m.attachments = [...(m.attachments ?? []), ...responseAttachments];
        }
      }
      const vm = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (vm) {
        vm.content += chunk;
        if (responseAttachments && responseAttachments.length > 0) {
          vm.attachments = [...(vm.attachments ?? []), ...responseAttachments];
        }
      }
    },
    onStatus(status) {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m && status === "stopped") m.statusNote = "(stopped)";
      const vm = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (vm && status === "stopped") vm.statusNote = "(stopped)";
    },
    onQuery(queryId, queryPrompt, queryAttachments) {
      // Query - это когда agent просит дополнительный input у пользователя.
      // В одиночном чате на него можно ответить, но в group transcript мы
      // специально оставляем query read-only, чтобы не путать, какому source
      // должен уйти ответ.
      const prev = findMessage(instanceId, currentAgentMsgId);
      if (prev) prev.streaming = false;
      const prevV = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (prevV) prevV.streaming = false;
      // В обычном agent chat query интерактивный: можно ответить обратно в source.
      appendMessage(instanceId, {
        id: randomUUID(),
        role: "query",
        content: queryPrompt,
        streaming: false,
        timestamp: Date.now(),
        queryId,
        promptId,
        replied: false,
        attachments: queryAttachments,
      });
      // В aggregate-чате query пока read-only.
      // Иначе пришлось бы решать, какой именно source получает ответ и как
      // показать это в UI. Для учебного group prompt это лишнее.
      appendVirtualMessage(virtualId, {
        id: randomUUID(),
        role: "query",
        content: queryPrompt,
        streaming: false,
        timestamp: Date.now(),
        queryId,
        promptId,
        replied: true,
        sourceInstanceId: instanceId,
        sourceLabel,
        turnId,
        attachments: queryAttachments,
      });
      newPerInstanceAgentBubble();
      newVirtualAgentBubble();
    },
    onToolUse(toolUseId, toolName, input) {
      // Tool events тоже показываем в обеих историях.
      // Это важно для agents, которые используют инструменты: общий transcript
      // должен честно показывать, почему ответ появился именно таким.
      const prev = findMessage(instanceId, currentAgentMsgId);
      if (prev) prev.streaming = false;
      const prevV = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (prevV) prevV.streaming = false;
      appendMessage(instanceId, {
        id: randomUUID(),
        role: "tool",
        content: "",
        streaming: false,
        timestamp: Date.now(),
        tool: { id: toolUseId, name: toolName, input },
      });
      appendVirtualMessage(virtualId, {
        id: randomUUID(),
        role: "tool",
        content: "",
        streaming: false,
        timestamp: Date.now(),
        tool: { id: toolUseId, name: toolName, input },
        sourceInstanceId: instanceId,
        sourceLabel,
        turnId,
      });
      newPerInstanceAgentBubble();
      newVirtualAgentBubble();
    },
    onToolResult(toolUseId, output, isError) {
      // Tool result приходит позже и должен найти уже созданный tool bubble.
      // Поэтому lookup идёт по toolUseId, а не по текущему streaming bubble id.
      const m = findMessageByToolId(instanceId, toolUseId);
      if (m && m.tool) {
        m.tool.result = output;
        m.tool.isError = isError;
      }
      const vm = findVirtualMessageByToolId(virtualId, toolUseId);
      if (vm && vm.tool) {
        vm.tool.result = output;
        vm.tool.isError = isError;
      }
    },
    onCost(turnCostUsd, totalCostUsd) {
      // Стоимость актуальна для cc-headless sessions.
      // Для basic persona agents поле обычно не используется, но generic UI
      // умеет показать его, если runtime пришлёт cost event.
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) m.costUsd = turnCostUsd;
      const vm = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (vm) vm.costUsd = turnCostUsd;
      if (isCcSession) bumpCcSessionCost(agent.name, totalCostUsd);
    },
    onDone() {
      // Один source закончил отвечать: закрываем его bubbles и убираем active prompt
      // из virtual session. Общая session считается busy, пока activePromptIds не пустой.
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) m.streaming = false;
      const vm = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (vm) vm.streaming = false;
      session.activePromptId = null;
      untrackVirtualPrompt(virtualId, turnId, instanceId);
    },
    onError(message, code, details) {
      // Ошибка одного target-а не валит всю virtual session.
      // Мы помечаем только bubble этого source, остальные targets продолжают stream.
      syncErrored = true;
      const detail = code ? ` [${code}]` : "";
      const extra = details ? ` ${JSON.stringify(details)}` : "";
      const formatted = `${message}${detail}${extra}`;
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) {
        m.error = formatted;
        m.streaming = false;
      }
      const vm = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (vm) {
        vm.error = formatted;
        vm.streaming = false;
      }
      session.activePromptId = null;
      untrackVirtualPrompt(virtualId, turnId, instanceId);
    },
  });
  if (!syncErrored) {
    // promptId появляется синхронно после bridge.prompt.
    // Он нужен Stop-кнопке virtual session: она отменяет все promptIds текущего turn.
    session.activePromptId = promptId;
    trackVirtualPrompt(virtualId, turnId, instanceId, promptId);
  }
}
