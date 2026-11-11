import fs from "node:fs/promises";
import path from "node:path";
import fsPromises from "node:fs/promises";
import { findProjectRoot, findGatewayDir, getProjectRouteFilePath, getConfDir, reloadGateway } from "../gateway.js";
import {
  CONTRACT_FILENAME,
  validatePegasContract,
  getEnvironmentDomains,
  getProjectRuntimeId,
  normalizeDomain,
} from "../contract.js";
import { ensureGatewayContainer } from "../docker.js";
import { generateCaddyfileSnippet } from "../generator.js";
import { mergeRouteFile, writeRouteFileAtomically } from "../route-merge.js";
import { buildSdkContext } from "../runtime-compose.js";
import { classifySharedImage, sharedPoolName } from "../shared-infra.js";
import { parseCaddyProjectFile } from "./status.js";
import { isCaTrusted, getCaPaths, readGatewayRootCert } from "../ca.js";
import crypto from "node:crypto";

/** SHA-1 fingerprint PEM-сертификата (строкой PEM, не файлом). */
function getCertSha1FromPem(pem: string): string | null {
  try {
    const x509 = new crypto.X509Certificate(pem);
    return x509.fingerprint.replace(/:/g, "").toLowerCase();
  } catch {
    return null;
  }
}
import { PegasContract } from "../types.js";

export interface ConnectOptions {
  cwd?: string;
  scenario?: string;
  gatewayDir?: string;
  json?: boolean;
  dryRun?: boolean;
  noExit?: boolean;
  skipGatewayEnsure?: boolean;
  skipReload?: boolean;
}

