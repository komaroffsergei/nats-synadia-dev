import { computed, reactive, watch } from "vue";
import { agentsState } from "./agents.ts";

/**
 * Multi-select state for the agent grid.
 *
 * По-русски: это ровно те самые "галочки под каждым агентом".
 *
 * Здесь НЕ хранится prompt text и НЕ создаётся общий backend context.
 * Здесь только Set<instanceId> карточек, которые пользователь отметил.
 * Дальше MultiSelectBar берёт этот Set и решает:
 * - либо отправить prompt каждому выбранному agent отдельно;
 * - либо создать UI-only virtual session и вести общий transcript группы.
 *
 * Orthogonal to `agentsState.selectedInstanceId` (which drives the right
 * panel — what's "open in chat"). The two interactions don't share state,
 * so a user can keep one chat open while ticking other cards for fan-out.
 */
export const selectionState = reactive({
  // Set удобен для галочек:
  // - add/delete O(1);
  // - порядок нам не важен;
  // - один agent нельзя выбрать дважды.
  ids: new Set<string>(),
});

export const selectedCount = computed(() => selectionState.ids.size);

export function isSelected(instanceId: string): boolean {
  // Helper для шаблонов/компонентов, где не хочется светить Set напрямую.
  return selectionState.ids.has(instanceId);
}

export function toggleSelection(instanceId: string): void {
  // Нажатие на кружок в AgentCard приходит сюда.
  // Важно: это не открывает чат справа, потому что AgentCard останавливает
  // propagation click-а на checkbox-кнопке.
  if (selectionState.ids.has(instanceId)) {
    selectionState.ids.delete(instanceId);
  } else {
    selectionState.ids.add(instanceId);
  }
}

export function clearSelection(): void {
  // Сброс режима выбора: кнопка ×, Esc, либо создание virtual session.
  selectionState.ids.clear();
}

// Drop selections for agents that vanished from discovery.
//
// Русская версия:
// если agent умер/перезапустился, его instanceId больше нет в свежем списке.
// Оставлять такую галочку нельзя: пользователь нажмёт Send, а target уже offline.
//
// Watch стоит на ссылке agentsState.list. Все mutator-ы в agents.ts заменяют
// массив целиком, поэтому watch срабатывает на Refresh/add/remove, но не шумит
// на каждое изменение полей внутри карточки.
watch(
  () => agentsState.list,
  () => {
    const present = new Set(agentsState.list.map((a) => a.instanceId));
    for (const id of [...selectionState.ids]) {
      if (!present.has(id)) selectionState.ids.delete(id);
    }
  },
);
