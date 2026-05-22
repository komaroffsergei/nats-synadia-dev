<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import AttachmentChips from "./AttachmentChips.vue";
import { agentsState, selectAgent } from "../stores/agents.ts";
import { clearSelection, selectionState } from "../stores/selection.ts";
import { getSession } from "../stores/chat.ts";
import { fileToAttachment, useBridge } from "../composables/useBridge.ts";
import { startPromptStream } from "../composables/promptStreaming.ts";
import { startVirtualTurn } from "../composables/virtualPromptStreaming.ts";
import { createVirtualSession } from "../stores/virtualSessions.ts";

// Нижняя панель группового prompt-а.
//
// Она появляется только когда пользователь отметил хотя бы одну карточку.
// Здесь важно различать два режима:
//
// 1. Обычный fan-out:
//    Send сразу вызывает startPromptStream(...) для каждого выбранного agent-а.
//    История пишется в отдельные обычные чаты agents.
//
// 2. "Общий virtual session":
//    UI создаёт локальный synthetic chat, фиксирует текущий набор targets,
//    отправляет первый prompt всем targets и показывает ответы в одном transcript.
//
// Новое для basic persona agents:
// если выбраны только basic personas и online есть basic controller,
// включённый "Общий virtual session" создаёт уже не browser-only session,
// а настоящую controller-managed group session через `agents.group.create...`.
//
// Поэтому теперь есть две реализации "группы":
// - чужие agents: browser-only fan-out, N отдельных prompt request-ов;
// - basic personas: controller создаёт real NATS group session agent.
const text = ref("");
const files = ref<File[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);
const sending = ref(false);
const virtualMode = ref(false);
const bridge = useBridge();

// Последний отчёт отправки показываем рядом с кнопкой.
// Это важно для группового prompt: пользователь должен сразу видеть,
// сколько агентов реально получили вопрос, а сколько были заняты и пропущены.
const lastReport = ref<{ ok: number; busy: number } | null>(null);
let reportTimer: ReturnType<typeof setTimeout> | null = null;

const selectedAgents = computed(() =>
  // Превращаем Set<instanceId> из stores/selection.ts в реальные DTO из discovery.
  // Если agent исчез, watch в selection.ts обычно уже уберёт id, но filter здесь
  // дополнительно защищает от race между discovery update и нажатием Send.
  agentsState.list.filter((a) => selectionState.ids.has(a.instanceId)),
);

const selectedCount = computed(() => selectedAgents.value.length);

const basicController = computed(() =>
  agentsState.list.find(
    (agent) => agent.agent === "basic" && agent.metadata?.["role"] === "controller",
  ) ?? null,
);

const allSelectedBasicPersonas = computed(
  () =>
    selectedAgents.value.length > 0 &&
    selectedAgents.value.every(
      (agent) => agent.agent === "basic" && agent.metadata?.["role"] === "persona",
    ),
);

const canCreateControllerGroup = computed(
  () => allSelectedBasicPersonas.value && basicController.value !== null,
);

const virtualModeLabel = computed(() =>
  canCreateControllerGroup.value ? "Controller group session" : "Общий virtual session",
);

const busyCount = computed(() => {
  // Agent считается busy, если у его chat session уже есть activePromptId.
  // Тогда не стартуем второй prompt параллельно в тот же instance.
  let n = 0;
  for (const a of selectedAgents.value) {
    if (getSession(a.instanceId).activePromptId !== null) n++;
  }
  return n;
});

const sendableCount = computed(() => selectedCount.value - busyCount.value);

// В обычном fan-out режиме нужен хотя бы один свободный target.
// В virtual session режиме выбранная группа фиксируется как отдельный чат,
// а занятые targets получают placeholder "(busy — skipped)".
// Поэтому создать virtual session можно даже если часть выбранных агентов занята.
const canSend = computed(() => {
  if (sending.value || text.value.trim().length === 0) return false;
  if (virtualMode.value) return selectedCount.value > 0;
  return sendableCount.value > 0;
});

