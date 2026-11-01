#!/usr/bin/env bun
/**
 * Генератор справочников документации из кода — единственных источников истины.
 *
 * 1. docs/reference/cli.md — справочник CLI: строится из COMMANDS/GLOBAL_OPTIONS
 *    в src/help.ts. Русские описания команд берутся из RU_COMMANDS ниже;
 *    флаги описываются на русском через RU_FLAGS.
 * 2. llms.txt — контекст для LLM-агентов (как и раньше, из src/commands/llms.ts).
 *
 * Файлы перезаписываются только при изменении содержимого — чтобы
 * не создавать лишние diff'ы. Запускается автоматически при bun run build.
 *
 * Гарантия актуальности: bun run docs:check в CI падает, если закоммичен
 * устаревший справочник.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { COMMANDS, GLOBAL_OPTIONS } from "../src/help.js";
import { buildLlmsText } from "../src/commands/llms.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI_REF_PATH = path.join(REPO_ROOT, "docs/reference/cli.md");
const LLMS_PATH = path.join(REPO_ROOT, "llms.txt");

/** Русские описания команд (source of truth по фактам — src/help.ts). */
const RU_COMMANDS: Record<string, string> = {
  init: "Инициализирует проект: создаёт контракт pegas.json, документацию и скрипты (runtime определяется автоматически)",
  update: "Обновляет @netrunner714/pegas до актуальной версии",
  dev: "Docker-runtime: сверяет контейнер с контрактом и подключается к логам; host-runtime: поднимает локальный HTTPS-прокси и приложение",
  deploy: "Разворачивает окружение (development/production): сеть, общий Gateway, контейнеры, маршруты",
  down: "Удаляет контейнеры проекта и его маршруты из Caddy (все окружения или одно через --env)",
  uninstall: "Удаляет Pegas из проекта и вычищает пакет (зеркально init)",
  ca: "Управляет локальным Root CA для доверенного dev-HTTPS (install/remove)",
  status: "Проверяет здоровье шлюза и активные маршруты проекта",
  llms: "Выводит машиночитаемый контекст для LLM-агентов",
};

/** Русские описания флагов. Ключ — имя флага. */
const RU_FLAGS: Record<string, string> = {
  "gateway-dir": "Переопределить каталог шлюза",
  json: "Машиночитаемый JSON-вывод (для агентов и скриптов)",
  help: "Показать справку",
  version: "Показать версию",
  force: "Сбросить контракт pegas.json на дефолты (создаёт pegas.json.bak)",
  "dry-run": "Показать план изменений без записи на диск",
  cwd: "Целевой каталог проекта",
  latest: "Обновляться между мажорными версиями (например, 1.x -> 2.x)",
  env: "Целевое окружение (например, production, stage)",
};

function ruCommandSummary(cmd: { name: string; summary: string }): string {
  return RU_COMMANDS[cmd.name] ?? cmd.summary;
}

function ruFlagDescription(name: string, fallback: string): string {
  return RU_FLAGS[name] ?? fallback;
}

function optionLabel(opt: { name: string; short?: string; placeholder?: string }): string {
  const short = opt.short ? `-${opt.short}, ` : "";
  return `${short}--${opt.name}${opt.placeholder ? ` ${opt.placeholder}` : ""}`;
}

function formatFlagList(options: { name: string; short?: string; placeholder?: string; description: string }[]): string[] {
  if (options.length === 0) return [];
  const labels = options.map(optionLabel);
  const width = Math.max(...labels.map((l) => l.length), 20);
  return options.map((opt, i) => {
    const pad = " ".repeat(Math.max(2, width - labels[i].length + 2));
    return `${labels[i]}${pad}${ruFlagDescription(opt.name, opt.description)}`;
  });
}

/** Строит docs/reference/cli.md из актуального реестра команд. */
export function buildCliReference(): string {
  const lines: string[] = [];

  lines.push("# Справочник CLI pegas");
  lines.push("");
  lines.push("> **Генерируемый файл.** Строится из src/help.ts командой \`bun run build\`.");
  lines.push("> Ручные правки перетираются. Русские описания команд — scripts/gen-docs.ts,");
  lines.push("> структура и факты — src/help.ts.");
  lines.push("");

  lines.push("## Команды");
  lines.push("");
  for (const cmd of COMMANDS) {
    lines.push("### \`pegas " + (cmd.usage || cmd.name) + "\`");
    lines.push("");
    lines.push(ruCommandSummary(cmd));
    lines.push("");
    if (cmd.options && cmd.options.length > 0) {
      lines.push("Флаги:");
      lines.push("");
      lines.push("\`\`\`text");
      lines.push(...formatFlagList(cmd.options));
      lines.push("\`\`\`");
      lines.push("");
    }
    if (cmd.examples && cmd.examples.length > 0) {
      lines.push("Примеры:");
      lines.push("");
      lines.push("\`\`\`bash");
      for (const ex of cmd.examples) lines.push(ex.replace(/^\$ /, ""));
      lines.push("\`\`\`");
      lines.push("");
    }
  }

  lines.push("## Глобальные флаги");
  lines.push("");
  lines.push("\`\`\`text");
  lines.push(...formatFlagList(GLOBAL_OPTIONS));
  lines.push("\`\`\`");
  lines.push("");

  return lines.join("\n");
}

async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {}

  if (existing === content) {
    console.log(`✓ ${path.relative(REPO_ROOT, filePath)} актуален`);
    return false;
  }

  await fs.writeFile(filePath, content, "utf-8");
  console.log(`✓ ${path.relative(REPO_ROOT, filePath)} перегенерирован (${content.length} байт)`);
  return true;
}

async function main(): Promise<void> {
  await fs.mkdir(path.dirname(CLI_REF_PATH), { recursive: true });
  await writeIfChanged(CLI_REF_PATH, buildCliReference());
  await writeIfChanged(LLMS_PATH, buildLlmsText());
}

main().catch((err) => {
  console.error("gen-docs failed:", err);
  process.exit(1);
});
