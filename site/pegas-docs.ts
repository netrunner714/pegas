// lib/pegas-docs.ts
// Загрузка документации pegas из GitHub (raw.githubusercontent.com).
// Репозиторий публичный — токены не нужны. Кеш в памяти процесса.

export interface PegasDocPage {
  slug: string;      // "quickstart" | "cli" | ...
  title: string;
  file: string;      // путь в репозитории: "docs/tutorials/quickstart.md"
}

const OWNER = "netrunner714";
const REPO = "pegas";
const BRANCH = "main";

const BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;

// Публичная навигация документации (внутренний раздел не включён).
export const PEGAS_DOC_PAGES: PegasDocPage[] = [
  { slug: "quickstart", title: "Быстрый старт", file: "docs/tutorials/quickstart.md" },
  { slug: "init", title: "Инициализация проекта", file: "docs/how-to/init.md" },
  { slug: "local-https", title: "Локальная разработка с HTTPS", file: "docs/how-to/local-https.md" },
  { slug: "cli", title: "Справочник CLI", file: "docs/reference/cli.md" },
  { slug: "contract", title: "Контракт pegas.json", file: "docs/reference/contract.md" },
  { slug: "architecture", title: "Архитектура", file: "docs/explanation/architecture.md" },
];

const mdCache = new Map<string, string>();

export async function fetchPegasDocMarkdown(file: string): Promise<string> {
  const cached = mdCache.get(file);
  if (cached !== undefined) return cached;

  const res = await fetch(`${BASE}/${file}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`pegas docs: ${file} → HTTP ${res.status}`);
  }
  const text = await res.text();
  mdCache.set(file, text);
  return text;
}

export async function findPegasDocPage(slug: string): Promise<PegasDocPage | undefined> {
  return PEGAS_DOC_PAGES.find((p) => p.slug === slug);
}
