import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
} from "@nats-io/jetstream";
import { env } from "./common.js";

export const YT_CODEX_STREAM = env("YT_CODEX_STREAM", "YT_CODEX");
export const YT_CODEX_JOB_SUBJECT = env("YT_CODEX_JOB_SUBJECT", "youtrack.codex.jobs.giscloud");
export const YT_CODEX_RESULT_SUBJECT = env("YT_CODEX_RESULT_SUBJECT", "youtrack.codex.results.giscloud");
export const CODEX_WORKER_DURABLE = env("CODEX_WORKER_DURABLE", "codex-worker");
export const GATEWAY_RESULTS_DURABLE = env("YOUTRACK_GATEWAY_RESULTS_DURABLE", "youtrack-gateway-results");

const ACK_WAIT_NANOS = Number(env("YT_CODEX_ACK_WAIT_MS", "900000")) * 1_000_000;

export async function openJetStream(nc) {
  const jsm = await jetstreamManager(nc);
  await ensureStream(jsm);
  await ensureConsumer(jsm, CODEX_WORKER_DURABLE, YT_CODEX_JOB_SUBJECT, Number(env("CODEX_WORKER_MAX_ACK_PENDING", "1")));
  await ensureConsumer(jsm, GATEWAY_RESULTS_DURABLE, YT_CODEX_RESULT_SUBJECT, Number(env("YOUTRACK_GATEWAY_MAX_ACK_PENDING", "20")));
  return { js: jetstream(nc), jsm };
}

export async function jetStreamReadiness(nc) {
  try {
    const { jsm } = await openJetStream(nc);
    const stream = await jsm.streams.info(YT_CODEX_STREAM);
    const worker = await jsm.consumers.info(YT_CODEX_STREAM, CODEX_WORKER_DURABLE);
    const results = await jsm.consumers.info(YT_CODEX_STREAM, GATEWAY_RESULTS_DURABLE);
    return {
      ok: true,
      stream: stream.config.name,
      subjects: stream.config.subjects ?? [],
      consumers: {
        worker: {
          name: worker.name,
          numPending: worker.num_pending,
          numAckPending: worker.num_ack_pending,
        },
        results: {
          name: results.name,
          numPending: results.num_pending,
          numAckPending: results.num_ack_pending,
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ensureStream(jsm) {
  try {
    const info = await jsm.streams.info(YT_CODEX_STREAM);
    const subjects = new Set(info.config.subjects ?? []);
    let changed = false;
    for (const subject of [YT_CODEX_JOB_SUBJECT, YT_CODEX_RESULT_SUBJECT]) {
      if (!subjects.has(subject)) {
        subjects.add(subject);
        changed = true;
      }
    }
    if (changed) {
      await jsm.streams.update(YT_CODEX_STREAM, {
        ...info.config,
        subjects: [...subjects],
      });
    }
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  await jsm.streams.add({
    name: YT_CODEX_STREAM,
    subjects: [YT_CODEX_JOB_SUBJECT, YT_CODEX_RESULT_SUBJECT],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    max_msgs: Number(env("YT_CODEX_MAX_MSGS", "10000")),
    max_age: Number(env("YT_CODEX_MAX_AGE_HOURS", "168")) * 60 * 60 * 1_000_000_000,
  });
}

async function ensureConsumer(jsm, durableName, filterSubject, maxAckPending) {
  const config = {
    durable_name: durableName,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    filter_subject: filterSubject,
    ack_wait: ACK_WAIT_NANOS,
    max_ack_pending: Number.isFinite(maxAckPending) && maxAckPending > 0 ? maxAckPending : 1,
  };

  try {
    await jsm.consumers.info(YT_CODEX_STREAM, durableName);
    await jsm.consumers.update(YT_CODEX_STREAM, durableName, {
      ack_wait: config.ack_wait,
      filter_subject: config.filter_subject,
      max_ack_pending: config.max_ack_pending,
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await jsm.consumers.add(YT_CODEX_STREAM, config);
  }
}

function isNotFound(error) {
  if (!error || typeof error !== "object") return false;
  const message = error instanceof Error ? error.message : String(error);
  const code = error.code || error.api_error?.err_code || error.api_error?.code;
  return code === 404 || /not found/i.test(message);
}
