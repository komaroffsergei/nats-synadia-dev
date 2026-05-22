<script setup lang="ts">
import { computed } from "vue";
import AgentGroup from "./AgentGroup.vue";
import MultiSelectBar from "./MultiSelectBar.vue";
import VirtualSessionsSection from "./VirtualSessionsSection.vue";
import { agentsState, agentSections } from "../stores/agents.ts";
import { selectionState } from "../stores/selection.ts";
import { virtualSessionsList } from "../stores/virtualSessions.ts";

// Левая колонка приложения:
// - сверху живые agents из NATS discovery;
// - рядом UI-only virtual sessions, если пользователь создал групповую беседу;
// - снизу плавающая MultiSelectBar, когда есть отмеченные галочки.
const groups = computed(() => agentSections.value);
// Empty state показываем только когда нет ни реальных agents, ни virtual sessions.
// Если пользователь уже создал virtual session, но discovery временно пустой,
// UI всё равно должен оставить рабочую область и историю группы.
const isEmpty = computed(
  () => groups.value.length === 0 && virtualSessionsList.value.length === 0,
);
const hasSelection = computed(() => selectionState.ids.size > 0);
</script>

<template>
  <main class="grid-pane">
    <header class="grid-head">
      <div>
        <h1 class="grid-title">Synadia Agent Network</h1>
        <p class="grid-sub">
          Живой список agents из NATS. Открой карточку для чата или отметь несколько галочками для общего prompt.
        </p>
      </div>
    </header>

    <div class="grid-body">
      <div v-if="isEmpty && agentsState.discovering" class="placeholder mono">ищу agents…</div>
      <div v-else-if="isEmpty" class="placeholder">
        <h2>Agents не найдены</h2>
        <p>
          Запусти <code class="mono">npm run controller</code>, затем нажми Refresh.
          Должны появиться controller и persona agents: teacher, engineer, skeptic, manager.
        </p>
      </div>
      <div v-else class="groups">
        <!-- VirtualSessionsSection не приходит из NATS.
             Это локальные UI-чаты, которые агрегируют несколько real agents. -->
        <VirtualSessionsSection />
        <!-- agentSections уже разделил список на promptable agents и controllers.
             Здесь компонент просто рисует готовые секции. -->
        <AgentGroup
          v-for="g in groups"
          :key="g.id"
          :label="g.label"
          :agents="g.agents"
        />
      </div>
    </div>

    <Transition name="bar">
      <MultiSelectBar v-if="hasSelection" />
    </Transition>
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

    /* Панель группового prompt выезжает снизу только transform-анимацией.
       Так список не прыгает лишний раз: layout просто освобождает место,
       а сама панель плавно занимает уже появившуюся область. */
.bar-enter-active,
.bar-leave-active {
  transition: transform 0.22s ease, opacity 0.18s ease;
}
.bar-enter-from,
.bar-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
.bar-enter-to,
.bar-leave-from {
  transform: translateY(0);
  opacity: 1;
}
</style>
