# pegas

> **Agent-native оркестратор окружений и L7 reverse-proxy для Docker.**
> Хостите сколько угодно сайтов и API на одном VPS: без конфликтов портов,
> с автоматическим Let's Encrypt SSL и hot-reload без даунтайма. Создан,
> чтобы быть надёжным и для людей, и для ИИ-агентов (Cursor, Claude Code,
> Cline, Copilot).

[![npm version](https://img.shields.io/npm/v/@netrunner714/pegas.svg?color=cb3837)](https://www.npmjs.com/package/@netrunner714/pegas)
[![CI](https://github.com/netrunner714/pegas/actions/workflows/ci.yml/badge.svg)](https://github.com/netrunner714/pegas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D24.0.0-black.svg)](package.json)

---

## Проблема

Несколько Docker-проектов на одном VPS ($5–20/мес) ломаются об одно и то же:

* **Ловушка 80/443**: каждый compose пробрасывает `ports: "80:80"` — первый
  проект занимает порты, остальные падают с `bind: address already in use`.
* **DNS-сплит-брейн**: проекты в общей сети с одинаковыми именами сервисов
  (`web`) — Docker round-robin шлёт запросы в чужие контейнеры.
* **502 на холодном старте**: маршруты обновились раньше, чем приложение
  поднялось (миграции, сборка Next.js — 10–30 секунд).
* **Захват доменов**: проект B прописывает домен проекта A и ломает маршрутизацию.
* **Переполнение диска**: неограниченные логи контейнеров молча заполняют VPS.

## Решение

Один общий Caddy-шлюз (~30 МБ RAM) владеет портами 80 и 443; все проекты
живут во внутренней сети `pegas-network` со скоуп-алиасами. Конфигурация —
декларативный контракт `pegas.json`, из которого генерируется всё остальное.

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

* **Ноль конфликтов портов**: 80/443 слушает только шлюз.
* **Скоуп-алиасы**: `<project>-<service>` — DNS-коллизии невозможны.
* **Readiness-проба**: роуты обновляются после готовности контейнеров — без 502.
* **Анти-хайджекинг доменов**: занятый другим проектом домен не пропустит деплой.
* **DNS pre-flight**: A-записи проверяются до деплоя, лимиты ACME не сжигаются.
* **Ротация логов**: `max-size: 50m`, `max-file: 3` — диск цел.
* **Ноль зависимостей**: только стандартные модули Node 24+.

## Быстрый старт

```bash
npx @netrunner714/pegas init   # привязать Pegas к проекту
npm run dev                    # локальный HTTPS: https://<проект>.localhost
npx pegas ca install           # (один раз) доверенный сертификат
npm run deploy                 # деплой на VPS: контейнеры + роуты + SSL
```

Подробное руководство с объяснением каждого шага —
[docs/tutorials/quickstart.md](docs/tutorials/quickstart.md).

## Документация

| Раздел | Содержание |
|---|---|
| [Быстрый старт](docs/tutorials/quickstart.md) | Обучающее руководство: init → dev → deploy |
| [Руководства](docs/how-to/) | Решение конкретных задач: [инициализация](docs/how-to/init.md), [локальный HTTPS](docs/how-to/local-https.md) |
| [Справочники](docs/reference/) | [CLI](docs/reference/cli.md) (генерируется из кода), [контракт pegas.json](docs/reference/contract.md) |
| [Архитектура](docs/explanation/architecture.md) | Как устроен Pegas и почему |
| [Контекст для агентов](llms.txt) | Машиночитаемое описание для Cursor / Claude Code / Cline |

Внутренняя документация мейнтейнеров — `docs/internal/` (не пользовательская).

## Контракт `pegas.json`

```jsonc
{
  "$schema": "https://netrunner714.ru/schemas/pegas.json",
  "projectName": "my-cool-app",
  "runtime": "docker",              // опциональный вход в Docker-рантайм
  "services": {
    "web": {
      "role": "app",
      "port": 3000,
      "domains": {
        "development": ["my-cool-app.localhost"],
        "production":  ["mycoolapp.com", "www.mycoolapp.com"]
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

Все поля и правила эволюции — в [справочнике контракта](docs/reference/contract.md).

## Для ИИ-агентов

* Каждая команда поддерживает `--json` — машиночитаемый вывод.
* Нет интерактивных промптов — агенты не зависают.
* `npx pegas llms` и [llms.txt](llms.txt) дают агенту полный контекст:
  контракт, команды, правила работы с сетью и портами.

## Безопасность

* Docker socket **не** монтируется в шлюз (в отличие от Traefik) — нет вектора
  повышения привилегий.
* Security-заголовки по умолчанию: HSTS, `nosniff`, `Referrer-Policy`.
* Секреты — по ссылке (`envFile`), не попадают в манифесты и логи.
* Локальный dev — user-space, без sudo; откат конфигурации при ошибке reload.

## Лицензия

MIT © [NETRUNNER714](https://netrunner714.ru)
