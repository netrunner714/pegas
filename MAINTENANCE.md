# Сопровождение pegas

## Что это

`@netrunner714/pegas` — L7-оркестратор и CLI для Docker: единый Caddy-шлюз, контракт
`pegas.json`, автоматический SSL, изоляция сетей, деплой сценариев и dev-маршруты.
Публикуется в npm, используется всеми проектами экосистемы. Прод — `netrunner714.ru/pegas`.

## Стек и пины

| Компонент | Версия |
|---|---|
| Bun / Node | 1.4.4 / >=26.0.0 |
| TypeScript | 7.0.2 (CLI) + API 6.0.3 (тулинг) |
| @types/node | ^26.6.6 |
| Runtime-зависимости | нет (только `node:*`) |

Сборка: `bun build src/index.ts --target=node` → `dist/index.js`, отдельный
`dist/runtime.js` для Runtime SDK. Пакет содержит `dist` и `schemas`.

TypeScript подключён двумя алиасами: `@typescript/native` (CLI 7.0.2) и `typescript` → `@typescript/typescript6` (API 6.0.3 для инструментов, которым нужен Compiler API). Причина и порядок обновления — в [корневом MAINTENANCE.md](../MAINTENANCE.md), раздел 2.1.

## Структура

```
src/commands        init, connect, disconnect, deploy, down, logs, status, check,
                    update, upgrade, ca, llms
src/*.ts            контракт, compose, шлюз, CORS, секреты, runtime SDK, аудиты
schemas             JSON-схема pegas.json
docs/               публичная документация (tutorials, how-to, reference, explanation)
docs/internal/      внутренние RFC и стратегия (в агентский контекст не попадают)
scripts/            генерация docs/example/llms, тесты, e2e, порог покрытия
site/               исходники промо-страницы и генератор документации для сайта
```

## Команды

```bash
bun install --frozen-lockfile
bun run build          # example + docs + dist + declarations
bun run typecheck
bun run test           # только через runner: изоляция моков, порог покрытия 80 %
bun run test:gate      # проверка покрытия
bun run test:e2e
bun run docs:check
```

Правила проекта запрещают прямые вызовы `bun test`, `bun build`, `bun src/index.ts` —
только через `bun run <script>`. Это зафиксировано в [AGENTS.md](AGENTS.md).

## Контракт и совместимость

- `pegas.json` v3: сценарные карты без пропусков, `runtime`, `build`, `port`, `domains`,
  `secrets`, `shared`, `publicHost`. Корневые `env`, `secrets`, `upstream`, `routes`,
  `bootInfra` удалены в v3.
- Изменения схемы и CLI — по SemVer; ломающие изменения только с планом миграции.
- `pegas init` не трогает `pegas.json` и не поднимает версии зависимостей.

## Релиз

1. Поднять `version` в `package.json`, обновить [CHANGELOG.md](CHANGELOG.md).
2. Закоммитить и запушить в `main`.
3. CI (`.github/workflows/ci.yml`): typecheck → тесты → docs:check → build → e2e.
4. Если версии нет в npm, job `publish` собирает `dist`, публикует в npm и GitHub
   Packages, ставит тег и создаёт GitHub Release.
5. Глобальная установка обновляется командой `pegas upgrade`, локальная зависимость
   проекта — `pegas update`.

## Проверки

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run docs:check
bun run build
```

Текущее покрытие — 87,1 % при пороге 80 %.

CI: [.github/workflows/ci.yml](.github/workflows/ci.yml) — на push в `main` и PR: typecheck, tests, docs:check, build, e2e; job `publish` публикует новую версию.

## Известные особенности

1. **Глобальный vs локальный pegas.** Глобально ставится из npm (`bun add -g`), `bun link`
   запрещён: иначе `pegas upgrade` и проверка версии работают против случайного checkout.
2. **Документация.** Публичная и внутренняя части разделены; внутренние формулировки
   не копируются в публичные дословно.
