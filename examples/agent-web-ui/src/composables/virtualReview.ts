import { agentsState } from "../stores/agents.ts";
import { getSession } from "../stores/chat.ts";
import {
  appendVirtualMessage,
  findVirtualMessage,
  trackVirtualPrompt,
  untrackVirtualPrompt,
  type VirtualMessage,
  type VirtualSession,
} from "../stores/virtualSessions.ts";
import { useBridge } from "./useBridge.ts";
import { randomUUID } from "../uuid.ts";
import type { DiscoveredAgentDTO } from "../wire.ts";

// Moderator review для virtual session.
//
// Это ответ на вопрос "кто может сравнить ответы всех личностей?".
// В этом demo такую роль выполняет persona agent `moderator`.
//
// Важная граница:
// moderator не имеет скрытого доступа к памяти teacher/engineer/skeptic/manager.
// UI сам собирает последние ответы из virtual transcript, делает из них один
// большой prompt и отправляет его moderator-у обычным bridge.prompt(...).
//
// Значит, "общий контекст" здесь - наша прикладная сборка transcript-а,
// а не отдельная фича Synadia/NATS.
type ReviewAnswer = {
  sourceInstanceId: string;
  sourceLabel: string;
  text: string;
};

type ReviewInput = {
  originalPrompt: string;
  answers: ReviewAnswer[];
};

export type ModeratorReviewResult = {
  ok: boolean;
  error?: string;
};

export function findModeratorAgent(): DiscoveredAgentDTO | null {
  // Moderator - обычный NATS agent, но мы ищем его по persona_id.
  // Это устойчивее, чем искать по русскому display name: wire name остаётся `moderator`.
  return (
    agentsState.list.find(
      (agent) =>
        agent.agent === "basic" &&
        agent.metadata?.["role"] === "persona" &&
        agent.metadata?.["persona_id"] === "moderator",
    ) ?? null
  );
}

function collectAnswersForTurn(session: VirtualSession, turnId: string): ReviewAnswer[] {
  // Собираем ответы только одного turnId.
  // Это не даёт случайно смешать ответы на разные вопросы пользователя.
  const bySource = new Map<string, ReviewAnswer>();

  for (const msg of session.messages) {
    // Берём только ответы реальных targets этой virtual session.
    // Ответы moderator-а, которые появятся после оценки, не попадут обратно
    // в следующий review случайно, потому что moderator не входит в session.targets.
    if (msg.turnId !== turnId) continue;
    if (msg.role !== "agent") continue;
    if (!msg.sourceInstanceId || !session.targets.includes(msg.sourceInstanceId)) continue;
    if (!msg.content.trim()) continue;

    const current =
      bySource.get(msg.sourceInstanceId) ??
      {
        sourceInstanceId: msg.sourceInstanceId,
        sourceLabel: msg.sourceLabel ?? msg.sourceInstanceId,
        text: "",
      };
    // У одного source может быть несколько bubbles:
    // например, agent сначала ответил, потом вызвал tool/query, потом продолжил.
    // Для moderator review склеиваем все куски одного source в один текст.
    current.text += `${current.text ? "\n\n" : ""}${msg.content.trim()}`;
    bySource.set(msg.sourceInstanceId, current);
  }

  return Array.from(bySource.values());
}

function latestReviewInput(session: VirtualSession): ReviewInput | null {
  // Ищем последний user turn, у которого уже есть ответы target agents.
  // Если последним сообщением была сама "оценка ответов", она не подойдёт:
  // у неё нет ответов от session.targets, значит мы пойдём к предыдущему turn.
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const msg = session.messages[index];
    if (!msg || msg.role !== "user" || !msg.turnId) continue;

    const answers = collectAnswersForTurn(session, msg.turnId);
    if (answers.length === 0) continue;

    return {
      originalPrompt: msg.content,
      answers,
    };
  }

  return null;
}

export function hasReviewableAnswers(session: VirtualSession): boolean {
  // Используется кнопкой "Оценить ответы": пока нет ни одного complete/partial
  // ответа target agents, кнопку держим disabled.
  return latestReviewInput(session) !== null;
}

