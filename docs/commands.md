# Канонический список команд Pegas CLI

По итогам ревизии интерфейс CLI приведен к строгому GitOps / Contract-First виду без императивных команд, псевдонимов и избыточных флагов.

| Команда | Описание | Окружение |
|---|---|:---:|
| `pegas init` | Инициализирует проект (`pegas.json`, `package.json`, `docs/pegas.md`) | `dev / local` |
| `pegas init --force` | Сбрасывает `pegas.json` на значения по умолчанию (создаёт бэкап) | `dev / local` |
| `pegas init --dry-run` | Симулирует инициализацию без записи файлов | `dev / local` |
| `pegas uninstall` | Зеркальный откат `init`: удаляет артефакты Pegas из проекта (контракт бэкапится в `pegas.json.bak`) | `dev / local` |
| `pegas uninstall --dry-run` | Предпросмотр удаления без записи на диск | `dev / local` |
| `pegas dev` | Поднимает локальный Caddy с HTTPS на `[service].[project].localhost` (порт 443, fallback 8443) | `dev` |
| `pegas dev -- <команда>` | Поднимает Caddy и запускает приложение разработчика в одном окне (напр. `pegas dev -- next dev`) | `dev` |
| `pegas ca install` | Генерирует локальный Root CA, добавляет его в доверенные ОС и выдаёт Caddy порт 443 (setcap) | `dev / local` |
| `pegas ca remove` | Удаляет локальный Root CA из системного хранилища доверия | `dev / local` |
| `pegas deploy <контур>` | Деплоит контейнеры и настраивает Caddy для контура (`production`, `stage`) | `prod / stage` |
| `pegas down` | Останавливает контейнеры проекта и удаляет его маршруты из Caddy | `prod / stage` |
| `pegas status` | Единый дашборд: здоровье шлюза Caddy, статус контейнеров и роутов проекта | `любое` |
| `pegas update` | Обновляет `@netrunner714/pegas` в `package.json` до актуальной версии | `dev / local` |
| `pegas update --latest` | Обновляет `@netrunner714/pegas` на последнюю мажорную версию | `dev / local` |
| `pegas llms` | Выводит компактный контекст контракта и шлюза для LLM-агентов | `любое` |

### Глобальные флаги
- `--json` — машиночитаемый JSON-вывод (для агентов и скриптов);
- `-h, --help` — контекстная справка по командам;
- `-v, --version` — версия CLI;
- `--cwd <path>` — переопределение рабочей директории проекта;
- `--gateway-dir <path>` — переопределение директории шлюза Caddy.
