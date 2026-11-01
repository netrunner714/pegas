// app/pegas/docs/page.tsx и app/pegas/docs/[slug]/page.tsx
// Страница документации pegas на сайте: markdown из GitHub, репозиторий —
// единственный источник истины. Обновляется сам после мержа в main.

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  PEGAS_DOC_PAGES,
  fetchPegasDocMarkdown,
  findPegasDocPage,
} from "@/lib/pegas-docs";

export const dynamic = "force-dynamic";

function DocLayout({ active, children }: { active: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-5xl gap-10 px-6 py-12">
      <aside className="w-56 shrink-0">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-neutral-500">
          Документация pegas
        </h2>
        <nav className="flex flex-col gap-1">
          {PEGAS_DOC_PAGES.map((p) => (
            <Link
              key={p.slug}
              href={`/pegas/docs/${p.slug}`}
              className={`rounded px-3 py-1.5 text-sm ${p.slug === active ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"}`}
            >
              {p.title}
            </Link>
          ))}
          <a
            href="https://github.com/netrunner714/pegas"
            className="mt-3 rounded px-3 py-1.5 text-sm text-neutral-500 hover:text-white"
          >
            GitHub ↗
          </a>
        </nav>
      </aside>
      <article className="prose prose-invert min-w-0 flex-1">{children}</article>
    </div>
  );
}

// --- app/pegas/docs/page.tsx: редирект на первую страницу ---
export default function DocsIndexPage() {
  return DocsIndex();
}

function DocsIndex() {
  const first = PEGAS_DOC_PAGES[0];
  return (
    <script
      dangerouslySetInnerHTML={{ __html: `window.location.replace('/pegas/docs/${first.slug}')` }}
    />
  );
}

// --- app/pegas/docs/[slug]/page.tsx ---
export async function generateStaticParams() {
  return PEGAS_DOC_PAGES.map((p) => ({ slug: p.slug }));
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = await findPegasDocPage(slug);
  if (!page) return <p className="p-12">Страница не найдена.</p>;

  let markdown: string;
  try {
    markdown = await fetchPegasDocMarkdown(page.file);
  } catch {
    return (
      <p className="p-12">
        Не удалось загрузить документацию. Попробуйте обновить страницу.
      </p>
    );
  }

  return (
    <DocLayout active={slug}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </DocLayout>
  );
}
