<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import MonitorTimelineItem from './components/MonitorTimelineItem.vue';
import BroadcastManager from './components/BroadcastManager.vue';

const privateMode=location.pathname.startsWith('/console');
const liveId=location.pathname.startsWith('/live/')?location.pathname.split('/')[2]:null;
const tab=ref('sessions'),sessions=ref<any[]>([]),selected=ref<any>(null),selectedId=ref('');
const status=ref('connecting'),error=ref(''),loading=ref(true),search=ref('');
const usage=ref<any>(null),connections=ref<any>(null),events=ref<any[]>([]),shares=ref<any[]>([]);
const olderItems=ref<any[]>([]),olderBoundary=ref<number|null>(null),olderAvailable=ref(true),loadingOlder=ref(false);
const visibleItems=computed(()=>{
  const map=new Map<string,any>();
  for(const i of [...olderItems.value,...(selected.value?.items||[])])map.set(i.itemId||`${i.groupId}/${i.segment}/${i.at}`,i);
  return Array.from(map.values());
});
const compareIds=ref<string[]>([]),paused=ref(false),pendingSnapshot=ref<any>(null);
const showPublish=ref(false),preview=ref<any>(null),shareFrom=ref('history'),shareHours=ref(24),shareLink=ref(''),publishing=ref(false);
const editingTitle=ref(false),titleDraft=ref(''),titleError=ref(''),savingTitle=ref(false),titleInput=ref<HTMLInputElement|null>(null);
let ws:WebSocket|null=null,reconnect:ReturnType<typeof setTimeout>|undefined,poll:ReturnType<typeof setInterval>|undefined;
let disposed=false,refreshing=false;
let returnFocus:HTMLElement|null=null;
const dialog=ref<HTMLElement|null>(null);
watch(showPublish,async(value)=>{
  if(value){returnFocus=document.activeElement as HTMLElement;await nextTick();dialog.value?.querySelector<HTMLElement>('button,select,input')?.focus();}
  else returnFocus?.focus();
});
function trapFocus(e:KeyboardEvent){
  if(e.key!=='Tab')return;
  const els=Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]),select,input,a[href]')||[]);
  if(!els.length)return;
  if(e.shiftKey&&document.activeElement===els[0]){e.preventDefault();els.at(-1)?.focus();}
  else if(!e.shiftKey&&document.activeElement===els.at(-1)){e.preventDefault();els[0].focus();}
}
const format=(n:any)=>n==null?'—':new Intl.NumberFormat('ru-RU').format(n);
const date=(v:string)=>v?new Date(v).toLocaleString('ru-RU'):'—';
const time=(v:string)=>v?new Date(v).toLocaleTimeString('ru-RU'):'—';
const stateLabel=(s:string)=>({streaming:'Идёт запрос',quiet:'Нет новых событий',completed:'Ответ завершён',failed:'Ошибка',incomplete:'Поток прерван',connecting:'Подключение',connected:'Подключено',reconnecting:'Переподключение',revoked:'Доступ закрыт'}[s] || s);
const qualityLabel=(q:string)=>q==='complete'?'Полные данные':q==='conflict'?'Есть расхождения':'Неполные данные';
const shown=computed(()=>sessions.value.filter(s=>`${s.title} ${s.model}`.toLowerCase().includes(search.value.toLowerCase())));
const selectedComparisons=computed(()=>sessions.value.filter(s=>compareIds.value.includes(s.id)));
const currentUsage=computed(()=>tab.value==='usage'?usage.value:selected.value?.usage);
const chart=computed(()=>currentUsage.value?.buckets?.slice(-24)||[]);
const maxBucket=computed(()=>Math.max(1,...chart.value.map((b:any)=>b.total)));
const hasActivity=computed(()=>sessions.value.filter(s=>s.status==='streaming').length);
const title=computed(()=>selected.value?.title || 'Сессия Codex');
const tabs=[['sessions','Сессии'],['broadcasts','Эфир сайта'],['traffic','Трафик'],['usage','Токены'],['compare','Сравнение'],['connections','Подключение']];

