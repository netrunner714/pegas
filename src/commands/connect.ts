import fs from "node:fs/promises";
import path from "node:path";
import { findProjectRoot, findGatewayDir, getProjectRouteFilePath, reloadGateway } from "../gateway.js";
import {
  CONTRACT_FILENAME,
  validatePegasContract,
  getEnvironmentDomains,
  normalizeDomain,
} from "../contract.js";
import { ensureGatewayContainer } from "../docker.js";
import { generateCaddyfileSnippet } from "../generator.js";
import { mergeRouteFile, writeRouteFileAtomically } from "../route-merge.js";
import { buildSdkContext } from "../runtime-compose.js";
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
    const msg = `Contract ${CONTRACT_FILENAME} not found in ${projectRoot}. Напишите контракт v3 по схеме https://netrunner714.ru/schemas/pegas.json (контекст: pegas llms).`;
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
    const dList = getEnvironmentDomains(svc, "development");
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
    // issue #23: владелец маршрута = владелец процесса. connect пишет маршруты только
    // для host-сервисов (driver: bun) — домены docker-сервисов принадлежат deploy.
    if ((serviceConfig.runtime?.["development"]?.driver ?? "docker") !== "bun") continue;
    const envDomains = getEnvironmentDomains(serviceConfig, "development");
    if (!Array.isArray(envDomains) || envDomains.length === 0) continue;

    // v3: порт — сценарная карта; дефолтов нет (Zero Scalars), domains без port ловит check
    const servicePort = serviceConfig.port?.["development"];
    if (!servicePort) {
      const msg = `services.${serviceName}: domains требуют port.development (см. pegas check)`;
      if (isJson) console.log(JSON.stringify({ error: msg }));
      else console.error(`❌ Error: ${msg}`);
      if (!options.noExit) process.exit(1);
      return;
    }
    const upstream = `host.docker.internal:${servicePort}`;

    // v3: cors — сценарная карта boolean
    const corsDev = serviceConfig.cors?.["development"];
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
          cors: isCorsEnabled ? true : false,
          corsOrigins: allProjectDomains,
        }),
      );
      registeredUrls.push({
        service: serviceName,
        url: `https://${normDomain}`,
        upstream: `127.0.0.1:${servicePort}`,
      });
    }
  }

  // issue #23: connect без единого bun-сервиса в development — «регистрировать нечего».
  // Предупреждение, не ошибка: connect продолжает писать .pegas/context.json и проверять TLS.
  if (snippets.length === 0) {
    const anyDevDomains = Object.values(contract.services || {}).some((svc) => {
      const d = getEnvironmentDomains(svc, "development");
      return Array.isArray(d) && d.length > 0;
    });
    if (anyDevDomains) {
      if (isJson) console.log(JSON.stringify({ warning: "No host-driver (bun) services with development domains — routes belong to pegas deploy (docker driver). Nothing to connect." }));
      else console.log(`   \x1b[33m⚠ В development нет host-сервисов (driver: bun) с доменами: маршруты этих доменов пишет 'pegas deploy' — connect регистрировать нечего.\x1b[0m`);
    }
  }

  const routeFilePath = getProjectRouteFilePath(gatewayDir, projectName, "development");

  // issue #24: merge по доменам. connect перезаписывает только свои блоки
  // (upstream host.docker.internal); deploy-блоки (scoped-upstream) и внешние
  // блоки сохраняются дословно. Файл — общий для владельцев процесса.
  if (snippets.length > 0 && !options.dryRun) {
    const existingContent = await fs.readFile(routeFilePath, "utf-8").catch(() => null);
    const merged = mergeRouteFile(
      existingContent,
      [
        `# Auto-generated by Pegas for project: ${projectName} [development]`,
        `# Proxies to native dev servers on the host via host.docker.internal`,
      ],
      "connect",
      "", // scoped-префикс deploy connect'у не нужен: любые чужие блоки
          // (deploy/внешние) классифицируются как «unknown» и сохраняются дословно.
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
      .filter(([_, svc]) => (svc.runtime?.["development"]?.driver ?? "docker") === "bun")
      .map(([name]) => name);
    const contextService = hostServices[0] || Object.keys(contract.services || {})[0];
    if (contextService) {
      const ctxJson = buildSdkContext(contract, "development", projectName, contextService);
      contextFile = path.join(projectRoot, ".pegas", "context.json");
      if (!options.dryRun) {
        await fs.mkdir(path.dirname(contextFile), { recursive: true });
        await fs.writeFile(contextFile, ctxJson, "utf-8");
      }
    }
  }

  // TLS-готовность: серты шлюза подписаны CA из docker-volume PKI. Если системный
  // стор не доверяет этому CA — браузер покажет красный замок. Проверяем и предупреждаем
  // ДО того, как пользователь столкнётся (после пересоздания volume CA меняется).
  let tlsTrusted: boolean | null = null;
  if (!options.dryRun) {
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
