import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import { UninstallOptions } from "../types.js";
import { findProjectRoot } from "../gateway.js";
import { CONTRACT_FILENAME } from "../contract.js";
import { PEGAS_AGENT_RULES_MARKER_REGEX } from "./init.js";
import { detectPackageManager, getRemoveCommand } from "../pm.js";

/**
 * `pegas uninstall` — зеркальный откат `pegas init`.
 *
 * Принцип: удаляем только то, что создали сами (фиксированный список
 * артефактов init), ничего сверх. Контракт бэкапится в pegas.json.bak
 * перед удалением. В конце запускается команда пакетного менеджера
 * (например, 'bun remove @netrunner714/pegas') — чтобы вычистить пакет
 * и обновить lockfile одной командой, без ручных next steps.
 */

/** Вырезает блок Pegas из AGENTS.md, возвращает новый контент или null. */
export function stripPegasBlockFromAgentsMd(content: string): string | null {
  if (!PEGAS_AGENT_RULES_MARKER_REGEX.test(content)) {
    return null;
  }
  let updated = content.replace(PEGAS_AGENT_RULES_MARKER_REGEX, "");
  // Зачистка пустых хвостов от вырезанного блока
  updated = updated.replace(/\n{3,}/g, "\n\n").trimEnd();
  return updated;
}

/** Разворачивает dev-скрипт из обёртки `pegas dev -- <cmd>` обратно в `<cmd>`. */
export function unwrapDevScript(devScript: string): string {
  // Пробел после ' -- ' обязателен: 'pegas dev --vite' — это флаги, не обёртка команды
  const match = devScript.match(/^pegas dev --(?: .*)?$/);
  if (!match) return devScript;
  return devScript.slice("pegas dev --".length).trim();
}

export interface UninstallActions {
  removed: string[];
  notes: string[];
  backupFile?: string;
}

/**
 * Чистит `pegas.json`, `docs/pegas.md`, блок в `AGENTS.md`, `.pegas/`,
 * строку `.pegas` в `.gitignore`. Возвращает список действий.
 */
export async function removePegasFiles(projectDir: string, dryRun = false): Promise<UninstallActions> {
  const actions: UninstallActions = { removed: [], notes: [] };
  const contractPath = path.join(projectDir, CONTRACT_FILENAME);

  // 1. Контракт: бэкап -> удаление
  const contractExists = await fs.access(contractPath).then(() => true).catch(() => false);
  if (contractExists) {
    const backupPath = `${contractPath}.bak`;
    if (!dryRun) {
      await fs.copyFile(contractPath, backupPath);
      await fs.rm(contractPath, { force: true });
    }
    actions.removed.push(CONTRACT_FILENAME);
    actions.backupFile = `${CONTRACT_FILENAME}.bak`;
    actions.notes.push(`Контракт сохранён в ${actions.backupFile}`);
  }

  // 2. docs/pegas.md (файл фиксированный, перегенерируемый init'ом)
  const docsPegasPath = path.join(projectDir, "docs", "pegas.md");
  const docsExists = await fs.access(docsPegasPath).then(() => true).catch(() => false);
  if (docsExists && !dryRun) {
    await fs.rm(docsPegasPath, { force: true });
  }
  if (docsExists) {
    actions.removed.push("docs/pegas.md");
  }

  // 3. Блок Pegas в AGENTS.md (вырезается по маркерам, остальное не трогаем)
  const agentsPath = path.join(projectDir, "AGENTS.md");
  try {
    const agentsContent = await fs.readFile(agentsPath, "utf-8");
    const stripped = stripPegasBlockFromAgentsMd(agentsContent);
    if (stripped !== null) {
      if (!dryRun) {
        if (stripped.length > 0) {
          await fs.writeFile(agentsPath, `${stripped}\n`, "utf-8");
        } else {
          // Файл состоял только из блока Pegas — удаляем целиком
          await fs.rm(agentsPath, { force: true });
        }
      }
      actions.removed.push("блок правил Pegas в AGENTS.md");
    }
  } catch {}

  // 4. .pegas/ целиком
  const pegasDir = path.join(projectDir, ".pegas");
  const pegasDirExists = await fs.access(pegasDir).then(() => true).catch(() => false);
  if (pegasDirExists && !dryRun) {
    await fs.rm(pegasDir, { recursive: true, force: true });
  }
  if (pegasDirExists) {
    actions.removed.push(".pegas/");
  }

  // 5. Строка .pegas в .gitignore
  const gitignorePath = path.join(projectDir, ".gitignore");
  try {
    const giContent = await fs.readFile(gitignorePath, "utf-8");
    const lines = giContent.split("\n");
    const filtered = lines.filter((l) => l.trim() !== ".pegas" && l.trim() !== ".pegas/");
    if (filtered.length !== lines.length) {
      let updated = filtered.join("\n");
      // Не оставляем пустой хвост из пустых строк
      updated = updated.replace(/\n{2,}$/g, "\n");
      if (!updated.endsWith("\n") && updated.length > 0) {
        updated += "\n";
      }
      if (!dryRun) {
        await fs.writeFile(gitignorePath, updated, "utf-8");
      }
      actions.removed.push("запись .pegas в .gitignore");
    }
  } catch {}

  return actions;
}

