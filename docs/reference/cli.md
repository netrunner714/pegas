# Справочник CLI pegas

> **Генерируемый файл.** Строится из src/help.ts командой `bun run build`.
> Ручные правки перетираются. Русские описания команд — scripts/gen-docs.ts,
> структура и факты — src/help.ts.

## Команды

### `pegas init [options]`

Инициализирует проект: создаёт контракт pegas.json, документацию и скрипты (runtime определяется автоматически)

Флаги:

```text
--force               Сбросить контракт pegas.json на дефолты (создаёт pegas.json.bak)
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

Обновляет @netrunner714/pegas до актуальной версии

Флаги:

```text
--latest              Обновляться между мажорными версиями (например, 1.x -> 2.x)
--cwd <path>          Целевой каталог проекта
```

Примеры:

```bash
pegas update
pegas update --latest
```

### `pegas logs [env] [service] [options]`

Просмотр и стриминг логов контейнеров любого окружения (development, stage, production)

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

### `pegas deploy [options]`

Разворачивает проект по сценарию из pegas.json: сеть, общий Gateway, контейнеры, маршруты

Флаги:

```text
-s, --scenario <name>  Целевой сценарий из pegas.json (например, development, production, stage)
-t, --target <name>    Алиас для --scenario
-e, --env <name>       Целевое окружение (например, production, stage)
--cwd <path>           Целевой каталог проекта
--dry-run              Показать план изменений без записи на диск
--skip-dns-check       Skip DNS pre-flight verification
--strict-dns           Abort deployment if DNS does not resolve to this host
--skip-up              Configure routes without bringing up containers
```

Примеры:

```bash
pegas -s development
pegas -s production
pegas deploy -s production
pegas deploy -t stage --dry-run
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

### `pegas uninstall [options]`

Удаляет Pegas из проекта и вычищает пакет (зеркально init)

Флаги:

```text
--dry-run             Показать план изменений без записи на диск
--cwd <path>          Целевой каталог проекта
```

Примеры:

```bash
pegas uninstall
pegas uninstall --dry-run
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

Проверяет контракт pegas.json, паритет секретов в .env и наличие устаревших файлов конфигурации

Флаги:

```text
--cwd <path>          Целевой каталог проекта
--fix                 Automatically repair common issues (.gitignore, .env.example sync, starter .env)
```

Примеры:

```bash
pegas check
pegas check --fix
pegas check --json
```

### `pegas status [options]`

Проверяет здоровье шлюза и активные маршруты проекта

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
-s, --scenario <name>  Целевой сценарий из pegas.json (например, development, production, stage)
-t, --target <name>    Алиас для --scenario
--gateway-dir <path>   Переопределить каталог шлюза
--json                 Машиночитаемый JSON-вывод (для агентов и скриптов)
-h, --help             Показать справку
-v, --version          Показать версию
```
