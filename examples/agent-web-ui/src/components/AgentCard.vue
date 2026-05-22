<script setup lang="ts">
import { computed, ref } from "vue";
import AgentStatusDot from "./AgentStatusDot.vue";
import type { DiscoveredAgentDTO } from "../wire.ts";
import { basicControllerForConnection, bucketOf, BUCKETS, removeAgent, type Bucket } from "../stores/agents.ts";
import { clearSession } from "../stores/chat.ts";
import { selectionState, toggleSelection } from "../stores/selection.ts";
import { useBridge } from "../composables/useBridge.ts";

const props = defineProps<{
  agent: DiscoveredAgentDTO;
  selected: boolean;
}>();

defineEmits<{ select: [instanceId: string] }>();

const bridge = useBridge();
const stoppingGroup = ref(false);
const stopError = ref<string | null>(null);

const bucket = computed<Bucket>(() => bucketOf(props.agent));

const isController = computed(() => bucket.value === BUCKETS.BASIC_CONTROL);
const isBasicPersona = computed(() => bucket.value === BUCKETS.BASIC_PERSONA);
const isBasicGroupSession = computed(() => bucket.value === BUCKETS.BASIC_GROUP_SESSION);

const tagLabel = computed<string>(() => {
  switch (bucket.value) {
    case BUCKETS.BASIC_CONTROL:
      return "BASIC CONTROL";
    case BUCKETS.BASIC_PERSONA:
      return "BASIC PERSONA";
    case BUCKETS.BASIC_GROUP_SESSION:
      return "BASIC GROUP";
    case BUCKETS.OPENCLAW:
      return "OPENCLAW";
    default:
      return props.agent.agent.toUpperCase();
  }
});

const tagColor = computed<string>(() => {
  switch (bucket.value) {
    case BUCKETS.BASIC_PERSONA:
      return "var(--accent-primary)";
    case BUCKETS.BASIC_GROUP_SESSION:
      return "var(--bucket-virtual)";
    case BUCKETS.BASIC_CONTROL:
      return "var(--bucket-headless)";
    case BUCKETS.OPENCLAW:
      return "var(--bucket-openclaw)";
    default:
      return "var(--bucket-other)";
  }
});

const subtitle = computed<string>(() => {
  if (isBasicPersona.value) return props.agent.metadata?.["persona_name"] ?? props.agent.name;
  if (isBasicGroupSession.value) return props.agent.metadata?.["group_label"] ?? props.agent.session ?? props.agent.name;
  return props.agent.session ?? props.agent.name;
});

const humanPayload = computed(() => {
  const n = props.agent.promptEndpoint.maxPayloadBytes;
  if (!n) return null;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
});

const model = computed(() => props.agent.metadata?.["model"] ?? null);
const targetPersonas = computed(() => props.agent.metadata?.["target_personas"] ?? null);
const groupStopId = computed(() => props.agent.metadata?.["group_id"] ?? props.agent.name);

const multiSelectable = computed(() => isBasicPersona.value);
const isMultiSelected = computed(() => selectionState.ids.has(props.agent.instanceId));

function onToggleSelect(e: Event): void {
  e.stopPropagation();
  toggleSelection(props.agent.instanceId);
}

async function onStopGroup(e: Event): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  if (!isBasicGroupSession.value || stoppingGroup.value) return;

  // UI не знает NATS subject `group.stop` напрямую. Он просит найденный
  // BASIC CONTROL сделать stop, а Bun bridge уже отправляет NATS request.
  const controller = basicControllerForConnection(props.agent.connectionId);
  if (!controller) {
    stopError.value = "BASIC CONTROL не найден";
    return;
  }

  const groupId = groupStopId.value.trim();
  if (!groupId) {
    stopError.value = "у group session нет group_id/name";
    return;
  }

  stoppingGroup.value = true;
  stopError.value = null;
  try {
    await bridge.basicGroupStop(controller.instanceId, groupId);

    // Bridge обычно сам пришлёт `agent-removed`, но локальная очистка делает
    // поведение мгновенным и безопасным, если событие уже было обработано.
    clearSession(props.agent.instanceId);
    removeAgent(props.agent.instanceId);
  } catch (err) {
    stopError.value = (err as Error).message;
  } finally {
    stoppingGroup.value = false;
  }
}
</script>