function autoResize(): void {
  // textarea растёт до 200px и дальше скроллится внутри себя.
  // Это держит нижнюю панель компактной даже для длинного общего prompt-а.
  const el = textarea.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

watch(text, () => void nextTick(autoResize));

function onKey(e: KeyboardEvent): void {
  // Enter отправляет, Shift+Enter оставляет перенос строки.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

function pickFiles(): void {
  // Кнопка-иконка открывает скрытый file input.
  fileInput.value?.click();
}

function onFiles(e: Event): void {
  // Files копируем в reactive array, потому что FileList живёт внутри input
  // и его неудобно мутировать напрямую.
  const input = e.target as HTMLInputElement;
  if (!input.files) return;
  files.value = [...files.value, ...Array.from(input.files)];
  input.value = "";
}

function removeFile(i: number): void {
  files.value = files.value.filter((_, j) => j !== i);
}

const fileError = ref<string | null>(null);

async function send(): Promise<void> {
  // Главная функция панели:
  // 1. читает prompt/files;
  // 2. конвертирует attachments;
  // 3. выбирает режим fan-out или virtual session;
  // 4. показывает короткий отчёт "сколько отправлено / сколько занято".
  const t = text.value.trim();
  if (!t || sending.value) return;

  sending.value = true;
  fileError.value = null;

  let attachments: Awaited<ReturnType<typeof fileToAttachment>>[] | undefined;
  if (files.value.length > 0) {
    try {
      attachments = await Promise.all(files.value.map(fileToAttachment));
    } catch (e) {
      fileError.value = `failed to read file: ${(e as Error).message}`;
      sending.value = false;
      return;
    }
  }

  // Берём snapshot targets именно в момент отправки.
  // Если discovery обновится прямо во время цикла, отчёт всё равно будет
  // относиться к той группе, которую пользователь видел при нажатии Send.
  let okN = 0;
  let busyN = 0;

  if (virtualMode.value) {
    if (canCreateControllerGroup.value && basicController.value) {
      // Controller-managed group session:
      // 1. просим basic/control создать новый dynamic AgentService;
      // 2. bridge подтягивает его через discovery;
      // 3. открываем новую карточку и отправляем первый prompt уже в неё.
      //
      // Это главный сценарий "controller собирает общий контекст":
      // последующие сообщения пользователь будет писать в group session agent,
      // а его контекст будет храниться внутри controller process.
      try {
        const personas = selectedAgents.value.map(
          (agent) => agent.metadata?.["persona_id"] ?? agent.name,
        );
        const label = `Группа: ${selectedAgents.value
          .map((agent) => agent.metadata?.["persona_name"] ?? agent.name)
          .join(", ")}`;
        const descriptor = await bridge.basicGroupCreate(basicController.value.instanceId, {
          personas,
          label,
        });
        const discovered = await bridge.discover();
        const groupAgent = discovered.find((agent) => agent.instanceId === descriptor.instance_id);
        if (!groupAgent) {
          throw new Error(`group session ${descriptor.session_id} создана, но ещё не видна в discovery`);
        }
        selectAgent(groupAgent.instanceId);
        startPromptStream(groupAgent, t, attachments);
        okN = 1;
        busyN = 0;
      } catch (e) {
        fileError.value = `failed to create controller group: ${(e as Error).message}`;
        sending.value = false;
        return;
      }
      clearSelection();
      virtualMode.value = false;
    } else {
      // Fallback для любых не-basic agents: старый UI-only virtual session.
      // Backend не получает отдельный group request: под капотом это N отдельных
      // `bridge.prompt(instanceId, text)` вызовов, а UI просто собирает ответы
      // в один общий transcript.
      const targetIds = selectedAgents.value.map((a) => a.instanceId);
      const virtualId = createVirtualSession(targetIds);
      const report = startVirtualTurn(virtualId, t, attachments);
      okN = report.ok;
      busyN = report.busy;
      selectAgent(virtualId);
      // Сбрасываем галочки: дальше эта группа живёт как отдельная virtual session.
      clearSelection();
      // Возвращаем toggle в default, чтобы следующий выбор не создавал session случайно.
      virtualMode.value = false;
    }
  } else {
    // Простой режим: отправить prompt каждому выбранному agent-у отдельно.
    // Здесь нет общего transcript, поэтому сравнивать ответы надо открывая
    // чаты agents по одному.
    for (const agent of selectedAgents.value) {
      if (getSession(agent.instanceId).activePromptId !== null) {
        busyN++;
        continue;
      }
      startPromptStream(agent, t, attachments);
      okN++;
    }
  }

  if (reportTimer !== null) clearTimeout(reportTimer);
  lastReport.value = { ok: okN, busy: busyN };
  reportTimer = setTimeout(() => {
    lastReport.value = null;
    reportTimer = null;
  }, 5_000);

  text.value = "";
  files.value = [];
  sending.value = false;
}

// Esc очищает multi-selection.
// Это быстрый способ выйти из режима "галочки под агентами", не ломая chat state.
function onDocKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && selectionState.ids.size > 0) {
    clearSelection();
  }
}

onMounted(() => {
  document.addEventListener("keydown", onDocKey);
});
onUnmounted(() => {
  document.removeEventListener("keydown", onDocKey);
  if (reportTimer !== null) clearTimeout(reportTimer);
});
</script>

