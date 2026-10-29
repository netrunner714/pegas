import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { InitOptions } from "../types.js";
import {
  checkDocker,
  checkDockerCompose,
  ensureDockerNetwork,
  startGatewayContainer,
  validateCaddyConfig,
} from "../docker.js";
import { findProjectRoot } from "../gateway.js";
import { setupProjectCompose } from "../compose.js";
import { setupProjectContract, updatePackageJson } from "../contract.js";

const DOCS_PEGAS_MD = `# Pegas

Этот проект настроен для работы со стандартизированным L7-шлюзом **Pegas**.

## Контракт сервисов
Конфигурация роутинга объявлена в файле \`pegas.json\`:
- \`upstream\`: адрес контейнера во внутренней сети \`pegas-network\` (например: \`app:3000\`)
- \`domains.dev\`: локальные домены разработки (например: \`app.localhost\`)
- \`domains.prod\`: боевые домены с автоматическим SSL Let's Encrypt

## Команды
* Локальная разработка: \`npm/pnpm/bun run dev\` (запускает \`pegas dev\`)
* Деплой на продакшен: \`npm/pnpm/bun run deploy\` (запускает \`pegas deploy\`)
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

  // 5. Surgery on docker-compose.yml
  const composeRes = await setupProjectCompose(cwd, contractRes.slug, dryRun);
  if (composeRes.created) {
    actions.push(`Создан ${composeRes.file} с expose и сетью pegas-network`);
  } else if (composeRes.updated) {
    actions.push(`Выполнена трансформация портов и подключение pegas-network в ${composeRes.file}`);
  } else {
    actions.push(`${composeRes.file}: порты и сеть pegas-network уже оптимизированы`);
  }

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

export async function handleServerInit(options: InitOptions): Promise<void> {
  const isJson = options.json ?? false;

  // 1. Check Docker
  const hasDocker = await checkDocker();
  if (!hasDocker) {
    if (isJson) {
      console.log(JSON.stringify({ error: "Docker daemon is not running or not installed." }));
    } else {
      console.error("❌ Error: Docker daemon is not running or not installed.");
    }
    if (!options.noExit) {
      process.exit(1);
    }
    return;
  }

  const hasCompose = await checkDockerCompose();
  if (!hasCompose) {
    if (isJson) {
      console.log(JSON.stringify({ error: "Docker Compose is not available." }));
    } else {
      console.error("❌ Error: Docker Compose is not available.");
    }
    if (!options.noExit) {
      process.exit(1);
    }
    return;
  }

  // 2. Gateway directory
  const gatewayDir = options.gatewayDir
    ? path.resolve(options.gatewayDir)
    : path.join(os.homedir(), "gateway");

  await fs.mkdir(gatewayDir, { recursive: true });
  const confDir = path.join(gatewayDir, "conf.d");
  await fs.mkdir(confDir, { recursive: true });

  // 3. Ensure Docker network
  const networkName = options.networkName || "pegas-network";
  await ensureDockerNetwork(networkName);

  // 4. Create Caddyfile if not exists
  const caddyfilePath = path.join(gatewayDir, "Caddyfile");
  try {
    await fs.access(caddyfilePath);
  } catch {
    const globalOptions = options.email ? `{\n    email ${options.email}\n}` : `{\n    # Global options\n}`;
    const defaultCaddyfile = `${globalOptions}\n\nimport /etc/caddy/conf.d/*.caddy\n`;
    await fs.writeFile(caddyfilePath, defaultCaddyfile, "utf-8");
  }

  // 5. Create docker-compose.yml if not exists
  const composePath = path.join(gatewayDir, "docker-compose.yml");
  try {
    await fs.access(composePath);
  } catch {
    const defaultCompose = `services:
  caddy:
    image: caddy:2-alpine
    container_name: gateway-caddy
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "3"
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./conf.d:/etc/caddy/conf.d:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - ${networkName}

networks:
  ${networkName}:
    external: true

volumes:
  caddy_data:
  caddy_config:
`;
    await fs.writeFile(composePath, defaultCompose, "utf-8");
  }

  // 6. Start Caddy
  const startRes = await startGatewayContainer(gatewayDir);
  if (!startRes.success) {
    if (isJson) {
      console.log(JSON.stringify({ error: "Failed to start Caddy container", details: startRes.stderr }));
    } else {
      console.error("❌ Failed to start Caddy container:", startRes.stderr);
    }
    if (!options.noExit) {
      process.exit(1);
    }
    return;
  }

  const validateRes = await validateCaddyConfig(gatewayDir);

  if (isJson) {
    console.log(
      JSON.stringify({
        status: "success",
        gatewayDir,
        network: networkName,
        validated: validateRes.success,
      })
    );
  } else {
    console.log("\n🚀 Pegas server gateway initialized successfully!");
    console.log(`   Gateway directory: ${gatewayDir}`);
    console.log(`   Docker network:    ${networkName}`);
    console.log(`   Caddy container:   Running on :80 and :443`);
    console.log("\nNext step: run `pegas add <domain> --upstream <service:port>` to route your first site.\n");
  }
}

export async function handleInit(options: InitOptions): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const dryRun = options.dryRun ?? false;

  // If explicitly requested server
  if (options.server) {
    await handleServerInit(options);
    return;
  }

  // If explicitly requested project
  if (options.project) {
    await handleProjectInit(cwd, isJson, dryRun);
    return;
  }

  // Smart detection:
  // Climb up to find .git or package.json
  const projectRoot = await findProjectRoot(cwd);

  if (projectRoot) {
    await handleProjectInit(projectRoot, isJson, dryRun);
  } else {
    await handleServerInit(options);
  }
}