<template>
  <div class="card-wrap" :style="{ '--tag-color': tagColor }">
    <div
      class="card"
      :class="{
        selected,
        'is-controller': isController,
        'is-group': isBasicGroupSession,
        'is-multi-selected': isMultiSelected,
      }"
      role="button"
      tabindex="0"
      @click="$emit('select', agent.instanceId)"
      @keydown.enter.prevent="$emit('select', agent.instanceId)"
      @keydown.space.prevent="$emit('select', agent.instanceId)"
    >
      <header class="card-head">
        <button
          v-if="multiSelectable"
          type="button"
          class="select-circle"
          :class="{ active: isMultiSelected }"
          role="checkbox"
          :aria-checked="isMultiSelected ? 'true' : 'false'"
          :title="isMultiSelected ? 'Убрать из group prompt' : 'Добавить в group prompt'"
          @click="onToggleSelect"
        >
          <svg
            v-if="isMultiSelected"
            class="check"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          ><polyline points="20 6 9 17 4 12" /></svg>
        </button>
        <div class="head-tags">
          <span class="agent-tag mono">{{ tagLabel }}</span>
          <span v-if="isController" class="role-badge mono">CONTROLLER</span>
        </div>
        <div class="head-actions">
          <button
            v-if="isBasicGroupSession"
            type="button"
            class="stop-group-btn"
            :class="{ busy: stoppingGroup }"
            :disabled="stoppingGroup"
            title="Удалить group session"
            aria-label="Удалить group session"
            @click="onStopGroup"
            @keydown.stop
          >
            <span v-if="stoppingGroup" class="mono">...</span>
            <span v-else aria-hidden="true">×</span>
          </button>
          <AgentStatusDot class="status-led" :instance-id="agent.instanceId" />
        </div>
      </header>

      <h3 class="card-title">{{ subtitle }}</h3>

      <div class="meta">
        <span class="badge connection mono">{{ agent.connectionLabel }}</span>
        <span class="owner mono">@{{ agent.owner }}</span>
        <span v-if="model" class="badge mono">{{ model }}</span>
        <span v-if="targetPersonas" class="badge mono">{{ targetPersonas }}</span>
      </div>

      <div class="grow-spacer" aria-hidden="true" />

      <p class="subject mono" :title="agent.promptEndpoint.subject">
        <span class="dim">›</span>{{ agent.promptEndpoint.subject }}
      </p>

      <div class="badges">
        <span v-if="humanPayload && !isController" class="badge">{{ humanPayload }}</span>
        <span v-if="agent.promptEndpoint.attachmentsOk" class="badge attachments-ok">attachments</span>
        <span v-if="agent.protocolVersion" class="badge subtle-badge">v{{ agent.protocolVersion }}</span>
      </div>

      <p v-if="isController" class="hint">создаёт group sessions</p>
      <p v-else-if="isBasicGroupSession" class="hint">хранит общий контекст группы</p>
      <p v-if="stopError" class="stop-error mono">{{ stopError }}</p>
    </div>
  </div>
</template>

<style scoped>
.card-wrap {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
}
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  flex: 1;
  padding: var(--space-md);
  background: var(--bg-secondary);
  border: 1px solid color-mix(in srgb, var(--tag-color, var(--text-muted)) 22%, transparent);
  border-radius: var(--border-radius);
  text-align: left;
  transition: all var(--transition-normal);
  cursor: pointer;
  width: 100%;
  overflow: hidden;
}
.card:hover {
  background: var(--bg-tertiary);
  border-color: color-mix(in srgb, var(--tag-color, var(--text-muted)) 45%, transparent);
  transform: translateY(-1px);
}
.card:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}
.card.selected {
  border-color: var(--accent-primary);
  background: linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary));
  box-shadow: var(--shadow-glow);
}
.card.is-controller {
  background: linear-gradient(180deg, var(--bg-secondary) 0%, rgba(167, 139, 250, 0.05) 100%);
}
.card.is-group {
  background: linear-gradient(180deg, var(--bg-secondary) 0%, color-mix(in srgb, var(--bucket-virtual) 7%, transparent) 100%);
}
.card.is-multi-selected {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--accent-primary) 55%, transparent),
    0 0 14px var(--accent-glow);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}
.head-tags {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  min-width: 0;
  flex-wrap: wrap;
}
.head-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  flex-shrink: 0;
}
.status-led { flex-shrink: 0; }

.stop-group-btn {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--error) 38%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--error) 9%, transparent);
  color: var(--error);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  transition: all var(--transition-fast);
}
.stop-group-btn:hover:not(:disabled),
.stop-group-btn:focus-visible {
  border-color: var(--error);
  background: color-mix(in srgb, var(--error) 18%, transparent);
  outline: none;
}
.stop-group-btn:disabled {
  cursor: wait;
  opacity: 0.75;
}
.stop-group-btn.busy {
  font-size: var(--text-xs);
}

.select-circle {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--text-dim) 80%, transparent);
  background: var(--bg-primary);
  color: white;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: all var(--transition-fast);
  position: relative;
  z-index: 2;
}
.card-wrap:hover .select-circle,
.select-circle.active,
.select-circle:focus-visible {
  opacity: 1;
}
.select-circle:hover,
.select-circle.active {
  border-color: var(--accent-primary);
  background: var(--accent-primary);
}
.select-circle .check {
  width: 12px;
  height: 12px;
  display: block;
}
.role-badge {
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
  color: var(--memory-preference);
  border: 1px solid color-mix(in srgb, var(--memory-preference) 45%, transparent);
  white-space: nowrap;
}
.agent-tag {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--tag-color, var(--accent-primary));
  background: color-mix(in srgb, var(--tag-color, var(--accent-primary)) 14%, transparent);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
}
.card-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--text-xs);
  color: var(--text-muted);
  flex-wrap: wrap;
}
.owner { color: var(--text-secondary); }
.grow-spacer {
  flex: 1;
  min-height: 0;
}
.subject {
  font-size: 11px;
  color: var(--text-dim);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.subject .dim {
  color: var(--accent-primary);
  opacity: 0.6;
  margin-right: 4px;
}
.badges {
  display: flex;
  gap: var(--space-xs);
  flex-wrap: wrap;
  padding-right: var(--space-md);
}
.badge {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
}
.attachments-ok {
  color: var(--success);
  background: var(--success-dim);
}
.subtle-badge {
  color: var(--text-dim);
}
.hint {
  font-size: 10px;
  color: var(--text-dim);
  margin: var(--space-xs) 0 0;
  font-style: italic;
}
.stop-error {
  margin: var(--space-xs) 0 0;
  color: var(--error);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
</style>
