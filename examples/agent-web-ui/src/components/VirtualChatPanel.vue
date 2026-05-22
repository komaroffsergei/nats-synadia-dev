<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import MessageBubble from "./MessageBubble.vue";
import PromptArea from "./PromptArea.vue";
import { fileToAttachment, useBridge } from "../composables/useBridge.ts";
import { startVirtualTurn } from "../composables/virtualPromptStreaming.ts";
import {
  findModeratorAgent,
  hasReviewableAnswers,
  startModeratorReview,
} from "../composables/virtualReview.ts";
import { agentsState } from "../stores/agents.ts";
import { getSession } from "../stores/chat.ts";
import {
  activePromptIdsOf,
  isVirtualSessionActive,
  type VirtualSession,
} from "../stores/virtualSessions.ts";

// Правая панель для UI-only group chat.
//
// Отличие от обычного ChatPanel:
// - здесь один пользовательский prompt уходит нескольким agents;
// - ответы разных agents показываются в одном transcript с source headers;
// - есть второй этап "Оценить ответы", который отправляет собранный transcript
//   agent-у moderator.
const props = defineProps<{ session: VirtualSession }>();

const bridge = useBridge();
const error = ref<string | null>(null);
const lastReport = ref<{ ok: number; busy: number; offline: number } | null>(null);
const reviewText = ref("Сравни ответы, найди противоречия, выбери самый полезный вариант и дай итоговый вывод.");
let reportTimer: ReturnType<typeof setTimeout> | null = null;

const messages = computed(() => props.session.messages);

const targetCount = computed(() => props.session.targets.length);

const onlineTargets = computed(() =>
  // Targets зафиксированы при создании virtual session.
  // Здесь проверяем, кто из них сейчас всё ещё есть в discovery.
  props.session.targets.filter((id) =>
    agentsState.list.some((a) => a.instanceId === id),
  ),
);

const sendableTargets = computed(() =>
  // Sendable = online и не занят другим activePromptId.
  // Занятые targets не блокируют всю session: они будут отмечены placeholder-ом.
  onlineTargets.value.filter(
    (id) => getSession(id).activePromptId === null,
  ),
);

const sendableCount = computed(() => sendableTargets.value.length);
const moderatorAgent = computed(() => findModeratorAgent());
const moderatorBusy = computed(() => {
  // Moderator - отдельный agent. Если он сейчас отвечает на другой prompt,
  // вторую оценку не запускаем.
  const moderator = moderatorAgent.value;
  if (!moderator) return false;
  return getSession(moderator.instanceId).activePromptId !== null;
});
const reviewable = computed(() => hasReviewableAnswers(props.session));
const canReview = computed(() => moderatorAgent.value !== null && reviewable.value && !moderatorBusy.value);

// Busy здесь означает: хотя бы один target внутри этой virtual session сейчас стримит ответ.
// Stop отменяет все per-source streams текущего group turn.
const busy = computed(() => isVirtualSessionActive(props.session.id));

// Auto-scroll: список сообщений сам хранит scroll position,
// а здесь мы только подталкиваем его вниз после нового bubble.
const listRef = ref<HTMLElement | null>(null);
function scrollToBottom(): void {
  const el = listRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}
watch(
  () => messages.value.length,
  () => void nextTick(scrollToBottom),
);
watch(
  () =>
    messages.value.length > 0
      ? messages.value[messages.value.length - 1]?.content
      : "",
  () => {
    const el = listRef.value;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      void nextTick(scrollToBottom);
    }
  },
);

// Заголовок source показываем только когда источник изменился.
// Так ответы одного agent-а идут компактно, но при смене agent-а видно,
// кто именно сейчас говорит.
function showSourceHeader(i: number): boolean {
  const m = messages.value[i];
  if (!m || !m.sourceInstanceId) return false;
  const prev = messages.value[i - 1];
  if (!prev) return true;
  return prev.sourceInstanceId !== m.sourceInstanceId;
}

async function onSubmit(text: string, files: File[]): Promise<void> {
  // Новый group turn внутри уже созданной virtual session.
  // В отличие от MultiSelectBar, здесь состав targets уже фиксирован.
  let attachments: Awaited<ReturnType<typeof fileToAttachment>>[] | undefined;
  if (files.length > 0) {
    try {
      attachments = await Promise.all(files.map(fileToAttachment));
    } catch (e) {
      error.value = `failed to read file: ${(e as Error).message}`;
      return;
    }
  }
  error.value = null;
  const report = startVirtualTurn(props.session.id, text, attachments);
  if (reportTimer !== null) clearTimeout(reportTimer);
  lastReport.value = { ok: report.ok, busy: report.busy, offline: report.offline };
  reportTimer = setTimeout(() => {
    lastReport.value = null;
    reportTimer = null;
  }, 5_000);
}

function onStop(): void {
  // Stop отменяет все promptIds, которые сейчас зарегистрированы внутри
  // этой virtual session: ответы разных sources, а также moderator review.
  for (const promptId of activePromptIdsOf(props.session.id)) {
    bridge.cancel(promptId);
  }
}

function onReview(): void {
  // Moderator review - второй этап после fan-out:
  // 1. UI берёт последний user turn и ответы всех target agents;
  // 2. собирает их в один большой prompt;
  // 3. отправляет этот prompt отдельному agent-у `moderator`;
  // 4. ответ moderator-а стримится в этот же virtual transcript.
  error.value = null;
  const result = startModeratorReview(props.session, reviewText.value);
  if (!result.ok) {
    error.value = result.error ?? "Не удалось запустить moderator review.";
  }
}

