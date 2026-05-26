<script setup lang="ts">
import { computed } from "vue";
import AgentStatusDot from "./AgentStatusDot.vue";
import type { DiscoveredAgentDTO } from "../wire.ts";
import { bucketOf, BUCKETS, type Bucket } from "../stores/agents.ts";

const props = defineProps<{
  agent: DiscoveredAgentDTO;
  selected: boolean;
}>();

defineEmits<{ select: [instanceId: string] }>();

const bucket = computed<Bucket>(() => bucketOf(props.agent));

const tagLabel = computed<string>(() => {
  if (bucket.value === BUCKETS.YOUTRACK) return "YOUTRACK";
  return props.agent.agent.toUpperCase();
});

const tagColor = computed<string>(() => {
  if (bucket.value === BUCKETS.YOUTRACK) return "var(--accent-primary)";
  return "var(--bucket-other)";
});

const subtitle = computed<string>(() => props.agent.session ?? props.agent.name);

const humanPayload = computed(() => {
  const n = props.agent.promptEndpoint.maxPayloadBytes;
  if (!n) return null;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
});

const role = computed(() => props.agent.metadata?.["role"] ?? null);
const mode = computed(() => props.agent.metadata?.["mode"] ?? null);
</script>

<template>
  <div class="card-wrap" :style="{ '--tag-color': tagColor }">
    <div
      class="card"
      :class="{ selected }"
      role="button"
      tabindex="0"
      @click="$emit('select', agent.instanceId)"
      @keydown.enter.prevent="$emit('select', agent.instanceId)"
      @keydown.space.prevent="$emit('select', agent.instanceId)"
    >
      <header class="card-head">
        <div class="head-tags">
          <span class="agent-tag mono">{{ tagLabel }}</span>
          <span v-if="role" class="role-badge mono">{{ role }}</span>
        </div>
        <AgentStatusDot class="status-led" :instance-id="agent.instanceId" />
      </header>

      <h3 class="card-title">{{ subtitle }}</h3>

      <div class="meta">
        <span class="badge connection mono">{{ agent.connectionLabel }}</span>
        <span class="owner mono">@{{ agent.owner }}</span>
        <span v-if="mode" class="badge mono">{{ mode }}</span>
      </div>

      <div class="grow-spacer" aria-hidden="true" />

      <p class="subject mono" :title="agent.promptEndpoint.subject">
        <span class="dim">›</span>{{ agent.promptEndpoint.subject }}
      </p>

      <div class="badges">
        <span v-if="humanPayload" class="badge">{{ humanPayload }}</span>
        <span v-if="agent.promptEndpoint.attachmentsOk" class="badge attachments-ok">attachments</span>
        <span v-if="agent.protocolVersion" class="badge subtle-badge">v{{ agent.protocolVersion }}</span>
      </div>
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
  min-height: 172px;
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
.status-led { flex-shrink: 0; }
.role-badge,
.agent-tag {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 2px 7px;
  border-radius: var(--border-radius-sm);
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.agent-tag {
  color: var(--tag-color, var(--accent-primary));
  background: color-mix(in srgb, var(--tag-color, var(--accent-primary)) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--tag-color, var(--accent-primary)) 28%, transparent);
}
.role-badge {
  color: var(--text-muted);
  border: var(--border-subtle);
}
.card-title {
  color: var(--text-primary);
  font-size: var(--text-lg);
  line-height: var(--leading-tight);
  margin: var(--space-xs) 0 0;
  overflow-wrap: anywhere;
}
.meta,
.badges {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-xs);
}
.owner {
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.badge {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 2px 7px;
  border-radius: var(--border-radius-sm);
  background: var(--bg-primary);
  border: var(--border-subtle);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 1;
}
.badge.connection {
  color: var(--accent-primary);
  background: var(--accent-glow);
  border-color: color-mix(in srgb, var(--accent-primary) 28%, transparent);
}
.attachments-ok {
  color: var(--success);
}
.subtle-badge {
  color: var(--text-muted);
}
.grow-spacer {
  flex: 1;
}
.subject {
  display: block;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.4;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subject .dim {
  color: var(--text-muted);
  margin-right: 4px;
}
</style>
