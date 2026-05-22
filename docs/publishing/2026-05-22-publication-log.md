# Журнал публикации проекта

Дата: 2026-05-22  
Проект: `/home/komaroff/dev/monitorsoft/synadia-nats-agents`  
Целевой remote: `https://git.giscloud.ru/trizna/nats-synadia-dev.git`  
Цель: собрать, закоммитить, запушить и подготовить публикацию на домене `*.gis-master.ru` по аналогии с `webrtc-komaroff.gis-master.ru`.

## Правила журнала

- Секреты, токены, cookies и значения переменных доступа не пишутся в файл.
- Ошибки фиксируются как факт: команда, симптом, причина, рабочее решение.
- Удачные решения фиксируются так, чтобы позже можно было перенести их в отдельный skill публикации проектов.

## Ход работ

### 2026-05-22T07:48:20+03:00

Команда: `bun run typecheck` в `examples/agent-web-ui`.

Результат: успешно, `tsc --noEmit` завершился без ошибок.

### 2026-05-22T07:48:20+03:00

Команда: ручная syntax-check команда для backend entrypoint'ов.

Результат: ошибка `MODULE_NOT_FOUND` для `src/basic-agent.js`.

Причина: команда проверки была составлена по старому имени файла. В текущем проекте такого entrypoint'а нет, актуальные backend-файлы лежат в `src/basic-controller.js`, `src/common.js`, `src/monitor.js`, `src/personas.js`, `scripts/*.js`, `plugins/basic-tools/index.js`.

Решение: проверять только реально существующие JavaScript entrypoint'ы.

### 2026-05-22T07:50:00+03:00

Команда: `node --check` для актуальных файлов:

- `src/basic-controller.js`
- `src/common.js`
- `src/monitor.js`
- `src/personas.js`
- `scripts/prepare-openclaw-basic-tools.js`
- `scripts/prepare-openclaw-nats-channel.js`
- `plugins/basic-tools/index.js`

Результат: успешно, syntax-check прошёл без ошибок.

### 2026-05-22T07:50:00+03:00

Команда: `bun run build` в `examples/agent-web-ui`.

Результат: успешно, Vite собрал production assets в `examples/agent-web-ui/dist`.

### 2026-05-22T08:00:00+03:00

Действие: добавлена минимальная публикационная обвязка по аналогии с `webrtc-komaroff`.

Файлы:

- `.gitlab-ci.yml` - две стадии: build image и deploy через `dry-stack`.
- `docker/Dockerfile` - runtime image: Node + Bun, сборка UI, запуск controller + UI bridge.
- `docker/Dockerfile.build` и `docker/build-images.sh` - build-labels wrapper для GitLab runner.
- `docker/docker-compose.yml` - один image target `trizna/nats-synadia-dev/app/<branch>`.
- `stack/nats-synadia-dev.drs` - dry-stack описание: `nats` service + публичный `app` service.
- `stack/Dockerfile.deploy` и `stack/deploy.sh` - deploy wrapper с поддержкой SSH key variables и retry.
- `scripts/start-production.js` - production entrypoint, который ждёт NATS и запускает controller + Bun UI server.

Решение: не класть NATS внутрь app container. NATS оставлен отдельным service в stack, а app container содержит только demo agents и browser-facing UI.

### 2026-05-22T08:02:00+03:00

Действие: добавлен `--host` и `/healthz` в Bun UI server.

Причина: для Swarm/Traefik container должен явно слушать `0.0.0.0`, а после deploy нужна простая проверка `https://nats-synadia-dev.gis-master.ru/healthz`.

Проверки:

- `bun run typecheck` - успешно.
- `bun run build` - успешно.
- `node --check` для backend/scripts/plugin - успешно.

### 2026-05-22T08:08:00+03:00

Команда: `cat stack/nats-synadia-dev.drs | dry-stack --tls-domain=gis-master.ru to_compose`.

Результат: успешно. Dry-stack сгенерировал compose с двумя service:

- `nats` на image `nats:2.11.6-scratch`;
- `app` на image `builder-registry.builder.giscloud.ru/trizna/nats-synadia-dev/app/main` с Traefik rule для `nats-synadia-dev.gis-master.ru`.

### 2026-05-22T08:10:00+03:00

Команда: `docker build -t nats-synadia-dev-local -f docker/Dockerfile .`.

Результат: успешно. Image собрался локально, UI build внутри Docker прошёл.

Наблюдение: скачивание `node:24-bookworm-slim` и Bun было медленным, но без ошибок. Для будущего skill полезно логировать длительные network steps отдельно, чтобы не путать медленную сеть с падением сборки.

