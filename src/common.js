import { connect } from "@nats-io/transport-node";
import { parseNatsUrl } from "@synadia-ai/agents";
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";

// Общие настройки и маленькие helper-ы для всего demo.
//
// Почему они вынесены отдельно:
// - controller, persona agents и OpenClaw plugin должны использовать одну
//   subject-схему (`basic/demo/control`, `basic/demo/teacher`, ...);
// - NATS_URL / Ollama настройки должны читаться одинаково во всех backend files;
// - JSON/UTF-8 encoding лучше держать в одном месте, потому что NATS payload -
//   это bytes, а не JavaScript object.
loadDotenv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

// TextDecoder можно переиспользовать: NATS payload приходит bytes,
// а monitor/API часто нужно превратить его в строку.
const textDecoder = new TextDecoder();

// Эти constants задают базовую subject-схему проекта.
//
// Формула prompt subject в Synadia Agent Protocol:
//   agents.prompt.<agent>.<owner>.<name>
//
// В этом demo:
//   Controller: agents.prompt.basic.<owner>.control
//   Persona:    agents.prompt.basic.<owner>.<persona_id>
//
// `BASIC_OWNER` - это namespace владельца. По умолчанию `demo`.
// Если запустить несколько копий проекта в одном NATS, можно дать им разные
// BASIC_OWNER, и subjects не будут конфликтовать.
export const BASIC_AGENT = "basic";
export const BASIC_OWNER = env("BASIC_OWNER", "demo");
export const CONTROL_NAME = "control";
export const NATS_URL = env("NATS_URL", "nats://127.0.0.1:4222");
// Ollama здесь выступает как самый простой локальный model backend.
// Synadia/NATS отвечают только за транспорт и discovery, а текст генерирует
// именно этот HTTP endpoint.
export const OLLAMA_BASE_URL = env("OLLAMA_BASE_URL", "http://ollama.h100.local");
export const OLLAMA_MODEL = env("OLLAMA_MODEL", "qwen3.5:9b");
export const OLLAMA_TIMEOUT_MS = Number(env("OLLAMA_TIMEOUT_MS", "120000"));
export const SERVICE_VERSION = "0.1.0";

export function env(name, defaultValue = "") {
  // Пустую строку считаем отсутствующим значением.
  // Это удобно для .env, где переменную могли оставить пустой.
  const value = process.env[name];
  return value && value.trim() ? value : defaultValue;
}

export async function connectNats(name) {
  // Все процессы проекта подключаются к одному NATS_URL.
  // name виден в diagnostics NATS server и помогает понять, кто подключился.
  //
  // parseNatsUrl приходит из @synadia-ai/agents: он превращает строку вида
  // nats://127.0.0.1:4222 в options, которые понимает @nats-io/transport-node.
  return connect({
    ...parseNatsUrl(NATS_URL),
    name,
  });
}

export function encodeJson(value) {
  // NATS не знает про JS objects, только bytes.
  // Поэтому JSON всегда явно кодируем в UTF-8.
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeUtf8(bytes) {
  // Обратное преобразование bytes -> string для monitor и API.
  return textDecoder.decode(bytes);
}

export function tryDecodeJson(bytes) {
  // Безопасный parser нужен monitor-у: он должен красиво показать JSON,
  // но не падать, если payload оказался plain text.
  const text = decodeUtf8(bytes);
  try {
    return { ok: true, value: JSON.parse(text), text };
  } catch {
    return { ok: false, value: null, text };
  }
}

export function formatError(error) {
  // В catch может прилететь не только Error, но и string/number/object.
  // Для логов и NATS service errors нам всегда нужна строка.
  if (error instanceof Error) return error.message;
  return String(error);
}

export function requirePrompt(prompt) {
  // Пустой prompt не отправляем в Ollama.
  // Почти всегда это ошибка UI, CLI или вызывающего agent-а.
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }
  return prompt.trim();
}

export function chunkText(text, maxChars = 900) {
  // Нестримащий Ollama ответ режем на chunks, чтобы wire-shape был похож
  // на обычный streaming response и не упирался в max_payload.
  //
  // Это особенно удобно для UI: ему всё равно, включён ли реальный streaming
  // в Ollama, потому что response всё равно приходит несколькими кусками.
  const chunks = [];
  for (let index = 0; index < text.length; index += maxChars) {
    chunks.push(text.slice(index, index + maxChars));
  }
  return chunks;
}

export async function* streamOllama({ prompt, systemPrompt }) {
  // Единственное место, где проект ходит в модель.
  // Все persona различия задаются systemPrompt, а пользовательский prompt
  // остаётся одинаковым для выбранной группы агентов.
  //
  // Это async generator: caller может делать
  //   for await (const chunk of streamOllama(...))
  // и сразу отправлять chunk в NATS streaming response.
  //
  // Так устроены и persona agents, и moderator review.
  const baseUrl = OLLAMA_BASE_URL.replace(/\/+$/, "");
  const timeoutMs = Number.isFinite(OLLAMA_TIMEOUT_MS) ? OLLAMA_TIMEOUT_MS : 120_000;
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: env("OLLAMA_STREAM", "false").toLowerCase() === "true",
      think: env("OLLAMA_THINK", "false").toLowerCase() === "true",
      messages: [
        {
          // systemPrompt - то, что делает agent-а "Учителем", "Инженером",
          // "Скептиком" и т.д. Один и тот же user prompt с разными systemPrompt
          // даёт разные стили ответа.
          role: "system",
          content: systemPrompt,
        },
        { role: "user", content: prompt },
      ],
    }),
  }).catch((error) => {
    throw new Error(
      `Ollama недоступна: ${baseUrl}. Проверь: curl --noproxy '*' ${baseUrl}/api/tags. Причина: ${formatError(error)}`,
    );
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 404) {
      throw new Error(
        [
          `Ollama 404: ${baseUrl}/api/chat не найден.`,
          "Проверь OLLAMA_BASE_URL: это должен быть прямой Ollama HTTP endpoint, а не NATS bridge или UI host.",
          `Быстрая проверка: curl --noproxy '*' ${baseUrl}/api/tags`,
          `Ответ сервера: ${body.slice(0, 300)}`,
        ].join(" "),
      );
    }
    throw new Error(`Ollama ${response.status}: ${body.slice(0, 500)}`);
  }

  if (!response.body) {
    throw new Error("Ollama response has no body");
  }

  const isStream = env("OLLAMA_STREAM", "false").toLowerCase() === "true";
  if (!isStream) {
    // Non-streaming режим проще для первого запуска:
    // Ollama отдаёт один JSON, мы достаём текст и режем его на искусственные chunks.
    const payload = await response.json();
    const text = payload.message?.content || payload.response || "";
    for (const chunk of chunkText(text)) yield chunk;
    return;
  }

  // Streaming режим Ollama отдаёт newline-delimited JSON:
  // каждая строка - отдельный маленький event. Поэтому держим buffer между
  // чтениями stream-а, режем по \n и разбираем только полные строки.
  const reader = response.body.getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += textDecoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const payload = JSON.parse(trimmed);
      if (payload.error) throw new Error(payload.error);
      const text = payload.message?.content || payload.response || "";
      if (text) yield text;
      if (payload.done) return;
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    const payload = JSON.parse(trailing);
    if (payload.error) throw new Error(payload.error);
    const text = payload.message?.content || payload.response || "";
    if (text) yield text;
  }
}
