// lib/pegas-docs.ts
// Документация pegas на сайте: контент И навигация читаются из репозитория
// (raw.githubusercontent.com, ветка main). Сайт не нужно переподнимать ни при
// правках страниц, ни при добавлении новых — структура парсится из
// docs/README.md при каждом запросе.

export interface PegasDocPage {
  slug: string;      // "quickstart" | "cli" | ...
  title: string;
  file: string;      // путь в репозитории: "docs/tutorials/quickstart.md"
}

const OWNER = "netrunner714";
const REPO = "pegas";
const BRANCH = "main";
const INDEX_FILE = "docs/README.md";

const BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;

const fetchCache = new Map<string, string>();

async function fetchRaw(file: string): Promise<string> {
  const cached = fetchCache.get(file);
  if (cached !== undefined) return cached;

  const res = await fetch(`${BASE}/${file}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`pegas docs: ${file} → HTTP ${res.status}`);
  }
  const text = await res.text();
  fetchCache.set(file, text);
  return text;
}

// Fallback, если docs/README.md недоступен или в нём нет ссылок.
const FALLBACK_PAGES: PegasDocPage[] = [
  { slug: "quickstart", title: "Быстрый старт", file: "docs/tutorials/quickstart.md" },
];

/** Слаг из пути файла: docs/tutorials/quickstart.md → quickstart. */
function slugFromFile(file: string): string {
  const base = file.replace(/\.md$/, "").split("/").pop() || "page";
  return base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "page";
}

/**
 * Навигация парсится из docs/README.md репозитория: все markdown-ссылки
 * вида ./path.md (или docs/…/path.md) становятся страницами документации.
 * Ссылки на internal/ игнорируются, ru/latinity не важна — порядок как в файле.
 */
export async function getPegasDocNav(): Promise<PegasDocPage[]> {
  let index: string;
  try {
    index = await fetchRaw(INDEX_FILE);
  } catch {
    return FALLBACK_PAGES;
  }

  const pages: PegasDocPage[] = [];
  const seen = new Set<string>();
  const linkRe = /\[([^\]]*)\]\(([^)]+\.md)(#[^)]*)?\)/g;

  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(index)) !== null) {
    const target = m[2];
    if (/^https?:/i.test(target)) continue;
    if (target.includes("internal")) continue;

    // Резолвим относительный путь ссылки к docs/README.md
    const resolved = target.startsWith("docs/")
      ? target
      : `docs/${target.replace(/^\.?\//, "")}`;

    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const title = (m[1] || slugFromFile(resolved))
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .replace(/^\s*\d+\.\s*/, "")
      .trim();

    pages.push({ slug: slugFromFile(resolved), title, file: resolved });
  }

  // Дедупликация по слагу (два разных файла с одним basename — оставляем первый)
  const bySlug = new Map<string, PegasDocPage>();
  for (const p of pages) {
    if (!bySlug.has(p.slug)) bySlug.set(p.slug, p);
  }
  return bySlug.size > 0 ? [...bySlug.values()] : FALLBACK_PAGES;
}

export async function fetchPegasDocMarkdown(file: string): Promise<string> {
  return fetchRaw(file);
}

export async function findPegasDocPage(slug: string): Promise<PegasDocPage | undefined> {
  const nav = await getPegasDocNav();
  return nav.find((p) => p.slug === slug);
}
