# Быстрый старт

> Цель руководства: за несколько минут получить проект с локальным HTTPS
> в деве и задеплоенный на VPS сайт. Копируйте команды как есть.

## Что понадобится

- Node.js 24+ и Docker на машине разработки;
- VPS с установленным Docker и правами на порты 80/443;
- домен (для прода) с A-записью на IP вашего VPS.

## Шаг 1. Подключить Pegas к проекту

Выполните в корне проекта:

```bash
npx @netrunner714/pegas init
```

Команда создаёт `docs/pegas.md` (правила для ИИ-агентов), добавляет блок Pegas
в `AGENTS.md` и правит `.gitignore` (`.pegas`, `.env*`, `!.env.example`).
Контракт `pegas.json` инициализация **не создаёт** — в v3 его пишут по
[схеме](https://netrunner714.ru/schemas/pegas.json) и эталону `example.json`
(разработчик или агент). Предпросмотр без записи:

```bash
npx @netrunner714/pegas init --dry-run
```

## Шаг 2. Описать контракт

Минимальный `pegas.json` (два сценария, один HTTP-сервис):

```jsonc
{
  "$schema": "https://netrunner714.ru/schemas/pegas.json",
  "projectName": "my-app",
  "scenarios": ["development", "production"],
  "gateway": {
    "development": { "httpPort": 80, "httpsPort": 443 },
    "production":  { "httpPort": 80, "httpsPort": 443, "acmeEmail": "admin@example.com" }
  },
  "services": {
    "web": {
      "runtime": { "development": { "driver": "docker" }, "production": { "driver": "docker" } },
      "build":   { "development": { "context": "." }, "production": { "context": "." } },
      "port":    { "development": 3000, "production": 3000 },
      "domains": { "development": ["my-app.localhost"], "production": ["example.com"] },
      "secrets": []
    }
  }
}
```

Правила: все сценарио-зависимые поля — карты с ключами из `scenarios` (Zero Scalars);
секреты — только имена в `services.<name>.secrets`, значения в `.env`/CI.

```bash
npx pegas check   # рид-онли аудит: контракт, секреты, git-гигиена
```

## Шаг 3. Локальная разработка с HTTPS

```bash
# 1. Доверенный Root CA (один раз на машину)
npx pegas ca install

# 2. Dev-маршруты проекта в общем шлюзе
npx pegas connect

# 3. Инфра-контейнеры сценария
npx pegas deploy -s development

# 4. Host-сервисы (driver: "bun") — привычной командой
bun run dev
```

Проект доступен по доверенному HTTPS: `https://my-app.localhost`.
Освободить маршруты: `npx pegas disconnect`.

## Шаг 4. Деплой на VPS

```bash
npx pegas deploy -s production
```

Pegas поднимет изолированные контейнеры, дождётся readiness-проб,
зарегистрирует маршруты, получит сертификаты Let's Encrypt и выполнит
hot-reload без даунтайма.

## Что дальше

- [Справочник контракта](../reference/contract.md) — все поля и правила;
- [Локальный HTTPS](../how-to/local-https.md) — детали CA и шлюза;
- [Архитектура](../explanation/architecture.md) — почему так устроено.
