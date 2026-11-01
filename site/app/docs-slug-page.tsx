// app/pegas/docs/[slug]/page.tsx
// Страница документации pegas: markdown И навигация читаются напрямую из
// GitHub (репозиторий — единственный источник истины). Новые страницы
// подхватываются сами после мержа в main; сайт не нужно переподнимать.

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  getPegasDocNav,
  fetchPegasDocMarkdown,
  findPegasDocPage,
} from "@/lib/pegas-docs";

export const dynamic = "force-dynamic";

/** Внутренние .md-ссылки становятся роутами сайта: ../reference/cli.md → /pegas/docs/cli */
function rewriteDocLinks(pageFile: string) {
  const dir = pageFile.replace(/\/+[^/]+$/, ""); // "docs/tutorials"
  return {
    a({ href, children }: { href?: string; children?: React.ReactNode }) {
      if (href && /\.md(#[^]*)?$/.test(href) && !/^https?:/.test(href)) {
        const clean = href.replace(/#.*$/, "");
        const absolute = clean.startsWith("docs/");
        const segs = absolute ? clean.split("/") : [...dir.split("/"), ...clean.split("/")];
        const out: string[] = [];
        for (const seg of segs) {
          if (seg === "..") out.pop();
          else if (seg && seg !== ".") out.push(seg);
        }
        const file = out.join("/");
        const slug = file.replace(/\.md$/, "").split("/").pop()?.toLowerCase() || "page";
        return <Link href={`/pegas/docs/${slug}`}>{children}</Link>;
      }
      return <a href={href}>{children}</a>;
    },
  };
}

export async function generateStaticParams() {
  const nav = await getPegasDocNav();
  return nav.map((p) => ({ slug: p.slug }));
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const pages = await getPegasDocNav();
  const page = await findPegasDocPage(slug);
  if (!page) {
    return <p className="p-12">Страница не найдена.</p>;
  }

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
    <div className="mx-auto flex max-w-5xl gap-10 px-6 py-12">
      <aside className="w-56 shrink-0">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-neutral-500">
          Документация pegas
        </h2>
        <nav className="flex flex-col gap-1">
          {pages.map((p) => (
            <Link
              key={p.slug}
              href={`/pegas/docs/${p.slug}`}
              className={`rounded px-3 py-1.5 text-sm ${p.slug === slug ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"}`}
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
      <article className="prose prose-invert min-w-0 flex-1">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={rewriteDocLinks(page.file)}>
          {markdown}
        </ReactMarkdown>
      </article>
    </div>
  );
}
