import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Скрипт подключает официальный Synadia OpenClaw NATS channel к локальному OpenClaw.
//
// Почему нужен runtime build:
// - npm package @synadia-ai/nats-channel лежит в node_modules;
// - OpenClaw удобнее грузить plugin по filesystem path;
// - мы не меняем vendor package, а собираем маленькую runtime-копию в
//   `.openclaw-nats-channel-runtime` и прописываем этот путь в ~/.openclaw/openclaw.json.
//
// Важно для пользователя: этот файл не трогает node_modules исходники.
// Он только читает dependency и создаёт локальный generated runtime.
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHANNEL_PACKAGE_ROOT = path.join(PROJECT_ROOT, "node_modules", "@synadia-ai", "nats-channel");
const RUNTIME_ROOT = path.join(PROJECT_ROOT, ".openclaw-nats-channel-runtime");
const RUNTIME_DIST = path.join(RUNTIME_ROOT, "dist");

const DEFAULT_NATS_CHANNEL_CONFIG = {
  accounts: {
    default: {
      enabled: true,
      // Должен совпадать с NATS_URL, где запущены controller/persona agents.
      url: process.env.NATS_URL || "nats://127.0.0.1:4222",
      // Это имя OpenClaw agent-а в NATS discovery, не имя нашего controller-а.
      agentName: "openclaw",
      // owner должен совпасть с BASIC_OWNER, если OpenClaw plugin/commands
      // должны видеть тот же demo namespace.
      owner: process.env.NATS_OWNER || process.env.BASIC_OWNER || "demo",
      description: "OpenClaw Synadia NATS demo",
    },
  },
};

function expandHome(filePath) {
  // OpenClaw CLI может печатать путь как ~/.openclaw/openclaw.json.
  // fs/promises ожидает настоящий absolute path, поэтому раскрываем ~ вручную.
  if (filePath === "~") return process.env.HOME;
  if (filePath.startsWith("~/")) return path.join(process.env.HOME, filePath.slice(2));
  return filePath;
}

function runOpenClaw(args, options = {}) {
  // Единственное место, где вызываем внешний `openclaw`.
  // stdio держим тихим, чтобы npm script выводил только наши итоговые подсказки.
  return execFileSync("openclaw", args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input: options.input,
  }).trim();
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readOptionalJson(filePath) {
  // Если config ещё не создан или повреждён, начинаем с пустого объекта.
  // Дальше buildOpenClawConfig аккуратно добавит нужные секции.
  try {
    return await readJson(filePath);
  } catch {
    return {};
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function assertDependencyInstalled() {
  // Перед сборкой проверяем именно published dependency.
  // Если npm install не запускали, ошибка должна быть понятной, а не esbuild ENOENT.
  try {
    await readJson(path.join(CHANNEL_PACKAGE_ROOT, "package.json"));
  } catch {
    throw new Error(
      "Не найден node_modules/@synadia-ai/nats-channel. Сначала запусти `npm install` в корне проекта.",
    );
  }
}

async function copyRuntimeMetadata(packageJson) {
  // Берём manifest из официального package и слегка расширяем schema account-а
  // полем `owner`. Это нужно, чтобы OpenClaw channel и наш demo использовали
  // один owner namespace в NATS subjects.
  const manifest = await readJson(path.join(CHANNEL_PACKAGE_ROOT, "openclaw.plugin.json"));
  const accountSchema =
    manifest.configSchema?.properties?.nats?.properties?.accounts?.additionalProperties ?? {};
  accountSchema.properties = {
    ...(accountSchema.properties ?? {}),
    owner: {
      type: "string",
      description: "Owner namespace for subject isolation",
    },
  };
  accountSchema.additionalProperties = false;

  const natsSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      accounts: {
        type: "object",
        additionalProperties: accountSchema,
      },
    },
    additionalProperties: false,
  };

  await writeFile(
    path.join(RUNTIME_ROOT, "openclaw.plugin.json"),
    JSON.stringify(
      {
        ...manifest,
        // channelConfigs - schema для OpenClaw config UI/validation.
        // Мы оставляем официальную структуру, но добавляем поддержку owner.
        channelConfigs: {
          ...(manifest.channelConfigs ?? {}),
          nats: {
            schema: natsSchema,
          },
        },
      },
      null,
      2,
    ),
  );
  await copyFile(path.join(CHANNEL_PACKAGE_ROOT, "README.md"), path.join(RUNTIME_ROOT, "README.md"));

  await writeFile(
    path.join(RUNTIME_ROOT, "package.json"),
    JSON.stringify(
      {
        ...packageJson,
        private: true,
        description: `${packageJson.description} (runtime build generated from npm dependency)`,
      },
      null,
      2,
    ),
  );
}

