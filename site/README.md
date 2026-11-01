# Страница /pegas/docs для сайта netrunner714.ru

Читает markdown-документацию **напрямую из GitHub** репозитория pegas
(он публичный): синхронизация не нужна вообще. Репозиторий — единственный
источник истины, сайт — только рендер.

## Файлы

- `app/docs-index-page.tsx` → `app/pegas/docs/page.tsx` — редирект на первую страницу;
- `app/docs-slug-page.tsx` → `app/pegas/docs/[slug]/page.tsx` — страница документации с навигацией;
- `app/schema-route.ts` → `app/schemas/pegas.json/route.ts` — отдача JSON Schema с `/schemas/pegas.json`;
- `pegas-docs.ts` → `lib/pegas-docs.ts` — слой данных: **контент и навигация** из raw.githubusercontent.com.

Файлы синхронизированы с реальным деплоем сайта (коммит 1b13454 в репо
netrunner714) и проверены локальной сборкой и smoke-тестами.

## Как подключить

1. Скопируйте три файла по путям выше (рендер — вашим существующим решением:
   react-markdown + remark-gfm, это dev-зависимости сайта, не pegas).
2. На лендинге `/pegas` добавьте ссылку «Документация» → `/pegas/docs`.

## Поведение

- **Контент и навигация** берутся с ветки `main` при каждом запросе:
  сайт обновляется в момент мержа, деплой сайта не нужен — ни при правках
  страниц, ни при добавлении новых.
- Навигация парсится из `docs/README.md` репозитория: все markdown-ссылки
  на `.md`-файлы становятся пунктами меню (в порядке следования в файле);
  ссылки на `internal/` игнорируются. Новая страница в docs — просто добавьте
  строку в `docs/README.md` и запушьте.
- При недоступности GitHub страница честно сообщает об ошибке; навигация
  откатывается к минимальному fallback.

## Отдача JSON Schema (`/schemas/pegas.json`)

Той же схемой — файл из репозитория, сайт только проксирует. Добавьте
route handler `app/schemas/pegas.json/route.ts`:

```ts
// app/schemas/pegas.json/route.ts
// Отдаёт JSON Schema контракта pegas прямо из GitHub (репозиторий —
// единственный источник истины). Устаревание невозможно: контент
// обновляется в момент мержа в main.

export const dynamic = "force-dynamic";

const SCHEMA_URL =
  "https://raw.githubusercontent.com/netrunner714/pegas/main/schemas/pegas.json";

export async function GET() {
  const res = await fetch(SCHEMA_URL, { cache: "no-store" });
  if (!res.ok) {
    return new Response("pegas schema unavailable", { status: 502 });
  }
  const body = await res.text();
  return new Response(body, {
    headers: {
      "content-type": "application/schema+json",
      "cache-control": "public, max-age=300",
    },
  });
}
```

После этого `$schema: "https://netrunner714.ru/schemas/pegas.json"` в
`pegas.json` включит автодополнение и валидацию в VS Code/WebStorm.
