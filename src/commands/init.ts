import fs from "node:fs/promises";
import path from "node:path";
import { InitOptions } from "../types.js";
import { findProjectRoot } from "../gateway.js";
import { setupProjectCompose } from "../compose.js";
import { setupProjectContract, updatePackageJson } from "../contract.js";
import { findOrDownloadCaddy } from "../binary.js";
import { VERSION, compareSemver } from "../version.js";
import { detectPackageManager, getUpdateCommand } from "../pm.js";

const DOCS_PEGAS_MD = `# Pegas

Этот проект настроен для работы со стандартизированным L7-шлюзом **Pegas**.

## Контракт сервисов
Конфигурация роутинга объявлена в файле \`pegas.json\`:
- \`port\`: порт приложения внутри контейнера (по умолчанию 3000)
- \`devGateway\`: параметры локального шлюза дева (по умолчанию \`httpsPort: 443\`, \`httpPort: 80\` — чистые URL без порта)
- \`domains.development\`: локальные домены разработки (\`[service].[project].localhost\`, например: \`web.my-app.localhost\`)
- \`domains.stage\`: домены стейджинга (например: \`stage.app.com\`)
- \`domains.production\`: боевые домены с автоматическим SSL Let's Encrypt

## Команды
* Локальная разработка: \`npm run dev\` (запускает \`pegas dev\`)
* Деплой на продакшен: \`npm run deploy\` (запускает \`pegas deploy production\`)
* Деплой на стейджинг: \`pegas deploy stage\`
* Остановка проекта: \`pegas down\`
* Доверенный локальный HTTPS: \`pegas ca install\` (один раз на машину)

Документация: https://netrunner714.ru/pegas
`;

export async function setupGitignore(projectDir: string, dryRun = false): Promise<string | null> {
  const gitignorePath = path.join(projectDir, ".gitignore");
  try {
    const content = await fs.readFile(gitignorePath, "utf-8");
    const lines = content.split("\n").map((line) => line.trim());
    if (lines.includes(".pegas") || lines.includes(".pegas/")) {
      return null;
    }
    const updated = content.endsWith("\n") ? `${content}.pegas\n` : `${content}\n.pegas\n`;
    if (!dryRun) {
      await fs.writeFile(gitignorePath, updated, "utf-8");
    }
    return "Добавлена запись .pegas в .gitignore";
  } catch {
    if (!dryRun) {
      await fs.writeFile(gitignorePath, ".pegas\n", "utf-8");
    }
    return "Создан .gitignore с записью .pegas";
  }
}

export const PEGAS_AGENT_RULES = `<!-- BEGIN:pegas-rules -->
## Pegas
- Перед работой с роутингом или окружениями изучить \`docs/pegas.md\` и \`pegas.json\`.
- Все публичные домены и порты сервисов объявляются в \`pegas.json\`.
<!-- END:pegas-rules -->`;

/** Маркер блока правил Pegas в AGENTS.md (используется init и uninstall). */
export const PEGAS_AGENT_RULES_MARKER_REGEX = /<!-- BEGIN:pegas-rules -->[\s\S]*?<!-- END:pegas-rules -->/;

export async function setupAgentsMd(projectDir: string, dryRun = false): Promise<string | null> {
  const agentsPath = path.join(projectDir, "AGENTS.md");
  const regex = PEGAS_AGENT_RULES_MARKER_REGEX;

  try {
    const content = await fs.readFile(agentsPath, "utf-8");
    if (regex.test(content)) {
      let updated = content.replace(regex, PEGAS_AGENT_RULES);
      if (!updated.endsWith("\n")) {
        updated += "\n";
      }
      if (updated === content) {
        return null;
      }
      if (!dryRun) {
        await fs.writeFile(agentsPath, updated, "utf-8");
      }
      return "Обновлен блок правил Pegas в AGENTS.md";
    }

    const trimmed = content.trimEnd();
    const updated = trimmed.length > 0 ? `${trimmed}\n\n${PEGAS_AGENT_RULES}\n` : `${PEGAS_AGENT_RULES}\n`;
    if (!dryRun) {
      await fs.writeFile(agentsPath, updated, "utf-8");
    }
    return "Добавлен блок правил Pegas в AGENTS.md";
  } catch {
    if (!dryRun) {
      await fs.writeFile(agentsPath, `${PEGAS_AGENT_RULES}\n`, "utf-8");
    }
    return "Создан AGENTS.md с правилами Pegas";
  }
}

export async function setupDevBinary(dryRun = false): Promise<string> {
  if (dryRun) {
    return "Проверка локального Caddy для dev-режима (dry-run: пропущено)";
  }
  try {
    await findOrDownloadCaddy({ silent: true });
    return "Подготовлен локальный Caddy для dev-режима";
  } catch (err: any) {
    return `Предупреждение: не удалось предзагрузить Caddy (${err?.message || "ошибка сети"}), будет загружен при первом pegas dev`;
  }
}

