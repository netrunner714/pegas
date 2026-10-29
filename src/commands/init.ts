import fs from "node:fs/promises";
import path from "node:path";
import { InitOptions } from "../types.js";
import { findProjectRoot } from "../gateway.js";
import { setupProjectCompose } from "../compose.js";
import { setupProjectContract, updatePackageJson } from "../contract.js";
import { findOrDownloadCaddy } from "../binary.js";

const DOCS_PEGAS_MD = `# Pegas

Этот проект настроен для работы со стандартизированным L7-шлюзом **Pegas**.

## Контракт сервисов
Конфигурация роутинга объявлена в файле \`pegas.json\`:
- \`port\`: порт приложения внутри контейнера (по умолчанию 3000)
- \`domains.development\`: локальные домены разработки (например: \`app.localhost\`)
- \`domains.stage\`: домены стейджинга (например: \`stage.app.com\`)
- \`domains.production\`: боевые домены с автоматическим SSL Let's Encrypt

## Команды
* Локальная разработка: \`npm run dev\` (запускает \`pegas up --env development\`)
* Деплой на продакшен: \`npm run deploy\` (запускает \`pegas up --env production\`)
* Деплой на стейджинг: \`pegas up --env stage\`
* Остановка проекта: \`pegas down\`

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

export async function setupAgentsMd(projectDir: string, dryRun = false): Promise<string | null> {
  const agentsPath = path.join(projectDir, "AGENTS.md");
  const regex = /<!-- BEGIN:pegas-rules -->[\s\S]*?<!-- END:pegas-rules -->/;

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

export async function handleProjectInit(
  cwd = process.cwd(),
  isJson = false,
  dryRun = false
): Promise<void> {
  const actions: string[] = [];

  if (cwd !== process.cwd()) {
    actions.push(`Корень репозитория: ${cwd}`);
  }

  // 1. Contract generation (pegas.json) with smart slug detection
  const contractRes = await setupProjectContract(cwd, dryRun);
  if (contractRes.created) {
    actions.push(`Создан контракт ${contractRes.file} для проекта '${contractRes.slug}'`);
  } else {
    actions.push(`Контракт ${contractRes.file} уже существует`);
  }

  // 2. Update package.json scripts and devDependencies
  const pkgActions = await updatePackageJson(cwd, dryRun);
  actions.push(...pkgActions);

  // 3. Setup .gitignore (.pegas)
  const gitignoreAction = await setupGitignore(cwd, dryRun);
  if (gitignoreAction) {
    actions.push(gitignoreAction);
  }

  // 4. Create docs/pegas.md
  const docsDir = path.join(cwd, "docs");
  const docsPath = path.join(docsDir, "pegas.md");
  if (!dryRun) {
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(docsPath, DOCS_PEGAS_MD, "utf-8");
  }
  actions.push("Сгенерирован docs/pegas.md");

  // 5. Setup AGENTS.md (Pegas agent rules)
  const agentsAction = await setupAgentsMd(cwd, dryRun);
  if (agentsAction) {
    actions.push(agentsAction);
  }

  // 6. Surgery on docker-compose.yml
  const composeRes = await setupProjectCompose(cwd, contractRes.slug, dryRun);
  if (composeRes.created) {
    actions.push(`Создан ${composeRes.file} с expose и сетью pegas-network`);
  } else if (composeRes.updated) {
    actions.push(`Выполнена трансформация портов и подключение pegas-network в ${composeRes.file}`);
  } else {
    actions.push(`${composeRes.file}: порты и сеть pegas-network уже оптимизированы`);
  }

  // 7. Pre-warm local dev Caddy binary
  const binaryAction = await setupDevBinary(dryRun);
  actions.push(binaryAction);

  if (isJson) {
    console.log(
      JSON.stringify({
        status: dryRun ? "dry-run" : "success",
        dryRun,
        project: contractRes.slug,
        contract: contractRes.contract,
        actions,
        docs: docsPath,
      })
    );
    return;
  }

  if (dryRun) {
    console.log("\n📋 [dry-run] Pegas project initialization preview:\n");
    for (const act of actions) {
      console.log(`  • ${act}`);
    }
    console.log("\nNo changes were written to disk. Run 'pegas init' to apply.\n");
    return;
  }

  console.log("\n✨ Project initialized with Pegas!\n");
  for (const act of actions) {
    console.log(`  ✓ ${act}`);
  }
  console.log("\nNext steps:");
  console.log("  1. Check pegas.json and set your domains.");
  console.log("  2. Start local dev with: npm run dev\n");
}

export async function handleInit(options: InitOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const dryRun = options.dryRun ?? false;

  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  await handleProjectInit(projectRoot, isJson, dryRun);
}
