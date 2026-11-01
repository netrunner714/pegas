// app/pegas/docs/page.tsx
// Редирект на первую страницу документации (навигация — из репозитория).

import { redirect } from "next/navigation";
import { getPegasDocNav } from "@/lib/pegas-docs";

export const dynamic = "force-dynamic";

export default async function DocsIndexPage() {
  const nav = await getPegasDocNav();
  const first = nav[0];
  redirect(`/pegas/docs/${first.slug}`);
}