/**
 * Проверяет статус локального Root CA и возвращает подсказку для init/dev.
 * Никогда не роняет вызывающий поток (best-effort).
 */
export async function checkCaStatusHint(): Promise<string | null> {
  try {
    const { isCaTrusted } = await import("../ca.js");
    if (await isCaTrusted()) {
      return "Локальный Root CA активен (HTTPS в браузере доверенный)";
    }
    return null;
  } catch {
    return null;
  }
}

export async function getProjectVersion(projectDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(projectDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    const dep =
      pkg.devDependencies?.["@netrunner714/pegas"] ||
      pkg.devDependencies?.pegas ||
      pkg.dependencies?.["@netrunner714/pegas"] ||
      pkg.dependencies?.pegas;
    if (dep) return dep.replace(/^[^0-9]*/, "");
  } catch {}

  return checkInstalledVersion(projectDir);
}

export async function checkInstalledVersion(projectDir: string): Promise<string | null> {
  const localPkgPath = path.join(projectDir, "node_modules", "@netrunner714", "pegas", "package.json");
  const fallbackPkgPath = path.join(projectDir, "node_modules", "pegas", "package.json");
  for (const p of [localPkgPath, fallbackPkgPath]) {
    try {
      const raw = await fs.readFile(p, "utf-8");
      const data = JSON.parse(raw);
      if (data.version) return data.version;
    } catch {}
  }
  return null;
}

