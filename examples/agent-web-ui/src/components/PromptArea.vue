<script setup lang="ts">
import { ref, watch, nextTick, computed } from "vue";
import AttachmentChips from "./AttachmentChips.vue";
import type { PromptExtra } from "../wire.ts";

type AdapterKind = "weather";

type WeatherExample = {
  label: string;
  prompt: string;
  lat: string;
  lon: string;
};

const WEATHER_EXAMPLES: WeatherExample[] = [
  {
    label: "Йошкар-Ола",
    prompt: "Как погода в Йошкар-Оле сейчас? Кратко: температура, осадки, облачность.",
    lat: "56.6328",
    lon: "47.8951",
  },
  {
    label: "Омск",
    prompt: "Проверь текущую погоду и риск осадков рядом с точкой.",
    lat: "54.9885",
    lon: "73.3242",
  },
  {
    label: "Сводка",
    prompt: "Дай короткую погодную сводку: температура, влажность, давление, осадки.",
    lat: "56.6328",
    lon: "47.8951",
  },
];

const props = defineProps<{
  busy: boolean;
  disabled: boolean;
  attachmentsOk: boolean;
  maxPayloadBytes?: number | undefined;
  adapter?: AdapterKind | null;
}>();

const emit = defineEmits<{
  submit: [text: string, files: File[], extra?: PromptExtra];
  stop: [];
}>();

const text = ref("");
const files = ref<File[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);
const weatherLat = ref("56.6328");
const weatherLon = ref("47.8951");
const adapterError = ref<string | null>(null);

const isWeatherAdapter = computed(() => props.adapter === "weather");

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
    void submit();
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

function submit(): void {
  const t = text.value.trim();
  if (!t || props.busy || props.disabled) return;
  const extra = buildAdapterExtra();
  if (adapterError.value) return;
  emit("submit", t, [...files.value], extra);
  text.value = "";
  files.value = [];
  void nextTick(autoResize);
}

function stop(): void {
  emit("stop");
}

function applyWeatherExample(example: WeatherExample): void {
  // Пример одновременно заполняет prompt и координаты. Пользователь видит
  // обычный текст, а bridge отправит lat/lon отдельными JSON fields envelope-а.
  text.value = example.prompt;
  weatherLat.value = example.lat;
  weatherLon.value = example.lon;
  adapterError.value = null;
  void nextTick(() => {
    autoResize();
    textarea.value?.focus();
  });
}

function buildAdapterExtra(): PromptExtra | undefined {
  if (!isWeatherAdapter.value) return undefined;

  const lat = Number(weatherLat.value.trim());
  const lon = Number(weatherLon.value.trim());
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    adapterError.value = "lat должен быть числом от -90 до 90";
    return undefined;
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    adapterError.value = "lon должен быть числом от -180 до 180";
    return undefined;
  }

  adapterError.value = null;
  return { lat, lon };
}

const payloadHint = computed(() => {
  if (!files.value.length) return null;
  const total = files.value.reduce((acc, f) => acc + f.size, 0);
  // rough overhead for base64 + JSON envelope
  const est = Math.ceil(total * 1.37) + 256;
  if (est >= 1024 * 1024) return `~${(est / (1024 * 1024)).toFixed(2)} MB`;
  if (est >= 1024) return `~${(est / 1024).toFixed(1)} KB`;
  return `~${est} B`;
});

const overLimit = computed(() => {
  if (!props.maxPayloadBytes || !files.value.length) return false;
  const total = files.value.reduce((acc, f) => acc + f.size, 0);
  return Math.ceil(total * 1.37) + 256 > props.maxPayloadBytes;
});
</script>