// Чистим таймер отчёта при уходе с панели, чтобы callback не писал в уже
// уничтоженный component instance.
onUnmounted(() => {
  if (reportTimer !== null) clearTimeout(reportTimer);
});
</script>

<template>
  <section class="chat-pane">
    <header class="chat-head">
      <div class="chat-title">
        <span class="chat-tag mono">VIRTUAL</span>
        <span class="chat-name">{{ session.label }}</span>
      </div>
      <div class="chat-sub mono">
        fan-out: online {{ onlineTargets.length }} из {{ targetCount }}
        <template v-if="lastReport">
          · отправлено: {{ lastReport.ok }}<template v-if="lastReport.busy + lastReport.offline > 0">
            (занято: {{ lastReport.busy }}, offline: {{ lastReport.offline }})</template>
        </template>
      </div>
      <div class="review-row">
        <!-- Этот input не является "общим контекстом" для всех future turns.
             Это только критерий оценки для следующего вызова moderator-а. -->
        <input
          v-model="reviewText"
          class="review-input"
          type="text"
          placeholder="Как moderator должен оценивать ответы?"
          :disabled="moderatorBusy"
          @keydown.enter.prevent="onReview"
        />
        <button
          type="button"
          class="review-btn"
          :disabled="!canReview"
          :title="
            !moderatorAgent
              ? 'moderator agent не найден'
              : !reviewable
                ? 'сначала дождись ответов agents'
                : moderatorBusy
                  ? 'moderator занят'
                  : 'передать все ответы moderator-у'
          "
          @click="onReview"
        >
          <!-- При клике UI соберёт последний user turn + ответы target agents
               и отправит их moderator-у как обычный prompt. -->
          Оценить ответы
        </button>
      </div>
    </header>

    <div v-if="error" class="error mono">{{ error }}</div>

    <div ref="listRef" class="list">
      <div v-if="messages.length === 0" class="empty">
        <p>Сообщений пока нет.</p>
        <p class="hint">
          Prompt ниже уйдёт всем {{ targetCount }} target{{ targetCount === 1 ? "" : "s" }},
          а ответы соберутся в этом общем transcript.
        </p>
      </div>
      <template v-for="(m, i) in messages" :key="m.id">
        <div v-if="showSourceHeader(i)" class="source-header">
          <span class="source-label mono">{{ m.sourceLabel }}</span>
        </div>
        <MessageBubble :message="m" />
      </template>
    </div>

    <PromptArea
      :busy="busy"
      :disabled="sendableCount === 0 && !busy"
      :attachments-ok="true"
      @submit="onSubmit"
      @stop="onStop"
    />
  </section>
</template>

<style scoped>
.chat-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg-deep);
}
.chat-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-md) var(--space-lg);
  background: var(--bg-primary);
  border-bottom: var(--border-subtle);
  flex-shrink: 0;
}
.chat-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
}
.chat-tag {
  font-size: var(--text-xs);
  color: var(--bucket-virtual);
  background: color-mix(in srgb, var(--bucket-virtual) 14%, transparent);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.chat-name {
  color: var(--text-primary);
  font-weight: 600;
}
.chat-sub {
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.review-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}
.review-input {
  min-width: 0;
  height: 32px;
  padding: 0 var(--space-sm);
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: var(--border-subtle);
  border-radius: var(--border-radius-sm);
  font: inherit;
  font-size: var(--text-xs);
}
.review-input:focus {
  outline: 1px solid var(--accent-primary);
  outline-offset: 1px;
}
.review-input:disabled {
  opacity: 0.6;
}
.review-btn {
  height: 32px;
  padding: 0 var(--space-md);
  color: var(--text-primary);
  background: color-mix(in srgb, var(--bucket-virtual) 16%, var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--bucket-virtual) 28%, transparent);
  border-radius: var(--border-radius-sm);
  font-size: var(--text-xs);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.review-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--bucket-virtual) 24%, var(--bg-secondary));
}
.review-btn:focus-visible {
  outline: 1px solid var(--accent-primary);
  outline-offset: 1px;
}
.review-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.error {
  padding: var(--space-sm) var(--space-lg);
  font-size: var(--text-xs);
  color: var(--error);
  background: var(--error-dim);
  border-bottom: 1px solid rgba(248, 113, 113, 0.3);
}

.list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-lg);
  overflow-y: auto;
  background: var(--bg-deep);
}
.empty {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--text-sm);
  max-width: 420px;
}
.hint {
  color: var(--text-dim);
  font-size: var(--text-xs);
  margin-top: var(--space-xs);
  line-height: var(--leading-relaxed);
}

/* Per-source headers split the linear transcript into one labelled block
   per agent per turn. The label is the only visual marker that bubbles
   below it came from a specific source (ToolBubble + AgentBubble can
   both follow without a repeated header). */
.source-header {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin: var(--space-md) 0 calc(var(--space-md) * -1 + var(--space-xs));
  padding: 0 var(--space-xs);
}
.source-header::before,
.source-header::after {
  content: "";
  flex: 1;
  height: 1px;
  background: color-mix(in srgb, var(--bucket-virtual) 18%, transparent);
}
.source-label {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--bucket-virtual);
  padding: 2px 8px;
  border-radius: var(--border-radius-sm);
  background: color-mix(in srgb, var(--bucket-virtual) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--bucket-virtual) 20%, transparent);
}
</style>
