# NATS / YouTrack agents: публичное демо

Адрес https://agents.komaroff-dev.ru/. Подготовлено 7 сентября 2026 года.
Дата подготовки демо не заменяет дату разработки исходного проекта.

## Реальная и демонстрационная части

Исходный контур: YouTrack webhook → JetStream → Codex worker → MCP → комментарий YouTrack.
Публичный контур: фиксированный webhook → исходный модуль JetStream → безопасный worker
с исходным `dryAnalysis` → настоящий subject результата → gateway → сессионная история.
`dryAnalysis` вынесен без изменения алгоритма в общий модуль и используется обоими worker.
Публичный образ не содержит Codex SDK, shell runner, MCP-клиент или рабочий gateway.
Внешние YouTrack URL, заголовки, ключи и корпоративные данные не передаются в образ.

## Доставка и восстановление

NATS account AGENTS, stream PORTFOLIO_AGENTS, отдельные subjects jobs/results,
два durable consumer с explicit ACK. ACK wait 3 секунды, не более пяти доставок,
1000 сообщений / 8 MiB / один час. Worker обрабатывает одно сообщение за раз.
Встроенный сценарий возвращает NAK один раз, затем повторная доставка через 2,5 секунды
обрабатывается обычным путём. Это симуляция ошибки до ACK, а не остановка процесса.
Реальный перезапуск контейнера проверяется отдельно при эксплуатационной проверке.
Повтор завершённого задания записывает duplicate_ignored и не применяет результат снова.

Состояния хранятся в SQLite WAL на общем томе API/worker. Cookie подписана HMAC,
Secure/HttpOnly/SameSite=Lax. Все чтения, повторы и сброс фильтруются по хешу сессии.
20 заданий на сессию, 1000 всего; очистка по TTL один час каждые пять минут и при запросе.
Публичных управляющих методов остановки контейнера или запуска команды нет.

## Code-map

| Функция | Экран/API | Модуль | Данные / проверка |
|---|---|---|---|
| Учебный webhook | POST api/jobs | portfolio-gateway, portfolio-store.create | фиксированный corpus, SQLite jobs; quota test |
| Очередь | схема / api/state | jetstream.openJetStream | NATS stream + consumers; production QA |
| Анализ | timeline | portfolio-worker, dry-analysis | исходный dry-run formatter; missing context test |
| Повтор | POST api/jobs/id/replay | worker completed guard | тот же ID, duplicate_ignored; production QA |
| Изоляция / сброс | GET state / DELETE jobs | portfolio-store.owned | owner SHA-256, TTL; isolation + expiry tests |

Перед правкой пройти связи экран → API → consumer → результат → хранилище, после правки
обновить карту и схемы, проверить повторную доставку и изоляцию. Исходный CODE_MAP.md
описывает рабочую интеграцию; публичное демо имеет отдельную карту выше.

## Сборка / эксплуатация

Node24 base закреплён digest. `portfolio/package-lock.json` фиксирует минимальные
runtime-зависимости. Dockerfile.portfolio собирается вне VPS, запуск по image digest.
Два контейнера по 128 MiB / 0.4 CPU, logs 3×5 MB. API healthcheck проверяет NATS,
worker healthcheck — свежий heartbeat. Nginx проксирует localhost:18405, NATS снаружи закрыт.
Числа времени в интерфейсе — фактические timestamps событий, состояние очереди — consumer info.
Встроенная задержка 700 мс нужна для наблюдения этапов и не является бенчмарком агента.
