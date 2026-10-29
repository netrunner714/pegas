import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import { UpdateOptions } from "../types.js";
import { findProjectRoot } from "../gateway.js";
import { VERSION, compareSemver, isSameMajor } from "../version.js";
import { checkNpmLatestVersion, checkInstalledVersion, setupAgentsMd } from "./init.js";
import { upgradePackageJson } from "../contract.js";
import { detectPackageManager, getUpdateCommand } from "../pm.js";

const DOCS_PEGAS_MD = `# Pegas

Этот проект настроен для работы со стандартизированным L7-шлюзом **Pegas**.

## Контракт сервисов
Конфигурация роутинга объявлена в файле \`pegas.json\`:
- \`port\`: порт приложения внутри контейнера (по умолчанию 3000)
- \`devGateway\`: параметры локального шлюза дева (\`httpPort: 8080\`, \`httpsPort: 8443\`, \`skipInstallTrust: true\`, \`admin: false\`)
- \`domains.development\`: локальные домены разработки (например: \`app.localhost\`)
- \`domains.stage\`: домены стейджинга (например: \`stage.app.com\`)
- \`domains.production\`: боевые домены с автоматическим SSL Let's Encrypt

## Команды
* Локальная разработка: \`npm run dev\` (запускает \`pegas dev\`)
* Деплой на продакшен: \`npm run deploy\` (запускает \`pegas deploy production\`)
* Деплой на стейджинг: \`pegas deploy stage\`
* Остановка проекта: \`pegas down\`

Документация: https://netrunner714.ru/pegas
`;

export async function resolveTargetVersion(
  currentVer: string,
  allowMajor: boolean,
  npmVerOverride?: string | null
): Promise<{ targetVer: string; hasNewerMajor: boolean; availableMajor?: string }> {
  const remoteVer = npmVerOverride !== undefined ? npmVerOverride : await checkNpmLatestVersion();
  const availableCandidates = [VERSION];
  if (remoteVer) {
    availableCandidates.push(remoteVer);
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
    console.error(`❌ Ошибка: @netrunner714/pegas не найден в зависимостях package.json. Сначала запустите 'pegas init'.`);
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

  // 1. Upgrade package.json
  await upgradePackageJson(projectRoot, targetVer, false);

  // 2. Run package manager update
  const [bin, ...binArgs] = updateCmd.split(" ");
  const child = child_process.spawnSync(bin, binArgs, {
    cwd: projectRoot,
    stdio: isJson ? "ignore" : "inherit",
    env: process.env,
  });

  // 3. Update docs/pegas.md and AGENTS.md to current standard
  const docsDir = path.join(projectRoot, "docs");
  const docsPath = path.join(docsDir, "pegas.md");
  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(docsPath, DOCS_PEGAS_MD, "utf-8");
  await setupAgentsMd(projectRoot, false);

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
  console.log(`  ✓ Обновлены docs/pegas.md и AGENTS.md`);

  if (hasNewerMajor && availableMajor) {
    console.log(`\n💡 Доступна новая мажорная версия v${availableMajor}. Для перехода запустите: pegas update --latest`);
  }
  console.log("");
}
