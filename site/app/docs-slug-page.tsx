// Страница документации pegas: markdown И навигация читаются напрямую из
// GitHub (репозиторий — единственный источник истины). Новые страницы
// подхватываются сами после мержа в main; сайт не нужно переподнимать.

import type { Metadata } from "next";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, ArrowUpRight } from "lucide-react";

import {
  getPegasDocNav,
  fetchPegasDocMarkdown,
  findPegasDocPage,
} from "@/lib/pegas-docs";

// Документация читается из GitHub при каждом запросе: маршрут блокирующий.
export const instant = false;


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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = await findPegasDocPage(slug);
  return {
    title: page ? `${page.title} — pegas` : "Документация pegas",
    description: "Документация pegas: руководства, справочники CLI и контракта, архитектура.",
  };
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
    return (
      <main className="min-h-screen bg-[#08080a] text-zinc-300">
        <p className="p-12">Страница не найдена.</p>
      </main>
    );
  }

  let markdown: string;
  try {
    markdown = await fetchPegasDocMarkdown(page.file);
  } catch {
    return (
      <main className="min-h-screen bg-[#08080a] text-zinc-300">
        <p className="p-12">Не удалось загрузить документацию. Попробуйте обновить страницу.</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#08080a] text-zinc-300 selection:bg-zinc-800 selection:text-white">
      <div className="max-w-5xl mx-auto px-6 py-12">
        <div className="mb-10">
          <Link
            href="/pegas"
            className="inline-flex items-center gap-2 text-xs font-mono text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Вернуться к pegas</span>
          </Link>
        </div>

        <div className="flex flex-col lg:flex-row gap-10">
          <aside className="lg:w-56 shrink-0">
            <h2 className="mb-3 text-xs font-mono uppercase tracking-widest text-zinc-500">
              Документация pegas
            </h2>
            <nav className="flex flex-col gap-1">
              {pages.map((p) => (
                <Link
                  key={p.slug}
                  href={`/pegas/docs/${p.slug}`}
                  className={`rounded-lg px-3 py-1.5 text-sm font-sans ${p.slug === slug ? "bg-zinc-900 text-white border border-zinc-800" : "text-zinc-400 hover:text-white transition-colors"}`}
                >
                  {p.title}
                </Link>
              ))}
              <a
                href="https://github.com/netrunner714/pegas"
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-sans text-zinc-500 hover:text-white transition-colors"
              >
                <span>GitHub</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </a>
            </nav>
          </aside>

          <article className="prose prose-invert min-w-0 flex-1 max-w-none
            prose-headings:font-mono prose-headings:tracking-tight
            prose-code:text-emerald-300 prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
            prose-pre:bg-zinc-950/80 prose-pre:border prose-pre:border-zinc-800 prose-pre:rounded-xl
            prose-a:text-emerald-300
            prose-strong:text-zinc-100
            prose-table:text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={rewriteDocLinks(page.file)}>
              {markdown}
            </ReactMarkdown>
          </article>
        </div>
      </div>
    </main>
  );
}