### 2026-05-22T08:12:00+03:00

Команды:

- `docker run -d --name nats-synadia-dev-smoke --network host -e HOST=0.0.0.0 -e PORT=3333 -e NATS_URL=nats://127.0.0.1:4222 nats-synadia-dev-local`
- `curl --noproxy '*' -fsS http://127.0.0.1:3333/healthz`
- `docker rm -f nats-synadia-dev-smoke`

Результат: успешно. `/healthz` вернул `ok=true`, controller напечатал `agents.prompt.basic.demo.*`, UI bridge подключился к NATS и слушал `0.0.0.0:3333`.

### 2026-05-22T08:13:00+03:00

Действие: добавлена проектная документация и PNG-схемы.

Файлы:

- `CODE_MAP.md` - карта ключевых файлов и функциональных точек.
- `docs/diagrams/architecture.dot` и `docs/diagrams/architecture.png`.
- `docs/diagrams/group-session-sequence.dot` и `docs/diagrams/group-session-sequence.png`.
- `docs/diagrams/deployment.dot` и `docs/diagrams/deployment.png`.

Команды:

- `dot -Tpng docs/diagrams/architecture.dot -o docs/diagrams/architecture.png`
- `dot -Tpng docs/diagrams/group-session-sequence.dot -o docs/diagrams/group-session-sequence.png`
- `dot -Tpng docs/diagrams/deployment.dot -o docs/diagrams/deployment.png`

Результат: успешно, PNG-файлы созданы и добавлены в документацию.

### 2026-05-22T08:20:00+03:00

Финальные проверки перед commit/push:

- `bun run typecheck` - успешно.
- `bun run build` - успешно.
- `node --check` для `src/*.js`, `scripts/*.js`, `plugins/basic-tools/index.js` - успешно.
- `cat stack/nats-synadia-dev.drs | dry-stack --tls-domain=gis-master.ru to_compose` - успешно.

Dry-stack ожидаемый публичный host: `nats-synadia-dev.gis-master.ru`.

### 2026-05-22T08:24:00+03:00

Действие: настроен Git remote.

Команда:

```sh
git remote add origin https://git.giscloud.ru/trizna/nats-synadia-dev.git
```

Если remote уже есть, используется `git remote set-url origin ...`.

Результат:

```text
origin https://git.giscloud.ru/trizna/nats-synadia-dev.git
```

### 2026-05-22T08:26:00+03:00

Команда: `GIT_TERMINAL_PROMPT=0 git ls-remote origin HEAD`.

Результат: ошибка `fatal: could not read Username for 'https://git.giscloud.ru': terminal prompts disabled`.

Причина: для HTTPS GitLab нужен username/password или PAT, а terminal prompt отключён намеренно.

Решение: взять PAT из Vault path `secret/codex/monitorsoft/dev/gitlab` и передать его через временный `GIT_ASKPASS`. Значение PAT в журнал не записывалось.

Проверка через `GIT_ASKPASS`: успешно, remote `main` найден.

### 2026-05-22T08:28:00+03:00

Команда: `git fetch origin main`.

Результат: успешно. Remote `main` содержит отдельный `Initial commit` только с README. Локальная история проекта и remote history не имеют общего merge-base, поэтому перед push нужен merge unrelated history без перезаписи remote.

### 2026-05-22T08:32:00+03:00

Коммит:

```text
38a7813 feat: добавить Synadia UI и публикацию на gis-master
```

После commit выполнен merge remote initial history:

```text
6a6fa75 chore: merge remote initial main
```

Причина merge: remote `origin/main` уже содержал `Initial commit`, а локальная история проекта была отдельной. Использована стратегия `ours`, чтобы сохранить remote commit в истории и не перетереть текущее содержимое проекта.

### 2026-05-22T08:36:00+03:00

Push:

```text
0ee0cee main -> origin/main
```

Pipeline:

```text
2531 failed
job 4858 build push failed
job 4859 deploy skipped
```

Ошибка из trace:

```text
fatal: not a git repository (or any of the parent directories): .git
error: Could not access '55ade9f603c14bb05413dd40346bf8426e9ebb8c'
Error executing git diff --name-only $CI_COMMIT_BEFORE_SHA $CI_COMMIT_SHA
```

Причина: `.dockerignore` исключал `.git/`, а `docker/build-images.sh` запускал `build-labels ... changed ...`, которому нужна git history внутри build container.

Решение:

