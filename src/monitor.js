import { connectNats, decodeUtf8, formatError, tryDecodeJson } from "./common.js";

// Очень простой учебный monitor NATS traffic-а.
//
// Он не участвует в работе controller-а и agents.
// Его задача - показать глазами, какие subjects реально бегают по NATS:
// - agents.prompt.*    пользовательские prompt request-ы;
// - agents.hb.*        heartbeats от AgentService;
// - agents.status.*    status/discovery request-ы;
// - _INBOX.*           reply subjects для request/reply.
function messageKind(subject) {
  // Грубая классификация только для красивого вывода в терминал.
  // Transport остаётся тем же самым NATS subject-ом, мы ничего не парсим глубоко.
  if (subject.startsWith("agents.hb.")) return "heartbeat";
  if (subject.startsWith("agents.prompt.")) return "prompt";
  if (subject.startsWith("agents.spawn.")) return "spawn";
  if (subject.startsWith("agents.list.")) return "list";
  if (subject.startsWith("agents.group.")) return "group";
  if (subject.startsWith("agents.personas.")) return "personas";
  if (subject.startsWith("agents.stop.")) return "stop";
  if (subject.startsWith("agents.status.")) return "status";
  if (subject.startsWith("_INBOX.")) return "reply";
  if (subject.startsWith("$SRV.")) return "service";
  return "message";
}

function formatPayload(data) {
  // Payload может быть JSON, plain text или пустым.
  // Для обучения удобнее красиво печатать JSON, но не падать на обычной строке.
  if (!data || data.length === 0) return "<empty>";

  const decoded = tryDecodeJson(data);
  if (decoded.ok) return JSON.stringify(decoded.value, null, 2);
  return decodeUtf8(data);
}

async function main() {
  // Подписка ">" означает "все subjects".
  // Это удобно локально, но в production так делать шумно и дорого.
  const nc = await connectNats("basic-monitor");
  const sub = nc.subscribe(">");
  await nc.flush();

  console.log("[monitor] listening on >");

  for await (const msg of sub) {
    // msg.reply показывает, что это request/reply вызов.
    // Например prompt request приходит на agents.prompt.*, а ответ агент шлёт
    // в временный reply subject вида _INBOX...
    const reply = msg.reply ? ` reply=${msg.reply}` : "";
    console.log(`\n[${new Date().toISOString()}] ${messageKind(msg.subject)} ${msg.subject}${reply}`);
    console.log(formatPayload(msg.data));
  }
}

main().catch((error) => {
  console.error(`[monitor] failed: ${formatError(error)}`);
  process.exitCode = 1;
});