export async function checkNpmLatestVersion(timeoutMs = 1200): Promise<string | null> {
  if (process.env.PEGAS_SKIP_NPM_CHECK || process.env.NODE_ENV === "test") {
    return null;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch("https://registry.npmjs.org/@netrunner714/pegas/latest", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version || null;
  } catch {
    return null;
  }
}

export async function handleProjectInit(
  cwd = process.cwd(),
  isJson = false,
  dryRun = false,
  optionsOrForce: boolean | { skipNpmCheck?: boolean; force?: boolean } = {}
): Promise<void> {
  const force = typeof optionsOrForce === "boolean" ? optionsOrForce : (optionsOrForce.force ?? false);
  const skipNpm =
    typeof optionsOrForce === "object" && typeof optionsOrForce.skipNpmCheck === "boolean"
      ? optionsOrForce.skipNpmCheck
      : Boolean(process.env.PEGAS_SKIP_NPM_CHECK || process.env.NODE_ENV === "test");

  const actions: string[] = [];

  // Отдельные (не «выполнено»-) заметки: выводятся после списка действий,
  // отдельным блоком, чтобы ключевая информация не терялась в списке.
  const notices: string[] = [];

  if (cwd !== process.cwd()) {
    actions.push(`Корень репозитория: ${cwd}`);
  }

  // 1. Contract generation (pegas.json) with smart slug detection
  const contractRes = await setupProjectContract(cwd, dryRun, force);
  if (contractRes.created) {
    actions.push(`Создан контракт ${contractRes.file} для проекта '${contractRes.slug}'`);
  } else if (contractRes.overwritten) {
    actions.push(`Сброшен на дефолт контракт ${contractRes.file} (бэкап сохранен в ${contractRes.backupFile})`);
  } else if (contractRes.updated) {
    const fields = contractRes.addedFields?.join(", ") || "devGateway";
    actions.push(`Дополнен контракт ${contractRes.file}: добавлены недостающие блоки (${fields})`);
  } else {
    actions.push(`Контракт ${contractRes.file} актуален`);
  }

  // 2. Update package.json scripts and devDependencies
  const runtime = contractRes.contract?.runtime;
  const pkgActions = await updatePackageJson(cwd, dryRun, runtime);
  actions.push(...pkgActions);

  // 2b. Check current version vs target version
  const currentVer = await getProjectVersion(cwd);
  if (currentVer && compareSemver(VERSION, currentVer) > 0) {
    const pm = await detectPackageManager(cwd);
    const updateCmd = getUpdateCommand(pm);
    actions.push(`Текущая: v${currentVer}, актуальная: v${VERSION}. Для обновления: ${updateCmd} (или 'pegas update')`);
  }

  // 2c. Check latest version from npm registry (non-blocking)
  const npmVer = skipNpm ? null : await checkNpmLatestVersion();
  if (npmVer && compareSemver(npmVer, VERSION) > 0) {
    const pm = await detectPackageManager(cwd);
    const updateCmd = getUpdateCommand(pm);
    actions.push(`Текущая: v${VERSION}, актуальная в npm: v${npmVer}. Для обновления: ${updateCmd} (или 'pegas update --latest')`);
  }

  // 3. Setup .gitignore (.pegas)
  const gitignoreAction = await setupGitignore(cwd, dryRun);
  if (gitignoreAction) {
    actions.push(gitignoreAction);
  }

  // 4. Create docs/pegas.md
  const docsContent = runtime === "docker"
    ? "# Pegas\n\nОкружение описывается в `pegas.json`. Development и production работают в Docker.\n\n## Команды\n- Развернуть development: `pegas deploy development`\n- Подключиться к логам: `pegas dev` (Ctrl+C только отключает логи)\n- Деплой production: `pegas deploy production`\n- Остановить проект: `pegas down`\n\nПользовательский Compose не является источником конфигурации Pegas.\n"
    : DOCS_PEGAS_MD;
  const docsDir = path.join(cwd, "docs");
  const docsPath = path.join(docsDir, "pegas.md");
  if (!dryRun) {
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(docsPath, docsContent, "utf-8");
  }
  actions.push("Сгенерирован docs/pegas.md");

  // 5. Setup AGENTS.md (Pegas agent rules)
  const agentsAction = await setupAgentsMd(cwd, dryRun);
  if (agentsAction) {
    actions.push(agentsAction);
  }

  // 6. Compose is a legacy host-runtime artifact. Docker runtime is generated
  // directly from pegas.json and must not create or patch project Compose files.
  if (runtime === "docker") {
    for (const generatedFile of [
      ".pegas/docker-compose.yml",
      ".pegas/docker-compose.yaml",
      ".pegas/compose.yml",
      ".pegas/compose.yaml",
    ]) {
      try {
        if (!dryRun) await fs.unlink(path.join(cwd, generatedFile));
        actions.push(`Удалён устаревший генерируемый ${generatedFile}`);
      } catch {}
    }
  } else {
    const composeRes = await setupProjectCompose(cwd, contractRes.slug, dryRun);
    if (composeRes.created) {
      actions.push(`Создан ${composeRes.file} с expose и сетью pegas-network`);
    } else if (composeRes.updated) {
      actions.push(`Выполнена трансформация портов и подключение pegas-network в ${composeRes.file}`);
    } else {
      actions.push(`${composeRes.file}: порты и сеть pegas-network уже оптимизированы`);
    }
  }

  // 7. Pre-warm local Caddy only for the legacy host runtime.
  if (runtime !== "docker") {
    const binaryAction = await setupDevBinary(dryRun);
    actions.push(binaryAction);
  } else {
    actions.push("Docker runtime использует общий контейнерный Caddy Gateway");
  }
  // 8. Local Root CA hint is relevant only to the legacy host Caddy runtime.
  if (runtime !== "docker" && !dryRun && !process.env.PEGAS_SKIP_CA_CHECK && process.env.NODE_ENV !== "test") {
    const caHint = await checkCaStatusHint();
    if (caHint) {
      actions.push(caHint);
    } else {
      notices.push("Сертификат не установлен: HTTPS в браузере будет с предупреждением.");
      notices.push("Решение: выполните 'pegas ca install' (один раз на машину).");
    }
  }

  if (isJson) {
    console.log(
      JSON.stringify({
        status: dryRun ? "dry-run" : "success",
        dryRun,
        project: contractRes.slug,
        contract: contractRes.contract,
        actions,
        notices,
        docs: docsPath,
      })
    );
    return;
  }

  if (dryRun) {
    console.log("\n📋 [dry-run] Предпросмотр инициализации проекта Pegas:\n");
    for (const act of actions) {
      console.log(`  • ${act}`);
    }
    for (const notice of notices) {
      console.log(`  ! ${notice}`);
    }
    console.log("\nИзменения не записаны на диск. Выполните 'pegas init' для применения.\n");
    return;
  }

  console.log("\n✨ Проект инициализирован с Pegas!\n");
  for (const act of actions) {
    console.log(`  ✓ ${act}`);
  }

  if (notices.length > 0) {
    console.log("");
    for (const notice of notices) {
      console.log(`  ⚠️  ${notice}`);
    }
  }

  console.log("\nЧто дальше:");
  console.log("  1. Проверьте pegas.json и укажите свои домены.");
  if (runtime === "docker") {
    console.log("  2. Разверните окружение: pegas deploy development");
    console.log("  3. Подключитесь к логам: pegas dev (Ctrl+C не останавливает контейнеры)\n");
  } else {
    console.log("  2. Запустите локальную разработку: npm run dev\n");
  }
}

export async function handleInit(options: InitOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const dryRun = options.dryRun ?? false;
  const force = Boolean(options.force);

  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  await handleProjectInit(projectRoot, isJson, dryRun, { force });
}