/**
 * Вычищает pegas-скрипты и devDependency из package.json.
 * Скрипт deploy удаляется только при дословном совпадении с тем, что
 * создаёт init; dev-скрипт разворачивается из обёртки.
 */
export async function removePegasFromPackageJson(projectDir: string, dryRun = false): Promise<UninstallActions> {
  const actions: UninstallActions = { removed: [], notes: [] };
  const pkgPath = path.join(projectDir, "package.json");

  let pkg: any;
  try {
    const raw = await fs.readFile(pkgPath, "utf-8");
    pkg = JSON.parse(raw);
  } catch {
    return actions;
  }

  const changed = false;
  let fileChanged = false;

  // 1. dev-скрипт: развернуть обёртку
  if (typeof pkg.scripts?.dev === "string" && pkg.scripts.dev.startsWith("pegas dev --")) {
    pkg.scripts.dev = unwrapDevScript(pkg.scripts.dev);
    if (pkg.scripts.dev === "") {
      delete pkg.scripts.dev;
      actions.removed.push("скрипт 'dev' (состоял только из обёртки pegas)");
    } else {
      actions.removed.push(`скрипт 'dev' развернут: '${pkg.scripts.dev}'`);
    }
    fileChanged = true;
  }

  // 2. deploy-скрипт: только дословное совпадение с init-версией
  if (pkg.scripts?.deploy === "pegas deploy production") {
    delete pkg.scripts.deploy;
    actions.removed.push("скрипт 'deploy'");
    fileChanged = true;
  }

  // 3. devDependency
  const depFields = ["devDependencies", "dependencies"];
  for (const field of depFields) {
    if (pkg[field]?.["@netrunner714/pegas"]) {
      delete pkg[field]["@netrunner714/pegas"];
      actions.removed.push(`'@netrunner714/pegas' из ${field}`);
      fileChanged = true;
    }
    if (pkg[field]?.pegas) {
      delete pkg[field].pegas;
      actions.removed.push(`'pegas' из ${field}`);
      fileChanged = true;
    }
  }

  if (fileChanged && !dryRun) {
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  }

  return actions;
}

export async function handleUninstall(options: UninstallOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const dryRun = options.dryRun ?? false;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const projectRoot = (await findProjectRoot(cwd)) || cwd;

  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);
  const contractExists = await fs.access(contractPath).then(() => true).catch(() => false);
  if (!contractExists) {
    const message = `Контракт '${CONTRACT_FILENAME}' не найден — Pegas в этом проекте не инициализирован.`;
    if (isJson) {
      console.log(JSON.stringify({ status: "not-initialized", message }));
    } else {
      console.log(`ℹ️  ${message}`);
    }
    return;
  }

  const fileActions = await removePegasFiles(projectRoot, dryRun);
  const pkgActions = await removePegasFromPackageJson(projectRoot, dryRun);

  const pm = await detectPackageManager(projectRoot);
  const removeCmd = getRemoveCommand(pm);

  // Запускаем пакетный менеджер одной командой: вычищает node_modules и lockfile
  let removeExitCode: number | null = null;
  let removeFailed = false;
  if (!dryRun) {
    const [bin, ...binArgs] = removeCmd.split(" ");
    const res = child_process.spawnSync(bin, binArgs, {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    });
    removeExitCode = res.status ?? 1;
    removeFailed = removeExitCode !== 0;
  }

  if (isJson) {
    console.log(
      JSON.stringify({
        status: dryRun ? "dry-run" : removeFailed ? "partial" : "success",
        dryRun,
        project: path.basename(projectRoot),
        removed: [...fileActions.removed, ...pkgActions.removed],
        backupFile: fileActions.backupFile,
        packageManager: pm,
        removeCommand: removeCmd,
        removeCommandExitCode: removeExitCode,
      })
    );
    return;
  }

  if (dryRun) {
    console.log("\n📋 [dry-run] Pegas uninstall preview:\n");
  } else {
    console.log("\n🧹 Pegas удалён из проекта:\n");
  }

  for (const item of [...fileActions.removed, ...pkgActions.removed]) {
    console.log(`  ✓ ${item}`);
  }
  if (fileActions.notes.length > 0 && !dryRun) {
    for (const note of fileActions.notes) {
      console.log(`  💾 ${note}`);
    }
  }
  if (fileActions.removed.length === 0 && pkgActions.removed.length === 0) {
    console.log("  (нечего удалять)");
  }

  if (dryRun) {
    console.log(`\n(запустите 'pegas uninstall' для применения; пакет удаляется командой '${removeCmd}')\n`);
  } else if (removeFailed) {
    console.error(`\n⚠️  Артефакты удалены, но команда '${removeCmd}' завершилась с кодом ${removeExitCode}.`);
    console.error(`   Пакет и lockfile нужно вычистить вручную.\n`);
    if (!options.noExit) {
      process.exit(1);
    }
  } else {
    console.log(`\n  ✓ Пакет вычищен и lockfile обновлён: ${removeCmd}\n`);
  }
}
