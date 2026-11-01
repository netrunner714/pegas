#!/usr/bin/env bun
/**
 * Проверка целостности документации для CI:
 *
 * 1. Сгенерированные файлы актуальны: docs/reference/cli.md и llms.txt
 *    совпадают с тем, что даёт генератор (иначе CI падает — справочник
 *    устарел, запустите `bun run build`).
 * 2. Ссылки: все относительные markdown-ссылки в публичной документации
 *    резолвятся в существующие файлы.
 * 3. Слои: публичные файлы не содержат шапку «Внутренний документ»;
 *    все файлы docs/internal/** её имеют.
 * 4. llms.txt не ссылается на внутренние документы.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { buildCliReference } from "./gen-docs.js";
import { buildLlmsText } from "../src/commands/llms.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const INTERNAL_MARKER = "Внутренний документ";

interface Violation {
  file: string;
  line?: number;
  message: string;
}

const errors: Violation[] = [];

function fail(): never {
  console.error("\n✗ Проверка документации провалилась:");
  for (const v of errors) {
    const at = v.line ? ":" + v.line : "";
    console.error("  " + v.file + at + " — " + v.message);
  }
  process.exit(1);
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listMarkdownFiles(full)));
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const GITHUB_LINE_RE = /\[[^\]]*\]\(([^)]+\.md)(#[^)]*)?\)/g;

async function main(): Promise<void> {
  // --- 1. Актуальность генерируемых файлов ---
  const cliRefExpected = buildCliReference();
  const cliRefActual = await readIfExists(path.join(REPO_ROOT, "docs/reference/cli.md"));
  if (cliRefActual !== cliRefExpected) {
    errors.push({ file: "docs/reference/cli.md", message: "устарел относительно src/help.ts; запустите `bun run build` и закоммитьте" });
  }
  const llmsExpected = buildLlmsText();
  const llmsActual = await readIfExists(path.join(REPO_ROOT, "llms.txt"));
  if (llmsActual !== llmsExpected) {
    errors.push({ file: "llms.txt", message: "устарел относительно src/commands/llms.ts; запустите `bun run build` и закоммитьте" });
  }

  // --- 2. Ссылки ---
  const publicDirs = ["docs/tutorials", "docs/how-to", "docs/reference", "docs/explanation"];
  const publicFiles: string[] = [path.join(REPO_ROOT, "README.md"), path.join(REPO_ROOT, "docs/README.md")];
  for (const d of publicDirs) {
    const dir = path.join(REPO_ROOT, d);
    try {
      publicFiles.push(...(await listMarkdownFiles(dir)));
    } catch {}
  }

  for (const file of publicFiles) {
    const text = await fs.readFile(file, "utf-8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      let m: RegExpExecArray | null;
      GITHUB_LINE_RE.lastIndex = 0;
      while ((m = GITHUB_LINE_RE.exec(lines[i])) !== null) {
        const target = m[1];
        if (/^https?:/i.test(target)) continue;
        const resolved = path.resolve(path.dirname(file), target);
        const exists = await readIfExists(resolved);
        if (exists === null) {
          errors.push({ file: path.relative(REPO_ROOT, file), line: i + 1, message: "битая ссылка: " + target });
        }
      }
    }
  }

  // --- 3. Гвард слоёв ---
  for (const file of publicFiles) {
    const text = await fs.readFile(file, "utf-8");
    if (text.includes(INTERNAL_MARKER)) {
      errors.push({ file: path.relative(REPO_ROOT, file), message: "содержит шапку внутреннего документа — файл не должен быть публичным" });
    }
  }
  const internalDir = path.join(REPO_ROOT, "docs/internal");
  const internalFiles = await listMarkdownFiles(internalDir);
  for (const file of internalFiles) {
    const text = await fs.readFile(file, "utf-8");
    if (!text.startsWith("# ") || !text.split("\n").slice(0, 12).some((l) => l.includes(INTERNAL_MARKER))) {
      errors.push({ file: path.relative(REPO_ROOT, file), message: "нет шапки «🔒 Внутренний документ» в первых строках" });
    }
  }

  // --- 4. llms.txt без внутренних ссылок ---
  const llms = await readIfExists(path.join(REPO_ROOT, "llms.txt"));
  if (llms && (llms.includes("docs/internal") || llms.includes(INTERNAL_MARKER))) {
    errors.push({ file: "llms.txt", message: "агентский контекст ссылается на внутренние документы" });
  }

  if (errors.length > 0) fail();
  console.log("✓ Документация актуальна: генерируемые файлы, ссылки, слои, агентский контекст");
}

main().catch((err) => {
  console.error("docs-check failed:", err);
  process.exit(1);
});
