<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import AttachmentChips from "./AttachmentChips.vue";
import { agentsState, basicControllerForConnection, selectAgent } from "../stores/agents.ts";
import { clearSelection, selectionState } from "../stores/selection.ts";
import { getSession } from "../stores/chat.ts";
import { fileToAttachment, useBridge } from "../composables/useBridge.ts";
import { startPromptStream } from "../composables/promptStreaming.ts";

const text = ref("");
const files = ref<File[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);
const sending = ref(false);
const createGroup = ref(true);
const fileError = ref<string | null>(null);
const lastReport = ref<{ ok: number; busy: number } | null>(null);
let reportTimer: ReturnType<typeof setTimeout> | null = null;

const bridge = useBridge();

const selectedAgents = computed(() =>
  agentsState.list.filter((a) => selectionState.ids.has(a.instanceId)),
);

const selectedCount = computed(() => selectedAgents.value.length);

const allSelectedBasicPersonas = computed(
  () =>
    selectedAgents.value.length > 0 &&
    selectedAgents.value.every(
      (agent) => agent.agent === "basic" && agent.metadata?.["role"] === "persona",
    ),
);

const selectedConnectionId = computed(() => selectedAgents.value[0]?.connectionId ?? null);

const allSelectedSameConnection = computed(
  () =>
    selectedAgents.value.length > 0 &&
    selectedAgents.value.every((agent) => agent.connectionId === selectedConnectionId.value),
);

const selectedBasicController = computed(() =>
  selectedConnectionId.value ? basicControllerForConnection(selectedConnectionId.value) : null,
);

const canCreateControllerGroup = computed(
  () =>
    createGroup.value &&
    allSelectedBasicPersonas.value &&
    allSelectedSameConnection.value &&
    selectedBasicController.value !== null,
);

const busyCount = computed(() => {
  let n = 0;
  for (const a of selectedAgents.value) {
    if (getSession(a.instanceId).activePromptId !== null) n++;
  }
  return n;
});

const sendableCount = computed(() => selectedCount.value - busyCount.value);

const canSend = computed(() => {
  if (sending.value || text.value.trim().length === 0) return false;
  if (createGroup.value) return canCreateControllerGroup.value;
  return sendableCount.value > 0;
});

function autoResize(): void {
  const el = textarea.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

watch(text, () => void nextTick(autoResize));

function onKey(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

function pickFiles(): void {
  fileInput.value?.click();
}

function onFiles(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (!input.files) return;
  files.value = [...files.value, ...Array.from(input.files)];
  input.value = "";
}

function removeFile(i: number): void {
  files.value = files.value.filter((_, j) => j !== i);
}

async function send(): Promise<void> {
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

  let okN = 0;
  let busyN = 0;

  if (canCreateControllerGroup.value && selectedBasicController.value) {
    try {
      const personas = selectedAgents.value.map((agent) => agent.metadata?.["persona_id"] ?? agent.name);
      const label = `Группа: ${selectedAgents.value
        .map((agent) => agent.metadata?.["persona_name"] ?? agent.name)
        .join(", ")}`;
      const descriptor = await bridge.basicGroupCreate(selectedBasicController.value.instanceId, { personas, label });
      const discovered = await bridge.discover();
      const groupAgent = discovered.find((agent) => agent.instanceId === descriptor.instance_id);
      if (!groupAgent) {
        throw new Error(`group session ${descriptor.session_id} создана, но ещё не видна в discovery`);
      }
      selectAgent(groupAgent.instanceId);
      startPromptStream(groupAgent, t, attachments);
      okN = 1;
    } catch (e) {
      fileError.value = `failed to create controller group: ${(e as Error).message}`;
      sending.value = false;
      return;
    }
    clearSelection();
  } else {
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

function onDocKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && selectionState.ids.size > 0) {
    clearSelection();
  }
}

onMounted(() => document.addEventListener("keydown", onDocKey));
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
        <span v-if="busyCount > 0" class="busy-hint mono"> · занято: {{ busyCount }}</span>
      </span>

      <span v-if="lastReport" class="report mono">
        отправлено {{ lastReport.ok }} из {{ lastReport.ok + lastReport.busy }}
        <template v-if="lastReport.busy > 0"> (занято: {{ lastReport.busy }})</template>
      </span>

      <span class="bar-spacer" />

      <label
        class="group-toggle mono"
        :class="{ active: createGroup }"
        :title="
          allSelectedBasicPersonas
            ? 'Создать настоящую group session через basic controller'
            : 'Controller group доступен только для BASIC PERSONA'
        "
      >
        <input type="checkbox" v-model="createGroup" />
        <span>Controller group session</span>
      </label>

      <button type="button" class="clear-btn" title="Очистить выбор (Esc)" @click="clearSelection">×</button>
    </div>

    <div v-if="files.length" class="chips-row">
      <AttachmentChips :files="files" @remove="removeFile" />
    </div>
    <div v-if="fileError" class="warn mono">{{ fileError }}</div>

    <div class="row">
      <button type="button" class="attach-btn" title="Прикрепить файлы" @click="pickFiles">📎</button>
      <input ref="fileInput" type="file" multiple style="display: none" @change="onFiles" />

      <textarea
        ref="textarea"
        v-model="text"
        class="textarea"
        rows="1"
        :placeholder="
          createGroup
            ? canCreateControllerGroup
              ? `Prompt создаст controller group session для ${selectedCount} persona`
              : 'Выбери BASIC PERSONA и дождись basic controller'
            : sendableCount === 0
              ? 'Все выбранные agents заняты'
              : `Введите prompt — Enter отправит ${sendableCount} agent`
        "
        @keydown="onKey"
      />

      <button
        type="button"
        class="btn send"
        :class="{ 'is-group': createGroup }"
        :disabled="!canSend"
        @click="send"
      >
        <template v-if="createGroup">Создать группу</template>
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

.group-toggle {
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
}
.group-toggle.active {
  color: var(--bucket-virtual);
  background: color-mix(in srgb, var(--bucket-virtual) 10%, transparent);
  border-color: color-mix(in srgb, var(--bucket-virtual) 35%, transparent);
}
.group-toggle input {
  cursor: pointer;
  accent-color: var(--bucket-virtual);
}

.clear-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--border-radius-sm);
  border: var(--border-subtle);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.clear-btn:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.chips-row { padding: 2px 0; }
.warn {
  color: var(--warning);
  font-size: var(--text-xs);
}
.row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-sm);
}
.attach-btn {
  width: 34px;
  height: 34px;
  border-radius: var(--border-radius-sm);
  border: var(--border-subtle);
  background: var(--bg-primary);
  color: var(--text-muted);
  cursor: pointer;
}
.textarea {
  flex: 1;
  min-height: 34px;
  max-height: 200px;
  resize: none;
  overflow-y: auto;
  border-radius: var(--border-radius-sm);
  border: var(--border-subtle);
  background: var(--bg-primary);
  color: var(--text-primary);
  padding: 8px var(--space-sm);
  font: inherit;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.textarea:focus {
  outline: 1px solid var(--accent-primary);
  outline-offset: 1px;
}
.btn.send {
  min-width: 132px;
  height: 34px;
  padding: 0 var(--space-md);
  border-radius: var(--border-radius-sm);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 40%, transparent);
  background: var(--accent-primary);
  color: white;
  font-size: var(--text-xs);
  font-weight: 700;
  cursor: pointer;
}
.btn.send.is-group {
  background: var(--bucket-virtual);
  border-color: color-mix(in srgb, var(--bucket-virtual) 40%, transparent);
}
.btn.send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
