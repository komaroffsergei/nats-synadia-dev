<script setup lang="ts">
import { selectedAgent } from "../stores/agents.ts";
import ChatPanel from "./ChatPanel.vue";
</script>

<template>
  <aside class="right-panel">
    <div v-if="!selectedAgent" class="empty">
      <div class="empty-inner">
        <h2>Выбери agent</h2>
        <p>
          Открой карточку для обычного чата или отметь несколько BASIC PERSONA,
          чтобы controller создал group session.
        </p>
      </div>
    </div>

    <ChatPanel v-else :agent="selectedAgent" />
  </aside>
</template>

<style scoped>
.right-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-primary);
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-2xl);
}
.empty-inner {
  max-width: 360px;
  text-align: center;
  color: var(--text-muted);
}
.empty-inner h2 {
  color: var(--text-secondary);
  margin-bottom: var(--space-md);
}
.empty-inner p {
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
}
</style>