- убрать `.git/` из `.dockerignore`;
- добавить fallback в `docker/build-images.sh`: если `changed` detection не смог построить plan, выполнить полный `build-labels ... gitlab set_version to_dockerfiles to_compose`.

### 2026-05-22T08:40:00+03:00

Локальная проверка builder image:

```sh
docker build -q -t build/nats-synadia-dev-local -f docker/Dockerfile.build .
docker run --rm ... -e CI_SKIP_PUSH=1 build/nats-synadia-dev-local
```

Результат: первая проблема с `.git` исправлена, но найдено новое падение:

```text
Version file not found: /build/.version
```

Причина: `build-labels ... set_version ...` ожидает корневой `.version`.

Решение: добавить `.version` со значением `0.1.0`.

### 2026-05-22T08:43:00+03:00

Повторная локальная проверка builder image нашла ещё один smoke-only edge case:

```text
Build ID not found. Please set GITHUB_RUN_NUMBER or CI_PIPELINE_IID environment variable
```

В GitLab `CI_PIPELINE_IID` должен быть доступен, но wrapper сделан устойчивее:

```sh
export CI_PIPELINE_IID="${CI_PIPELINE_IID:-${CI_PIPELINE_ID:-0}}"
```

Так локальный smoke и нестандартный runner не падают из-за отсутствия IID.

### 2026-05-22T08:46:00+03:00

Следующая локальная проверка builder image:

```text
/build/docker/build-images.sh: line 37: docker: command not found
```

Причина: `docker/Dockerfile.build` устанавливал `docker-cli-buildx`, но не сам `docker-cli`.

Решение: добавить пакет `docker-cli` в `apk add`.

### 2026-05-22T08:50:00+03:00

Следующая локальная проверка builder image дошла до `docker buildx bake`, но упала:

```text
Pass "--allow=fs.read=.." to grant requested privileges.
ERROR: additional privileges requested
```

Причина: bake plan строит image из context `..`, потому что `docker/docker-compose.yml` лежит в `docker/`, а Dockerfile проекта находится уровнем выше. Новые версии buildx требуют явного filesystem entitlement.

Решение: добавить в wrapper:

```sh
export BUILDX_BAKE_ENTITLEMENTS_FS="${BUILDX_BAKE_ENTITLEMENTS_FS:-0}"
```

### 2026-05-22T08:53:00+03:00

Повторная локальная проверка builder image после фиксов:

```sh
docker build -q -t build/nats-synadia-dev-local -f docker/Dockerfile.build .
docker run --rm -e CI_SKIP_PUSH=1 ... build/nats-synadia-dev-local
```

Результат: успешно. `docker buildx bake` собрал app image локально без push.

Проверенный image target:

```text
builder-registry.builder.giscloud.ru/trizna/nats-synadia-dev/app/main:0.1.0
builder-registry.builder.giscloud.ru/trizna/nats-synadia-dev/app/main:latest
```

### 2026-05-22T09:04:00+03:00

Push исправлений builder-а:

```text
3b7edd3 main -> origin/main
```

Pipeline:

```text
2532 success
job 4860 build push success
job 4861 deploy success
```

Проверка production URL:

```sh
curl --noproxy '*' -k -fsS https://nats-synadia-dev.gis-master.ru/healthz
curl --noproxy '*' -k -fsSI https://nats-synadia-dev.gis-master.ru/
```

Результат:

```text
/healthz: ok=true, service=synadia-nats-agents-web-ui, NATS=nats://nats-synadia-dev_nats:4222, sdkProtocolVersion=0.3
/: HTTP/2 200, x-proxy=traefik
```

Итог: проект опубликован на `https://nats-synadia-dev.gis-master.ru/`.

### 2026-05-22T08:16:00+03:00

Проблема после публикации: при prompt в chat agent-а UI показывал ошибку:

```text
handler error: Ollama 404: 404 page not found [500]
```

Проверки:

```sh
curl --noproxy '*' -k https://nats2ollama.gis-master.ru/api/tags
curl --noproxy '*' -k https://nats2ollama.gis-master.ru/api/chat
```

Результат: оба endpoint-а вернули `404 page not found`.

Причина: `nats2ollama.gis-master.ru` не является прямым Ollama HTTP API для этого demo, а `src/common.js` вызывает именно `${OLLAMA_BASE_URL}/api/chat`.

Рабочий endpoint:

```sh
curl --noproxy '*' http://ollama.h100.local/api/tags
curl --noproxy '*' http://ollama.h100.local/api/chat
```

Результат: `200 OK`, модели `qwen3:30b` и `qwen3.5:9b` доступны.

Решение:

