// Отдаёт JSON Schema контракта pegas прямо из GitHub (репозиторий —
// единственный источник истины). Устаревание невозможно: контент
// обновляется в момент мержа в main.

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
