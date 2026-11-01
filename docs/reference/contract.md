# Контракт pegas.json

> Справочник по всем полям декларативного контракта. Контракт хранится в корне
> проекта и коммитится в git: он — единственный источник истины об окружении
> проекта, из него генерируются все производные артефакты.

## Схема целиком

```jsonc
{
  "projectName": "my-app",            // slug проекта
  "runtime": "docker",                // "docker" | "host" (отсутствует = host)
  "bootInfra": true,                  // поднимать ли БД при pegas dev (host-runtime)
  "deploy": { ... },                  // настройки деплоя
  "devGateway": { ... },              // настройки локального шлюза (host-runtime)
  "services": { ... }                 // сервисы проекта
}
```

## Корневые поля

| Поле | Тип | Default | Описание |
|---|---|---|---|
| `$schema` | string | `"https://netrunner714.ru/schemas/pegas.json"` | URL JSON Schema: включает автодополнение и валидацию в редакторе. Записывается при `pegas init`, доступен в [schemas/pegas.json](https://github.com/netrunner714/pegas/blob/main/schemas/pegas.json) |
| `projectName` | string | slug из package.json или имени каталога | Идентификатор проекта: скоуп сетевых алиасов и имя route-файла `conf.d/<projectName>.caddy` |
| `runtime` | "host" \| "docker" | "host" | Опциональный вход в декларативный Docker-рантайм. Отсутствие или `"host"` — прежнее поведение (semver-major не меняется) |
| `bootInfra` | boolean | false | При `true` `pegas dev` автоматически поднимает инфраструктурные сервисы из docker-compose.yml |
| `deploy` | object | — | См. [Секция deploy](#секция-deploy) |
| `devGateway` | object | — | См. [Секция devGateway](#секция-devgateway-host-runtime) |
| `env` | object | `{}` | **Глобальный конфиг проекта**: env-ключи, переносимые между окружениями и коммитимые в git. Значение — строка (одинаково во всех профилях) или карта `{ development, stage, production }` со **всеми тремя** ключами (частичные карты невалидны). Инжектится каждому сервису при `pegas dev`/`deploy`; сервисный `env` перекрывает глобальный. Секреты — только в `envFile` |
| `services` | object | **обязательно** | Сервисы проекта; ключ — имя сервиса |

### Пример глобального env

```jsonc
{
  "env": {
    "PUBLIC_PORT": { "development": "5432", "stage": "5432", "production": "5432" },
    "FEATURE_X": { "development": "true", "stage": "false", "production": "false" },
    "STATIC_KEY": "value"  // одинаковая во всех профилях
  }
}
```

Профиль выбирает сам запуск: `pegas deploy production` подставляет значения `production`, `pegas dev` — `development`. В коде проекта не нужны ключи типа `APP_ENV`/`NODE_ENV` и ветвления по ним: окружение уже разрешено деплоем (плюс каждому app-сервису инжектится `PEGAS_ENV=development|stage|production`).

## Секция services

Каждый сервис (ключ объекта) описывает один контейнер:

| Поле | Тип | Default | Описание |
|---|---|---|---|
| `port` | number \| string | — | Порт, который сервис слушает внутри сети |
| `upstream` | string | — | `<сервис>:<порт>` — цель проксирования во внутренней сети (host-runtime) |
| `build` | object | — | Сборка образа из контекста проекта: `{ context, dockerfile?, target? }` (`target` — stage multi-target Dockerfile). Взаимоисключимо с `image` |
| `image` | string | — | Готовый образ вместо сборки |
| `command` | string[] | default образа | Команда запуска контейнера |
| `env` | Record<string, string> | — | **Несекретные** переменные окружения |
| `envFile` | string | — | Путь к gitignored env-файлу; секреты передаются Docker напрямую, не попадают в манифесты и логи |
| `volumes` | string[] | — | Дополнительные named/bind volumes (синтаксис Compose short syntax) |
| `bindMount` | string | корень проекта | Путь исходников, монтируемый в контейнер |
| `role` | "app" \| "infra" | авто-детекция | Явная классификация сервиса |
| `hmr` | object | — | `{ fileWatch: "auto" \| "events" \| "polling" }` — режим отслеживания файлов |
| `dependsOn` | object \| string[] | — | Сервисы, которые должны подняться раньше |
| `healthcheck` | object | — | Docker healthcheck: `{ test, interval?, timeout?, retries?, startPeriod? }` |
| `domains` | object | — | Домены по окружениям, см. ниже |

### domains

```jsonc
"domains": {
  "development": ["my-app.localhost"],   // канонические имена окружений
  "stage":       ["staging.my-app.com"],
  "production":  ["my-app.com", "www.my-app.com"]
}
```

- Ключи — имена окружений. Поддерживаются алиасы `dev`/`prod`, но
  канонические имена — `development`/`production`; маршруты алиасов
  вычищаются при деплое канонического имени.
- Домены проверяются на анти-хайджекинг: деплой останавливается, если домен
  уже занят другим проектом на сервере.
- IDN-домены (`магазин.рф`) поддерживаются нативно, конвертируются в Punycode
  для файловой системы.

## Секция devGateway (host-runtime)

| Поле | Тип | Описание |
|---|---|---|
| `httpPort` | number | Порт локального HTTP-шлюза |
| `httpsPort` | number | Порт локального HTTPS-шлюза (default 443, fallback 8443+) |
| `skipInstallTrust` | boolean | Не устанавливать CA в системное хранилище |
| `admin` | boolean | Включить admin-интерфейс Caddy |
| `systemCaddy` | boolean | Использовать системный Caddy вместо закешированного бинарника |
| `caddyPath` | string | Явный путь к бинарнику Caddy |

## Секция deploy

| Поле | Тип | Описание |
|---|---|---|
| `strictDns` | boolean | Прервать деплой, если DNS-записи не соответствуют IP сервера |
| `skipDnsCheck` | boolean | Пропустить DNS pre-flight |
| `skipReadiness` | boolean | Пропустить проверку readiness контейнеров |

## Эволюция контракта

- Все новые поля **optional**: старые контракты остаются валидными.
- Расширения следуют SemVer: новые поля — minor, смена семантики существующих — major.
- `pegas init` никогда не мутирует контракт молча; плановое обновление — `pegas update`.
