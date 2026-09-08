import { connectNats, decodeUtf8, formatError, tryDecodeJson } from "./common.js";

// Очень простой учебный monitor NATS traffic-а.
//
// Он не участвует в работе gateway-а, worker-а и agents.
// Его задача - показать глазами, какие subjects реально бегают по NATS:
// - youtrack.codex.*   JetStream jobs/results;
// - _INBOX.*           reply subjects для request/reply.
function messageKind(subject) {
  // Грубая классификация только для красивого вывода в терминал.
  // Transport остаётся тем же самым NATS subject-ом, мы ничего не парсим глубоко.
  if (subject.startsWith("youtrack.codex.jobs.")) return "codex-job";
  if (subject.startsWith("youtrack.codex.results.")) return "codex-result";
  if (subject.startsWith("youtrack.messages.")) return "youtrack-chat";
  if (subject.startsWith("_INBOX.")) return "reply";
  if (subject.startsWith("$SRV.")) return "service";
  if (subject.startsWith("$JS.")) return "jetstream";
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
  const nc = await connectNats("youtrack-codex-monitor");
  const sub = nc.subscribe(">");
  await nc.flush();

  console.log("[monitor] listening on >");

  for await (const msg of sub) {
    // msg.reply показывает, что это request/reply вызов.
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
