# Codex Monitor

Монитор реального трафика Codex: proxy → ограниченный outbox → NATS JetStream → projector → SQLite → Bun/Vue → публичная лента портфолио.

Synadia Agents SDK и discovery/prompt bridge удалены. Старый пример доступен в истории Git. NATS выполняет доставку событий и восстановление consumers; прикладной код связывает сессии, учитывает usage и управляет публикациями.

Отдельный контур YouTrack сохранён: HTTP webhook → gateway → JetStream → Codex worker → result consumer → YouTrack MCP/REST. `/console/youtrack` показывает состояние очереди, конфигурации интеграции и последние задания без запуска агентов из браузера.

Запуск: `npm ci`, затем `cd examples/agent-web-ui && bun install --frozen-lockfile && bun run build`; в корне `npm run start:production`. Worker запускается отдельно: `npm run worker`.

Проверки: `node --test src/nats-options.test.js`, `bun test examples/agent-web-ui/server/monitor`, `bunx vue-tsc --noEmit` в каталоге UI.

Контракты мониторинга: [PROXY-MONITOR](docs/PROXY-MONITOR.md), [эфиры](docs/site-broadcasts.md), [статусы](docs/session-controls.md). Старые эксплуатационные инструкции для исходного Swarm-примера сохранены как исторические материалы; действующий выпуск использует Docker Compose на VPS.

Производные стили UI сохраняют Apache-2.0 attribution в `examples/agent-web-ui/LICENSE` и `NOTICE`.
