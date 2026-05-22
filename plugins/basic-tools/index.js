import { connect } from "@nats-io/transport-node";
import { Agents, parseNatsUrl } from "@synadia-ai/agents";
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// Это маленький OpenClaw plugin поверх нашего NATS demo.
//
// Цепочка вызова для команды:
//   пользователь пишет в OpenClaw: /basic что такое controller?
//   -> OpenClaw вызывает handler команды `basic`
//   -> handler вызывает askBasicController(prompt)
//   -> askBasicController через @synadia-ai/agents ищет agent basic/demo/control
//   -> controller получает prompt по NATS
//   -> controller делегирует ответ дефолтной persona `teacher`
//   -> поток ответа возвращается обратно в OpenClaw.
//
// Важно: plugin не импортирует src/basic-controller.js напрямую.
// Между ними только NATS protocol, поэтому OpenClaw может жить отдельным процессом.
const DEFAULT_NATS_URL = "nats://127.0.0.1:4222";
const DEFAULT_OWNER = "demo";

function env(name, defaultValue) {
  // Локальный helper повторяет поведение src/common.js, но plugin лежит отдельно
  // и не зависит от внутренних файлов demo. Так plugin остаётся маленьким и
  // переносимым: ему нужны только NATS_URL/BASIC_OWNER.
  const value = process.env[name];
  return value && value.trim() ? value : defaultValue;
}

async function askBasicController(prompt) {
  // Эта функция делает один полный request/response cycle в Synadia Agent Protocol.
  //
  // Здесь не нужно руками собирать subject `agents.prompt.basic.demo.control`:
  // SDK `Agents.discover()` сам находит service по metadata и возвращает объект,
  // у которого уже есть удобный `.prompt(...)`.
  const natsUrl = env("NATS_URL", DEFAULT_NATS_URL);
  const owner = env("BASIC_OWNER", DEFAULT_OWNER);
  const nc = await connect({
    ...parseNatsUrl(natsUrl),
    name: "openclaw-basic-tool",
  });
  const agents = new Agents({
    nc,
    // Модель может отвечать дольше обычного HTTP request-а.
    // Поэтому timeout делаем явным и достаточно большим для локальной Ollama.
    streamInactivityTimeoutMs: 180_000,
  });

  try {
    // Discovery фильтр - это место, где plugin выбирает именно controller:
    // agent=basic, owner=<demo>, name=control.
    //
    // Если BASIC_OWNER поменяли, OpenClaw должен запускаться с тем же owner,
    // иначе он будет искать другой namespace и controller не найдётся.
    const found = await agents.discover({
      timeoutMs: 2_000,
      filter: {
        agent: "basic",
        owner,
        name: "control",
      },
    });

    if (found.length === 0) {
      throw new Error(`basic controller not found: agents.prompt.basic.${owner}.control`);
    }

    // found[0].prompt() публикует request на prompt subject controller-а.
    // Ответ приходит как async stream: controller может присылать несколько
    // chunks, а OpenClaw command собирает их в один итоговый текст.
    const stream = await found[0].prompt(prompt, {
      inactivityTimeoutMs: 180_000,
      maxWaitMs: 600_000,
    });

    let text = "";
    for await (const message of stream) {
      // Нас интересуют только response chunks.
      // Protocol ещё может нести status/query/tool events, но этот учебный
      // plugin показывает самый простой happy path.
      if (message.type === "response") text += message.text;
    }
    return text;
  } finally {
    // OpenClaw вызывает команду короткими задачами, поэтому соединение закрываем
    // после каждого вызова. Для high-throughput plugin можно было бы держать
    // nc/agents глобально, но для учебного примера так проще читать.
    await agents.close();
    await nc.close();
  }
}

export default definePluginEntry({
  id: "basic-tools",
  name: "Basic Tools",
  description: "Calls the minimal Synadia NATS controller/persona demo.",
  register(api) {
    // Tool - это то, что LLM внутри OpenClaw может вызвать как инструмент,
    // если runtime поддерживает tool calling. Пользователь напрямую его обычно
    // не пишет, но tool полезен для agentic сценариев.
    api.registerTool({
      name: "basic_ask",
      description: "Ask the minimal NATS controller, which delegates to the default persona agent.",
      parameters: Type.Object({
        prompt: Type.String({
          description: "Question or instruction for the default persona agent.",
        }),
      }),
      execute: async (_id, { prompt }) => ({
        content: [{ type: "text", text: await askBasicController(String(prompt ?? "")) }],
      }),
    });

    // Command - это ручная slash-команда в OpenClaw.
    // Пример:
    //   /basic объясни controller простыми словами
    //
    // channels:["nats"] говорит OpenClaw, что команда относится к nats channel.
    api.registerCommand({
      name: "basic",
      description: "Run the minimal NATS controller/persona demo.",
      acceptsArgs: true,
      channels: ["nats"],
      requireAuth: false,
      handler: async ({ args }) => {
        const prompt = String(args ?? "").trim();
        if (!prompt) return { text: "Usage: /basic <prompt>" };
        return { text: await askBasicController(prompt) };
      },
    });
  },
});
