#!/usr/bin/env bun
/**
 * Регенерирует llms.txt из единого источника истины (src/commands/llms.ts,
 * который строит CLI-секцию из COMMANDS в help.ts).
 *
 * Файл перезаписывается только при изменении содержимого — чтобы
 * не создавать лишние diff'ы и случайно не потерять ручные правки.
 *
 * Запускается автоматически при `bun run build`.
 */
import fs from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LLMS_PATH = path.join(REPO_ROOT, "llms.txt");

async function main(): Promise<void> {
  const { buildLlmsText } = await import("../src/commands/llms.js");
  const content = buildLlmsText();

  let existing: string | null = null;
  try {
    existing = await fs.readFile(LLMS_PATH, "utf-8");
  } catch {}

  if (existing === content) {
    console.log("✓ llms.txt is up to date");
    return;
  }

  await fs.writeFile(LLMS_PATH, content, "utf-8");
  console.log(`✓ llms.txt regenerated (${content.length} bytes)`);
}

main().catch((err) => {
  console.error("gen-llms failed:", err);
  process.exit(1);
});
