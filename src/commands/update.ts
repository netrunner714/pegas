import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import type { UpdateOptions } from "../types.js";
import { findProjectRoot } from "../gateway.js";
import { VERSION, compareSemver, isSameMajor } from "../version.js";
import { detectPackageManager, getUpdateCommand } from "../pm.js";

/** Последняя версия в npm-registry (best-effort: null при недоступности сети). */
async function checkNpmLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/@netrunner714/pegas/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

export async function resolveTargetVersion(
  currentVer: string,
  allowMajor: boolean,
  npmVerOverride?: string | null
): Promise<{ targetVer: string; hasNewerMajor: boolean; availableMajor?: string }> {
  const remoteVer = npmVerOverride !== undefined ? npmVerOverride : await checkNpmLatestVersion();
  const availableCandidates: string[] = [];
  if (remoteVer) {
    availableCandidates.push(remoteVer);
  }
  if (availableCandidates.length === 0 || (remoteVer && compareSemver(VERSION, remoteVer) <= 0)) {
    availableCandidates.push(VERSION);
  }

  // Find overall highest version
  let highestOverall = currentVer;
  for (const cand of availableCandidates) {
    if (compareSemver(cand, highestOverall) > 0) {
      highestOverall = cand;
    }
  }

  // Find highest version in the same major
  let highestSameMajor = currentVer;
  for (const cand of availableCandidates) {
    if (isSameMajor(currentVer, cand) && compareSemver(cand, highestSameMajor) > 0) {
      highestSameMajor = cand;
    }
  }

  const hasNewerMajor = compareSemver(highestOverall, currentVer) > 0 && !isSameMajor(currentVer, highestOverall);

  if (allowMajor) {
    return {
      targetVer: highestOverall,
      hasNewerMajor: false,
    };
  }

  return {
    targetVer: highestSameMajor,
    hasNewerMajor,
    availableMajor: hasNewerMajor ? highestOverall : undefined,
  };
}

export async function handleUpdate(options: UpdateOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const allowMajor = options.latest ?? false;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();

  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  const pkgPath = path.join(projectRoot, "package.json");

  let rawPkg: string;
  try {
    rawPkg = await fs.readFile(pkgPath, "utf-8");
  } catch {
    console.error(`❌ Ошибка: 'package.json' не найден в корне проекта (${projectRoot}).`);
    if (!options.noExit) process.exit(1);
    return;
  }

  let pkg: any;
  try {
    pkg = JSON.parse(rawPkg);
  } catch {
    console.error(`❌ Ошибка: не удалось распарсить 'package.json' как валидный JSON.`);
    if (!options.noExit) process.exit(1);
    return;
  }

  const depStr =
    pkg.devDependencies?.["@netrunner714/pegas"] ||
    pkg.devDependencies?.pegas ||
    pkg.dependencies?.["@netrunner714/pegas"] ||
    pkg.dependencies?.pegas;

  if (!depStr) {
    console.error(`❌ Ошибка: @netrunner714/pegas не найден в зависимостях package.json. Установите: bun add -d @netrunner714/pegas.`);
    if (!options.noExit) process.exit(1);
    return;
  }

  const currentVer = depStr.replace(/^[^0-9]*/, "") || "0.0.0";
  const { targetVer, hasNewerMajor, availableMajor } = await resolveTargetVersion(currentVer, allowMajor);
  const pm = await detectPackageManager(projectRoot);
  const updateCmd = getUpdateCommand(pm);

  const isUpToDate = compareSemver(targetVer, currentVer) <= 0;

  if (isUpToDate) {
    if (isJson) {
      console.log(
        JSON.stringify({
          status: "up-to-date",
          current: currentVer,
          target: targetVer,
          latest: allowMajor,
          hasNewerMajor,
          availableMajor,
        })
      );
      return;
    }

    console.log(`\n✓ @netrunner714/pegas уже актуален (v${currentVer}).`);
    if (hasNewerMajor && availableMajor) {
      console.log(`\n💡 Доступна новая мажорная версия v${availableMajor}. Для перехода запустите: pegas update --latest\n`);
    }
    return;
  }

  // 1. Upgrade package.json (devDependencies: ^targetVer; имя зависимости сохраняется)
  const depKey =
    pkg.devDependencies?.["@netrunner714/pegas"] !== undefined ? "devDependencies.@netrunner714/pegas"
    : pkg.devDependencies?.pegas !== undefined ? "devDependencies.pegas"
    : pkg.dependencies?.["@netrunner714/pegas"] !== undefined ? "dependencies.@netrunner714/pegas"
    : "dependencies.pegas";
  const [section, name] = depKey.split(".");
  pkg[section][name] = `^${targetVer}`;
  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

  // 2. Run package manager update
  const [bin, ...binArgs] = updateCmd.split(" ");
  const child = child_process.spawnSync(bin, binArgs, {
    cwd: projectRoot,
    stdio: isJson ? "ignore" : "inherit",
    env: process.env,
  });

  if (child.status !== 0) {
    // Rollback package.json to original content
    await fs.writeFile(pkgPath, rawPkg, "utf-8");

    if (isJson) {
      console.log(
        JSON.stringify({
          error: `Update command '${updateCmd}' failed with exit code ${child.status ?? 1}`,
          oldVersion: currentVer,
          targetVersion: targetVer,
        })
      );
    } else {
      console.error(`\n❌ Ошибка: команда '${updateCmd}' завершилась с ошибкой (код ${child.status ?? 1}).`);
      console.error(`   Изменения в package.json отменены.\n`);
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  if (isJson) {
    console.log(
      JSON.stringify({
        status: "success",
        oldVersion: currentVer,
        newVersion: targetVer,
        packageManager: pm,
        updateCommand: updateCmd,
        exitCode: child.status ?? 0,
        hasNewerMajor,
        availableMajor,
      })
    );
    return;
  }

  console.log(`\n✨ @netrunner714/pegas успешно обновлен: v${currentVer} -> v${targetVer}!\n`);
  console.log(`  ✓ Обновлен package.json (devDependencies: ^${targetVer})`);
  console.log(`  ✓ Выполнена команда: ${updateCmd}`);

  if (hasNewerMajor && availableMajor) {
    console.log(`\n💡 Доступна новая мажорная версия v${availableMajor}. Для перехода запустите: pegas update --latest`);
  }
  console.log("");
}
