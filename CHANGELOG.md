# Changelog

Все заметные изменения проекта документируются в этом файле.

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование — [SemVer](https://semver.org/lang/ru/).

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