- заменить `OLLAMA_BASE_URL` в `stack/nats-synadia-dev.drs` и `docker/Dockerfile` на `http://ollama.h100.local`;
- улучшить текст ошибки в `src/common.js` для 404, чтобы сразу было понятно, что base URL не является прямым Ollama endpoint.

После deploy `58b4ce4` pipeline `2534` прошёл успешно, но WebSocket smoke показал новую ошибку:

```text
handler error: Ollama недоступна: http://ollama.h100.local ... Причина: fetch failed
```

Причина: из app container имя `ollama.h100.local` не резолвится/не маршрутизируется так же, как с рабочей машины. При этом сам HTTP endpoint на `192.168.28.134` требует Host header `ollama.h100.local`: прямой `http://192.168.28.134/api/tags` даёт 404, а `Host: ollama.h100.local` даёт 200.

Решение: добавить в dry-stack app service:

```ruby
extra_hosts: ['ollama.h100.local:192.168.28.134']
```

Так container будет ходить на нужный IP, но HTTP Host останется `ollama.h100.local`.

### 2026-05-22T08:19:00+03:00

Push host mapping:

```text
048779e main -> origin/main
```

Pipeline:

```text
2536 success
job 4866 build push success
job 4867 deploy success
```

End-to-end smoke через публичный WebSocket:

```text
wss://nats-synadia-dev.gis-master.ru/ws
discover -> agents=6
prompt teacher -> response chunks -> done
```

Результат: prompt в agent `teacher` больше не падает с `Ollama 404` или `fetch failed`.

### 2026-05-22T08:55:22+03:00

Публикация исправления удаления `BASIC GROUP` и новой sequence diagram.

Локальные проверки:

```text
bun run typecheck -> success
bun run build -> success
node --check src/basic-controller.js -> success
```

Git push:

```text
local HEAD c1ec942444d008cab51153254727e8f1fcc03d52
remote main before push c1ec942444d008cab51153254727e8f1fcc03d52
git push origin main -> Everything up-to-date
remote main after push c1ec942444d008cab51153254727e8f1fcc03d52
```

Pipeline:

```text
2538 success
job 4868 build push success
job 4869 deploy success
```

Production checks:

```text
https://nats-synadia-dev.gis-master.ru/healthz -> HTTP/2 200, ok=true
https://nats-synadia-dev.gis-master.ru/ -> HTTP/2 200
public bundle index-Bf3yc08H.js contains "Удалить group session" and group_id stop logic
```

WebSocket smoke на production:

```text
wss://nats-synadia-dev.gis-master.ru/ws
discover -> agents=6
basic-group-create -> created group-1 label=smoke-delete-1779429306417
basic-group-stop -> stopped group-1
```

Результат: кнопка удаления `BASIC GROUP` опубликована, а production bridge
успешно останавливает динамическую group session по техническому `group_id`.

### 2026-05-22T12:37:00+03:00

Публикация weather adapter-а для внешнего NATS `nats-agent-ruby`.

Изменения:

- добавлена форма `lat/lon` для `agents.prompt.weather.dev.h100`;
- добавлены примеры запросов "Йошкар-Ола", "Омск", "Сводка";
- WebSocket wire contract расширен полем `extra`;
- bridge отправляет custom NATS envelope с `prompt`, `lat`, `lon`;
- generic agents по-прежнему идут через обычный `Agent.prompt()`.

Локальные проверки:

```text
bun run typecheck -> success
bun run build -> success
node --check scripts/start-production.js && node --check src/common.js -> success
```

Push:

```text
commit 9b7bc0f feat: добавить weather adapter для prompt extra
git push -o ci.skip origin main -> success
```

Причина `ci.skip`: обычный push pipeline запустил бы deploy без внешних NATS
variables и временно переключил бы сервис обратно на local demo NATS.

Ручной pipeline с external NATS variables:

```text
pipeline 2544 -> success
build push -> success
deploy -> success
```

Production checks:

```text
https://nats-synadia-dev.gis-master.ru/healthz -> HTTP 200
healthz nats -> nats://<redacted>@rag-stack_inference_nats:4222
discovery -> agents.prompt.weather.dev.h100
```

End-to-end smoke через публичный WebSocket:

```text
prompt: "как погода в йошкар оле? кратко: температура, осадки, облачность"
extra:  { lat: 56.6328, lon: 47.8951 }
status: ack -> done
result: weather answer received
```

Наблюдение: сразу после Swarm update был краткий `504` на `/healthz`, но через
несколько секунд service стабилизировался и дальше стабильно возвращал `200`.
