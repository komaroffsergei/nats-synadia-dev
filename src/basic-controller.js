import { AgentService } from "@synadia-ai/agent-service";
import {
  BASIC_AGENT,
  BASIC_OWNER,
  CONTROL_NAME,
  OLLAMA_MODEL,
  SERVICE_VERSION,
  connectNats,
  encodeJson,
  formatError,
  requirePrompt,
  streamOllama,
} from "./common.js";
import {
  DEFAULT_PERSONA_ID,
  MODERATOR_PERSONA_ID,
  PERSONAS,
  PERSONAS_BY_ID,
  publicPersonas,
  resolvePersona,
} from "./personas.js";

// Этот файл - главный runtime demo.
//
// В нём описаны ТРИ разных типа NATS agents:
//
// 1. Persona agents:
//    teacher / engineer / skeptic / manager / moderator.
//    Это обычные promptable agents. Их можно выбрать в UI, отправить им prompt,
//    они отвечают через Ollama и разные systemPrompt из src/personas.js.
//
// 2. Controller agent:
//    control.
//    Это тоже обычный Synadia AgentService, то есть он виден в discovery и имеет
//    prompt/status/heartbeat subjects. Отличие только в metadata.role="controller"
//    и extraEndpoints list/personas/review/group.create/group.list/group.stop.
//    UI по metadata.role понимает, что control не надо показывать как "человека"
//    с галочкой.
//
// 3. Dynamic group session agents:
//    group-1 / group-2 / ...
//    Их создаёт controller во время работы через endpoint group.create.
//    Это настоящие NATS agents:
//    они появляются в discovery, имеют свой prompt subject и хранят общий
//    контекст выбранной группы внутри controller process.
//
// Важно: Synadia/NATS protocol не знает "магического controller object".
// Controller здесь - это прикладная роль, которую мы обозначаем metadata.role.
// Транспорт остаётся тем же самым: NATS subjects + request/reply streaming.
//
// Этот файл намеренно ближе к Synadia Agent Protocol:
// - каждый "человек" из src/personas.js становится отдельным promptable agent;
// - controller остаётся отдельным agent-ом и может создавать group sessions;
// - basic persona group создаётся через controller как реальный NATS agent.
//
// Главное учебное отличие от прошлой версии:
// раньше controller на каждый prompt создавал временный session-agent;
// теперь persona agents живут постоянно, поэтому UI сразу видит карточки
// "Учитель", "Инженер", "Скептик", "Менеджер" через $SRV.INFO.agents.

// Все AgentService instances складываем сюда, чтобы:
// - стартовать их в одном месте;
// - остановить их в обратном порядке при SIGINT/SIGTERM;
// - показать их через controller list endpoint.
const services = [];

// Динамические group sessions живут в памяти controller process.
// Это намеренно учебный in-memory вариант:
// - легко увидеть, где именно controller "помнит" групповой контекст;
// - после перезапуска process группы исчезают;
// - если нужен durable context, этот Map можно заменить на NATS KV/JetStream.
const groupSessions = new Map();
let groupCounter = 0;

// Один NATS connection на весь backend process.
// Это проще для demo: controller и все persona agents живут в одном Node process,
// но в NATS они выглядят как отдельные discoverable services.
let nc;

// AgentService держит subscriptions/timers, но этот interval оставлен как
// явный "keep process alive" маркер. Так файл читается проще: main() стартует
// services и дальше процесс живёт до SIGINT/SIGTERM.
let holdProcessOpen;

function nowIso() {
  // ISO-строка удобна для UI, CLI и логов: её можно читать без локального formatter-а.
  return new Date().toISOString();
}

