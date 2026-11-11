# Справочник CLI pegas

> **Генерируемый файл.** Строится из src/help.ts командой `bun run build`.
> Ручные правки перетираются. Русские описания команд — scripts/gen-docs.ts,
> структура и факты — src/help.ts.

## Команды

### `pegas init [options]`

Скаффолдер Pegas: маркерный блок AGENTS.md, docs/pegas.md, .pegas/ и записи .gitignore. Контракт pegas.json НЕ создаётся — его пишут руками рядом с проектом

Флаги:

```text
--force               Перезапустить скаффолдинг, даже если маркерный блок уже есть (идемпотентное слияние)
--dry-run             Показать план изменений без записи на диск
--cwd <path>          Целевой каталог проекта
```

Примеры:

```bash
pegas init
pegas init --force
pegas init --dry-run
```

### `pegas update [options]`

Обновляет @netrunner714/pegas до актуальной версии (без --latest — только внутри мажора)

Флаги:

```text
--latest              Обновляться между мажорными версиями (например, 2.x -> 3.x)
--cwd <path>          Целевой каталог проекта
```

Примеры:

```bash
pegas update
pegas update --latest
```

### `pegas upgrade [options]`

Upgrade the global pegas installation on this machine (bun add -g / npm install -g)

Флаги:

```text
--latest              Обновляться между мажорными версиями (например, 2.x -> 3.x)
```

Примеры:

```bash
pegas upgrade
pegas upgrade --latest
```

### `pegas connect -s <scenario> [options]`

Регистрирует все сервисы сценария в общем шлюзе: host-сервисы через host.docker.internal, docker-сервисы — на scoped-алиас; маршруты [service].[project].localhost

Флаги:

```text
-s, --scenario <name>  Целевой сценарий из pegas.json (например, development, production, stage)
--cwd <path>           Целевой каталог проекта
--dry-run              Показать план изменений без записи на диск
```

Примеры:

```bash
pegas connect
pegas connect -s stage
pegas connect -s production --dry-run
```

### `pegas disconnect -s <scenario> [options]`

Удаляет route-файл разработки из шлюза и останавливает шлюз, если он больше никем не используется

Флаги:

```text
-s, --scenario <name>  Целевой сценарий из pegas.json (например, development, production, stage)
--cwd <path>           Целевой каталог проекта
```

Примеры:

```bash
pegas disconnect
pegas disconnect -s stage
```

### `pegas logs [env] [service] [options]`

Просмотр и стриминг логов контейнеров любого сценария (development, stage, production)

Флаги:

```text
-e, --env <name>      Целевое окружение (например, production, stage)
-f, --follow          Стримить логи в реальном времени (отслеживать вывод)
-n, --tail <lines>    Количество последних строк логов (по умолчанию: 100)
--cwd <path>          Целевой каталог проекта
```

Примеры:

```bash
pegas logs
pegas logs -f
pegas logs production
pegas logs production -f
pegas logs development api -f
pegas logs -n 50
```

### `pegas deploy -s <scenario> [options]`

Разворачивает проект по сценарию из pegas.json: сеть, общий Gateway, контейнеры, маршруты

Флаги:

```text
-s, --scenario <name>  Целевой сценарий из pegas.json (например, development, production, stage)
--cwd <path>           Целевой каталог проекта
--skip-dns-check       Skip DNS pre-flight verification
--strict-dns           Abort deployment if DNS does not resolve to this host
--skip-up              Do not start containers; validate the scenario only
--dry-run              Показать план изменений без записи на диск
```

Примеры:

```bash
pegas deploy -s production
pegas deploy --scenario stage
pegas deploy -s development --dry-run
```

### `pegas down [options]`

Удаляет контейнеры проекта и его маршруты из Caddy

Флаги:

```text
--cwd <path>          Целевой каталог проекта
--env <environment>   Целевое окружение (например, production, stage)
```

Примеры:

```bash
pegas down
pegas down --env development
```

### `pegas ca <install|remove> [options]`

Управляет локальным Root CA для доверенного dev-HTTPS (install/remove)

Флаги:

```text
--dry-run             Показать план изменений без записи на диск
```

Примеры:

```bash
pegas ca install
pegas ca remove
```

### `pegas check [options]`

Read-only аудит v3-контракта: валидатор, паритет секретов, гигиена .gitignore. Ничего не меняет

Флаги:

```text
--cwd <path>          Целевой каталог проекта
```

Примеры:

```bash
pegas check
pegas check --json
```

### `pegas status [options]`

Единый дашборд: здоровье шлюза плюс все сервисы Pegas со здоровьем реальных процессов

Флаги:

```text
--cwd <path>          Целевой каталог проекта
```

Примеры:

```bash
pegas status
pegas status --json
```

### `pegas llms [options]`

Выводит машиночитаемый контекст для LLM-агентов

Примеры:

```bash
pegas llms
pegas llms --json
```

## Глобальные флаги

```text
--gateway-dir <path>  Переопределить каталог шлюза
--json                Машиночитаемый JSON-вывод (для агентов и скриптов)
-h, --help            Показать справку
-v, --version         Показать версию
```