<template>
  <div class="bar" role="region" aria-label="Групповой prompt">
    <div class="bar-head">
      <span class="count mono">
        выбрано: <strong>{{ selectedCount }}</strong>
        <span v-if="busyCount > 0" class="busy-hint mono">
          · занято: {{ busyCount }}
        </span>
      </span>

      <span v-if="lastReport" class="report mono">
        отправлено {{ lastReport.ok }} из {{ lastReport.ok + lastReport.busy }}<template
          v-if="lastReport.busy > 0"> (занято: {{ lastReport.busy }})</template>
      </span>

      <span class="bar-spacer" />

      <!-- Если включено, Send создаёт persistent virtual session:
           фиксирует текущие галочки, отправляет первый prompt всем targets
           и переводит правую панель в общий transcript этой группы. -->
      <label
        class="virtual-toggle mono"
        :class="{ active: virtualMode }"
        :title="
          canCreateControllerGroup
            ? 'Создать настоящую group session через basic controller'
            : 'Создать общий browser-only virtual session для выбранных агентов'
        "
      >
        <input type="checkbox" v-model="virtualMode" />
        <span>{{ virtualModeLabel }}</span>
      </label>

      <button
        type="button"
        class="clear-btn"
        title="Очистить выбор (Esc)"
        @click="clearSelection"
      >×</button>
    </div>

    <div v-if="files.length" class="chips-row">
      <AttachmentChips :files="files" @remove="removeFile" />
    </div>
    <div v-if="fileError" class="warn mono">{{ fileError }}</div>

    <div class="row">
      <button
        type="button"
        class="attach-btn"
        title="Прикрепить файлы"
        @click="pickFiles"
      >📎</button>
      <input
        ref="fileInput"
        type="file"
        multiple
        style="display: none"
        @change="onFiles"
      />

      <textarea
        ref="textarea"
        v-model="text"
        class="textarea"
        rows="1"
        :placeholder="
          virtualMode
            ? canCreateControllerGroup
              ? `Prompt создаст controller group session для ${selectedCount} persona${selectedCount === 1 ? '' : 's'}`
              : `Prompt создаст virtual session для ${selectedCount} agent${selectedCount === 1 ? '' : 's'}`
            : sendableCount === 0
              ? 'Все выбранные агенты заняты — подожди или выбери других'
              : `Введите prompt — Enter отправит ${sendableCount} agent${sendableCount === 1 ? '' : 's'}`
        "
        @keydown="onKey"
      />

      <button
        type="button"
        class="btn send"
        :class="{ 'is-virtual': virtualMode }"
        :disabled="!canSend"
        @click="send"
      >
        <template v-if="virtualMode">Создать и отправить</template>
        <template v-else>Отправить: {{ sendableCount }}</template>
      </button>
    </div>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-sm) var(--space-md) var(--space-md);
  background: var(--bg-secondary);
  border-top: 1px solid color-mix(in srgb, var(--accent-primary) 35%, transparent);
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.35);
  flex-shrink: 0;
  /* Faint top accent to mark the bar as a layered overlay rather than a
     pane edge. The sibling `.grid-body` shrinks when this appears, which
     is the visible "make room for the bar" behaviour the user expects. */
}

.bar-head {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  font-size: var(--text-xs);
}
.count {
  color: var(--text-secondary);
  background: var(--accent-glow);
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--accent-primary) 35%, transparent);
}
.count strong {
  color: var(--accent-primary);
  font-weight: 700;
}
.busy-hint { color: var(--warning); }
.report {
  color: var(--text-muted);
  font-size: 11px;
}
.bar-spacer { flex: 1; }

.virtual-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  user-select: none;
  padding: 3px 8px;
  border-radius: var(--border-radius-sm);
  border: 1px solid transparent;
  transition: all var(--transition-fast);
}
.virtual-toggle:hover {
  color: var(--text-secondary);
}
.virtual-toggle.active {
  color: var(--bucket-virtual);
  background: color-mix(in srgb, var(--bucket-virtual) 10%, transparent);
  border-color: color-mix(in srgb, var(--bucket-virtual) 35%, transparent);
}
.virtual-toggle input { cursor: pointer; accent-color: var(--bucket-virtual); }

.clear-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 50%;
  background: transparent;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: all var(--transition-fast);
}
.clear-btn:hover {
  color: var(--error);
  border-color: var(--error);
  background: var(--error-dim);
}

.chips-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-sm);
}

.warn {
  font-size: var(--text-xs);
  color: var(--error);
  background: var(--error-dim);
  padding: 4px 8px;
  border-radius: var(--border-radius-sm);
}

.row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-sm);
}

.textarea {
  flex: 1;
  min-height: 38px;
  max-height: 200px;
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-primary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text-primary);
  resize: none;
  line-height: var(--leading-normal);
  overflow-y: auto;
}
.textarea:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.attach-btn {
  height: 38px;
  width: 38px;
  border: var(--border-subtle);
  background: var(--bg-primary);
  border-radius: var(--border-radius);
  color: var(--text-secondary);
  transition: all var(--transition-fast);
  font-size: 1.1em;
  cursor: pointer;
}
.attach-btn:hover {
  color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.btn {
  height: 38px;
  padding: 0 var(--space-lg);
  border-radius: var(--border-radius);
  font-size: var(--text-sm);
  font-weight: 600;
  transition: all var(--transition-fast);
  cursor: pointer;
}
.btn.send {
  background: var(--accent-gradient);
  color: white;
  border: none;
}
.btn.send:hover:not(:disabled) { filter: brightness(1.1); }
.btn.send:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.send.is-virtual {
  background: linear-gradient(135deg, var(--bucket-virtual), #c026d3);
}
</style>
