# Changelog

Все заметные изменения проекта документируются в этом файле.

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование — [SemVer](https://semver.org/lang/ru/).

## [3.0.1] — 2026-11-05

### Fixed

- **connect/deploy: фильтрация по драйверу** ([#23](https://github.com/netrunner714/pegas/issues/23)) — правило «владелец маршрута = владелец процесса»:
  - `connect` пишет dev-маршруты только для host-сервисов (`runtime.development.driver: "bun"`); домены docker-сервисов больше не направляются на `host.docker.internal`. Если bun-сервисов с доменами нет — предупреждение «регистрировать нечего» (connect продолжает писать `.pegas/context.json` и проверять TLS).
  - `deploy` в readiness проверяет только контейнерные сервисы: host-сервис (bun) контейнера не имеет, манифест его не поднимает — 30-секундный таймаут и падение после подъёма инфры устранены.
  - `deploy` не генерирует сниппеты для bun-сервисов в development и не удаляет файл маршрутов, принадлежащий `connect` (upstream `host.docker.internal`) — маршрут `host.docker.internal:<port>` переживает deploy.

## [3.0.0] — 2026-11-04

Мажорный релиз: контракт Pegas v3. Пересборка декларативного слоя вокруг сценариев
(Zero Scalars), отказ от docker-compose-легаси в репо проектов и появление Runtime SDK.
Спецификация — docs/internal/rfc/RFC_CONTRACT_V3.md (реализован полностью).

### Added

- **Контракт v3**: корневые `scenarios: string[]`, `gateway` (httpPort/httpsPort/admin/acmeEmail по сценариям) и посервисные сценарные карты (`runtime`, `image`, `build`, `port`, `domains`, `cors`, `env`, `volumes`, `dependsOn`, `healthcheck`, `command`, `ports`, `publicHost`). JSON Schema — https://netrunner714.ru/schemas/pegas.json; эталон example.json генерируется из схемы.
- **Zero Scalars**: каждое средозависимое поле — строгая карта по ключам из `scenarios`, без пропусков и дефолтов. Корневые `env`, `secrets`, `deploy`, `devGateway` удалены; секреты — посервисные (`services.<name>.secrets`).
- **Service discovery `pegas://<имя-сервиса>`**: значения env вида `pegas://api` разворачиваются при генерации манифеста во внутренний адрес сети (`<scheme>://<project>-<scenario>-<service>:<port>`, scheme по образу целевого сервиса: redis/postgresql/http).
- **Платформенная инъекция PORT**: манифест подставляет env `PORT` из port-карты контракта каждому docker-сервису (вместе с `PEGAS_CONTEXT`/`PEGAS_SCENARIO`) — порты читают любые рантаймы (Rust/Go/Python), ручной env-ключ `PORT` больше не нужен и перекрывается.
- **Runtime SDK** (`@netrunner714/pegas/runtime`): типизированный доступ к контексту оркестрации — `currentService()` (порт, домены, scenario), `services()` (карта соседей с internalUrl), `secret()` (обязательный секрет с понятной ошибкой и списком ожидаемых), `optionalSecret()` (секрет, осознанно не заданный в части сценариев). Транспорт: env `PEGAS_CONTEXT` в контейнерах + файл `.pegas/context.json` для host-запусков. Дистрибутив типизирован (dist/runtime.d.ts генерируется при сборке).
- **`pegas connect` пишет `.pegas/context.json`**: host-сервисы сценария development получают тот же discovery-контекст, что и контейнеры; `pegas disconnect` удаляет его.
- **TLS-готовность как first-class**: `connect` и `status` сверяют CA живого шлюза (PKI в docker-volume) с хранилищами доверия ОС — обе стороны в WSL (Linux-бандл и Windows Root через certutil). При недоверии — предупреждение с готовым лечением; `ca install` синхронизирует экспорт с живым шлюзом (актуализация после пересоздания volume).
- **`pegas llms` / llms.txt**: агентный контекст, генерируемый из кода; включает доктрину env-доступа (env — транспорт инъекции, не источник топологии).
- **`pegas check` v3**: рид-онли аудит контракта, паритета секретов 1:1, git-гигиены и свежести артефактов (`docs/pegas.md`, блок AGENTS.md). Docker-aware детектор Caddyfile: конфиг в образе (COPY в Dockerfile) не алертится.

### Changed

- **Сценарии вместо окружений**: деплой строго `pegas deploy -s <scenario>`; сценарий — флаг запуска, код читает готовые значения (ветвления по NODE_ENV-like env в коде запрещены — платформа выводит их сама).
- **`pegas init` — тонкий scaffolder**: генерирует/обновляет только артефакты (`docs/pegas.md`, блок AGENTS.md, `.gitignore`-гигиену). Контракт `pegas.json` не создаёт и не трогает — он пишется по схеме и эталону. Идемпотентен.
- **connect/disconnect** — финальные имена (бывшие link/unlink): dev-маршруты `*.localhost` в общем шлюзе.
- Эфемерные артефакты: compose-манифест генерируется на каждый деплой и не хранится в репо; из репо проектов исчезают docker-compose.yml, Caddyfile шлюза и ручные CORS-списки (CORS ставит шлюз по `services.<name>.cors`).
- Документация (README, docs/) переписана под v3; реализованные RFC перенесены в docs/internal/rfc/ с шапками статуса; справочники cli.md и llms.txt генерируются из кода при сборке.

### Removed

- Команды `pegas dev`, `pegas link`, `pegas unlink`, `pegas migrate` (v2-инструменты перехода; миграция v2→v3 — ручная правка контракта под контролем `pegas check`).
- Поля контракта v2: корневые `env`, `secrets`, `deploy`, `devGateway`, `bootInfra`, сервисные `role`, `envFile`, макросы `${services.<name>.<prop>}` (заменены сценарными картами и `pegas://`).
- Харвестинг docker-compose в `pegas init` (инвентаризация сервисов, starter-Dockerfile, env-генерация).

### Migration (v2 → v3)

1. Переписать `pegas.json` по схеме v3 (Zero Scalars: сценарные карты, посервисные секреты) — руками, используя `pegas check` как единственный проводник.
2. Вычистить из кода `PORT`/`APP_DOMAIN`/`CLIENT_ORIGINS`/NODE_ENV-ветвления: топология — через Runtime SDK (`currentService()`, `services()`), секреты — `secret()`/`optionalSecret()`.
3. Удалить docker-compose.yml и Caddyfile шлюза из репо (контейнерная статика образа — легитимна).
4. `pegas ca install` после первого `pegas connect` (CA шлюза мог смениться при пересоздании volume).

## [1.8.0] — 2026-11-01

### Added
- Глобальный env-блок контракта (`env`): переносимый конфиг проекта. Значение — строка (одинаково для всех профилей) или карта development/stage/production со всеми тремя ключами; частичные карты и неизвестные профили — ошибки валидации. При dev/deploy значение текущего профиля инжектится каждому сервису (сервисный env перекрывает глобальный). Секреты — по-прежнему только в envFile. Устраняет ключи типа APP_ENV/NODE_ENV и ветвления по окружению в коде: профиль выбирает запуск (`pegas deploy production`), код читает готовое значение (+ `PEGAS_ENV` инжектится всем app-сервисам).
- `pegas init` собирает контракт из всей секции `services` docker-compose-файла, а не только главного веб-сервиса:
  - app-сервисы — с `build` (`context`, `dockerfile`, `target`), `image`, `port`, `env`, `envFile`, `dependsOn` и доменами по каждому окружению;
  - infra-сервисы — с `image`, named `volumes` и `role: "infra"`;
  - сервисы под `profiles` и собственные прокси (caddy/nginx) пропускаются: их активность и замена общим шлюзом не выводимы из файла.
- Структурный харвест: порт из `EXPOSE` в `apps/<сервис>/Dockerfile` заполняется сервису, у которого compose порт не раскрыл; каталоги `apps/*` без Dockerfile — кандидаты, в контракт не попадают; runtime-стейджи корневого multi-target Dockerfile распознаются (builder/deps отфильтрованы).
- Харвест доменов из `Caddyfile` проекта: файл ищется в корне и в типовых директориях (`caddy/`, `config/`, `docker/`, `deploy/`, `configs/`) в порядке приоритета (корень — конвенция «caddy — главный шлюз»; поддиректории — сервисный caddy). Домены блоков `домен { reverse_proxy <сервис>:<порт> }` копируются в `domains.production` литералами вместо example.com-заглушек. Чистые redirect-блоки (www) не копируются — pegas строит www-redirect сам; сплит-роутинг и сервисы вне контракта пропускаются без домыслов.
- Поле `services.<name>.build.target` в контракте и JSON Schema: stage multi-target Dockerfile передаётся в генерируемый compose как есть.
- Главный сервис для dev-алиаса `<project>.localhost` выбирается прежней эвристикой (стандартное имя → порт → первый).

### Changed
- Значения compose с подстановками `${VAR}` не попадают в контракт как литералы: неразрешённые значения пропускаются.
- Заглушки stage и production — единая `example.com` без имени сервиса: домены не угадываются ни из имён, ни из структуры. Production-домен попадает в контракт только как литеральный факт из Caddyfile.

## [1.6.0] — 2026-11-01

### Changed
- Заглушки stage/prod-доменов при `pegas init` — `<сервис>.example.com`
  (RFC 2606) вместо выдуманного `<slug>.com`: явно видно, что домен не заполнен.

### Added
- `$schema` в `pegas.json`: `pegas init` записывает ссылку на JSON Schema,
  `reconcile` бэкфиллит её в существующие контракты. Публичная схема —
  `schemas/pegas.json` в репозитории.
- Документация: Diataxis-структура (`tutorials`/`how-to`/`reference`/`explanation`),
  генерируемый справочник CLI (`docs/reference/cli.md` из `src/help.ts`),
  справочник контракта, CHANGELOG, гвард целостности `docs:check` в CI.
- Разделение публичной и внутренней документации (`docs/internal/`).

### Changed
- README переведён на русский язык.

### Removed
- Устаревший `llms-full.txt` (ручная копия старой архитектуры, не перегенерировался).

## [1.5.0] — 2026-11-01

### Added
- Декларативный Docker-рантайм (opt-in `runtime: "docker"`): общий Gateway,
  labels `pegas.project`/`pegas.environment`, эфемерные манифесты,
  изоляция окружений, named volumes для зависимостей, детекция стека.
- `pegas uninstall` — зеркальный откат `init`.
- `pegas deploy <env>` / `pegas down --env <environment>`.
- Локальный Root CA: кроссплатформенная установка доверия (Linux/macOS/Windows/WSL).
- Единый корень `~/.pegas` и автоматический bootstrap сервера.
- E2E-раннеры: hermetic-сьют (11 фаз), dev-сьют, совместимость с реальными репо.

## [1.2.0] — 2026-10-2x

### Changed
- CLI переведён на строгую GitOps-модель: императивные команды и псевдонимы убраны.
- Справка и опции parseArgs генерируются из единого реестра команд.

## [1.1.0] — 2026-10-1x

### Added
- Неинвазивная compose-хирургия (`expose` вместо проброса портов).
- Кеширование бинарника Caddy в `~/.pegas/bin` с проверкой версии.
- `pegas update` с semver-защитой и откатом.

## [1.0.0] — 2026-10-08

### Added
- Первый публичный релиз: init/dev/deploy, генератор Caddyfile, анти-хайджекинг,
  DNS pre-flight, ротация логов, CI с автопубликацией в npmjs и GitHub Packages.

---

`[Unreleased]`-секция ведётся в обратном порядке вверху файла перед релизом.