async function api(path:string,init?:RequestInit) {
  const r=await fetch(path,{credentials:'same-origin',...init});
  if (!r.ok) throw Error(r.status===401?'Нужен вход владельца':r.status===410?'Трансляция завершена или доступ отозван':`Не удалось получить данные (${r.status})`);
  return r.json();
}
async function refresh() {
  if(refreshing)return;refreshing=true;
  try {
    if(privateMode) {
      const [s,u,c]=await Promise.all([api('/api/v1/monitor/sessions'),api('/api/v1/monitor/usage'),api('/api/v1/monitor/connections')]);
      const current=new Map<string,any>(s.sessions.map((row:any)=>[row.id,row]));
      for(const row of sessions.value)if(!current.has(row.id))current.set(row.id,row);
      sessions.value=Array.from(current.values());usage.value=u;connections.value=c;
    } else if(!liveId) sessions.value=await api('/api/public/sessions');
    error.value='';
  } catch(e){error.value=(e as Error).message;} finally {loading.value=false;refreshing=false;}
}
async function select(id:string) {
  editingTitle.value=false;titleError.value='';
  error.value='';selectedId.value=id;selected.value=null;events.value=[];shares.value=[];olderItems.value=[];olderBoundary.value=null;olderAvailable.value=true;
  try {
    const s=await api(`/api/v1/monitor/sessions/${id}`);
    if(selectedId.value!==id)return;
    selected.value=s;ws?.send(JSON.stringify({kind:'subscribe',sessionId:id,cursor:s.cursor}));
    await detailExtras();
    const url=new URL(location.href);url.searchParams.set('session',id);history.replaceState(null,'',url);
  } catch(e){error.value=(e as Error).message;}
}
async function loadOlder(){
  if(loadingOlder.value||!selected.value)return;loadingOlder.value=true;
  const id=selectedId.value;
  try{
    const path=privateMode?`/api/v1/monitor/sessions/${id}`:`/api/public/sessions/${liveId}`;
    const s=await api(`${path}?before=${olderBoundary.value||selected.value.oldest}`);
    if(privateMode&&id!==selectedId.value)return;
    olderItems.value=[...s.items,...olderItems.value];olderBoundary.value=s.oldest;olderAvailable.value=s.hasOlder;
  }catch(e){error.value=(e as Error).message;}finally{loadingOlder.value=false;}
}
async function moreSessions(){
  const last=sessions.value.at(-1);if(!last)return;
  const s=await api('/api/v1/monitor/sessions?before='+encodeURIComponent(last.updated_at+last.id));
  sessions.value=[...sessions.value,...s.sessions];
}
async function moreEvents(){
  const s=await api(`/api/v1/monitor/sessions/${selectedId.value}/events?after=${events.value.at(-1)?.seq||0}`);
  events.value=[...events.value,...s.events];
}
async function detailExtras() {
  if(!privateMode||!selectedId.value)return;
  const id=selectedId.value;
  const [ev,sh]=await Promise.all([api(`/api/v1/monitor/sessions/${id}/events`),api(`/api/v1/monitor/sessions/${id}/shares`)]);
  if(id===selectedId.value){events.value=ev.events;shares.value=sh;}
}
function connect() {
  if(disposed||!privateMode&&!liveId)return;
  ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}${privateMode?'/monitor/ws':`/public/ws?share=${encodeURIComponent(liveId!)}`}`);
  ws.onopen=()=>{status.value='connected';ws?.send(JSON.stringify({kind:'subscribe',sessionId:privateMode?selectedId.value:undefined,cursor:selected.value?.cursor||0}));};
  ws.onmessage=e=>{
    const message=JSON.parse(e.data);
    if(message.kind==='snapshot') {
      if(privateMode&&message.data?.id!==selectedId.value)return;
      if(paused.value)pendingSnapshot.value=message.data;else selected.value=message.data;
      if(privateMode)void refresh();
    }
    if(message.kind==='changed')void refresh();
    if(message.kind==='revoked'){status.value='revoked';selected.value=null;error.value='Трансляция завершена или доступ отозван';}
  };
  ws.onclose=e=>{if(disposed||e.code===1008){if(!privateMode){selected.value=null;status.value='revoked';}return;}status.value='reconnecting';reconnect=setTimeout(connect,1500);};
  ws.onerror=()=>{status.value='reconnecting';};
}
watch(paused,value=>{if(!value&&pendingSnapshot.value){selected.value=pendingSnapshot.value;pendingSnapshot.value=null;}});
watch(tab,()=>{if(tab.value==='traffic')void detailExtras().catch(e=>error.value=e.message);});
const fromValue=()=>shareFrom.value==='now'?new Date().toISOString():new Date(Date.now()-24*3600_000).toISOString();
async function editTitle() {
  titleDraft.value=selected.value?.customTitle || '';titleError.value='';editingTitle.value=true;
  await nextTick();titleInput.value?.focus();
}
async function saveTitle(clear=false) {
  const id=selectedId.value;
  if(!clear && !titleDraft.value.trim()){titleError.value='Введите название чата.';return;}
  savingTitle.value=true;titleError.value='';
  try {
    const s=await api(`/api/v1/monitor/sessions/${id}/title`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:clear?null:titleDraft.value.trim()})});
    if(selectedId.value===id){selected.value=s;editingTitle.value=false;}
    await refresh();
  } catch {if(selectedId.value===id)titleError.value='Не удалось сохранить название. Проверьте соединение и повторите.';}
  finally {savingTitle.value=false;}
}
async function openPreview() {
  error.value='';shareLink.value='';
  try{
    const id=selectedId.value,path=`/api/v1/monitor/sessions/${id}/preview?from=${encodeURIComponent(fromValue())}`;
    const data=await api(path);let page=data;
    while(page.hasOlder){page=await api(`${path}&before=${page.oldest}`);data.items=[...page.items,...data.items];}
    if(id!==selectedId.value)return;
    preview.value=data;showPublish.value=true;
  }
  catch(e){error.value=(e as Error).message;}
}
async function publish() {
  publishing.value=true;
  try {
    const result=await api(`/api/v1/monitor/sessions/${selectedId.value}/shares`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:fromValue(),hours:Number(shareHours.value)})});
    shareLink.value=`${location.origin}/live/${result.token}`;await detailExtras();await refresh();
  } catch(e){error.value=(e as Error).message;} finally{publishing.value=false;}
}
async function revoke(id:string) {
  try{await api(`/api/v1/monitor/shares/${id}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'});await detailExtras();await refresh();}
  catch(e){error.value=(e as Error).message;}
}
function toggleCompare(id:string) {compareIds.value=compareIds.value.includes(id)?compareIds.value.filter(x=>x!==id):[...compareIds.value,id].slice(-4);}
onMounted(async()=>{
  await refresh();
  if(privateMode){const id=new URLSearchParams(location.search).get('session');if(id)await select(id);}
  if(liveId){try{selected.value=await api(`/api/public/sessions/${liveId}`);}catch(e){error.value=(e as Error).message;status.value='revoked';}}
  connect();poll=setInterval(()=>{void refresh();},5000);
});
onUnmounted(()=>{disposed=true;clearTimeout(reconnect);clearInterval(poll);ws?.close();});
</script>