<template>
  <div class="wrap" :class="{ disabled }">
    <div v-if="isWeatherAdapter" class="adapter weather-adapter">
      <div class="adapter-fields">
        <label class="coord-field">
          <span class="mono">lat</span>
          <input
            v-model="weatherLat"
            class="coord-input mono"
            inputmode="decimal"
            :disabled="disabled || busy"
          />
        </label>
        <label class="coord-field">
          <span class="mono">lon</span>
          <input
            v-model="weatherLon"
            class="coord-input mono"
            inputmode="decimal"
            :disabled="disabled || busy"
          />
        </label>
      </div>
      <div class="example-row">
        <button
          v-for="example in WEATHER_EXAMPLES"
          :key="example.label"
          type="button"
          class="example-btn"
          :disabled="disabled || busy"
          @click="applyWeatherExample(example)"
        >{{ example.label }}</button>
      </div>
      <div v-if="adapterError" class="warn mono">{{ adapterError }}</div>
    </div>

    <div v-if="files.length" class="chips-row">
      <AttachmentChips :files="files" @remove="removeFile" />
      <span
        v-if="payloadHint"
        class="payload-hint mono"
        :class="{ 'over-limit': overLimit }"
      >
        envelope {{ payloadHint }}
        <template v-if="overLimit"> — exceeds agent's max_payload</template>
      </span>
    </div>

    <div v-if="files.length > 0 && !attachmentsOk" class="warn mono">
      agent declared attachments_ok = false; send will be rejected locally by the SDK
    </div>

    <div class="row">
      <button
        type="button"
        class="attach-btn"
        :disabled="disabled || !attachmentsOk"
        :title="attachmentsOk ? 'Attach files' : 'Agent does not accept attachments'"
        @click="pickFiles"
      >📎</button>
      <input
        ref="fileInput"
        type="file"
        multiple
        style="display: none"
        @change="onFiles"
      />

      <textarea
        ref="textarea"
        v-model="text"
        class="textarea"
        rows="1"
        :placeholder="disabled ? 'Select an agent to start prompting...' : 'Type a prompt — Enter to send'"
        :disabled="disabled"
        @keydown="onKey"
      />

      <button
        v-if="busy"
        type="button"
        class="btn stop"
        @click="stop"
      >Stop</button>
      <button
        v-else
        type="button"
        class="btn send"
        :disabled="!text.trim() || disabled"
        @click="submit"
      >Send</button>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-md);
  background: var(--bg-secondary);
  border-top: var(--border-subtle);
  flex-shrink: 0;
}
.wrap.disabled { opacity: 0.7; }

.adapter {
  display: grid;
  gap: var(--space-xs);
}

.adapter-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-sm);
}

.coord-field {
  display: grid;
  gap: 3px;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.coord-input {
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 var(--space-sm);
  background: var(--bg-primary);
  border: var(--border-subtle);
  border-radius: var(--border-radius-sm);
  color: var(--text-primary);
  font-size: var(--text-xs);
}

.coord-input:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px var(--accent-glow);
}

.example-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
}

.example-btn {
  min-height: 28px;
  padding: 0 var(--space-sm);
  border: var(--border-subtle);
  border-radius: var(--border-radius-sm);
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  transition: all var(--transition-fast);
}

.example-btn:hover:not(:disabled) {
  color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.example-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.chips-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-sm);
}
.payload-hint {
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.payload-hint.over-limit { color: var(--error); }

.warn {
  font-size: var(--text-xs);
  color: var(--warning);
  background: var(--warning-dim);
  padding: 4px 8px;
  border-radius: var(--border-radius-sm);
}

.row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-sm);
}

.textarea {
  flex: 1;
  min-height: 38px;
  max-height: 200px;
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-primary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text-primary);
  resize: none;
  line-height: var(--leading-normal);
  overflow-y: auto;
}
.textarea:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.textarea:disabled { opacity: 0.6; cursor: not-allowed; }

.attach-btn {
  height: 38px;
  width: 38px;
  border: var(--border-subtle);
  background: var(--bg-primary);
  border-radius: var(--border-radius);
  color: var(--text-secondary);
  transition: all var(--transition-fast);
  font-size: 1.1em;
}
.attach-btn:hover:not(:disabled) {
  color: var(--accent-primary);
  border-color: var(--accent-primary);
}
.attach-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.btn {
  height: 38px;
  padding: 0 var(--space-lg);
  border-radius: var(--border-radius);
  font-size: var(--text-sm);
  font-weight: 600;
  transition: all var(--transition-fast);
}
.btn.send {
  background: var(--accent-gradient);
  color: white;
  border: none;
}
.btn.send:hover:not(:disabled) { filter: brightness(1.1); }
.btn.send:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.stop {
  background: var(--error-dim);
  color: var(--error);
  border: 1px solid var(--error);
}
.btn.stop:hover { background: var(--error); color: white; }
</style>
