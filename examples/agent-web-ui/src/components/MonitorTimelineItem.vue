<script setup lang="ts">
import { computed } from 'vue';
import { displayParts } from '../../shared/monitor-display';

const props = defineProps<{ item: any; activity?: string }>();
const parts = computed(() => displayParts(props.item));
const contextOnly = computed(() => parts.value.some(p => p.context) && parts.value.every(p => p.context || !p.text.trim()));
const label = computed(() => contextOnly.value ? 'Служебный контекст' : props.item.role === 'user' ? 'Поручение'
  : props.activity === 'title_generation' && props.item.role === 'assistant' ? 'Результат служебного запроса'
  : ({ reasoning: 'Размышления', message: 'Ответ', tool_call: 'Вызов инструмента', tool_result: 'Результат инструмента' }[props.item.kind as string] || props.item.kind));
</script>

<template>
  <details :class="['timeline-item', item.kind, { 'service-context': contextOnly }]" :open="!contextOnly">
    <summary><span class="item-symbol">{{contextOnly ? '≡' : item.kind === 'reasoning' ? '✦' : item.kind.startsWith('tool') ? '⌘' : '↗'}}</span><strong>{{label}}</strong><span v-if="item.name" class="mono tool-name">{{item.name}}</span><span v-if="contextOnly" class="context-hint">раскрыть текст</span><time>{{item.at ? new Date(item.at).toLocaleTimeString('ru-RU') : '—'}}</time></summary>
    <div class="item-body">
      <pre v-if="contextOnly">{{item.text}}</pre>
      <template v-else v-for="(part, index) in parts" :key="index">
        <details v-if="part.context" class="embedded-context"><summary>Служебный контекст <span class="context-hint">раскрыть текст</span></summary><pre>{{part.text}}</pre></details>
        <pre v-else>{{part.text}}</pre>
      </template>
      <span v-if="!item.complete" class="streaming-label">● Поступает текст</span>
      <p v-if="item.truncated" class="notice">Текст неполный: достигнут предел хранения элемента.</p>
    </div>
  </details>
</template>

<style scoped>
.timeline-item{border:var(--border-light);border-radius:8px;background:var(--bg-secondary);border-left:3px solid var(--accent-primary);min-width:0}
.timeline-item.reasoning{border-left-color:#a78bfa}.timeline-item.tool_call,.timeline-item.tool_result{border-left-color:#67e8f9}.timeline-item.service-context{border-left-color:var(--text-muted)}
summary{padding:12px 16px;display:flex;align-items:center;gap:9px;cursor:pointer;font-size:12px;list-style:none;flex-wrap:wrap}summary::after{content:'⌄';color:var(--text-muted)}summary:focus-visible{outline:2px solid var(--accent-primary);outline-offset:2px;border-radius:4px}
time{margin-left:auto;font:10px var(--font-mono);color:var(--text-muted)}.item-symbol{color:var(--accent-primary)}.item-body{padding:0 16px 16px}
pre{background:none;padding:0;font:12px/1.75 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;color:var(--text-secondary);overflow:visible}
.tool-name{color:var(--info);font-size:10px;overflow-wrap:anywhere}.context-hint{font-size:10px;color:var(--text-muted)}details[open]>summary>.context-hint{display:none}
.embedded-context{margin:8px 0 14px;border:var(--border-light);border-radius:6px}.embedded-context pre{padding:0 12px 12px}.embedded-context summary{padding:10px 12px;color:var(--text-secondary)}
.streaming-label{font-size:10px;color:var(--success)}.notice{padding:12px 16px;border:1px solid #fbbf2433;background:var(--warning-dim);color:var(--warning);font-size:12px;border-radius:6px;margin-top:14px}
</style>
