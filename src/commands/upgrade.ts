import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import child_process from "node:child_process";
import type { UpgradeOptions } from "../types.js";
import { compareSemver } from "../version.js";
import { resolveTargetVersion } from "./update.js";

/**
 * pegas upgrade — обновление глобальной установки pegas.
 * Отличие от pegas update: update меняет локальную зависимость
 * внутри проекта (package.json + lockfile), upgrade меняет
 * глобальный CLI на машине (bun add -g / npm install -g).
 * Локальные версии в проектах upgrade не трогает.
 */

export type GlobalPackageManager = "bun" | "npm";

export interface GlobalInstallation {
  pm: GlobalPackageManager;
  packageDir: string;
  version: string;
  /** true — глобальный пакет это symlink на checkout (dev-линк link:global), а не установка из npm. */
  linked: boolean;
}

export function getGlobalUpgradeCommand(pm: GlobalPackageManager, targetVer: string): string {
  const spec = "@netrunner714/pegas@" + targetVer;
  return pm === "bun" ? "bun add -g " + spec : "npm install -g " + spec;
}

async function readPackageVersion(packageDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(packageDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function npmGlobalRoot(): Promise<string | null> {
  try {
    const res = child_process.spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
    if (res.status !== 0) return null;
    const out = typeof res.stdout === "string" ? res.stdout.trim() : "";
    return out || null;
  } catch {
    return null;
  }
}

export async function detectGlobalInstallation(overrides: { globalDir?: string; npmRoot?: string | null; homeDir?: string | null } = {}): Promise<GlobalInstallation | null> {
  const candidates: Array<{ pm: GlobalPackageManager; packageDir: string }> = [];
  if (overrides.globalDir) {
    candidates.push({ pm: "npm", packageDir: overrides.globalDir });
  }
  const npmRoot = overrides.npmRoot !== undefined ? overrides.npmRoot : (await npmGlobalRoot());
  if (npmRoot) {
    candidates.push({ pm: "npm", packageDir: path.join(npmRoot, "@netrunner714", "pegas") });
  }
  const home = overrides.homeDir !== undefined ? overrides.homeDir : os.homedir();
  if (home) {
    candidates.push({ pm: "bun", packageDir: path.join(home, ".bun", "install", "global", "node_modules", "@netrunner714", "pegas") });
  }
  for (const c of candidates) {
    const version = await readPackageVersion(c.packageDir);
    if (!version) continue;
    return { pm: c.pm, packageDir: c.packageDir, version, linked: await isSymlink(c.packageDir) };
  }
  return null;
}

export async function handleUpgrade(options: UpgradeOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const allowMajor = options.latest ?? false;

  const fail = (msg: string): void => {
    if (isJson) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(msg);
    }
    if (!options.noExit) process.exit(1);
  };

  const installation = await detectGlobalInstallation({
    globalDir: options.globalDir,
    ...(options.npmRoot !== undefined ? { npmRoot: options.npmRoot } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  });
  if (!installation) {
    fail("❌ Ошибка: глобальный pegas не установлен. Установите: bun add -g @netrunner714/pegas (или npm install -g @netrunner714/pegas).");
    return;
  }

  if (installation.linked) {
    const target = await fs.realpath(installation.packageDir).catch(() => installation.packageDir);
    fail("❌ Ошибка: глобальный pegas — это dev-линк на checkout (" + target + "), а не установка из npm. Обновите checkout (git pull), затем в нём: bun run link:global. Или сначала bun unlink, затем bun add -g @netrunner714/pegas.");
    return;
  }

  const currentVer = installation.version;
  const { targetVer, hasNewerMajor, availableMajor } = await resolveTargetVersion(currentVer, allowMajor);
  const isUpToDate = compareSemver(targetVer, currentVer) <= 0;

  if (isUpToDate) {
    if (isJson) {
      console.log(JSON.stringify({ status: "up-to-date", current: currentVer, target: targetVer, latest: allowMajor, hasNewerMajor, availableMajor, scope: "global" }));
      return;
    }
    console.log("\n✓ Глобальный pegas уже актуален (v" + currentVer + ").");
    if (hasNewerMajor && availableMajor) {
      console.log("\n💡 Доступна новая мажорная версия v" + availableMajor + ". Для перехода запустите: pegas upgrade --latest\n");
    }
    return;
  }

  const upgradeCmd = getGlobalUpgradeCommand(installation.pm, targetVer);
  const [bin, ...binArgs] = upgradeCmd.split(" ");
  const child = child_process.spawnSync(bin, binArgs, {
    stdio: isJson ? "ignore" : "inherit",
    env: process.env,
  });

  if (child.status !== 0) {
    if (isJson) {
      console.log(JSON.stringify({ error: "Update command '" + upgradeCmd + "' failed with exit code " + String(child.status ?? 1), oldVersion: currentVer, targetVersion: targetVer, scope: "global" }));
    } else {
      console.error("\n❌ Ошибка: команда '" + upgradeCmd + "' завершилась с ошибкой (код " + String(child.status ?? 1) + ").\n");
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  if (isJson) {
    console.log(JSON.stringify({ status: "success", oldVersion: currentVer, newVersion: targetVer, packageManager: installation.pm, updateCommand: upgradeCmd, exitCode: child.status ?? 0, hasNewerMajor, availableMajor, scope: "global" }));
    return;
  }

  console.log("\n✨ Глобальный pegas успешно обновлен: v" + currentVer + " -> v" + targetVer + "!\n");
  console.log("  ✓ Выполнена команда: " + upgradeCmd);
  console.log("  ℹ️ Локальные версии в проектах обновляются отдельно: pegas update (внутри проекта)");
  if (hasNewerMajor && availableMajor) {
    console.log("\n💡 Доступна новая мажорная версия v" + availableMajor + ". Для перехода запустите: pegas upgrade --latest");
  }
  console.log("");
}
