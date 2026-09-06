// Deterministic dry-run formatter shared by the original worker and the public demo.
export function dryAnalysis(job) {
  const issue = job.issue || {};
  return [
    "Краткий анализ задачи:",
    `- Задача: ${job.issueId}`,
    `- Событие: ${job.event || "(unknown)"}`,
    `- Summary: ${issue.summary || "(empty)"}`,
    "",
    "Проверка полноты:",
    issue.description ? "- Описание есть, можно анализировать детали." : "- Описание пустое, нужен контекст от автора.",
    "",
    "Риски:",
    "- Dry-run режим не вызывал реальный Codex и не проверял кодовую базу.",
    "",
    "Вопросы:",
    issue.description ? "- Явных блокирующих вопросов на dry-run этапе нет." : "- Какой ожидаемый результат и где воспроизводится проблема?",
    "",
    "Next steps:",
    "- Уточнить недостающие детали в YouTrack.",
    "- Запустить worker без CODEX_DRY_RUN для полноценного анализа.",
  ].join("\n");
}