function controlSubject(verb) {
  // Extra endpoint controller-а оставляем в той же verb-first схеме:
  // agents.<verb>.basic.<owner>.control
  //
  // Примеры:
  // - agents.list.basic.demo.control
  // - agents.personas.basic.demo.control
  // - agents.review.basic.demo.control
  //
  // Эти subjects не являются обязательной частью Synadia protocol.
  // Это наши учебные служебные ручки вокруг controller-а.
  return `agents.${verb}.${BASIC_AGENT}.${BASIC_OWNER}.${CONTROL_NAME}`;
}

function parseJson(bytes) {
  // Extra endpoints получают сырой NATS payload, поэтому JSON разбираем вручную.
  // Пустой payload считаем пустым объектом: так `nats req ... ''` работает без шума.
  if (!bytes || bytes.length === 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

function serviceSnapshot(service, extra = {}) {
  // Compact snapshot для учебного list endpoint.
  // Это не часть базового Synadia protocol, а удобная ручка для наблюдения.
  // Важно, что subject берём из service.subject, а не собираем руками:
  // AgentService уже провалидировал токены и знает фактическую форму subjects.
  return {
    agent: BASIC_AGENT,
    owner: BASIC_OWNER,
    name: service.subject.name,
    prompt_subject: service.subject.prompt,
    status_subject: service.subject.status,
    heartbeat_subject: service.subject.heartbeat,
    listed_at: nowIso(),
    ...extra,
  };
}

function addJsonEndpoint(name, subject, handler) {
  // AgentService берёт на себя discovery/status/heartbeat, а extra endpoint
  // нужен только для маленьких служебных JSON-команд controller-а.
  //
  // @nats-io/services вызывает endpoint handler синхронно, поэтому async-код
  // запускается через void (async () => ...). Если handler бросает исключение,
  // превращаем его в NATS service error, чтобы CLI и UI получили понятную ошибку,
  // а не зависший request.
  return {
    name,
    subject,
    queue: "agents",
    metadata: { role: "controller" },
    handler: (_err, msg) => {
      void (async () => {
        try {
          const result = await handler(parseJson(msg.data));
          msg.respond(encodeJson(result));
        } catch (error) {
          msg.respondError(500, formatError(error));
        }
      })();
    },
  };
}

function normalizeReviewAnswers(rawAnswers) {
  // Controller review endpoint удобен для CLI/скриптов:
  // можно прислать либо массив [{ agent, text }], либо object { teacher: "..." }.
  // Внутри всё приводим к одному массиву блоков.
  //
  // Почему это находится в controller, а не в moderator:
  // moderator - обычный LLM agent, ему лучше получать уже готовый plain-text prompt.
  // Controller endpoint делает "прикладную упаковку" данных в удобный prompt.
  if (Array.isArray(rawAnswers)) {
    return rawAnswers
      .map((item, index) => ({
        agent: String(item?.agent ?? item?.name ?? `answer-${index + 1}`),
        text: String(item?.text ?? item?.answer ?? item?.content ?? "").trim(),
      }))
      .filter((item) => item.text.length > 0);
  }

  if (rawAnswers && typeof rawAnswers === "object") {
    return Object.entries(rawAnswers)
      .map(([agent, text]) => ({
        agent,
        text: String(text ?? "").trim(),
      }))
      .filter((item) => item.text.length > 0);
  }

  return [];
}

function buildReviewPrompt({ originalPrompt, criteria, answers }) {
  // Этот prompt - явный "контекстный пакет" для moderator agent.
  // Так видно, откуда у moderator появляется доступ к ответам других agents:
  // не магией shared memory, а обычной передачей transcript-а в prompt.
  //
  // Это важный учебный момент:
  // - teacher/engineer/skeptic не делят память между собой;
  // - UI или controller собирает их тексты;
  // - moderator получает эти тексты в prompt-е как входные данные.
  return [
    "Нужно оценить ответы нескольких агентов.",
    "",
    "Инструкция пользователя для оценки:",
    criteria,
    "",
    "Исходный вопрос пользователя:",
    originalPrompt || "(исходный вопрос не передан)",
    "",
    "Ответы агентов:",
    ...answers.map((answer, index) =>
      [
        "",
        `### ${index + 1}. ${answer.agent}`,
        answer.text,
      ].join("\n"),
    ),
    "",
    "Сделай краткий, но полезный разбор:",
    "1. Что общего в ответах.",
    "2. Где ответы расходятся или противоречат друг другу.",
    "3. Какой ответ самый полезный и почему.",
    "4. Итоговый синтез: что пользователю лучше принять как ответ.",
  ].join("\n");
}

function shortText(text, maxChars = 900) {
  // Для in-memory summary держим строки ограниченными.
  // Это не "умная память", а простой защитный предел, чтобы длинный ответ
  // одного agent-а не раздувал весь контекст на следующие turns.
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function groupSummaryFromTurns(turns, maxChars = 6000) {
  // Детерминированный summary без дополнительного LLM-вызова.
  //
  // Почему не просто "весь transcript":
  // каждый новый вопрос group session отправляет нескольким persona agents.
  // Если каждый раз пихать весь raw transcript, prompt быстро станет огромным.
  //
  // Поэтому group session хранит raw turns отдельно, а в prompt отдаёт:
  // - компактное summary последних turns;
  // - и текущий новый вопрос.
  const parts = [];
  for (const turn of turns.slice(-8)) {
    parts.push(`Вопрос: ${shortText(turn.prompt, 500)}`);
    for (const answer of turn.answers) {
      parts.push(`${answer.name}: ${shortText(answer.text, 650)}`);
    }
    if (turn.synthesis) {
      parts.push(`Итог: ${shortText(turn.synthesis, 800)}`);
    }
  }
  const text = parts.join("\n");
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function normalizePersonaIds(rawPersonas) {
  // group.create принимает список persona ids из UI:
  // ["teacher", "engineer", "skeptic"].
  //
  // Если список пустой, берём все обычные роли кроме moderator:
  // moderator лучше использовать как оценщика/синтезатора, а не как участника
  // каждого группового ответа по умолчанию.
  const fallback = PERSONAS
    .map((persona) => persona.id)
    .filter((id) => id !== MODERATOR_PERSONA_ID);
  const source = Array.isArray(rawPersonas) && rawPersonas.length > 0 ? rawPersonas : fallback;
  const unique = [...new Set(source.map((id) => String(id).trim()).filter(Boolean))];
  if (unique.length === 0) throw new Error("group requires at least one persona");
  for (const id of unique) {
    if (!PERSONAS_BY_ID.has(id)) throw new Error(`unknown group persona: ${id}`);
  }
  return unique;
}

function groupDescriptor(record) {
  // DTO для UI/CLI. instance_id появляется только после service.start().
  return {
    group_id: record.id,
    session_id: record.name,
    label: record.label,
    subject: record.service.subject.prompt,
    heartbeat_subject: record.service.subject.heartbeat,
    status_subject: record.service.subject.status,
    target_personas: record.personas.map((persona) => persona.id),
    summary_chars: record.summary.length,
    turn_count: record.turns.length,
    active_request: record.activeRequest,
    created_at: record.createdAt,
    last_activity: record.lastActivity,
    instance_id: record.service.instanceId,
  };
}

function buildGroupPersonaPrompt(record, persona, prompt) {
  // Prompt, который получает каждый участник group session.
  //
  // Главное отличие от обычного persona prompt:
  // сюда добавляется общий контекст группы, который хранится у controller-а.
  // Поэтому teacher/engineer/skeptic начинают учитывать прошлые групповые
  // вопросы и ответы, хотя сами persona agents своей общей памяти не имеют.
  const otherPersonas = record.personas
    .filter((item) => item.id !== persona.id)
    .map((item) => item.name)
    .join(", ");
  return [
    `Ты отвечаешь внутри групповой сессии "${record.label}".`,
    `Твоя роль в этой группе: ${persona.name} (${persona.tone}).`,
    otherPersonas ? `Другие участники группы: ${otherPersonas}.` : "Других участников нет.",
    "",
    record.summary
      ? ["Краткий общий контекст прошлых групповых turns:", record.summary].join("\n")
      : "Прошлого контекста в этой group session пока нет.",
    "",
    "Новый вопрос пользователя:",
    prompt,
    "",
    "Ответь по-русски только от своей роли. Не пересказывай весь контекст, используй его только если он помогает.",
  ].join("\n");
}

function buildGroupSynthesisPrompt(record, prompt, answers) {
  // После отдельных ответов group session просит moderator-а собрать итог.
  // Это ещё один обычный LLM prompt, просто он строится controller/session кодом.
  return buildReviewPrompt({
    originalPrompt: prompt,
    criteria:
      "Собери общий итог для group session: что сказали участники, где они расходятся, какой практический вывод принять.",
    answers: answers.map((answer) => ({
      agent: answer.name,
      text: answer.text,
    })),
  });
}

async function streamGroupAnswer(record, prompt, response) {
  // Основной runtime path динамической group session.
  //
  // Пользователь пишет в chat group-1:
  // - group session добавляет вопрос в контекст;
  // - последовательно вызывает выбранные persona prompts;
  // - собирает их ответы;
  // - просит moderator-а сделать синтез;
  // - сохраняет turn в памяти controller process.
  record.activeRequest = true;
  record.lastActivity = nowIso();
  const answers = [];
  let synthesis = "";

  await response.send(
    [
      `Group session: ${record.label}`,
      `Targets: ${record.personas.map((persona) => persona.name).join(", ")}`,
      `Context turns: ${record.turns.length}`,
      "",
    ].join("\n"),
  );

  try {
    for (const persona of record.personas) {
      const personaPrompt = buildGroupPersonaPrompt(record, persona, prompt);
      let text = "";
      await response.send(`\n\n## ${persona.name}\n`);
      for await (const chunk of streamOllama({ prompt: personaPrompt, systemPrompt: persona.systemPrompt })) {
        text += chunk;
        await response.send(chunk);
      }
      answers.push({
        id: persona.id,
        name: persona.name,
        text,
      });
    }

    const moderator = resolvePersona(MODERATOR_PERSONA_ID);
    const synthesisPrompt = buildGroupSynthesisPrompt(record, prompt, answers);
    await response.send("\n\n## Модератор: итог группы\n");
    for await (const chunk of streamOllama({ prompt: synthesisPrompt, systemPrompt: moderator.systemPrompt })) {
      synthesis += chunk;
      await response.send(chunk);
    }

    const turn = {
      id: `${record.id}-turn-${record.turns.length + 1}`,
      prompt,
      answers,
      synthesis,
      createdAt: nowIso(),
    };
    record.turns.push(turn);
    record.summary = groupSummaryFromTurns(record.turns);
    record.lastActivity = turn.createdAt;
  } finally {
    record.activeRequest = false;
  }
}

function createGroupSessionAgent(record) {
  // Динамический group session agent.
  //
  // Это именно тот случай "controller динамически создаёт session":
  // createControllerAgent() живёт постоянно, а createGroupSessionAgent()
  // вызывается по запросу group.create уже после старта процесса.
  const service = new AgentService({
    nc,
    agent: BASIC_AGENT,
    owner: BASIC_OWNER,
    name: record.name,
    session: record.label,
    version: SERVICE_VERSION,
    attachmentsOk: false,
    description: `Controller-managed group session: ${record.label}`,
    extraMetadata: {
      role: "session",
      session_type: "group",
      parent_controller: CONTROL_NAME,
      group_id: record.id,
      group_label: record.label,
      target_personas: record.personas.map((persona) => persona.id).join(","),
      platform: "synadia-agent-web-ui-demo",
    },
  });

  service.onPrompt(async (envelope, response) => {
    const prompt = requirePrompt(envelope.prompt);
    await streamGroupAnswer(record, prompt, response);
  });

  return service;
}

async function createGroupSession(payload) {
  // Controller endpoint `agents.group.create.basic.demo.control`.
  //
  // Payload:
  //   { "personas": ["teacher", "engineer"], "label": "..." }
  //
  // Возвращает descriptor, по которому UI может сразу открыть новую карточку.
  const personaIds = normalizePersonaIds(payload.personas ?? payload.targets ?? payload.target_personas);
  const personas = personaIds.map(resolvePersona);
  groupCounter += 1;
  const name = `group-${groupCounter}`;
  const label =
    String(payload.label ?? "").trim() ||
    `Группа #${groupCounter}: ${personas.map((persona) => persona.shortName).join(", ")}`;
  const record = {
    id: name,
    name,
    label,
    personas,
    turns: [],
    summary: "",
    activeRequest: false,
    createdAt: nowIso(),
    lastActivity: nowIso(),
    service: null,
  };
  const service = createGroupSessionAgent(record);
  record.service = service;
  await service.start();
  services.push(service);
  groupSessions.set(record.id, record);
  console.log(`[group] ${record.name}: ${service.subject.prompt}`);
  return groupDescriptor(record);
}

async function stopGroupSession(payload) {
  // Controller endpoint `agents.group.stop.basic.demo.control`.
  // Останавливает динамический group session agent и убирает его из discovery.
  const id = String(payload.group_id ?? payload.session_id ?? payload.name ?? "").trim();
  if (!id) throw new Error("group.stop requires group_id or session_id");
  const record =
    groupSessions.get(id) ??
    Array.from(groupSessions.values()).find((group) => group.name === id || group.label === id);
  if (!record) throw new Error(`group session not found: ${id}`);
  await record.service.stop();
  groupSessions.delete(record.id);
  const index = services.indexOf(record.service);
  if (index >= 0) services.splice(index, 1);
  return {
    stopped: true,
    group_id: record.id,
  };
}

function listGroupSessions() {
  return {
    groups: Array.from(groupSessions.values()).map(groupDescriptor),
  };
}

async function runReview(payload) {
  // Служебный controller endpoint:
  // UI обычно вызывает moderator напрямую, но через CLI удобно показать
  // ту же идею без браузера: передал набор ответов -> получил оценку.
  //
  // Этот endpoint намеренно не ходит в NATS к persona agents. Он принимает уже
  // готовые answers. Поэтому его удобно вызывать из nats CLI, тестов или другого
  // orchestration-кода, который сам собрал ответы.
  const answers = normalizeReviewAnswers(payload.answers);
  if (answers.length === 0) {
    throw new Error("review requires non-empty answers");
  }

  const criteria = String(
    payload.criteria ??
      payload.review_prompt ??
      "Сравни ответы, найди сильные стороны, противоречия и дай итоговый вывод.",
  ).trim();
  const originalPrompt = String(payload.original_prompt ?? payload.user_prompt ?? payload.prompt ?? "").trim();
  const moderator = resolvePersona(MODERATOR_PERSONA_ID);
  const prompt = buildReviewPrompt({ originalPrompt, criteria, answers });
  let review = "";

  for await (const chunk of streamOllama({ prompt, systemPrompt: moderator.systemPrompt })) {
    review += chunk;
  }

  return {
    moderator: MODERATOR_PERSONA_ID,
    criteria,
    original_prompt: originalPrompt,
    answers_count: answers.length,
    review,
  };
}

async function streamPersonaAnswer(persona, prompt, response, { intro = "" } = {}) {
  // Одна persona = один systemPrompt + один и тот же user prompt.
  // Вся "разность людей" появляется не из UI, а из systemPrompt конкретного agent-а.
  //
  // response - это streaming writer из @synadia-ai/agent-service.
  // Каждый response.send(chunk) уходит отдельным response chunk-ом в NATS stream.
  // Caller SDK/UI читает эти chunks постепенно и показывает "печатающийся" ответ.
  if (intro) {
    await response.send(intro);
  }

  for await (const chunk of streamOllama({ prompt, systemPrompt: persona.systemPrompt })) {
    await response.send(chunk);
  }
}

function createPersonaAgent(persona) {
  // Создаём один AgentService на одну роль.
  // В NATS discovery это будет отдельная карточка с собственным instance_id,
  // heartbeat subject и prompt subject.
  //
  // Например для teacher:
  // - agents.prompt.basic.demo.teacher
  // - agents.status.basic.demo.teacher
  // - agents.hb.basic.demo.teacher
  const service = new AgentService({
    // Эта комбинация задаёт главный prompt subject:
    // agents.prompt.basic.<owner>.<persona.id>
    nc,
    agent: BASIC_AGENT,
    owner: BASIC_OWNER,
    name: persona.id,
    session: persona.id,
    version: SERVICE_VERSION,
    attachmentsOk: false,
    description: `${persona.name}: ${persona.tone}; model ${OLLAMA_MODEL}`,
    extraMetadata: {
      // role=persona - наш прикладной marker для UI.
      // По нему UI понимает, что это "человек", которого можно выбрать галочкой.
      role: "persona",
      persona_id: persona.id,
      persona_name: persona.name,
      model: OLLAMA_MODEL,
      platform: "synadia-agent-web-ui-demo",
    },
  });

  service.onPrompt(async (envelope, response) => {
    // Это основной path из Synadia UI:
    // пользователь выбирает карточку persona agent и UI вызывает agent.prompt().
    const prompt = requirePrompt(envelope.prompt);
    await streamPersonaAnswer(persona, prompt, response);
  });

  return service;
}

function createControllerAgent() {
  // Здесь ОПИСЫВАЕТСЯ КОНТРОЛЛЕР.
  //
  // Технически это тот же AgentService, что и persona agents.
  // Отличия:
  // - name/session = "control";
  // - metadata.role = "controller";
  // - есть extraEndpoints list/personas/review/group.create/group.list/group.stop;
  // - prompt handler не является отдельной "личностью", а делегирует вопрос
  //   дефолтной persona, чтобы /basic из OpenClaw всегда имел стабильную точку входа.
  const defaultPersona = resolvePersona(DEFAULT_PERSONA_ID);
  const service = new AgentService({
    // Controller - это обычный discoverable agent, но metadata.role говорит UI
    // положить его в секцию Controllers, а не в список "людей" для галочек.
    nc,
    agent: BASIC_AGENT,
    owner: BASIC_OWNER,
    name: CONTROL_NAME,
    session: CONTROL_NAME,
    version: SERVICE_VERSION,
    attachmentsOk: false,
    description: "Controller for the local basic persona agents demo.",
    extraMetadata: {
      // Вот главный marker controller-а.
      // UI читает metadata.role и переносит такую карточку в секцию "Контроллеры".
      role: "controller",
      platform: "synadia-agent-web-ui-demo",
    },
    extraEndpoints: [
      // list - показать текущее состояние demo process:
      // сам controller + все persona services и их subjects.
      addJsonEndpoint("list", controlSubject("list"), async () => ({
        controller: serviceSnapshot(service, { role: "controller" }),
        personas: services
          .filter((item) => PERSONAS_BY_ID.has(item.subject.name))
          .map((item) =>
            serviceSnapshot(item, {
              role: "persona",
              persona_id: item.subject.name,
            }),
          ),
        groups: Array.from(groupSessions.values()).map(groupDescriptor),
      })),
      // personas - вернуть display catalog ролей без systemPrompt.
      // Это безопаснее, чем отдавать полный prompt каждой роли наружу как UI metadata.
      addJsonEndpoint("personas", controlSubject("personas"), async () => ({
        personas: publicPersonas(),
      })),
      // review - controller-level демонстрация "общего контекста":
      // caller передаёт ответы нескольких agents, controller упаковывает их в prompt
      // и запускает moderator systemPrompt через Ollama.
      addJsonEndpoint("review", controlSubject("review"), runReview),
      // group.create - ключевой пример динамического создания session.
      // Controller получает список persona ids и создаёт новый AgentService
      // с metadata.role="session", session_type="group".
      addJsonEndpoint("group-create", controlSubject("group.create"), createGroupSession),
      // group.list - показать динамические group sessions и их in-memory context size.
      addJsonEndpoint("group-list", controlSubject("group.list"), async () => listGroupSessions()),
      // group.stop - убрать динамический group session из NATS discovery.
      addJsonEndpoint("group-stop", controlSubject("group.stop"), stopGroupSession),
    ],
  });

  service.onPrompt(async (envelope, response) => {
    // Controller prompt сохраняем полезным для CLI/OpenClaw `/basic`.
    // Он не создаёт отдельный agent, а просто делегирует вопрос дефолтной persona.
    const prompt = requirePrompt(envelope.prompt);
    await streamPersonaAnswer(defaultPersona, prompt, response, {
      intro: [
        `Controller: ${CONTROL_NAME}`,
        `Delegated to: ${defaultPersona.name}`,
        `Direct prompt subject: agents.prompt.${BASIC_AGENT}.${BASIC_OWNER}.${defaultPersona.id}`,
        "",
      ].join("\n"),
    });
  });

  return service;
}

async function stopEverything() {
  // При Ctrl+C аккуратно снимаем NATS services, чтобы discovery не показывал
  // старые карточки до истечения heartbeat timeout.
  if (holdProcessOpen) clearInterval(holdProcessOpen);

  for (const service of [...services].reverse()) {
    try {
      await service.stop();
    } catch (error) {
      console.warn(`[controller] stop failed for ${service.subject.name}: ${formatError(error)}`);
    }
  }

  if (nc) await nc.drain();
}

async function main() {
  // 1. Подключаемся к NATS.
  //    NATS_URL берётся из .env или default nats://127.0.0.1:4222.
  nc = await connectNats("basic-controller");

  // 2. Создаём controller первым, чтобы он был services[0] и чтобы list endpoint
  //    мог видеть persona services после их добавления в массив.
  services.push(createControllerAgent());

  // 3. На каждую persona создаём отдельный AgentService.
  //    Это не "виртуальные роли" внутри одного handler-а, а реальные NATS services.
  for (const persona of PERSONAS) {
    services.push(createPersonaAgent(persona));
  }

  // 4. Стартуем services. После start() они отвечают на $SRV.INFO.agents,
  //    публикуют heartbeats и принимают prompt requests.
  for (const service of services) {
    await service.start();
  }

  // 5. Печатаем subjects. Это самая быстрая подсказка, куда слать nats req.
  console.log(`[controller] ${services[0].subject.prompt}`);
  console.log(`[controller] ${controlSubject("list")}`);
  console.log(`[controller] ${controlSubject("personas")}`);
  console.log(`[controller] ${controlSubject("review")}`);
  console.log(`[controller] ${controlSubject("group.create")}`);
  console.log(`[controller] ${controlSubject("group.list")}`);
  console.log(`[controller] ${controlSubject("group.stop")}`);
  for (const service of services.slice(1)) {
    console.log(`[persona] ${service.subject.name}: ${service.subject.prompt}`);
  }
  console.log("[ui] bridge: npm run ui:bridge");
  console.log("[ui] vite:   npm run ui:vite");
  console.log("[ui] prod:   npm run ui");

  process.once("SIGINT", () => {
    void stopEverything().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void stopEverything().finally(() => process.exit(0));
  });

  holdProcessOpen = setInterval(() => {}, 60_000);
}

main().catch((error) => {
  console.error(`[controller] failed: ${formatError(error)}`);
  process.exitCode = 1;
});
