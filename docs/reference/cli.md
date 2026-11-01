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

### `pegas dev [options] [-- <command...>]`

Docker-runtime: сверяет контейнер с контрактом и подключается к логам; host-runtime: поднимает локальный HTTPS-прокси и приложение

Флаги:

```text
--cwd <path>          Целевой каталог проекта
```

Примеры:

```bash
pegas dev
pegas dev -- next dev
```

### `pegas deploy <env> [options]`

Разворачивает окружение (development/production): сеть, общий Gateway, контейнеры, маршруты

Флаги:

```text
-e, --env <name>      Целевое окружение (например, production, stage)
--cwd <path>          Целевой каталог проекта
```

Примеры:

```bash
pegas deploy production
pegas deploy stage
```

### `pegas down [options]`

Удаляет контейнеры проекта и его маршруты из Caddy (все окружения или одно через --env)

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
--gateway-dir <path>  Переопределить каталог шлюза
--json                Машиночитаемый JSON-вывод (для агентов и скриптов)
-h, --help            Показать справку
-v, --version         Показать версию
```
