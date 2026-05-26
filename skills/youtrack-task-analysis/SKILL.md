# YouTrack Task Analysis

Use this skill when Codex is asked to analyze a YouTrack issue created or updated by webhook.

## Output

Write a compact Russian analysis with these sections:

1. `Краткий смысл` - what the task appears to ask for.
2. `Полнота описания` - whether the summary, description, changed fields, and webhook data are enough.
3. `Риски` - implementation, product, operational, or ambiguity risks.
4. `Вопросы` - concrete questions only when information is missing.
5. `Next steps` - practical next actions for the assignee or requester.

## Rules

- Base the analysis only on the issue data and webhook JSON provided in the prompt.
- Separate documented facts from assumptions.
- Keep it short enough for a YouTrack comment.
- Do not claim that code was changed or tests were run.
- Do not call YouTrack APIs.
- Do not include secrets or tokens if they appear in input.