export async function handleConnect(options: ConnectOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd || process.cwd();
  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);

  let rawContract: string;
  try {
    rawContract = await fs.readFile(contractPath, "utf-8");
  } catch {
    const msg = `Contract ${CONTRACT_FILENAME} not found in ${projectRoot}. Напишите контракт v3 по схеме https://pegas.netrunner714.ru/schemas/pegas.json (контекст: pegas llms).`;
    if (isJson) console.log(JSON.stringify({ error: msg }));
    else console.error(`❌ Error: ${msg}`);
    if (!options.noExit) process.exit(1);
    return;
  }

  let contract: PegasContract;
  try {
    contract = JSON.parse(rawContract);
  } catch (err: any) {
    const msg = `Invalid JSON in ${contractPath}: ${err?.message || err}`;
    if (isJson) console.log(JSON.stringify({ error: msg }));
    else console.error(`❌ Error: ${msg}`);
    if (!options.noExit) process.exit(1);
    return;
  }

  const contractIssues = validatePegasContract(contract);
  if (contractIssues.length > 0) {
    const errorDetails = contractIssues.map((issue) => `${issue.path}: ${issue.message}`).join(", ");
    const message = `Invalid ${CONTRACT_FILENAME}: ${errorDetails}`;
    if (isJson) console.log(JSON.stringify({ error: message, issues: contractIssues }));
    else {
      console.error(`❌ Error: Invalid ${CONTRACT_FILENAME}:`);
      for (const issue of contractIssues) {
        console.error(`   - ${issue.path}: ${issue.message}`);
      }
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  const projectName = contract.projectName || path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  const scenario = options.scenario || "development";
  const scenarioNames = (contract as any).scenarios;
  if (Array.isArray(scenarioNames) && !scenarioNames.includes(scenario)) {
    const msg = `Scenario "${scenario}" is not declared in ${CONTRACT_FILENAME}. Available: ${scenarioNames.join(", ")}.`;
    if (isJson) console.log(JSON.stringify({ error: msg }));
    else console.error(`❌ Error: ${msg}`);
    if (!options.noExit) process.exit(1);
    return;
  }
  const runtimeId = getProjectRuntimeId(projectRoot, projectName);
  const gatewayDir = await findGatewayDir(options.gatewayDir);

  // 1. Ensure Caddy Gateway is running (starts Caddy if not already running — first project)
  if (!options.dryRun && !options.skipGatewayEnsure) {
    const gwRes = await ensureGatewayContainer(gatewayDir);
    if (!gwRes.success) {
      const msg = `Could not start shared Pegas Gateway: ${gwRes.stderr || gwRes.stdout}`;
      if (isJson) console.log(JSON.stringify({ error: msg }));
      else console.error(`❌ Error: ${msg}`);
      if (!options.noExit) process.exit(1);
      return;
    }
  }

  // 2. Generate Caddy routes pointing to host.docker.internal:<port>
  const snippets: string[] = [];
  const registeredUrls: { service: string; url: string; upstream: string }[] = [];
  const seenDomains = new Set<string>();

  // Collect all domains declared in development for this project to configure CORS
  const allProjectDomains: string[] = [];
  for (const [_, svc] of Object.entries(contract.services || {})) {
    const dList = getEnvironmentDomains(svc, scenario);
    if (Array.isArray(dList)) {
      for (const d of dList) {
        const norm = normalizeDomain(d);
        if (norm && norm !== "yourdomain.com") {
          allProjectDomains.push(norm);
        }
      }
    }
  }

  for (const [serviceName, serviceConfig] of Object.entries(contract.services || {})) {
    // connect — это объявление проекта в сети, а не запуск процессов.
    // Регистрируем все сервисы сценария: host-сервисы идут на host.docker.internal,
    // docker-сервисы — на scoped-алиас, который создаст deploy.
    const driver = serviceConfig.runtime?.[scenario]?.driver ?? "docker";
    const envDomains = getEnvironmentDomains(serviceConfig, scenario);
    if (!Array.isArray(envDomains) || envDomains.length === 0) continue;

    // v3: порт — сценарная карта; дефолтов нет (Zero Scalars), domains без port ловит check
    const servicePort = serviceConfig.port?.[scenario];
    if (!servicePort) {
      const msg = `services.${serviceName}: domains требуют port.${scenario} (см. pegas check)`;
      if (isJson) console.log(JSON.stringify({ error: msg }));
      else console.error(`❌ Error: ${msg}`);
      if (!options.noExit) process.exit(1);
      return;
    }
    const sharedProfile = serviceConfig.scope?.[scenario] === "shared"
      ? classifySharedImage(serviceConfig.image?.[scenario])
      : null;
    const upstream = driver === "bun"
      ? `host.docker.internal:${servicePort}`
      : sharedProfile
        ? `${sharedPoolName(sharedProfile, scenario)}:${servicePort}`
        : `${runtimeId}-${scenario}-${serviceName}:${servicePort}`;

    // v3: cors — сценарная карта boolean
    const corsDev = serviceConfig.cors?.[scenario];
    const isCorsEnabled =
      corsDev !== false &&
      (Boolean(corsDev) ||
        serviceName === "api" ||
        serviceName.startsWith("api") ||
        envDomains.some((d) => d.startsWith("api.")));

    for (const domain of envDomains) {
      const normDomain = normalizeDomain(domain);
      if (!normDomain || normDomain === "yourdomain.com" || seenDomains.has(normDomain)) continue;
      seenDomains.add(normDomain);

      snippets.push(
        generateCaddyfileSnippet({
          domain: normDomain,
          upstream,
          // Если www уже объявлен отдельным доменом, не генерируем второй
          // www-блок с redir: иначе Caddy падает на ambiguous site definition.
          noWww: envDomains.some((d) => normalizeDomain(d) === `www.${normDomain}`),
          cors: isCorsEnabled ? true : false,
          corsOrigins: allProjectDomains,
          // issue #30: метаданные маршрута. Владелец — connect для всех драйверов:
          // connect объявляет маршрут, deploy только запускает контейнер.
          meta: {
            project: projectName,
            service: serviceName,
            env: scenario,
            driver,
            owner: "connect",
            port: servicePort,
          },
        }),
      );
      registeredUrls.push({
        service: serviceName,
        url: `https://${normDomain}`,
        upstream: driver === "bun" ? `127.0.0.1:${servicePort}` : upstream,
      });
    }
  }

  // Анти-хайджекинг: connect объявляет домен раньше deploy, поэтому проверяем
  // владельцев в остальных route-файлах до записи.
  {
    const confDir = getConfDir(gatewayDir);
    const currentFile = path.basename(getProjectRouteFilePath(gatewayDir, projectName, scenario));
    const declared = new Set(allProjectDomains);
    try {
      for (const file of await fsPromises.readdir(confDir)) {
        if (!file.endsWith(".caddy") || file === currentFile) continue;
        const content = await fsPromises.readFile(path.join(confDir, file), "utf-8");
        for (const route of parseCaddyProjectFile(content, file)) {
          if (route.projectName === projectName) continue;
          const conflict = route.domains.find((d) => declared.has(d));
          if (!conflict) continue;
          const msg = `Domain '${conflict}' is already owned by project '${route.projectName}' (in ${file}).`;
          if (isJson) console.log(JSON.stringify({ error: "Domain collision", domain: conflict, ownerProject: route.projectName, ownerFile: file }));
          else console.error(`\n❌ Error: ${msg}\n   Connect aborted to prevent route hijacking.`);
          if (!options.noExit) process.exit(1);
          return;
        }
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  if (snippets.length === 0) {
    const anyDomains = Object.values(contract.services || {}).some((svc) => {
      const d = getEnvironmentDomains(svc, scenario);
      return Array.isArray(d) && d.length > 0;
    });
    if (anyDomains) {
      if (isJson) console.log(JSON.stringify({ warning: `No services with ${scenario} domains — nothing to connect.` }));
      else console.log(`   \x1b[33m⚠ В сценарии ${scenario} нет сервисов с доменами — регистрировать нечего.\x1b[0m`);
    }
  }

  const routeFilePath = getProjectRouteFilePath(gatewayDir, projectName, scenario);

  // issue #24: merge по доменам. connect перезаписывает только свои блоки
  // (upstream host.docker.internal); deploy-блоки (scoped-upstream) и внешние
  // блоки сохраняются дословно. Файл — общий для владельцев процесса.
  if (snippets.length > 0 && !options.dryRun) {
    const existingContent = await fs.readFile(routeFilePath, "utf-8").catch(() => null);
    const merged = mergeRouteFile(
      existingContent,
      [
        `# Auto-generated by Pegas for project: ${projectName} [${scenario}]`,
        `# Routes are declared by pegas connect; deploy only starts containers.`,
      ],
      "connect",
      `${runtimeId}-${scenario}`,
      snippets,
    );
    if (merged.content !== null) {
      await writeRouteFileAtomically(routeFilePath, merged.content);
      if (!options.skipReload) {
        await reloadGateway({ gatewayDir, json: isJson, silent: true, exitOnError: false });
      }
    }
  }

  // 3. Host-контекст для Runtime SDK: .pegas/context.json — сервисы сценария
  // development целиком; service = первый host-сервис (driver: bun). Контейнерам
  // PEGAS_CONTEXT инжектится манифестом; host-запускам нужен файл. SDK кэширует.
  let contextFile: string | null = null;
  {
    const hostServices = Object.entries(contract.services || {})
      .filter(([_, svc]) => (svc.runtime?.[scenario]?.driver ?? "docker") === "bun")
      .map(([name]) => name);
    const contextService = hostServices[0] || Object.keys(contract.services || {})[0];
    if (contextService) {
      const ctxJson = buildSdkContext(contract, scenario, runtimeId, contextService);
      contextFile = path.join(projectRoot, ".pegas", "context.json");
      if (!options.dryRun) {
        await fs.mkdir(path.dirname(contextFile), { recursive: true });
        await fs.writeFile(contextFile, ctxJson, "utf-8");
      }
    }
  }

  // TLS-готовность localhost. Для публичных доменов Caddy сам берёт Let's Encrypt:
  // локальный CA и его установка в системный стор не нужны. Проверяем только
  // сценарии с *.localhost, иначе прод получал бы ложное "CA not trusted".
  const needsLocalCa = registeredUrls.some((r) => {
    const host = new URL(r.url).hostname;
    return host === "localhost" || host.endsWith(".localhost");
  });
  let tlsTrusted: boolean | null = null;
  if (!options.dryRun && needsLocalCa) {
    const paths = getCaPaths();
    const gatewayRoot = await readGatewayRootCert();
    if (gatewayRoot !== null) {
      const gatewaySha1 = getCertSha1FromPem(gatewayRoot.toString("utf-8"));
      const exportSha1 = await fs.readFile(paths.caCertPath, "utf-8").then((p) => getCertSha1FromPem(p)).catch(() => null);
      if (exportSha1 !== gatewaySha1) {
        // Экспорт разошёлся с живым шлюзом: актуализируем (ca install сделает то же,
        // но connect — момент истины: пользователь прямо сейчас пойдёт в браузер).
        if (!options.dryRun) {
          await fs.mkdir(path.dirname(paths.caCertPath), { recursive: true });
          await fs.writeFile(paths.caCertPath, gatewayRoot, { mode: 0o644 });
        }
      }
      tlsTrusted = await isCaTrusted(process.platform, paths, { gatewayRoot });
    }
  }

  if (isJson) {
    console.log(
      JSON.stringify({
        status: "connected",
        project: projectName,
        scenario,
        routeFile: routeFilePath,
        contextFile: contextFile,
        tlsTrusted: tlsTrusted,
        urls: registeredUrls,
      }),
    );
  } else {
    console.log(`\n🔗 \x1b[1;32mProject '${projectName}' connected to Pegas Gateway!\x1b[0m\n`);
    for (const r of registeredUrls) {
      console.log(`   • \x1b[1m${r.url}\x1b[0m ➔ \x1b[90m${r.upstream}\x1b[0m`);
    }
    if (tlsTrusted === false) {
      console.log();
      console.log(`   \x1b[33m⚠ Браузер покажет красный замок: системное хранилище не доверяет CA шлюза.\x1b[0m`);
      console.log(`     Лечение: pegas ca install   (обновит доверие; попросит sudo)\x1b[0m`);
      if (process.platform === "linux") {
        console.log(`     или вручную: sudo cp ~/.pegas/ca/root.crt /usr/local/share/ca-certificates/pegas-root-ca.crt && sudo update-ca-certificates`);
      }
    }
    console.log();
  }
}
