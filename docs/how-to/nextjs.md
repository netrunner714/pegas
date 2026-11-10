# Next.js и домены `*.localhost` шлюза Pegas (`allowedDevOrigins`)

> How-to: настроить dev-сервер Next.js так, чтобы HMR и dev-ресурсы работали на
> доменах шлюза Pegas (`<project>.localhost`, `<service>.<project>.localhost`).

## Проблема

Pegas публикует локальные сервисы на доменах зоны `.localhost` через общий
шлюз (Caddy): `pegas connect` и `pegas deploy -s development` строят маршруты из
поля `services.<name>.domains` сценария `development`.

Next.js, начиная с версии 15.3 (и в backport-ветке 14.2.30), по умолчанию
защищает собственные dev-ресурсы (`/_next/*`, `/__nextjs*`) от обращений с
посторонних origin. Хост из заголовка `Origin` (для запросов без него — из
`Referer`) сравнивается со списком разрешённых; домен шлюза в этот список не
входит. Dev-сервер печатает предупреждение и/или отвечает `403` на HMR-сокете,
что выглядит как ошибка CORS на стороне шлюза:

```text
⚠ Blocked cross-origin request to Next.js dev resource /_next/webpack-hmr
  from "site.my-app.localhost".
Cross-origin access to Next.js dev resources is blocked by default for safety.
To allow this host in development, add it to "allowedDevOrigins" in next.config.js
```

Причина не в маршрутизации Pegas, а в настройке самого Next.js: домен шлюза
нужно разрешить опцией `allowedDevOrigins`.

## Решение

Опция `allowedDevOrigins` — массив строк в конфигурации Next.js. Значения
сопоставляются только с hostname запроса: схему, порт и путь указывать не нужно.
Поддерживаются шаблоны: `*` заменяет ровно одну метку hostname, `**` — одну и
более, но только в начале шаблона.

Рекомендуемый набор значений для проекта Pegas — точное имя зоны и рекурсивный
шаблон на каждый `<project>.localhost`:

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["my-app.localhost", "**.my-app.localhost"],
};

export default nextConfig;
```

```js
// next.config.js
module.exports = {
  allowedDevOrigins: ["my-app.localhost", "**.my-app.localhost"],
};
```

```js
// next.config.mjs
export default {
  allowedDevOrigins: ["my-app.localhost", "**.my-app.localhost"],
};
```

После изменения конфигурации dev-сервер Next.js перезапускают.

### Почему `*.localhost` недостаточно

В сообщении Next.js и в его документации встречается универсальный на первый взгляд
шаблон `['*.localhost']`. Он соответствует ровно одной метке перед `.localhost`,
то есть покрывает `<project>.localhost`, но не покрывает
`<service>.<project>.localhost`. Проект Pegas, у которого есть и корневой домен,
и домены сервисов, такой шаблон покрывает лишь частично.

Есть следствие, которое важно учитывать. В Next.js 14.2.30–16.1 режим реакции
зависит от того, задана ли опция вообще: пока `allowedDevOrigins` отсутствует,
dev-сервер ограничивается предупреждением и пропускает запрос; как только опция
появляется, непокрытый origin получает жёсткий ответ `403`. Начиная с 16.2
запрос с непокрытого origin блокируется всегда. Поэтому запись
`allowedDevOrigins: ['*.localhost']` в проекте с доменами вида
`<service>.<project>.localhost` превращает предупреждение в блокировку:
HMR перестаёт работать окончательно.

Точное имя зоны плюс рекурсивный шаблон (`"my-app.localhost", "**.my-app.localhost"`)
покрывают и корень зоны, и поддомены любого уровня. Этот набор работает на всех
версиях Next.js, где опция существует, включая ветку 14.2 (в ней шаблоны
`*.localhost` и `**.localhost` не сопоставляются вовсе, а точное имя и
`**.<project>.localhost` — работают).

В Next.js 16.3+ встроенный список разрешённых origin содержит `**.localhost`
вместо `*.localhost`, поэтому домены шлюза любой глубины разрешены без
дополнительной настройки.

## Поведение `pegas check`

`pegas check` инспектирует проект и выдаёт предупреждение (не ошибку), если:

- в `package.json` объявлен Next.js версии, поддерживающей `allowedDevOrigins`
  (15.3.0+ или 14.2.30+), и
- в сценарии `development` контракта есть домены зоны `.localhost`, и
- файл `next.config.{js,mjs,ts,mts,cjs}` отсутствует, либо в нём нет ключа
  `allowedDevOrigins`, либо его значение не покрывает dev-домены проекта.

Предупреждение содержит готовый список значений и ссылку на этот гайд. Проверка
учитывает встроенный в Next.js список разрешённых origin: `localhost` разрешён
всегда, `*.localhost` — в версиях до 16.2, `**.localhost` — с 16.3. Поэтому на
Next.js 16.3+ предупреждение о доменах `.localhost` не выдаётся: они покрыты
встроенным списком.

Если значение `allowedDevOrigins` вычисляется динамически (переменная, вызов
функции, spread, интерполяция), `pegas check` не может разобрать его
текстовым анализом. Вместо ложного предупреждения команда выдаёт подсказку
проверить покрытие доменов вручную.

Аудит работает только с корнем проекта. Монорепо, где приложение Next.js лежит
в подкаталоге (например, `apps/web`), не инспектируется: предупреждение в этом
случае не выдаётся.

## Версии Next.js без `allowedDevOrigins`

Опция `allowedDevOrigins` появилась в Next.js 15.3.0 и в ветке 14.2 начиная с
14.2.30. На более ранних версиях (15.0–15.2, 14.2.29 и ниже) защита dev-ресурсов
не реализована, опция отсутствует, и `pegas check` не выдаёт предупреждение о
ней. Наличие ключа `allowedDevOrigins` в конфигурации такой версии Next.js
отмечает как неизвестную опцию.

## Связанные материалы

* [Локальная разработка с HTTPS](./local-https.md) — `pegas connect`, доверенный CA, домены `*.localhost`.
* [Контракт pegas.json](../reference/contract.md) — поле `services.<name>.domains` и сценарные карты.
* Документация Next.js: `allowedDevOrigins` — <https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins>.