function buildModeratorPrompt(input: ReviewInput, criteria: string): string {
  // Это главный "доступ к ответам всех агентов".
  // Moderator не читает чужую память и не подписывается на их private state.
  // UI сам собирает transcript и передаёт его moderator-у как обычный prompt.
  return [
    "Пользователь просит оценить ответы нескольких агентов.",
    "",
    "Инструкция пользователя для оценки:",
    criteria.trim() || "Сравни ответы и дай итоговую рекомендацию.",
    "",
    "Исходный вопрос пользователя:",
    input.originalPrompt,
    "",
    "Ответы агентов:",
    ...input.answers.map((answer, index) =>
      [
        "",
        `### ${index + 1}. ${answer.sourceLabel}`,
        answer.text,
      ].join("\n"),
    ),
    "",
    "Ответь по-русски. Структура:",
    "1. Короткое сравнение.",
    "2. Сильные стороны каждого ответа.",
    "3. Противоречия или пробелы.",
    "4. Итоговый синтез и что делать дальше.",
  ].join("\n");
}

function markStreamingDone(message: VirtualMessage | undefined): void {
  // Маленький helper, чтобы callbacks onDone/onError одинаково закрывали bubble.
  if (message) message.streaming = false;
}

export function startModeratorReview(
  session: VirtualSession,
  criteria: string,
): ModeratorReviewResult {
  // Запускает второй prompt после группового ответа.
  // Возвращает синхронный result только о старте операции; сам review streaming
  // продолжает приходить через callbacks bridge.prompt.
  const moderator = findModeratorAgent();
  if (!moderator) {
    return {
      ok: false,
      error: "moderator agent не найден. Перезапусти controller, чтобы появился basic.demo.moderator.",
    };
  }

  const moderatorSession = getSession(moderator.instanceId);
  if (moderatorSession.activePromptId !== null) {
    return {
      ok: false,
      error: "moderator сейчас занят другим prompt.",
    };
  }

  const input = latestReviewInput(session);
  if (!input) {
    return {
      ok: false,
      error: "В этой virtual session ещё нет готовых ответов agents для оценки.",
    };
  }

  const bridge = useBridge();
  const turnId = randomUUID();
  const promptText = buildModeratorPrompt(input, criteria);
  const visibleCriteria = criteria.trim() || "Сравни ответы и дай итоговую рекомендацию.";

  // В общий transcript добавляем visible user bubble, чтобы было видно,
  // какую именно оценочную инструкцию пользователь дал moderator-у.
  appendVirtualMessage(session.id, {
    id: randomUUID(),
    role: "user",
    content: `Оценить ответы агентов:\n${visibleCriteria}`,
    streaming: false,
    timestamp: Date.now(),
    turnId,
  });

  const reviewMsgId = randomUUID();
  // Затем создаём пустой streaming bubble ответа moderator-а.
  // Его content будет пополняться в onResponse ниже.
  appendVirtualMessage(session.id, {
    id: reviewMsgId,
    role: "agent",
    content: "",
    streaming: true,
    timestamp: Date.now(),
    sourceInstanceId: moderator.instanceId,
    sourceLabel: "MODERATOR · оценка ответов",
    turnId,
  });

  let syncErrored = false;
  let promptId = "";
  promptId = bridge.prompt(moderator.instanceId, promptText, undefined, {
    onResponse(chunk) {
      // Moderator отвечает как обычный agent stream.
      // Мы просто пишем chunk в заранее созданный bubble reviewMsgId.
      const msg = findVirtualMessage(session.id, reviewMsgId);
      if (msg) msg.content += chunk;
    },
    onStatus(status) {
      const msg = findVirtualMessage(session.id, reviewMsgId);
      if (msg && status === "stopped") msg.statusNote = "(stopped)";
    },
    onDone() {
      // Review закончен: снимаем busy-state с moderator-а и virtual session.
      markStreamingDone(findVirtualMessage(session.id, reviewMsgId));
      moderatorSession.activePromptId = null;
      untrackVirtualPrompt(session.id, turnId, moderator.instanceId);
    },
    onError(message, code, details) {
      // Ошибка moderator-а не удаляет уже собранные ответы других agents.
      // Пользователь может поправить критерий или перезапустить controller.
      syncErrored = true;
      const msg = findVirtualMessage(session.id, reviewMsgId);
      if (msg) {
        const detail = code ? ` [${code}]` : "";
        const extra = details ? ` ${JSON.stringify(details)}` : "";
        msg.error = `${message}${detail}${extra}`;
      }
      markStreamingDone(msg);
      moderatorSession.activePromptId = null;
      untrackVirtualPrompt(session.id, turnId, moderator.instanceId);
    },
  });

  if (!syncErrored) {
    // trackVirtualPrompt нужен Stop-кнопке virtual session:
    // она сможет отменить review так же, как обычный group turn.
    moderatorSession.activePromptId = promptId;
    trackVirtualPrompt(session.id, turnId, moderator.instanceId, promptId);
  }

  return { ok: true };
}
