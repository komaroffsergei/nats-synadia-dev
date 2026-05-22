<script setup lang="ts">
import { ref, watch } from "vue";
import ConnectionBar from "./components/ConnectionBar.vue";
import AgentGrid from "./components/AgentGrid.vue";
import RightPanel from "./components/RightPanel.vue";
import { bridgeState } from "./stores/bridge.ts";
import { agentsState } from "./stores/agents.ts";
import { useBridge } from "./composables/useBridge.ts";

const bridge = useBridge();
const error = ref<string | null>(null);

async function refreshAgents(): Promise<void> {
  if (agentsState.discovering) return;
  agentsState.discovering = true;
  error.value = null;
  try {
    await bridge.discover();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    agentsState.discovering = false;
  }
}

watch(
  () => bridgeState.status,
  (newStatus, oldStatus) => {
    if (newStatus === "open" && oldStatus !== "open") {
      void refreshAgents();
    }
  },
  { immediate: true },
);
</script>

<template>
  <ConnectionBar @refresh="refreshAgents" />
  <div v-if="error" class="global-error mono">{{ error }}</div>
  <main class="shell">
    <AgentGrid />
    <RightPanel />
  </main>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 480px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.global-error {
  padding: var(--space-sm) var(--space-lg);
  font-size: var(--text-xs);
  color: var(--error);
  background: var(--error-dim);
  border-bottom: 1px solid rgba(248, 113, 113, 0.3);
}

@media (max-width: 1100px) {
  .shell {
    grid-template-columns: minmax(0, 1fr) 380px;
  }
}
</style>
