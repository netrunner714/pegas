// Редирект на первую страницу документации (навигация — из репозитория).

import { redirect } from "next/navigation";
import { getPegasDocNav } from "@/lib/pegas-docs";

// Документация читается из GitHub при каждом запросе: маршрут блокирующий.
export const instant = false;


export default async function DocsIndexPage() {
  const nav = await getPegasDocNav();
  const first = nav[0];
  redirect(`/pegas/docs/${first.slug}`);
}
