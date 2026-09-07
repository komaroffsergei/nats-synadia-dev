<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import MonitorTimelineItem from './MonitorTimelineItem.vue';
const props = defineProps<{ sessions: any[]; selectedId?: string }>();
const rows = ref<any[]>([]),
  sessionId = ref(props.selectedId || ''),
  title = ref(''),
  mode = ref('live');
const local = (at: number) => {
  const d = new Date(at);
  return new Date(at - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
};
const from = ref(local(Date.now() - 3600000)),
  to = ref(local(Date.now() - 1000));
const loop = ref(true),
  speed = ref(1),
  skipPauses = ref(true),
  position = ref(0);
const revisionsOpen = ref(false);
const draft = ref<any>(null),
  busy = ref(false),
  error = ref(''),
  notice = ref('');
const messages: Record<string, string> = {
  recording_unavailable:
    'В этом периоде нет сохранённых событий. Выберите другой период: обычная история хранится 24 часа.',
  recording_too_large:
    'Запись слишком большая. Выберите более короткий фрагмент (до 8 MiB и 6000 событий).',
  archive_limit:
    'Архив заполнен: максимум 128 MiB или 50 публикаций. Удалите ненужные записи.',
  preview_expired: 'Предварительный просмотр устарел. Подготовьте его ещё раз.',
  invalid_range:
    'Проверьте начало и конец: они должны быть в прошлом, конец позже начала.',
  draft_limit:
    'Слишком много предварительных просмотров. Они освобождаются через 15 минут.',
};
async function api(path = '', init?: RequestInit) {
  const r = await fetch('/api/v1/monitor/broadcasts' + path, {
    credentials: 'same-origin',
    ...init,
  });
  const data = await r.json();
  if (!r.ok)
    throw Error(
      messages[data.error] ||
        (r.status === 401
          ? 'Нужен вход владельца'
          : 'Не удалось сохранить изменения. Проверьте заполненные поля.'),
    );
  return data;
}
const request = (method: string, body: any) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
async function refresh() {
  rows.value = await api();
}
watch(sessionId, (id) => {
  const s = props.sessions.find((s) => s.id === id);
  title.value = s?.customTitle || '';
  if (s)
    from.value = local(
      Math.max(Date.parse(s.first_at), Date.now() - 24 * 3600000),
    );
  draft.value = null;
});
watch([title, mode, from, to, loop, speed, skipPauses, position], () => {
  draft.value = null;
});
const previewItems = computed(() => {
  if (!draft.value) return [];
  const p = draft.value.preview;
  if (!p.frames) return p.items;
  const map = new Map();
  for (const f of p.frames) map.set(f.item.itemId, f.item);
  return [...map.values()];
});
async function preview() {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    draft.value = await api(
      '/preview',
      request('POST', {
        sessionId: sessionId.value,
        title: title.value,
        mode: mode.value,
        from: new Date(from.value).toISOString(),
        to: new Date(to.value).toISOString(),
        loop: loop.value,
        speed: Number(speed.value),
        skipPauses: skipPauses.value,
        position: Number(position.value),
      }),
    );
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function publish() {
  if (!draft.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api('', request('POST', { draftId: draft.value.draftId }));
    draft.value = null;
    notice.value = 'Публикация появилась в эфире сайта.';
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function update(row: any, body: any) {
  busy.value = true;
  error.value = '';
  try {
    await api('/' + row.id, request('PATCH', body));
    await refresh();
    notice.value =
      body.visible === false
        ? 'Публикация скрыта, открытые трансляции закрыты.'
        : 'Настройки сохранены.';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function remove(row: any) {
  busy.value = true;
  error.value = '';
  try {
    await api('/' + row.id, request('DELETE', {}));
    await refresh();
    notice.value = 'Публикация и сохранённая запись удалены.';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  const s = props.sessions.find((s) => s.id === sessionId.value);
  if (s) {
    title.value = s.customTitle || '';
    from.value = local(
      Math.max(Date.parse(s.first_at), Date.now() - 24 * 3600000),
    );
  }
  void refresh().catch((e) => (error.value = e.message));
});
</script>

<template>
  <section class="broadcast-manager">
    <div class="heading">
      <div>
        <h2>Эфир сайта</h2>
        <p>
          Выберите, что увидят посетители komaroff-dev.ru. Остальные сессии
          остаются скрытыми.
        </p>
      </div>
      <a
        href="https://komaroff-dev.ru/ru/#work-broadcast"
        target="_blank"
        rel="noopener"
        >Открыть сайт ↗</a
      >
    </div>
    <p v-if="error" role="alert" class="notice error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <div class="manager-grid">
      <form @submit.prevent="preview" class="editor">
        <h3>Новая публикация</h3>
        <label for="broadcast-session"
          >Сессия<select id="broadcast-session" v-model="sessionId" required>
            <option value="" disabled>Выберите сессию</option>
            <option v-for="s in sessions" :key="s.id" :value="s.id">
              {{ s.title }} · {{ s.model || 'модель неизвестна' }}
            </option>
          </select></label
        >
        <label
          >Название для посетителей<input
            v-model="title"
            maxlength="160"
            required
            placeholder="Например: Массовый импорт GeoJSON"
        /></label>
        <label
          >Режим<select v-model="mode">
            <option value="live">Прямой эфир</option>
            <option value="replay">Запись с повтором</option>
          </select></label
        >
        <div class="fields">
          <label
            >Начало фрагмента<input
              v-model="from"
              type="datetime-local"
              step="1"
              required /></label
          ><label v-if="mode === 'replay'"
            >Конец фрагмента<input
              v-model="to"
              type="datetime-local"
              step="1"
              required
          /></label>
        </div>
        <p class="help">
          Время вашего браузера.
          {{
            mode === 'live'
              ? 'Публикуется история с выбранного начала и новые события этой сессии.'
              : 'Запись хранится отдельно от 24-часовой истории и ничего не запускает повторно.'
          }}
        </p>
        <div class="fields">
          <label
            >Порядок в эфире<input
              v-model.number="position"
              type="number"
              min="0"
              max="999"
              required /></label
          ><label v-if="mode === 'replay'"
            >Скорость<select v-model.number="speed">
              <option :value="0.5">0.5×</option>
              <option :value="1">1×</option>
              <option :value="2">2×</option>
              <option :value="4">4×</option>
            </select></label
          >
        </div>
        <template v-if="mode === 'replay'"
          ><label class="check"
            ><input v-model="loop" type="checkbox" /> Повторять по кругу</label
          ><label class="check"
            ><input v-model="skipPauses" type="checkbox" /> Пропускать паузы
            длиннее 3 секунд</label
          ></template
        >
        <button type="submit" class="primary" :disabled="busy || !sessionId">
          {{ busy ? 'Подготовка…' : 'Предварительный просмотр' }}
        </button>
      </form>
      <section class="publications">
        <h3>Публикации и плейлист</h3>
        <p v-if="!rows.length" class="help">
          Пока ничего не опубликовано. Сначала подготовьте предварительный
          просмотр.
        </p>
        <article v-for="row in rows" :key="row.id" class="publication">
          <div class="row-heading">
            <strong>{{ row.title }}</strong
            ><span :class="['mode', { 'is-hidden': !row.visible }]">{{
              !row.visible
                ? 'Скрыта'
                : row.mode === 'live'
                  ? 'Прямой эфир'
                  : 'Повтор записи'
            }}</span>
          </div>
          <p class="help">
            {{
              row.mode === 'replay'
                ? new Date(row.from).toLocaleString('ru-RU') +
                  ' · ' +
                  Math.round(row.durationMs / 1000) +
                  ' с · ' +
                  (row.bytes / 1048576).toFixed(2) +
                  ' MiB'
                : 'Новые события выбранной сессии'
            }}
            · порядок {{ row.position }}
          </p>
          <div class="row-actions">
            <button
              :disabled="busy"
              @click="update(row, { visible: !row.visible })"
            >
              {{ row.visible ? 'Скрыть' : 'Показать на сайте' }}</button
            ><button
              :disabled="busy || row.position === 0"
              @click="update(row, { position: Math.max(0, row.position - 1) })"
            >
              Выше</button
            ><button
              :disabled="busy"
              @click="update(row, { position: row.position + 1 })"
            >
              Ниже</button
            ><a
              v-if="row.visible"
              :href="
                'https://komaroff-dev.ru/ru/?broadcast=' +
                row.id +
                '#work-broadcast'
              "
              target="_blank"
              rel="noopener"
              >Посмотреть ↗</a
            >
          </div>
          <div v-if="row.mode === 'replay'" class="row-actions">
            <button :disabled="busy" @click="update(row, { loop: !row.loop })">
              Повтор: {{ row.loop ? 'вкл.' : 'выкл.' }}</button
            ><button
              :disabled="busy"
              @click="update(row, { skipPauses: !row.skipPauses })"
            >
              {{
                row.skipPauses ? 'Без длинных пауз' : 'Исходные паузы'
              }}</button
            ><label
              >Скорость
              <select
                :value="row.speed"
                :disabled="busy"
                @change="
                  update(row, {
                    speed: Number(($event.target as HTMLSelectElement).value),
                  })
                "
              >
                <option :value="0.5">0.5×</option>
                <option :value="1">1×</option>
                <option :value="2">2×</option>
                <option :value="4">4×</option>
              </select></label
            >
          </div>
          <button
            v-if="!row.visible"
            :disabled="busy"
            class="delete"
            @click="remove(row)"
          >
            Удалить публикацию{{ row.mode === 'replay' ? ' и запись' : '' }}
          </button>
        </article>
        <p class="help">
          Публикации действуют до скрытия или удаления. Скрытие сразу закрывает
          доступ на сайте. Отдельные временные ссылки в разделе «Сессии»
          сохраняют свой срок действия.
        </p>
      </section>
    </div>
    <section
      v-if="draft"
      class="preview"
      aria-label="Предварительный просмотр публикации"
    >
      <h3>
        {{ draft.preview.title }} ·
        {{ draft.preview.mode === 'live' ? 'Прямой эфир' : 'Запись' }}
      </h3>
      <p class="help">
        Это доступный посетителю текст.
        {{
          mode === 'live'
            ? 'После публикации будут видны и новые события этой сессии.'
            : 'Зафиксирована именно эта запись. Изменение исходной истории её не меняет.'
        }}
        Предварительный просмотр действует 15 минут.
      </p>
      <p v-if="draft.preview.partial" class="notice">
        История фрагмента неполная; эта отметка будет видна посетителю.
      </p>
      <div class="preview-log">
        <MonitorTimelineItem
          v-for="item in previewItems"
          :key="item.itemId"
          :item="item"
        />
        <p v-if="!previewItems.length">
          Пока нет текстовых событий в выбранном периоде.
        </p>
      </div>
      <details
        v-if="draft.preview.frames"
        class="revisions"
        @toggle="revisionsOpen = ($event.target as HTMLDetailsElement).open"
      >
        <summary>
          Все изменения текста записи ·
          {{ draft.preview.frames.length }} событий
        </summary>
        <p class="help">
          Выше — итоговый текст. Здесь доступны все промежуточные версии,
          которые будут воспроизводиться, с исходным временем и содержимым.
        </p>
        <pre v-if="revisionsOpen">{{
          JSON.stringify(draft.preview.frames, null, 2)
        }}</pre>
      </details>
      <div class="row-actions">
        <button class="primary" :disabled="busy" @click="publish">
          Опубликовать на сайте</button
        ><button :disabled="busy" @click="draft = null">Отменить</button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.revisions {
  margin-block: 18px;
  font-size: 12px;
}
.revisions summary {
  cursor: pointer;
  padding: 12px;
  border: var(--border-light);
}
.revisions pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 500px;
  overflow: auto;
  background: var(--bg-deep);
  padding: 16px;
  font: 11px/1.7 monospace;
}
.broadcast-manager {
  padding: 26px;
  background: var(--bg-secondary);
  border: var(--border-light);
  border-radius: 10px;
  margin: 0 28px 28px;
  color: var(--text-primary);
}
h2 {
  font-size: 22px;
}
h3 {
  font-size: 15px;
  margin: 0 0 18px;
}
.heading {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 24px;
}
.heading p,
.help {
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-muted);
}
.heading a {
  white-space: nowrap;
  font-size: 12px;
  color: var(--accent-primary);
}
.manager-grid {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(280px, 1.3fr);
  gap: 30px;
}
.editor {
  display: flex;
  flex-direction: column;
  gap: 15px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
input,
select {
  background: var(--bg-deep);
  border: var(--border-light);
  border-radius: 5px;
  min-height: 42px;
  padding: 9px;
  color: var(--text-primary);
  width: 100%;
  min-width: 0;
  font: inherit;
}
.fields {
  display: flex;
  gap: 12px;
}
.fields label {
  flex: 1;
  min-width: 0;
}
.check {
  flex-direction: row;
  align-items: center;
}
.check input {
  width: 18px;
  min-height: 18px;
}
.help {
  margin: 0 0 12px;
}
.publication {
  padding: 18px;
  border: var(--border-light);
  border-radius: 6px;
  margin-bottom: 14px;
  background: var(--bg-tertiary);
}
.row-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  justify-content: space-between;
  margin-bottom: 12px;
}
.row-heading strong {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.mode {
  font-size: 10px;
  color: var(--accent-primary);
  white-space: nowrap;
}
.mode.is-hidden {
  color: var(--text-muted);
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 12px;
}
.row-actions a,
button {
  border: var(--border-light);
  padding: 9px 12px;
  border-radius: 5px;
  background: var(--bg-tertiary);
  font-size: 12px;
  color: var(--text-primary);
  min-height: 38px;
  cursor: pointer;
}
.row-actions label {
  flex-direction: row;
  align-items: center;
}
.row-actions select {
  width: 72px;
}
.primary {
  background: var(--accent-primary);
  color: white;
}
.delete {
  margin-top: 16px;
  color: var(--error);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.notice {
  padding: 12px;
  background: var(--bg-elevated);
  border-left: 3px solid var(--accent-primary);
  font-size: 12px;
  line-height: 1.7;
}
.error {
  border-color: var(--error);
}
.preview {
  border-top: var(--border-light);
  margin-top: 30px;
  padding-top: 25px;
}
.preview-log {
  max-height: 550px;
  overflow: auto;
  border: var(--border-light);
  padding: 14px;
  display: grid;
  gap: 12px;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 3px;
}
@media (max-width: 900px) {
  .manager-grid {
    grid-template-columns: 1fr;
  }
  .heading {
    flex-direction: column;
  }
  .broadcast-manager {
    margin: 0 16px 20px;
    padding: 18px;
  }
}
@media (max-width: 480px) {
  .fields {
    flex-direction: column;
  }
  .row-heading {
    flex-direction: column;
  }
  .broadcast-manager {
    margin: 0 10px 20px;
    padding: 14px;
  }
}
</style>