<template>
  <div class="monitor">
    <header class="connection-bar">
      <a class="brand" :href="privateMode?'/console/':'/'"><span class="brand-mark">N</span>NATS Agent Console <small>CODЕX PROXY</small></a>
      <div class="connection-status"><i :class="status" />{{privateMode||liveId?stateLabel(status):'Публичные трансляции'}}</div>
      <a v-if="!privateMode" class="subtle-link" href="/console/">Вход владельца ↗</a>
      <a v-else class="subtle-link" href="/">Публичная страница ↗</a>
    </header>
    <div v-if="error" role="alert" class="error-banner">{{error}} <button v-if="status!=='revoked'" @click="refresh">Повторить</button></div>
    <template v-if="privateMode">
      <section class="workspace-heading"><div><span class="eyebrow">НАБЛЮДЕНИЕ · РЕАЛЬНЫЙ ТРАФИК</span><h1>Работа Codex в прямом эфире</h1><p>Сессии, размышления и инструменты из вашего proxy.</p></div><a class="legacy-link" href="/console/youtrack">YouTrack / NATS ↗</a></section>
      <nav class="tabs" aria-label="Разделы мониторинга"><button v-for="[id,label] in tabs" :key="id" :aria-current="tab===id?'page':undefined" :class="{active:tab===id}" @click="tab=id">{{label}}</button></nav>
      <section class="metrics"><div><span>Сессии proxy</span><strong>{{format(sessions.length)}}</strong></div><div><span>Активные запросы</span><strong class="green">{{format(hasActivity)}}</strong></div><div><span>Токены · новая история</span><strong>{{format(usage?.total)}}</strong></div><div><span>Полнота учёта</span><strong class="small-stat">{{usage?qualityLabel(usage.quality):'Ожидание данных'}}</strong></div></section>
      <main v-if="tab==='sessions'||tab==='traffic'" class="workspace" :class="{'has-selection':selectedId}">
        <aside class="session-list">
          <div class="list-heading"><h2>Сессии <small>{{shown.length}}</small></h2><button class="icon-button" aria-label="Обновить сессии" @click="refresh">↻</button></div>
          <label class="search"><span class="sr-only">Поиск сессий</span><input v-model="search" placeholder="Поиск по задаче или модели" /></label>
          <p class="session-explanation">Один чат может создавать дополнительные запросы: например, для названия. Их токены тоже учитываются.</p>
          <p v-if="loading" class="empty">Загружаем сессии…</p>
          <div v-else-if="!shown.length" class="empty"><b>{{search?'Ничего не найдено':'Пока нет событий'}}</b><p>{{search?'Попробуйте другой запрос.':'Новая сессия появится, когда запрос пройдёт через Codex proxy.'}}</p></div>
          <button v-for="s in shown" :key="s.id" class="session-card" :class="{selected:s.id===selectedId}" @click="select(s.id)">
            <span class="card-top"><span class="badge" :class="s.status">{{stateLabel(s.status)}}</span><span v-if="s.shared" class="shared-label">Опубликована</span></span>
            <span v-if="s.activity==='title_generation'" class="service-label">Служебный запрос · название чата</span>
            <strong>{{s.title}}</strong><span v-if="!s.customTitle && s.requestPreview" class="request-preview">{{s.activity==='title_generation'?'Предложение модели: ':'Первое поручение: '}}{{s.requestPreview}}</span><span class="model mono">{{s.model||'Модель пока неизвестна'}}</span>
            <span class="card-bottom"><span>{{format(s.usage.total)}} токенов</span><span>{{time(s.updated_at)}}</span></span>
            <span v-if="s.correlation==='unassigned'" class="warning-text">Непривязанный запрос</span>
          </button>
          <button v-if="sessions.length>=100" class="secondary" @click="moreSessions">Ещё сессии</button>
        </aside>
        <section class="detail">
          <div v-if="!selected" class="empty large"><span class="empty-icon">⌁</span><h2>{{selectedId?'Загружаем сессию…':'Выберите сессию'}}</h2><p>Здесь появятся размышления, ответы и события инструментов.<br />Состояние задачи не определяется по тишине в потоке.</p></div>
          <template v-else>
            <div class="detail-heading"><button class="mobile-back" @click="selectedId='';selected=null">← Сессии</button><div><span class="eyebrow">{{selected.model||'CODEX'}} · {{stateLabel(selected.status)}}</span><h2>{{title}}</h2><button v-if="!editingTitle" class="title-edit-link" @click="editTitle">{{selected.customTitle?'Изменить название чата':'Задать название чата'}} ✎</button></div><button class="primary" @click="openPreview">Опубликовать ↗</button></div>
            <form v-if="editingTitle" class="title-editor" @submit.prevent="saveTitle()" @keydown.esc.prevent="editingTitle=false">
              <label for="chat-title">Название чата</label>
              <input id="chat-title" ref="titleInput" v-model="titleDraft" maxlength="160" placeholder="Как чат называется в Codex" autocomplete="off" :disabled="savingTitle" aria-describedby="title-help" />
              <p id="title-help">Название задаётся вручную в Synadia. Чат в Codex не переименовывается. В уже созданных публикациях сохраняется прежнее имя.</p>
              <p v-if="titleError" role="alert" class="title-error">{{titleError}}</p>
              <div class="title-actions"><button type="submit" class="primary" :disabled="savingTitle">{{savingTitle?'Сохраняем…':'Сохранить название'}}</button><button type="button" class="secondary" :disabled="savingTitle" @click="editingTitle=false">Отмена</button><button v-if="selected.customTitle" type="button" class="danger-link" :disabled="savingTitle" @click="saveTitle(true)">Убрать название</button></div>
            </form>
            <div class="detail-meta"><span>{{date(selected.first_at)}}</span><span>{{format(selected.usage.total)}} токенов</span><button @click="paused=!paused">{{paused?'▶ Продолжить обновление':'Ⅱ Пауза просмотра'}}</button></div>
            <p v-if="selected.activity==='title_generation'" class="service-explanation">Codex запросил название и описание чата. Это вспомогательная работа приложения, а не второй ответ на ваше поручение. Привязка к конкретному чату не подтверждена идентификатором в трафике.</p>
            <p v-if="selected.partial" class="notice">История неполная: часть событий пропущена или удалена по сроку хранения.</p>
            <template v-if="tab==='sessions'">
              <div v-if="!selected.items.length" class="empty">Запрос зарегистрирован. Ожидаем доступный текст от proxy.</div>
              <button v-if="selected?.hasOlder&&olderAvailable" class="secondary" :disabled="loadingOlder" @click="loadOlder">{{loadingOlder?'Загружаем…':'Показать более ранние события'}}</button><div class="timeline">
                <MonitorTimelineItem v-for="item in visibleItems" :key="item.itemId" :item="item" :activity="selected.activity" />
              </div>
              <section v-if="shares.length" class="shares"><h3>Публикации этой сессии</h3><div v-for="s in shares" :key="s.id"><span>{{s.revoked_at?'Доступ отозван':Date.parse(s.expires_at)<Date.now()?'Срок истёк':`Доступна до ${date(s.expires_at)}`}}</span><button v-if="!s.revoked_at&&Date.parse(s.expires_at)>Date.now()" class="danger-link" @click="revoke(s.id)">Отозвать</button></div></section>
            </template>
            <template v-else>
              <h3 class="section-label">Запросы и физические попытки</h3><div class="attempts"><article v-for="a in selected.attempts" :key="a.id"><span class="badge" :class="a.status">{{stateLabel(a.status)}}</span><strong class="mono">{{a.transport?.toUpperCase()}} · {{a.model||'—'}}</strong><span>{{format(a.duration_ms)}} мс · {{time(a.started_at)}} <span v-if="a.retry">· повтор</span></span><p v-if="a.error" class="warning-text">{{a.error}}</p><small class="mono">{{a.id}}</small></article></div>
              <h3 class="section-label">Инспектор очищенных событий <button @click="detailExtras">↻</button></h3><details v-for="event in events" :key="event.eventId" class="event"><summary><span class="mono">{{event.type}}</span> <time>{{time(event.at)}}</time></summary><pre>{{JSON.stringify(event,null,2)}}</pre></details><button v-if="events.length>=500" class="secondary" @click="moreEvents">Ещё события</button>
            </template>
          </template>
        </section>
      </main>
      <BroadcastManager v-else-if="tab==='broadcasts'" :sessions="sessions" :selected-id="selectedId" />
      <main v-else-if="tab==='usage'" class="wide-panel">
        <div class="panel-heading"><div><h2>Токены</h2><p>Расход из ответов proxy. Кэш и reasoning уже входят в общий итог.</p></div><span class="badge">{{qualityLabel(usage?.quality)}}</span></div>
        <div class="usage-metrics"><div><span>Вход</span><strong>{{format(usage?.input)}}</strong></div><div><span>Из кэша · часть входа</span><strong>{{format(usage?.cached)}}</strong></div><div><span>Выход</span><strong>{{format(usage?.output)}}</strong></div><div><span>Reasoning · часть выхода</span><strong>{{format(usage?.reasoning)}}</strong></div></div>
        <div v-if="chart.length" class="chart" aria-label="Расход токенов по часам"><div v-for="b in chart" :key="b.at" :title="`${date(b.at)}: ${format(b.total)} токенов`"><span class="bar" :style="{height:Math.max(2,b.total/maxBucket*160)+'px'}"/><small>{{new Date(b.at).getHours()}}:00</small></div></div><div v-else class="empty">График появится после первого ответа с данными usage.</div>
        <p v-if="usage?.unknown||usage?.partial||usage?.conflicts" class="notice">Без данных usage: {{usage.unknown}}. С неполной разбивкой: {{usage.partial}}. С расхождениями: {{usage.conflicts}}.</p>
        <div class="table-wrap"><table><thead><tr><th>Время</th><th>Модель</th><th>Вход</th><th>Выход</th><th>Итого</th><th>Полнота</th></tr></thead><tbody><tr v-for="a in usage?.attempts" :key="a.attemptId"><td>{{date(a.at)}}</td><td>{{a.model}}</td><td>{{format(a.input)}}</td><td>{{format(a.output)}}</td><td>{{format(a.total)}}</td><td>{{qualityLabel(a.quality)}}</td></tr></tbody></table></div>
        <section class="legacy-stat"><h3>Ранее накопленная статистика proxy</h3><p>Хранится отдельно: её нельзя разложить по сессиям или прибавить к новой истории без проверки пересечения периодов.</p><pre v-if="connections?.legacy">{{JSON.stringify(connections.legacy,null,2)}}</pre><p v-else>Исторические агрегаты ещё не импортированы.</p></section>
      </main>
      <main v-else-if="tab==='compare'" class="wide-panel"><h2>Сравнение сессий</h2><p>Выберите до четырёх сессий. Просмотр ничего не запускает.</p><div class="compare-options"><label v-for="s in sessions" :key="s.id"><input type="checkbox" :checked="compareIds.includes(s.id)" @change="toggleCompare(s.id)" />{{s.title||'Сессия без названия'}}</label></div><div class="compare-grid"><article v-for="s in selectedComparisons" :key="s.id"><h3>{{s.title||'Сессия Codex'}}</h3><p class="mono">{{s.model}}</p><strong>{{format(s.usage.total)}}</strong><p>токенов · {{qualityLabel(s.usage.quality)}}</p><p>{{stateLabel(s.status)}}</p><button class="secondary" @click="tab='sessions';select(s.id)">Открыть сессию ↗</button></article></div></main>
      <main v-else class="wide-panel"><h2>Подключение и доставка</h2><p>Единственный источник событий — Codex proxy. Состояние транспорта не является статусом выполнения задачи.</p><div class="health-grid"><article><span>Источник</span><h3>Codex proxy</h3><p>{{connections?.source?date(connections.source.at):'Событий пока нет'}}</p></article><article><span>NATS JetStream</span><h3>{{connections?.nats==='connected'?'Подключён':'Переподключение'}}</h3><p>Отдельный stream CODEX_TRACE</p></article><article><span>Очередь отправки</span><h3>{{format(connections?.ingest?.pending)}} событий</h3><p>{{format(connections?.ingest?.source?.outboxBytes)}} байт в буфере</p></article><article><span>Обработчик истории</span><h3>{{connections?.projector?'Получает события':'Ожидает события'}}</h3><p>{{connections?.projector?date(connections.projector.at):'—'}}</p></article><article><span>Хранение</span><h3>24 часа / 90 дней</h3><p>Текстовая история / учёт токенов</p></article><article><span>Пропуски</span><h3>{{format(connections?.ingest?.source?.dropped||0)}}</h3><p>{{connections?.gap?'Обнаружен пропуск последовательности':'Пропуски последовательности не зафиксированы'}}</p></article></div></main>
    </template>
    <main v-else class="public-page">
      <div class="public-heading"><span class="eyebrow">СЕРГЕЙ КОМАРОВ · РАБОЧИЙ ПРОЦЕСС</span><h1>{{liveId?'Рабочая сессия Codex':'Над чем я сейчас работаю'}}</h1><p>Реальные события из Codex proxy: размышления, ответы и инструменты. Опубликовано владельцем.</p></div>
      <template v-if="liveId&&selected"><div class="panel-heading"><div><h2>{{title}}</h2><span class="mono">{{selected.model}}</span></div><span class="badge">Только просмотр</span></div><p v-if="selected.partial" class="notice">Доступная история неполная.</p><p class="public-total">{{format(selected.usage.total)}} токенов · до {{date(selected.expiresAt)}}</p><button v-if="selected?.hasOlder&&olderAvailable" class="secondary" :disabled="loadingOlder" @click="loadOlder">{{loadingOlder?'Загружаем…':'Показать более ранние события'}}</button><div class="timeline"><MonitorTimelineItem v-for="(item,i) in visibleItems" :key="i" :item="item" /></div></template>
      <div v-else-if="!liveId&&sessions.length" class="public-grid"><a v-for="s in sessions" :key="s.id" class="session-card" :href="`/live/${s.id}`"><span class="badge">Опубликованная сессия</span><h2>{{s.title}}</h2><span class="mono">{{s.model}}</span><span>{{date(s.updatedAt)}} · Смотреть ↗</span></a></div>
      <div v-else-if="!error" class="empty large"><span class="empty-icon">⌁</span><h2>Сейчас нет открытых трансляций</h2><p>Новая сессия появится здесь, когда я открою её для просмотра.</p><a class="secondary" href="https://komaroff-dev.ru/">Посмотреть проекты ↗</a></div>
      <footer><a href="https://komaroff-dev.ru/">← Портфолио</a><span>Synadia · NATS · Codex proxy</span></footer>
    </main>
    <div v-if="showPublish" class="modal-backdrop" @click.self="showPublish=false" @keydown.esc="showPublish=false"><section ref="dialog" @keydown="trapFocus" role="dialog" aria-modal="true" aria-labelledby="publish-heading" class="publish-dialog"><div class="panel-heading"><h2 id="publish-heading">Предпросмотр публикации</h2><button aria-label="Закрыть" @click="showPublish=false">✕</button></div><p>Посетители увидят полный доступный текст этой сессии. Проверьте содержание перед публикацией.</p><div class="publish-options"><label>Начало<select v-model="shareFrom"><option value="history">Доступная история и новые события</option><option value="now">Только новые события</option></select></label><label>Срок, часов<input v-model="shareHours" type="number" min="1" max="168" /></label></div><p class="publication-title"><strong>Название трансляции:</strong> {{preview?.title}}</p><div class="preview-content"><template v-if="shareFrom==='history'"><MonitorTimelineItem v-for="(item,i) in preview?.items" :key="i" :item="item" :activity="selected?.activity" /><p v-if="!preview?.items?.length">Текст пока не поступил.</p></template><p v-else>Будут видны только события после публикации.</p></div><div v-if="shareLink" class="share-result"><label>Ссылка на трансляцию<input readonly :value="shareLink" @focus="($event.target as HTMLInputElement).select()" /></label><a :href="shareLink" target="_blank" rel="noreferrer">Открыть трансляцию ↗</a></div><div v-else class="modal-actions"><button class="secondary" @click="showPublish=false">Отмена</button><button class="primary" :disabled="publishing" @click="publish">{{publishing?'Публикуем…':'Опубликовать эту сессию'}}</button></div></section></div>
  </div>
