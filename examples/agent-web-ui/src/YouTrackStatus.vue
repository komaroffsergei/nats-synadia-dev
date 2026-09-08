<script setup lang="ts">
import {onMounted,onUnmounted,ref} from 'vue';
const state=ref<any>(null),jobs=ref<any>(null),error=ref(''),busy=ref(false);
let timer:ReturnType<typeof setInterval>|undefined,disposed=false;
async function refresh(){
  if(busy.value)return;busy.value=true;
  try{
    const [s,j]=await Promise.all(['/youtrack/status','/youtrack/jobs/last'].map(async p=>{
      const r=await fetch(p);if(!r.ok)throw Error(r.status===401?'Нужен вход владельца':`Служба недоступна (${r.status})`);return r.json();
    }));
    if(!disposed){state.value=s;jobs.value=j;error.value='';}
  }catch(e){if(!disposed)error.value=(e as Error).message;}finally{busy.value=false;}
}
const access=(v:string)=>({set:'Настроен',missing:'Не настроен',not_required_mcp:'Через MCP',not_required_dry_run:'Тестовый режим'}[v]||'Нет данных');
onMounted(()=>{void refresh();timer=setInterval(()=>void refresh(),5000);});
onUnmounted(()=>{disposed=true;clearInterval(timer);});
</script>
<template>
  <main class="operations">
    <header><a href="/console/">← Codex Monitor</a><span>NATS / JETSTREAM</span></header>
    <h1>YouTrack → Codex worker</h1>
    <p>Webhook поступает в gateway, задача сохраняется в JetStream. Worker обрабатывает её, а gateway возвращает результат в YouTrack.</p>
    <p class="muted">Только наблюдение. Подключение к очереди не подтверждает успешное выполнение задачи или доступность модели.</p>
    <button :disabled="busy" @click="refresh">{{busy?'Обновление…':'Обновить'}}</button>
    <p v-if="error" role="alert">{{error}}</p>
    <template v-if="state">
      <section class="cards">
        <article><small>NATS</small><strong>{{state.nats?.connected?'Подключён':'Нет подключения'}}</strong></article>
        <article><small>Gateway</small><strong>{{state.gateway?.ok?'Готов':'Недоступен'}}</strong></article>
        <article><small>YouTrack</small><strong>{{access(state.gateway?.youtrack?.access)}}</strong><span>{{state.gateway?.dryRun?'Dry run':state.gateway?.youtrack?.mode}}</span></article>
      </section>
      <h2>Очередь {{state.gateway?.jetstream?.stream}}</h2>
      <div class="table"><table><thead><tr><th>Обработчик</th><th>В очереди</th><th>Ожидают подтверждения</th></tr></thead><tbody>
        <tr v-for="(consumer,key) in state.gateway?.jetstream?.consumers" :key="key"><td>{{consumer.name}}</td><td>{{consumer.numPending}}</td><td>{{consumer.numAckPending}}</td></tr>
      </tbody></table></div>
      <h2>Последние задания и результаты</h2>
      <p class="muted">Список хранится в памяти gateway с момента его запуска; это не полная история очереди.</p>
      <pre>{{JSON.stringify(jobs,null,2)}}</pre>
    </template>
  </main>
</template>
<style scoped>
.operations{width:min(1100px,100%);margin:0 auto;padding:24px;color:var(--text-primary,#eee);box-sizing:border-box}header{display:flex;justify-content:space-between;gap:12px;font-size:12px}a{color:#c4a5ff}h1{font-size:clamp(24px,4vw,38px);margin:30px 0 14px}p{line-height:1.6;max-width:800px}.muted,small{color:#a6a5b8}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:24px}article{padding:20px;border:1px solid #353443;border-radius:8px}article>*{display:block}strong{margin:12px 0;font-size:18px}h2{font-size:20px;margin-top:28px}button{background:#232131;color:#eee;border:1px solid #706098;padding:12px 20px;cursor:pointer;border-radius:6px}button:focus-visible,a:focus-visible{outline:2px solid #c4a5ff;outline-offset:4px}.table,pre{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}td,th{padding:12px;border-bottom:1px solid #353443}pre{padding:18px;background:#111018;max-height:350px;font-size:12px}@media(max-width:600px){.operations{padding:16px}.cards{grid-template-columns:1fr}header{flex-wrap:wrap}}
</style>
