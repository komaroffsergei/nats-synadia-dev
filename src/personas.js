// Здесь лежит список учебных "людей"-агентов.
// В runtime это не один большой group handler, а несколько настоящих NATS agents:
// teacher, engineer, skeptic, manager, moderator.
// Synadia UI видит их через discovery и может выбрать несколько карточек галочками.
// Один общий user prompt затем уходит каждому выбранному agent-у отдельно,
// а разный ответ получается из-за разного systemPrompt.
//
// Отдельная роль moderator нужна для второго шага:
// UI собирает уже готовые ответы teacher/engineer/skeptic/manager и передаёт
// их moderator-у как контекст, чтобы тот сравнил ответы по пользовательскому
// критерию и дал итоговую оценку.

export const MODERATOR_PERSONA_ID = "moderator";

export const PERSONAS = [
  {
    // Учитель нужен как "дефолтный безопасный голос".
    // Именно к нему controller делегирует `/basic <prompt>` из OpenClaw,
    // потому что для первого знакомства обычно полезнее простое объяснение,
    // чем критика или менеджерская сводка.
    id: "teacher",
    name: "Учитель",
    shortName: "Учитель",
    tone: "спокойно объясняет",
    color: "blue",
    systemPrompt:
      "Ты терпеливый учитель. Объясняй простыми словами, через бытовые примеры. Отвечай по-русски. Если вопрос технический, сначала дай простую аналогию, потом коротко назови реальные термины.",
  },
  {
    // Инженер отвечает ближе к runbook-у:
    // команды, проверки, ограничения, "что руками сделать дальше".
    id: "engineer",
    name: "Инженер",
    shortName: "Инженер",
    tone: "говорит практично",
    color: "green",
    systemPrompt:
      "Ты практичный инженер. Отвечай по-русски. Давай конкретные шаги, команды, ограничения и что проверить. Не украшай ответ, пиши как рабочую инструкцию.",
  },
  {
    // Скептик имитирует ревьюера.
    // Его удобно выбирать вместе с engineer/teacher, чтобы сразу увидеть
    // риски и слабые допущения в ответах других ролей.
    id: "skeptic",
    name: "Скептик",
    shortName: "Скептик",
    tone: "ищет риски",
    color: "amber",
    systemPrompt:
      "Ты скептик и ревьюер. Отвечай по-русски. Ищи слабые места, неочевидные риски, скрытые допущения и вопросы, которые надо уточнить перед реализацией.",
  },
  {
    // Менеджер не обязан глубоко решать технику.
    // Его роль - превратить обсуждение в критерии готовности и следующие шаги.
    id: "manager",
    name: "Менеджер",
    shortName: "Менеджер",
    tone: "сводит к решению",
    color: "violet",
    systemPrompt:
      "Ты менеджер проекта. Отвечай по-русски. Своди обсуждение к решению: цель, результат, кто что делает, какие следующие шаги и где критерий готовности.",
  },
  {
    // Moderator - тоже обычная persona, но UI использует её вторым шагом.
    // Сначала teacher/engineer/skeptic/manager независимо отвечают на вопрос.
    // Потом UI собирает эти ответы в один prompt и отправляет moderator-у.
    // Поэтому moderator "имеет доступ" к чужим ответам только потому,
    // что они явно переданы ему в prompt.
    id: MODERATOR_PERSONA_ID,
    name: "Модератор",
    shortName: "Модератор",
    tone: "сравнивает ответы",
    color: "cyan",
    systemPrompt:
      "Ты модератор и арбитр. Тебе дают исходный вопрос, ответы нескольких агентов и критерий оценки от пользователя. Отвечай по-русски. Сравни ответы, найди общее, противоречия, сильные и слабые места, укажи лучший ответ или собери итоговый синтез. Не выдумывай ответы агентов: опирайся только на переданный контекст.",
  },
];

// Быстрый lookup нужен controller-у и UI server-у, чтобы не писать
// одинаковую логику поиска роли по id в разных местах.
export const PERSONAS_BY_ID = new Map(PERSONAS.map((persona) => [persona.id, persona]));

// Первая роль используется как безопасный default для controller prompt.
// Это нужно для CLI/OpenClaw `/basic`, где пользователь обращается к controller-у,
// а controller уже делегирует вопрос дефолтной persona.
export const DEFAULT_PERSONA_ID = PERSONAS[0].id;

export function publicPersonas() {
  // System prompt не отдаём в UI как основной display data:
  // интерфейсу нужны названия и короткие описания, а полный prompt остаётся
  // внутренней настройкой агента. Это делает экран спокойнее.
  //
  // Если понадобится показывать/редактировать prompts в UI, лучше добавить
  // отдельный явный endpoint, а не случайно протаскивать systemPrompt во все карточки.
  return PERSONAS.map(({ id, name, shortName, tone, color }) => ({
    id,
    name,
    shortName,
    tone,
    color,
  }));
}

export function resolvePersona(id = DEFAULT_PERSONA_ID) {
  // Единственная строгая точка проверки persona id.
  // Если где-то в controller или CLI опечатались в id, ошибка появится сразу,
  // а не превратится в молчаливый fallback на неправильную роль.
  const persona = PERSONAS_BY_ID.get(id);
  if (!persona) {
    throw new Error(`unknown persona: ${id}`);
  }
  return persona;
}

export function resolvePersonaList(ids) {
  // Если ручной API ничего не выбрал, берём всех.
  // В Synadia UI основной групповой сценарий живёт в virtual session,
  // но helper оставляем полезным для CLI/тестов.
  //
  // Set убирает дубли: если caller передал ["teacher", "teacher"], модель
  // не будет дважды отвечать одной и той же ролью.
  const requested = Array.isArray(ids) && ids.length > 0 ? ids : PERSONAS.map((persona) => persona.id);
  const unique = [...new Set(requested.map((id) => String(id).trim()).filter(Boolean))];
  return unique.map(resolvePersona);
}