</template>

<style scoped>
.title-edit-link{margin-top:10px;color:var(--info);font-size:12px;text-align:left}.title-editor{margin-top:18px;padding:16px;background:var(--bg-secondary);border:var(--border-light);border-radius:8px}.title-editor label{display:block;font-size:12px;margin-bottom:9px}.title-editor input{box-sizing:border-box;width:100%;padding:11px 12px;border:var(--border-light);border-radius:6px;background:var(--bg-deep);color:var(--text-primary);font:inherit}.title-editor input:focus-visible{outline:2px solid var(--accent-primary);outline-offset:2px}.title-editor p{font-size:11px;line-height:1.6;color:var(--text-muted);margin-top:9px}.title-editor .title-error{color:var(--error)}.title-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}.title-actions .danger-link{font-size:11px;padding:8px}.request-preview{font-size:10px;line-height:1.5;color:var(--text-muted);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}

.session-explanation{font-size:11px;line-height:1.6;color:var(--text-muted);margin:0 0 16px}.service-label{font-size:10px;line-height:1.5;color:#c4b5fd}.service-explanation{font-size:12px;line-height:1.7;color:var(--text-secondary);padding:12px 16px;background:var(--bg-tertiary);border-left:3px solid #a78bfa;border-radius:6px;margin:0 0 16px}

.monitor{height:100%;display:flex;flex-direction:column;overflow:auto;background:var(--bg-deep);font-size:14px}.connection-bar{display:flex;align-items:center;gap:24px;min-height:60px;padding:12px 24px;border-bottom:var(--border-light);background:var(--bg-secondary);flex-shrink:0}.brand{color:var(--text-primary);font-weight:650;display:flex;align-items:center;gap:10px}.brand small{font-size:10px;letter-spacing:1px;color:var(--text-muted);margin-left:6px}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:7px;background:var(--accent-gradient)}.connection-status{display:flex;align-items:center;gap:7px;font:11px var(--font-mono);color:var(--text-muted);margin-left:auto}.connection-status i{width:7px;height:7px;background:var(--warning);border-radius:50%}.connection-status i.connected{background:var(--success)}.subtle-link,.legacy-link{font-size:12px;color:var(--text-secondary)}.workspace-heading{padding:28px 28px 18px;display:flex;align-items:center;justify-content:space-between;gap:20px}.workspace-heading h1{font-size:24px;margin:6px 0 8px}.eyebrow{font:10px var(--font-mono);letter-spacing:1.3px;color:var(--accent-primary)}.tabs{display:flex;gap:4px;padding:0 28px;border-bottom:var(--border-light);overflow:auto;flex-shrink:0}.tabs button{padding:12px 20px;color:var(--text-muted);white-space:nowrap;border-bottom:2px solid transparent}.tabs button.active{border-bottom-color:var(--accent-primary);color:var(--text-primary);background:var(--accent-glow)}.metrics{display:grid;grid-template-columns:repeat(4,1fr);padding:20px 28px;gap:16px;flex-shrink:0}.metrics>div,.usage-metrics>div{padding:16px 20px;background:var(--bg-secondary);border:var(--border-subtle);border-radius:8px;display:flex;flex-direction:column;gap:7px}.metrics span,.usage-metrics span{font-size:11px;color:var(--text-muted)}.metrics strong{font:27px var(--font-mono);font-weight:600}.metrics .small-stat{font:14px var(--font-sans);padding:8px 0}.green{color:var(--success)}.workspace{display:grid;grid-template-columns:minmax(270px,340px) minmax(0,1fr);margin:0 28px 28px;border:var(--border-light);border-radius:10px;min-height:440px;flex:1;overflow:hidden;background:var(--bg-primary)}.session-list{border-right:var(--border-light);padding:16px;max-height:calc(100vh - 335px);min-height:440px;overflow:auto;background:var(--bg-secondary)}.list-heading,.panel-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.list-heading h2{font-size:14px}.list-heading small{color:var(--text-muted);font-weight:400}.icon-button{font-size:24px}.search{display:block;margin:14px 0}.search input{width:100%;background:var(--bg-deep);border:var(--border-light);padding:10px;border-radius:6px;font-size:12px;color:var(--text-primary)}.session-card{display:flex;flex-direction:column;gap:12px;width:100%;padding:16px;text-align:left;border:var(--border-light);border-radius:8px;background:var(--bg-tertiary);margin-bottom:10px;min-width:0;color:var(--text-primary)}.session-card.selected{border-color:var(--accent-primary);background:var(--accent-glow)}.session-card strong{font-size:13px;line-height:1.5;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.card-top,.card-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px}.badge{padding:4px 7px;background:var(--bg-elevated);border-radius:4px;font-size:10px;color:var(--text-secondary);white-space:nowrap;display:inline-flex}.badge.streaming{color:var(--success);background:var(--success-dim)}.badge.failed,.badge.incomplete{color:var(--warning);background:var(--warning-dim)}.shared-label{font-size:9px;color:var(--info)}.model,.card-bottom{font-size:10px;color:var(--text-muted)}.detail{min-width:0;padding:24px;max-height:calc(100vh - 335px);min-height:440px;overflow:auto}.detail-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.detail-heading h2{font-size:18px;line-height:1.5;overflow-wrap:anywhere;max-width:760px;margin-top:6px}.primary,.secondary{padding:10px 14px;min-height:38px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;white-space:nowrap}.primary{background:var(--accent-primary);color:white}.secondary{border:var(--border-light);background:var(--bg-tertiary);color:var(--text-primary)}.detail-meta{display:flex;gap:18px;flex-wrap:wrap;color:var(--text-muted);font-size:11px;padding:14px 0 20px}.detail-meta button{color:var(--info);margin-left:auto}.timeline{display:flex;flex-direction:column;gap:14px}.timeline-item{border:var(--border-light);border-radius:8px;background:var(--bg-secondary);border-left:3px solid var(--accent-primary);min-width:0}.timeline-item.reasoning{border-left-color:#a78bfa}.timeline-item.tool_call,.timeline-item.tool_result{border-left-color:#67e8f9}.timeline-item summary{padding:12px 16px;display:flex;align-items:center;gap:9px;cursor:pointer;font-size:12px;list-style:none;flex-wrap:wrap}.timeline-item summary::after{content:'⌄';color:var(--text-muted)}.timeline-item time{margin-left:auto;font:10px var(--font-mono);color:var(--text-muted)}.item-symbol{color:var(--accent-primary)}.item-body{padding:0 16px 16px}.item-body pre,.preview-content pre{background:none;padding:0;font:12px/1.75 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;color:var(--text-secondary);overflow:visible}.tool-name{color:var(--info);font-size:10px;overflow-wrap:anywhere}.streaming-label{font-size:10px;color:var(--success)}.notice,.error-banner{padding:12px 16px;border:1px solid #fbbf2433;background:var(--warning-dim);color:var(--warning);font-size:12px;border-radius:6px;margin-bottom:14px}.error-banner{margin:12px 28px 0;display:flex;justify-content:space-between;gap:12px}.empty{padding:32px 16px;text-align:center;color:var(--text-muted)}.empty p{font-size:12px;line-height:1.8;margin-top:12px}.empty.large{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:360px;gap:10px}.empty-icon{font-size:54px;color:var(--accent-primary)}.empty h2{font-size:18px}.section-label{font-size:13px;margin:20px 0 12px}.attempts{display:grid;gap:10px}.attempts article{border:var(--border-light);padding:14px;border-radius:6px;display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:11px}.attempts small{width:100%;color:var(--text-muted);overflow-wrap:anywhere}.event{border-bottom:var(--border-light);padding:10px 0;font-size:11px}.event summary{cursor:pointer;display:flex;justify-content:space-between}.event pre{margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px}.warning-text{color:var(--warning);font-size:10px}.shares{margin-top:24px;border-top:var(--border-light);padding-top:20px}.shares h3{font-size:13px;margin-bottom:10px}.shares>div{display:flex;justify-content:space-between;gap:14px;padding:8px 0;font-size:11px;color:var(--text-muted)}.danger-link{color:var(--error)}.wide-panel{margin:0 28px 28px;padding:26px;border:var(--border-light);border-radius:10px;background:var(--bg-secondary);min-height:430px}.wide-panel h2{font-size:20px;margin-bottom:10px}.wide-panel p{font-size:12px;line-height:1.8}.usage-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:25px 0}.usage-metrics>div{background:var(--bg-tertiary)}.usage-metrics strong{font:24px var(--font-mono)}.chart{height:210px;display:flex;align-items:flex-end;gap:12px;padding:20px 8px;border-bottom:var(--border-light);margin:10px 0 24px}.chart>div{flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:80px;min-width:16px}.bar{width:100%;background:var(--accent-gradient);border-radius:4px 4px 0 0;min-height:2px}.chart small{font:10px var(--font-mono);color:var(--text-muted)}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:11px}th,td{text-align:left;border-bottom:var(--border-light);padding:12px;color:var(--text-secondary)}th{color:var(--text-muted);font-weight:500}.legacy-stat{border-top:var(--border-light);margin-top:30px;padding-top:24px}.legacy-stat h3{font-size:14px}.legacy-stat pre{font-size:10px;max-height:240px;white-space:pre-wrap;overflow-wrap:anywhere}.compare-options{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0}.compare-options label{padding:10px;border:var(--border-light);border-radius:6px;font-size:11px;max-width:280px;overflow-wrap:anywhere;display:flex;gap:8px;align-items:flex-start}.compare-grid,.health-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:24px}.compare-grid article,.health-grid article{padding:20px;background:var(--bg-tertiary);border:var(--border-light);border-radius:8px;overflow-wrap:anywhere}.compare-grid h3{font-size:14px;line-height:1.6;margin-bottom:12px}.compare-grid strong{font:32px var(--font-mono);display:block;margin:20px 0 8px}.compare-grid button{margin-top:20px}.health-grid span{font-size:11px;color:var(--text-muted)}.health-grid h3{font-size:17px;margin:14px 0}.public-page{max-width:1100px;width:100%;margin:auto;padding:50px 28px}.public-heading{margin-bottom:36px}.public-heading h1{font-size:36px;margin:10px 0 16px;line-height:1.2}.public-heading p{max-width:730px;line-height:1.8}.public-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.public-grid h2{font-size:19px;line-height:1.6;overflow-wrap:anywhere}.public-grid .session-card{padding:24px;gap:20px}.public-total{margin:16px 0 24px;font:12px var(--font-mono)}footer{border-top:var(--border-light);padding-top:26px;margin-top:48px;display:flex;justify-content:space-between;gap:16px;color:var(--text-muted);font-size:12px}.modal-backdrop{position:fixed;inset:0;background:#000b;z-index:100;display:grid;place-items:center;padding:20px}.publish-dialog{background:var(--bg-secondary);border:var(--border-light);border-radius:12px;padding:24px;width:min(900px,100%);max-height:90vh;overflow:auto;box-shadow:var(--shadow-lg)}.publish-dialog h2{font-size:20px}.publish-dialog p{font-size:12px;line-height:1.8;margin:12px 0}.publish-options{display:flex;gap:16px;margin:20px 0}.publish-options label{flex:1;display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--text-muted)}.publish-options input,.publish-options select,.share-result input{padding:11px;border:var(--border-light);border-radius:6px;background:var(--bg-deep);color:var(--text-primary);width:100%}.preview-content{max-height:40vh;overflow:auto;padding:16px;border:var(--border-light);border-radius:6px;background:var(--bg-deep)}.preview-content article{margin-bottom:20px}.preview-content b{font-size:12px;display:block;margin-bottom:8px;color:var(--accent-primary)}.modal-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:20px}.share-result{margin-top:20px;display:grid;gap:10px;font-size:12px}.share-result input{margin-top:8px}.mobile-back{display:none}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
@media(max-width:900px){.brand small{display:none}.workspace-heading h1{font-size:21px}.metrics{gap:8px;padding:16px}.metrics>div{padding:12px}.metrics strong{font-size:21px}.workspace{margin:0 16px 20px;grid-template-columns:270px minmax(0,1fr)}.detail{padding:16px}.detail-heading{flex-direction:column}.compare-grid,.health-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.usage-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.wide-panel{margin:0 16px 20px;padding:20px}.connection-bar{padding:12px 16px;gap:12px}}
@media(max-width:650px){.connection-bar{flex-wrap:wrap;gap:10px}.brand{font-size:13px}.brand-mark{width:25px;height:25px}.connection-status{font-size:9px}.subtle-link{font-size:10px;margin-left:35px}.workspace-heading{padding:22px 16px 14px;display:block}.workspace-heading h1{font-size:22px}.workspace-heading p{font-size:12px;line-height:1.6}.legacy-link{display:inline-block;margin-top:14px}.tabs{padding:0 8px}.tabs button{font-size:12px;padding:12px}.metrics{grid-template-columns:repeat(2,1fr)}.metrics .small-stat{font-size:12px}.workspace{display:block;min-height:400px;flex:none}.session-list{max-height:none;min-height:400px;border:none;padding:12px}.detail{display:none;max-height:none;min-height:400px}.has-selection .session-list{display:none}.has-selection .detail{display:block}.mobile-back{display:block;font-size:12px;color:var(--info)}.detail-heading h2{font-size:16px}.detail-meta{font-size:10px;gap:10px}.detail-meta button{margin-left:0}.timeline-item summary{padding:12px;font-size:11px}.item-body{padding:0 12px 12px}.item-body pre{font-size:11px;line-height:1.8}.timeline-item time{font-size:9px}.tool-name{max-width:180px}.public-page{padding:32px 16px}.public-heading h1{font-size:30px}.public-heading p{font-size:12px}.public-grid{grid-template-columns:1fr}.public-grid .session-card{padding:20px}.public-page .panel-heading{align-items:flex-start}.public-page .panel-heading h2{font-size:18px;overflow-wrap:anywhere}.public-total{font-size:10px;line-height:1.8}.compare-grid,.health-grid{grid-template-columns:1fr}.usage-metrics strong{font-size:18px}.usage-metrics>div{padding:12px}.wide-panel{padding:16px}.chart{gap:5px}.chart small{font-size:8px}.publish-dialog{padding:18px}.publish-dialog h2{font-size:17px}.publish-options{flex-direction:column}.modal-backdrop{padding:10px}.modal-actions{flex-wrap:wrap}.modal-actions button{flex:1}footer{flex-direction:column;font-size:11px}.error-banner{margin:12px 16px 0}.empty.large{min-height:300px}}
</style>
