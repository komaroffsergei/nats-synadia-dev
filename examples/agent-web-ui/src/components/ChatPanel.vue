<script setup lang="ts">
import { computed, ref } from "vue";
import MessageList from "./MessageList.vue";
import PromptArea from "./PromptArea.vue";
import { fileToAttachment, useBridge } from "../composables/useBridge.ts";
import { startPromptStream } from "../composables/promptStreaming.ts";
import { getSession, messagesFor, type Message } from "../stores/chat.ts";
import { bucketOf, BUCKETS } from "../stores/agents.ts";
import type { DiscoveredAgentDTO, PromptExtra } from "../wire.ts";

const props = defineProps<{ agent: DiscoveredAgentDTO }>();

const bridge = useBridge();
const error = ref<string | null>(null);

const tagLabel = computed<string>(() => {
  switch (bucketOf(props.agent)) {
    case BUCKETS.BASIC_CONTROL:
      return "BASIC CONTROL";
    case BUCKETS.BASIC_GROUP_SESSION:
      return "BASIC GROUP";
    case BUCKETS.BASIC_PERSONA:
      return "BASIC PERSONA";
    case BUCKETS.OPENCLAW:
      return "OPENCLAW";
    default:
      return props.agent.agent.toUpperCase();
  }
});

const tagColor = computed<string>(() => {
  switch (bucketOf(props.agent)) {
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

const displayName = computed(
  () =>
    props.agent.metadata?.["persona_name"] ??
    props.agent.metadata?.["group_label"] ??
    props.agent.session ??
    props.agent.name,
);

const currentMessages = computed(() => messagesFor(props.agent.instanceId));
const busy = computed(() => getSession(props.agent.instanceId).activePromptId !== null);
const attachmentsOk = computed(() => props.agent.promptEndpoint.attachmentsOk === true);
const maxPayloadBytes = computed(() => props.agent.promptEndpoint.maxPayloadBytes);
const promptAdapter = computed<"weather" | null>(() => {
  // Пока адаптер один: weather agent из соседнего Ruby сервиса. Проверяем
  // именно subject, чтобы не завязаться на UI bucket или отсутствующую metadata.
  if (props.agent.promptEndpoint.subject === "agents.prompt.weather.dev.h100") return "weather";
  return null;
});

async function onSubmit(text: string, files: File[], extra?: PromptExtra): Promise<void> {
  let attachments: Awaited<ReturnType<typeof fileToAttachment>>[] | undefined;
  if (files.length > 0) {
    try {
      attachments = await Promise.all(files.map(fileToAttachment));
    } catch (e) {
      error.value = `failed to read file: ${(e as Error).message}`;
      return;
    }
  }

  startPromptStream(props.agent, text, attachments, extra);
}

function onQueryReply(message: Message, answer: string): void {
  if (message.replied) return;
  if (!message.promptId || !message.queryId) return;
  bridge.queryReply(message.promptId, message.queryId, answer);
  message.replied = true;
  message.replyValue = answer;
}

function onStop(): void {
  const s = getSession(props.agent.instanceId);
  if (s.activePromptId) bridge.cancel(s.activePromptId);
}
</script>

<template>
  <section class="chat-pane" :style="{ '--tag-color': tagColor }">
    <header class="chat-head">
      <div class="chat-title">
        <span class="chat-agent mono">{{ tagLabel }}</span>
        <span class="chat-name">{{ displayName }}</span>
        <span class="chat-connection mono">{{ agent.connectionLabel }}</span>
        <span class="chat-owner mono">@{{ agent.owner }}</span>
      </div>
      <div class="chat-sub mono">{{ agent.promptEndpoint.subject }}</div>
    </header>
    <div v-if="error" class="error mono">{{ error }}</div>
    <MessageList :messages="currentMessages" @reply="onQueryReply" />
    <PromptArea
      :busy="busy"
      :disabled="false"
      :attachments-ok="attachmentsOk"
      :max-payload-bytes="maxPayloadBytes"
      :adapter="promptAdapter"
      @submit="onSubmit"
      @stop="onStop"
    />
  </section>
</template>

<style scoped>
.chat-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg-deep);
}
.chat-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-md) var(--space-lg);
  background: var(--bg-primary);
  border-bottom: var(--border-subtle);
  flex-shrink: 0;
}
.chat-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
}
.chat-agent {
  font-size: var(--text-xs);
  color: var(--tag-color, var(--accent-primary));
  background: color-mix(in srgb, var(--tag-color, var(--accent-primary)) 14%, transparent);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.chat-name {
  color: var(--text-primary);
  font-weight: 600;
}
.chat-owner {
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.chat-connection {
  color: var(--accent-primary);
  font-size: var(--text-xs);
  background: var(--accent-glow);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
}
.chat-sub {
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.error {
  padding: var(--space-sm) var(--space-lg);
  font-size: var(--text-xs);
  color: var(--error);
  background: var(--error-dim);
  border-bottom: 1px solid rgba(248, 113, 113, 0.3);
}
</style>
