import { connect } from "@nats-io/transport-node";
import { natsOptions } from "./nats-options.js";
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";

loadDotenv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export const SERVICE_VERSION = "0.2.0";
export const NATS_URL = env("NATS_URL", "nats://127.0.0.1:4222");

export function env(name, defaultValue = "") {
  const value = process.env[name];
  return value && value.trim() ? value : defaultValue;
}

export function envAny(names, defaultValue = "") {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value;
  }
  return defaultValue;
}

export function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export async function connectNats(name) {
  return connect({
    ...natsOptions(NATS_URL),
    name,
  });
}

export function encodeJson(value) {
  return textEncoder.encode(JSON.stringify(value));
}

export function decodeUtf8(bytes) {
  return textDecoder.decode(bytes);
}

export function tryDecodeJson(bytes) {
  const text = decodeUtf8(bytes);
  try {
    return { ok: true, value: JSON.parse(text), text };
  } catch {
    return { ok: false, value: null, text };
  }
}

export function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function compactText(text, maxChars = 4000) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}...`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function safeJson(value, maxChars = 12000) {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars - 1)}...`;
}
