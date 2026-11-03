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
import { PegasContract } from "../types.js";

export interface LinkOptions {
  cwd?: string;
  gatewayDir?: string;
  json?: boolean;
  dryRun?: boolean;
  noExit?: boolean;
  skipGatewayEnsure?: boolean;
  skipReload?: boolean;
}

export async function handleLink(options: LinkOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd || process.cwd();
  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);

  let rawContract: string;
  try {
    rawContract = await fs.readFile(contractPath, "utf-8");
  } catch {
    const msg = `Contract ${CONTRACT_FILENAME} not found in ${projectRoot}. Run 'pegas init' first.`;
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
    if (serviceConfig.role === "infra") continue;

    const envDomains = getEnvironmentDomains(serviceConfig, "development");
    if (!Array.isArray(envDomains) || envDomains.length === 0) continue;

    const servicePort = serviceConfig.port || 3000;
    const upstream = `host.docker.internal:${servicePort}`;

    const isCorsEnabled =
      serviceConfig.cors !== false &&
      (Boolean(serviceConfig.cors) ||
        serviceName === "api" ||
        serviceName.startsWith("api") ||
        envDomains.some((d) => d.startsWith("api.")));

    let scopedRoutes: Record<string, string> | undefined;
    if (serviceConfig.routes && Object.keys(serviceConfig.routes).length > 0) {
      scopedRoutes = {};
      for (const [routePath, target] of Object.entries(serviceConfig.routes)) {
        const targetStr = typeof target === "string" ? target : target.to;
        const [targetSvcName, explicitPort] = targetStr.split(":");
        const targetPort = explicitPort || contract.services?.[targetSvcName]?.port || "3000";
        scopedRoutes[routePath] = `host.docker.internal:${targetPort}`;
      }
    }

    for (const domain of envDomains) {
      const normDomain = normalizeDomain(domain);
      if (!normDomain || normDomain === "yourdomain.com" || seenDomains.has(normDomain)) continue;
      seenDomains.add(normDomain);

      snippets.push(
        generateCaddyfileSnippet({
          domain: normDomain,
          upstream,
          routes: scopedRoutes,
          cors: isCorsEnabled ? (serviceConfig.cors || true) : false,
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

  const routeFilePath = getProjectRouteFilePath(gatewayDir, projectName, "development");

  if (snippets.length > 0) {
    const fullSnippet = [
      `# Auto-generated by Pegas for project: ${projectName} [development]`,
      `# Proxies to native dev servers on the host via host.docker.internal`,
      ``,
      snippets.join("\n\n"),
      ``,
    ].join("\n");

    if (!options.dryRun) {
      await fs.mkdir(path.dirname(routeFilePath), { recursive: true });
      await fs.writeFile(routeFilePath, fullSnippet, "utf-8");
      if (!options.skipReload) {
        await reloadGateway({ gatewayDir, json: isJson, silent: true, exitOnError: false });
      }
    }
  }

  if (isJson) {
    console.log(
      JSON.stringify({
        status: "linked",
        project: projectName,
        routeFile: routeFilePath,
        urls: registeredUrls,
      }),
    );
  } else {
    console.log(`\n🔗 \x1b[1;32mProject '${projectName}' linked to Pegas Gateway!\x1b[0m\n`);
    for (const r of registeredUrls) {
      console.log(`   • \x1b[1m${r.url}\x1b[0m ➔ \x1b[90m${r.upstream}\x1b[0m`);
    }
    console.log();
  }
}