async function buildRuntime() {
  // Каждый запуск пересобирает runtime с нуля.
  // Это защищает от stale build-а после npm update @synadia-ai/nats-channel.
  const packageJson = await readJson(path.join(CHANNEL_PACKAGE_ROOT, "package.json"));

  await rm(RUNTIME_ROOT, { recursive: true, force: true });
  await mkdir(RUNTIME_DIST, { recursive: true });
  await copyRuntimeMetadata(packageJson);

  const sharedBuildOptions = {
    // bundle=true даёт OpenClaw один простой ESM файл вместо дерева TS sources.
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent",
    external: ["openclaw"],
  };

  await build({
    ...sharedBuildOptions,
    entryPoints: [path.join(CHANNEL_PACKAGE_ROOT, "index.ts")],
    outfile: path.join(RUNTIME_DIST, "index.js"),
  });

  await build({
    ...sharedBuildOptions,
    entryPoints: [path.join(CHANNEL_PACKAGE_ROOT, "setup-entry.ts")],
    outfile: path.join(RUNTIME_DIST, "setup-entry.js"),
  });
}

function readOpenClawConfigPath() {
  try {
    // Сначала спрашиваем OpenClaw, где его config.
    // Это лучше, чем всегда предполагать ~/.openclaw/openclaw.json.
    const output = runOpenClaw(["--no-color", "config", "file"]);
    const candidates = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith("openclaw.json"));
    const configPath = candidates.at(-1);
    if (configPath) return expandHome(configPath);
  } catch {
    // Если config уже невалиден из-за удалённого plugin path, CLI не отдаёт путь.
  }

  return path.join(process.env.HOME, ".openclaw", "openclaw.json");
}

function buildOpenClawConfig(config) {
  // Эта функция чисто преобразует старый openclaw.json в новый.
  // Никакого IO внутри: так проще проверить глазами, что именно меняется.
  const currentPaths = config.plugins?.load?.paths ?? [];
  const currentNats = config.channels?.nats ?? {};
  const currentAccounts = currentNats.accounts ?? {};
  const currentDefault = currentAccounts.default ?? {};
  const normalizedRuntime = path.resolve(RUNTIME_ROOT);
  const nextPaths = currentPaths
    .map((entry) => path.resolve(String(entry)))
    // Убираем старую копию этого же runtime, чтобы path не дублировался.
    .filter((entry) => entry !== normalizedRuntime)
    // Убираем stale path по basename на случай, если проект переносили.
    .filter((entry) => path.basename(entry) !== ".openclaw-nats-channel-runtime");

  nextPaths.push(normalizedRuntime);

  return {
    ...config,
    channels: {
      ...(config.channels ?? {}),
      nats: {
        ...currentNats,
        accounts: {
          ...currentAccounts,
          default: {
            // Defaults задают рабочий минимум для demo, а currentDefault ниже
            // сохраняет пользовательские поля, если они уже были в config.
            ...DEFAULT_NATS_CHANNEL_CONFIG.accounts.default,
            ...currentDefault,
            // Эти поля принудительно включаем, потому что цель скрипта -
            // сделать NATS channel готовым к запуску прямо сейчас.
            enabled: true,
            agentName: "openclaw",
            owner: process.env.NATS_OWNER || process.env.BASIC_OWNER || "demo",
            description: "OpenClaw Synadia NATS demo",
          },
        },
      },
    },
    plugins: {
      ...(config.plugins ?? {}),
      entries: {
        ...(config.plugins?.entries ?? {}),
        nats: {
          // Включаем plugin entry `nats`, который объявлен в manifest runtime-а.
          enabled: true,
        },
      },
      load: {
        ...(config.plugins?.load ?? {}),
        paths: nextPaths,
      },
    },
  };
}

async function configureOpenClaw() {
  // Финальный шаг: нашли config path, прочитали текущий JSON, записали новый JSON.
  const configPath = readOpenClawConfigPath();
  const config = await readOptionalJson(configPath);
  await writeJson(configPath, buildOpenClawConfig(config));
}

async function main() {
  await assertDependencyInstalled();
  await buildRuntime();
  await configureOpenClaw();

  console.log(`[openclaw:nats] runtime: ${RUNTIME_ROOT}`);
  console.log("[openclaw:nats] OpenClaw config теперь грузит официальный @synadia-ai/nats-channel runtime");
}

main().catch((error) => {
  console.error(`[openclaw:nats] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
