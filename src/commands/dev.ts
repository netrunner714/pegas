import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import { findProjectRoot, findGatewayDir, getProjectRouteFilePath, reloadGateway } from "../gateway.js";
import {
  CONTRACT_FILENAME,
  validatePegasContract,
  getEnvironmentDomains,
  normalizeDomain,
  getProjectRuntimeId,
} from "../contract.js";
import { ensureGatewayContainer } from "../docker.js";
import { generateCaddyfileSnippet } from "../generator.js";
import { createRuntimeCompose } from "../runtime-compose.js";
import { detectPackageManager } from "../pm.js";
import { PegasContract, ServiceContract } from "../types.js";

export interface DevOptions {
  cwd?: string;
  gatewayDir?: string;
  json?: boolean;
  noRun?: boolean;
  command?: string[];
  noExit?: boolean;
  dryRun?: boolean;
}

export async function handleDev(options: DevOptions = {}): Promise<void> {
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
  const runtimeId = contract.runtime === "docker" ? getProjectRuntimeId(projectRoot, projectName) : projectName;
  const gatewayDir = await findGatewayDir(options.gatewayDir);

  // 1. Ensure Caddy Gateway is running
  if (!options.dryRun) {
    const gwRes = await ensureGatewayContainer(gatewayDir);
    if (!gwRes.success) {
      const msg = `Could not start shared Pegas Gateway: ${gwRes.stderr || gwRes.stdout}`;
      if (isJson) console.log(JSON.stringify({ error: msg }));
      else console.error(`❌ Error: ${msg}`);
      if (!options.noExit) process.exit(1);
      return;
    }
  }

  // 2. Start infra services (e.g. redis, postgres) if any exist
  const infraServices: [string, ServiceContract][] = Object.entries(contract.services || {}).filter(
    ([_, s]) => s.role === "infra" || (s.role !== "app" && typeof s.image === "string" && !s.build),
  );

  if (infraServices.length > 0 && !options.dryRun) {
    try {
      const infraContract: PegasContract = {
        ...contract,
        runtime: "docker",
        services: Object.fromEntries(infraServices),
      };
      const { content: composeContent } = createRuntimeCompose(infraContract, {
        projectRoot,
        projectId: runtimeId,
        environment: "development",
      });
      const infraNames = infraServices.map(([name]) => name);
      const composeProjectName = `${runtimeId}-development`;
      child_process.execFileSync(
        "docker",
        ["compose", "--project-name", composeProjectName, "--project-directory", projectRoot, "-f", "-", "up", "-d", ...infraNames],
        {
          input: composeContent,
          cwd: projectRoot,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (err: any) {
      const stderr = err?.stderr?.toString() || err?.message || "";
      if (!isJson) {
        console.warn(`⚠️ Warning: could not start infra services (${infraServices.map(([n]) => n).join(", ")}): ${stderr}`);
      }
    }
  }

  // 3. Generate Caddy routes pointing to host.docker.internal:<port>
  const snippets: string[] = [];
  const registeredUrls: { service: string; url: string; upstream: string }[] = [];
  const seenDomains = new Set<string>();

  for (const [serviceName, serviceConfig] of Object.entries(contract.services || {})) {
    if (serviceConfig.role === "infra" && !serviceConfig.domains) continue;

    const envDomains = getEnvironmentDomains(serviceConfig, "development");
    if (!Array.isArray(envDomains) || envDomains.length === 0) continue;

    const servicePort = serviceConfig.port || 3000;
    const upstream = `host.docker.internal:${servicePort}`;

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
      await reloadGateway({ gatewayDir, json: isJson, silent: true, exitOnError: false });
    }
  }

  // 4. Output summary
  if (isJson) {
    console.log(
      JSON.stringify({
        status: "ready",
        project: projectName,
        urls: registeredUrls,
        infraServices: infraServices.map(([n]) => n),
      }),
    );
  } else {
    console.log(`\n🚀 \x1b[1;32mPegas dev environment ready!\x1b[0m`);
    if (infraServices.length > 0) {
      console.log(`   📦 Infra: ${infraServices.map(([n]) => `\x1b[36m${n}\x1b[0m`).join(", ")} running`);
    }
    for (const r of registeredUrls) {
      console.log(`   • \x1b[1m${r.url}\x1b[0m ➔ \x1b[90m${r.upstream}\x1b[0m`);
    }
    console.log();
  }

  if (options.noRun || options.dryRun) {
    return;
  }

  // 5. Detect and execute the dev command
  let devCmd: string;
  let devArgs: string[] = [];

  const pm = await detectPackageManager(projectRoot);
  let pkgJson: any = {};
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf-8"));
  } catch {}

  const scripts = pkgJson.scripts || {};

  if (options.command && options.command.length > 0) {
    if (options.command.length === 1 && scripts[options.command[0]]) {
      devCmd = pm;
      devArgs = ["run", options.command[0]];
    } else {
      devCmd = options.command[0];
      devArgs = options.command.slice(1);
    }
  } else {
    let scriptToRun: string | null = null;
    const appServicesCount = Object.values(contract.services || {}).filter(
      (s) => s.role === "app" || (!s.role && !s.image)
    ).length;

    if (appServicesCount > 1 && scripts["dev:all"]) {
      scriptToRun = "dev:all";
    } else if (scripts["dev"] && !scripts["dev"].trim().startsWith("pegas dev")) {
      scriptToRun = "dev";
    } else if (scripts["dev:all"]) {
      scriptToRun = "dev:all";
    } else if (scripts["dev:run"]) {
      scriptToRun = "dev:run";
    } else if (scripts["start"]) {
      scriptToRun = "start";
    }

    if (scriptToRun) {
      devCmd = pm;
      devArgs = ["run", scriptToRun];
    } else {
      if (pm === "bun") {
        devCmd = "bun";
        devArgs = ["dev"];
      } else {
        devCmd = pm;
        devArgs = ["run", "dev"];
      }
    }
  }

  if (!isJson) {
    console.log(`▶ Running: \x1b[36m${devCmd} ${devArgs.join(" ")}\x1b[0m\n`);
  }

  const result = child_process.spawnSync(devCmd, devArgs, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });

  if (result.status !== null && result.status !== 0 && !options.noExit) {
    process.exit(result.status);
  }
}
