# Changelog

Все заметные изменения проекта документируются в этом файле.

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование — [SemVer](https://semver.org/lang/ru/).

## [1.7.0] — 2026-11-01

### Added
- `pegas init` собирает контракт из всей секции `services` docker-compose-файла, а не только главного веб-сервиса:
  - app-сервисы — с `build` (`context`, `dockerfile`, `target`), `image`, `port`, `env`, `envFile`, `dependsOn` и доменами по каждому окружению;
  - infra-сервисы — с `image`, named `volumes` и `role: "infra"`;
  - сервисы под `profiles` и собственные прокси (caddy/nginx) пропускаются: их активность и замена общим шлюзом не выводимы из файла.
- Структурный харвест: порт из `EXPOSE` в `apps/<сервис>/Dockerfile` заполняется сервису, у которого compose порт не раскрыл; каталоги `apps/*` без Dockerfile — кандидаты, в контракт не попадают; runtime-стейджи корневого multi-target Dockerfile распознаются (builder/deps отфильтрованы).
- Харвест доменов из `Caddyfile` проекта: домены блоков `домен { reverse_proxy <сервис>:<порт> }` копируются в `domains.production` литералами вместо example.com-заглушек. Чистые redirect-блоки (www) не копируются — pegas строит www-redirect сам; сплит-роутинг и сервисы вне контракта пропускаются без домыслов.
- Поле `services.<name>.build.target` в контракте и JSON Schema: stage multi-target Dockerfile передаётся в генерируемый compose как есть.
- Главный сервис для dev-алиаса `<project>.localhost` выбирается прежней эвристикой (стандартное имя → порт → первый).

### Changed
- Значения compose с подстановками `${VAR}` не попадают в контракт как литералы: неразрешённые значения пропускаются.

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
