import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Скрипт прописывает наш локальный OpenClaw plugin `plugins/basic-tools`
// в пользовательский ~/.openclaw/openclaw.json.
//
// Он не собирает TypeScript и не меняет vendor code: basic-tools уже маленький
// ESM plugin, который OpenClaw может загрузить напрямую по path.
//
// Зачем отдельный script, а не править config руками:
// - OpenClaw config path может отличаться;
// - старые paths от прошлых экспериментов надо убрать, иначе CLI может пытаться
//   загрузить удалённый plugin;
// - повторный запуск должен быть idempotent.
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ROOT = path.join(PROJECT_ROOT, "plugins", "basic-tools");

function expandHome(filePath) {
  // CLI часто возвращает путь с ~, Node fs - нет.
  if (filePath === "~") return process.env.HOME;
  if (filePath.startsWith("~/")) return path.join(process.env.HOME, filePath.slice(2));
  return filePath;
}

function runOpenClaw(args, options = {}) {
  // Запускаем OpenClaw только чтобы спросить путь config-а.
  // Если config сейчас битый, catch ниже вернёт default path.
  return execFileSync("openclaw", args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input: options.input,
  }).trim();
}

async function readJson(filePath) {
  // Пустой объект - нормальное стартовое состояние:
  // OpenClaw сам создаст config позже, либо мы создадим нужные секции сейчас.
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readOpenClawConfigPath() {
  try {
    // Предпочитаем реальный config path из CLI.
    // Это важно, если OpenClaw когда-нибудь поддержит нестандартный config dir.
    const output = runOpenClaw(["--no-color", "config", "file"]);
    const configPath = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith("openclaw.json"))
      .at(-1);
    if (configPath) return expandHome(configPath);
  } catch {
    // Если config уже невалиден из-за старого plugin path, CLI не отдаёт путь.
  }

  return path.join(process.env.HOME, ".openclaw", "openclaw.json");
}

async function main() {
  // 1. Находим и читаем OpenClaw config.
  const configPath = readOpenClawConfigPath();
  const config = await readJson(configPath);
  const normalizedPlugin = path.resolve(PLUGIN_ROOT);

  // 2. Убираем старый plugin entry от предыдущего newsroom demo.
  //    Иначе в OpenClaw останется включённый entry, которого уже нет в проекте.
  const entries = { ...(config.plugins?.entries ?? {}) };
  delete entries["newsroom-tools"];

  // 3. Нормализуем plugin paths:
  //    - убираем текущий путь, чтобы не дублировать;
  //    - убираем любой basename basic-tools от старого расположения;
  //    - для paths внутри текущего PROJECT_ROOT/plugins оставляем только те,
  //      которые реально существуют.
  const nextPaths = (config.plugins?.load?.paths ?? [])
    .map((entry) => path.resolve(String(entry)))
    .filter((entry) => entry !== normalizedPlugin)
    .filter((entry) => path.basename(entry) !== "basic-tools")
    .filter((entry) => !entry.startsWith(path.join(PROJECT_ROOT, "plugins")) || existsSync(entry));

  nextPaths.push(normalizedPlugin);

  // 4. Включаем entry `basic-tools` и записываем обновлённый config.
  //    После этого OpenClaw сможет показать command `/basic` и tool `basic_ask`.
  const nextConfig = {
    ...config,
    plugins: {
      ...(config.plugins ?? {}),
      entries: {
        ...entries,
        "basic-tools": {
          enabled: true,
        },
      },
      load: {
        ...(config.plugins?.load ?? {}),
        paths: nextPaths,
      },
    },
  };

  await writeJson(configPath, nextConfig);
  console.log(`[openclaw:tools] plugin: ${PLUGIN_ROOT}`);
}

main().catch((error) => {
  console.error(`[openclaw:tools] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
