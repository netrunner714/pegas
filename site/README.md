# Страница /pegas/docs для сайта netrunner714.ru

Читает markdown-документацию **напрямую из GitHub** репозитория pegas
(он публичный): синхронизация не нужна вообще. Репозиторий — единственный
источник истины, сайт — только рендер.

## Файлы

- `page.tsx` — страница документации (server component, Next.js App Router);
- `pegas-docs.ts` — слой данных: список страниц и загрузка markdown из
  raw.githubusercontent.com с кешем в памяти (ISR/refresh по вкуху).

## Как подключить

1. Положите оба файла в соответствующие каталоги приложения сайта
   (`app/pegas/docs/page.tsx`, `lib/pegas-docs.ts`).
2. Рендер markdown — вашим существующим решением (react-markdown +
   remark-gfm). Это единственные dev-зависимости сайта, не pegas.
3. Проверьте, что на лендинге `/pegas` ссылка «Документация» ведёт на
   `/pegas/docs`.

## Поведение

- Контент берётся с ветки `main` — сайт обновляется в момент мержа, без
  деплоя сайта.
- Внутренний раздел (`docs/internal/`) в навигацию не включён.
- `docs/reference/cli.md` на сайте всегда свежий: он генерируется в CI
  репозитория на каждый билд.

## Отдача JSON Schema (`/schemas/pegas.json`)

Той же схемой — файл из репозитория, сайт только проксирует. Добавьте в
Next.js route handler `app/schemas/pegas/route.ts`:

```ts
// app/schemas/pegas/route.ts
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
