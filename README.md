# pegas

> **Agent-native оркестратор окружений и L7 reverse-proxy на базе Caddy для Docker.**
> Хостите сколько угодно сайтов и API на одном VPS: без конфликтов портов,
> с автоматическим Let's Encrypt SSL, строгой изоляцией секретов и hot-reload без даунтайма.
> Создан, чтобы быть надёжным и для разработчиков, и для ИИ-агентов (Cursor, Claude Code, Cline, Copilot).

[![npm version](https://img.shields.io/npm/v/@netrunner714/pegas.svg?color=cb3837)](https://www.npmjs.com/package/@netrunner714/pegas)
[![CI](https://github.com/netrunner714/pegas/actions/workflows/ci.yml/badge.svg)](https://github.com/netrunner714/pegas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D24.0.0-black.svg)](package.json)

---

## Проблема

Несколько проектов на одном VPS ломаются об одни и те же типовые проблемы:

* **Ловушка 80/443**: каждый Compose пытается занять `ports: "80:80"` / `"443:443"` — первый проект стартует, остальные падают с `bind: address already in use`.
* **DNS-сплит-брейн**: сервисы с популярными именами (`web`, `api`) в общей сети путаются, и Docker round-robin отправляет трафик в чужие контейнеры.
* **Вмешательство в package.json**: многие утилиты пытаются переписывать `scripts.dev` или навязывать свои команды запуска, ломая стек разработчика.
* **502 на холодном старте**: маршрутизация переключается до того, как приложение реально готово отвечать на запросы (сборка, миграции БД).
* **Захват доменов**: проект B случайно или намеренно объявляет домен проекта A и ломает чужой трафик.
* **Утечка секретов и комментированный мусор**: секреты размазываются по compose-файлам или коммитятся в репозиторий.

## Решение

Один легковесный Caddy-шлюз (~30 МБ RAM) держит порты 80 и 443; все проекты живут в общей сети `pegas-network` со скоуп-алиасами (`<project>-<service>`). Конфигурация объявляется в едином контракте `pegas.json`.

```
                Internet (:80 / :443)
                         │
                         ▼
              ┌─────────────────────┐
              │   pegas-gateway     │  ~30 МБ RAM, auto Let's Encrypt
              └──────────┬──────────┘
                         │  pegas-network
          ┌──────────────┴──────────────┐
          ▼                             ▼
   <проект-A>-web:3000         <проект-B>-web:8080
```

* **Чистый package.json**: Pegas не трогает и не оборачивает команды `scripts` (никакого скальпирования `dev` или `deploy`).
* **Локальный dev через link/unlink**: `pegas link` подключает проект к шлюзу (`*.localhost` -> `host.docker.internal:<port>`), а `pegas unlink` отключает. Запускайте свой dev-сервер привычным способом (`npm run dev`, `bun dev`, `cargo run` и т.д.).
* **Единый деплой по сценарию**: `pegas deploy -s <scenario>` — сценарий передается строго через флаг (`-s production`, `-s stage` и др.), никаких разрозненных команд-алиасов.
* **Строгий аудит (`pegas check`)**: проверка 1:1 паритета секретов между `pegas.json`, `.env` и `.env.example`, запрет закомментированных присваиваний и защита через `.gitignore`.
* **Readiness-пробы**: Caddy переключает маршруты только после того, как контейнер стал healthy — ноль 502 Bad Gateway.
* **Анти-хайджекинг**: Pegas блокирует развертывание, если домен уже закреплен за другим проектом на сервере.
* **Ноль сторонних зависимостей**: написан на чистом TypeScript под Node.js 24+ и Bun без единой зависимости в `dependencies`.

---

## Быстрый старт

### 1. Инициализация проекта

В корне любого репозитория выполните:

```bash
npx @netrunner714/pegas init
```

Команда автоматически определит стек проекта, создаст декларативный контракт `pegas.json`, стартовые файлы секретов (`.env.example`, `.env`), добавит `.pegas` в `.gitignore` и создаст документацию `docs/pegas.md` для ИИ-агентов.

### 2. Локальная разработка с HTTPS (`*.localhost`)

```bash
# 1. Установить локальный доверенный Root CA (выполняется один раз на машине)
npx pegas ca install

# 2. Подключить проект к локальному шлюзу
npx pegas link

# 3. Запустить проект привычной для вас командой разработки
npm run dev # или: bun dev, pnpm dev, cargo run и т.д.
```

Ваш проект мгновенно доступен по доверенному HTTPS: `https://<проект>.localhost`.

После окончания работы отключите проект:
```bash
npx pegas unlink
```

### 3. Деплой на VPS

На сервере развертывание выполняется строго по имени сценария из `pegas.json`:

```bash
# Деплой production-сценария
npx pegas deploy -s production

# Или деплой staging-сценария
npx pegas deploy -s stage
```

Pegas поднимет изолированные контейнеры, проверит readiness-пробы, зарегистрирует маршруты в Caddy, запросит бесплатные сертификаты Let's Encrypt и выполнит hot-reload без даунтайма.

---

## Основные команды

| Команда | Описание |
|---|---|
| `pegas init` | Создать контракт `pegas.json`, шаблоны секретов и документацию |
| `pegas link` | Подключить проект к локальному шлюзу (`*.localhost` -> локальный порт) |
| `pegas unlink` | Отключить проект от шлюза и очистить локальные dev-маршруты |
| `pegas deploy -s <scenario>` | Развернуть проект по сценарию из `pegas.json` (`-s production`, `-s stage` и др.) |
| `pegas logs -f [service]` | Потоковый просмотр логов контейнеров (Ctrl+C отключает только логи) |
| `pegas status` | Дашборд шлюза, всех активных доменов, upstream-адресов и контейнеров |
| `pegas check` | Полный аудит контракта, соответствия секретов и безопасности |
| `pegas down` | Остановить контейнеры проекта и удалить его маршруты из шлюза |
| `pegas ca <install\|remove>` | Управление локальным доверенным Root CA |
| `pegas update` | Обновить Pegas до актуальной версии (`--latest` для мажорных релизов) |

Полный справочник всех флагов и опций генерируется автоматически: [docs/reference/cli.md](docs/reference/cli.md).

---

## Контракт `pegas.json`

`pegas.json` — единственный источник правды о сети, доменах и сервисах проекта:

```jsonc
{
  "$schema": "https://netrunner714.ru/schemas/pegas.json",
  "projectName": "my-cool-app",
  "runtime": "docker",
  "secrets": [
    "DATABASE_URL",
    "API_SECRET"
  ],
  "env": {
    "APP_PORT": "3000",
    "PUBLIC_API_URL": {
      "development": "https://api.my-cool-app.localhost",
      "stage": "https://stage-api.mycoolapp.com",
      "production": "https://api.mycoolapp.com"
    }
  },
  "services": {
    "web": {
      "role": "app",
      "port": 3000,
      "domains": {
        "development": ["my-cool-app.localhost"],
        "production":  ["mycoolapp.com", "www.mycoolapp.com"]
      },
      "routes": {
        "/api/*": "api:4000"
      }
    },
    "api": {
      "role": "app",
      "port": 4000,
      "domains": {
        "development": ["api.my-cool-app.localhost"],
        "production":  ["api.mycoolapp.com"]
      }
    },
    "postgres": {
      "role": "infra",
      "image": "postgres:18-alpine",
      "volumes": ["pgdata:/var/lib/postgresql"]
    }
  }
}
```

* **`secrets`**: Список обязательных ключей секретов. Значения хранятся строго в `.env` (gitignored), а имена фиксируются в `.env.example`.
* **`env`**: Переносимые конфигурационные параметры (строка либо карта профилей `development`/`stage`/`production`). Поддерживаются ссылки на свойства других сервисов: `${services.<name>.<prop>}`.
* **`services.*.routes`**: L7-маршрутизация путей (например, проксирование `/api/*` в отдельный бэкенд внутри Caddy).

Подробное описание полей контракта — в [справочнике контракта](docs/reference/contract.md).

---

## Для ИИ-агентов

Pegas изначально спроектирован с расчетом на автономную работу AI-агентов (Cursor, Claude Code, Cline, Copilot):

* **Строгий JSON-режим**: любая команда поддерживает флаг `--json` с детерминированным машиночитаемым выводом.
* **Никаких интерактивных зависаний**: команды никогда не блокируют терминал вопросами или промптами.
* **Контекст в одном файле**: команда `npx pegas llms` и файл [llms.txt](llms.txt) содержат компактное, полное описание архитектуры, контракта и команд.
* **Самодиагностика и исправление**: `pegas check --fix` находит несоответствия секретов или `.gitignore` и автоматически их исправляет.

---

## Документация

| Раздел | Содержание |
|---|---|
| [Быстрый старт](docs/tutorials/quickstart.md) | Пошаговое руководство от инициализации до деплоя |
| [Руководства (How-To)](docs/how-to/) | Решение конкретных задач: [инициализация](docs/how-to/init.md), [локальный HTTPS](docs/how-to/local-https.md) |
| [Справочники](docs/reference/) | [CLI](docs/reference/cli.md) (автогенерируемый из кода), [контракт pegas.json](docs/reference/contract.md) |
| [Архитектура](docs/explanation/architecture.md) | Внутреннее устройство Pegas и обоснование технических решений |
| [Контекст для агентов](llms.txt) | Полный контекст для AI-ассистентов |

---

## Лицензия

MIT © [NETRUNNER714](https://netrunner714.ru)
