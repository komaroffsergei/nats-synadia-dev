<script setup lang="ts">
import { computed } from "vue";
import AgentGroup from "./AgentGroup.vue";
import { agentsState, agentSections } from "../stores/agents.ts";

const groups = computed(() => agentSections.value);
const isEmpty = computed(() => groups.value.length === 0);
</script>

<template>
  <main class="grid-pane">
    <header class="grid-head">
      <div>
        <h1 class="grid-title">Synadia NATS Agents</h1>
        <p class="grid-sub">
          YouTrack gateway agent, chat stream и NATS discovery.
        </p>
      </div>
    </header>

    <div class="grid-body">
      <div v-if="isEmpty && agentsState.discovering" class="placeholder mono">ищу agents…</div>
      <div v-else-if="isEmpty" class="placeholder">
        <h2>Agents не найдены</h2>
        <p>
          Запусти <code class="mono">npm run gateway</code>, затем нажми Refresh.
        </p>
      </div>
      <div v-else class="groups">
        <AgentGroup
          v-for="g in groups"
          :key="g.id"
          :label="g.label"
          :agents="g.agents"
        />
      </div>
    </div>
  </main>
</template>

<style scoped>
.grid-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-primary);
  border-right: var(--border-subtle);
}
.grid-head {
  padding: var(--space-lg) var(--space-xl) var(--space-md);
  border-bottom: var(--border-subtle);
  flex-shrink: 0;
}
.grid-title {
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}
.grid-sub {
  font-size: var(--text-sm);
  color: var(--text-muted);
  margin: 4px 0 0;
}
.grid-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-lg) var(--space-xl);
}
.groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-2xl);
}
.placeholder {
  padding: var(--space-2xl);
  text-align: center;
  color: var(--text-muted);
}
.placeholder h2 {
  color: var(--text-secondary);
  margin-bottom: var(--space-md);
}
.placeholder p {
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  max-width: 480px;
  margin: 0 auto;
}
.placeholder code {
  color: var(--accent-primary);
  background: transparent;
  padding: 0;
}

</style>
