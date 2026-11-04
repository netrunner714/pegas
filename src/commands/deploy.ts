import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import child_process from "node:child_process";
import { findProjectRoot, findGatewayDir, getProjectRouteFilePath, getConfDir, reloadGateway } from "../gateway.js";
import { CONTRACT_FILENAME, normalizeDomain, getEnvironmentDomains, getProjectRuntimeId, validatePegasContract } from "../contract.js";
import { PegasContract } from "../types.js";
import { generateCaddyfileSnippet } from "../generator.js";
import { parseCaddyProjectFile } from "./status.js";
import { validateDomains } from "../dns.js";
import { runRuntimeCompose } from "../runtime.js";
import { ensureGatewayContainer, stopGatewayIfUnused } from "../docker.js";
import { withRuntimeLock } from "../runtime-lock.js";
import { verifySecrets } from "../secrets.js";

export interface DeployOptions {
  scenario?: string;
  gatewayDir?: string;
  skipUp?: boolean;
  skipReadiness?: boolean;
  readinessTimeoutMs?: number;
  gracePeriodMs?: number;
  strictDns?: boolean;
  skipDnsCheck?: boolean;
  serverIp?: string;
  json?: boolean;
  cwd?: string;
  noExit?: boolean;
}

export interface ReadinessResult {
  ready: boolean;
  service: string;
  reason?: string;
  containerId?: string;
}

/** Replace a route file atomically so Caddy never observes a partial write. */
async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf-8", mode: 0o644, flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

/**
 * Polls container status until running and healthy, preventing 502 Bad Gateway
 * errors during deployments before Caddy routes traffic to the container.
 */
export async function waitForContainerReadiness(
  projectRoot: string,
  serviceName: string,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    gracePeriodMs?: number;
    composeFile?: string;
    projectId?: string;
    environment?: string;
  } = {}
): Promise<ReadinessResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const defaultGrace = process.env.PEGAS_DEPLOY_GRACE_MS !== undefined
    ? parseInt(process.env.PEGAS_DEPLOY_GRACE_MS, 10)
    : 3000;
  const gracePeriodMs = options.gracePeriodMs ?? defaultGrace;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let containerId = "";
    try {
      const dockerArgs = options.projectId
        ? ["ps", "-q", "--filter", `label=pegas.project=${options.projectId}`, "--filter", `label=pegas.scenario=${options.environment || "development"}`, "--filter", `label=pegas.service=${serviceName}`]
        : [
            "compose",
            ...(options.composeFile
              ? ["--project-directory", projectRoot, "-f", options.composeFile]
              : []),
            "ps", "-q", serviceName,
          ];

      const psRes = child_process.execFileSync(
        "docker",
        dockerArgs,
        { cwd: projectRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000 }
      );
      containerId = psRes.trim().split("\n")[0]?.trim();
    } catch {}

    if (!containerId) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }

    try {
      const inspectRes = child_process.execFileSync(
        "docker",
        ["inspect", containerId],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
      );
      const inspectData = JSON.parse(inspectRes);
      if (Array.isArray(inspectData) && inspectData.length > 0) {
        const state = inspectData[0].State;
        if (state) {
          const status = state.Status?.toLowerCase();

          if (status === "exited" || status === "dead") {
            return {
              ready: false,
              service: serviceName,
              containerId,
              reason: `Container exited unexpectedly (exit code ${state.ExitCode})`,
            };
          }

          if (status === "running") {
            if (state.Health) {
              const healthStatus = state.Health.Status?.toLowerCase();
              if (healthStatus === "healthy") {
                return { ready: true, service: serviceName, containerId };
              }
              if (healthStatus === "unhealthy") {
                return {
                  ready: false,
                  service: serviceName,
                  containerId,
                  reason: `Container healthcheck failed: status is '${state.Health.Status}'`,
                };
              }
            } else {
              if (gracePeriodMs > 0) {
                await new Promise((r) => setTimeout(r, gracePeriodMs));
              }
              return { ready: true, service: serviceName, containerId };
            }
          }
        }
      }
    } catch {}

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return {
    ready: false,
    service: serviceName,
    reason: `Timed out waiting for service '${serviceName}' to become ready after ${timeoutMs / 1000}s`,
  };
}

export function resolveScopedUpstream(upstream: string, projectName: string): string {
  const parts = upstream.split(":");
  const host = parts[0];
  const port = parts[1] || "3000";

  if (!host) return upstream;
  if (host.startsWith(`${projectName}-`)) return upstream;
  if (host === "localhost" || host === "127.0.0.1" || /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return upstream;
  return `${projectName}-${host}:${port}`;
}

async function handleDeployUnlocked(options: DeployOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd || process.cwd();
  const rawScenario = options.scenario;
  if (!rawScenario) {
    const errorMsg = "Scenario is required for deploy. Option -s or --scenario is missing.";
    if (isJson) console.log(JSON.stringify({ error: errorMsg }));
    else {
      console.error(`❌ Error: ${errorMsg}`);
      console.error("   Usage: pegas deploy -s <scenario>");
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  const env = rawScenario;

  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);
  let rawContract: string;
  try {
    rawContract = await fs.readFile(contractPath, "utf-8");
  } catch {
    if (isJson) console.log(JSON.stringify({ error: `Contract '${CONTRACT_FILENAME}' not found. Run 'pegas init' first.` }));
    else {
      console.error(`❌ Error: Contract '${CONTRACT_FILENAME}' not found in project root (${projectRoot}).`);
      console.error("   Run 'pegas init' to generate it.");
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  let contract: PegasContract;
  try {
    contract = JSON.parse(rawContract);
  } catch (err: any) {
    if (isJson) console.log(JSON.stringify({ error: `Failed to parse '${path.basename(contractPath)}': Invalid JSON syntax.`, details: err.message }));
    else {
      console.error(`❌ Error: Failed to parse '${path.basename(contractPath)}': Invalid JSON syntax.`);
      console.error(`   ${err.message}`);
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  const contractIssues = validatePegasContract(contract);
  if (contractIssues.length > 0) {
    const details = contractIssues.map((issue) => `${issue.path}: ${issue.message}`);
    if (isJson) console.log(JSON.stringify({ error: "Invalid Pegas contract", details }));
    else {
      console.error("❌ Invalid Pegas contract:");
      for (const detail of details) console.error(`  - ${detail}`);
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  const secretsCheck = await verifySecrets(projectRoot, contract);
  if (!secretsCheck.valid) {
    if (isJson) console.log(JSON.stringify({ error: "Secrets verification failed", details: secretsCheck.errors }));
    else {
      console.error("❌ Secrets verification failed:");
      for (const err of secretsCheck.errors) console.error(`  - ${err}`);
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  const projectName = contract.projectName || path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  const runtimeId = getProjectRuntimeId(projectRoot, projectName);
  const gatewayDir = await findGatewayDir(options.gatewayDir);
  const confDir = getConfDir(gatewayDir);
  await fs.mkdir(confDir, { recursive: true });

  const strictDns = options.strictDns ?? false;
  const skipDnsCheck = options.skipDnsCheck ?? false;
  const skipReadiness = options.skipReadiness ?? false;

  const requestedDomains: string[] = [];
  for (const [, serviceConfig] of Object.entries(contract.services || {})) {
    for (const d of getEnvironmentDomains(serviceConfig, env)) {
      const norm = normalizeDomain(d);
      if (norm && norm !== "yourdomain.com") {
        if (!requestedDomains.includes(norm)) requestedDomains.push(norm);
        const parts = norm.split(".");
        if (!norm.startsWith("www.") && parts.length === 2 && !requestedDomains.includes(`www.${norm}`)) {
          requestedDomains.push(`www.${norm}`);
        }
      }
    }
  }

  if (requestedDomains.length === 0) {
    const available = contract.scenarios;
    const envHint = available.length > 0
      ? `Available environments: ${available.join(", ")}`
      : `No environments with active domains defined in '${CONTRACT_FILENAME}'.`;
    if (isJson) console.log(JSON.stringify({ error: `Environment '${env}' has no domains defined in '${CONTRACT_FILENAME}'.`, availableEnvironments: available }));
    else {
      console.error(`\n❌ Error: Environment '${env}' has no domains defined in '${CONTRACT_FILENAME}'.`);
      console.error(`   ${envHint}`);
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  const projectRouteFile = getProjectRouteFilePath(gatewayDir, projectName, env);
  const currentProjectFileName = path.basename(projectRouteFile);

  // Canonical name of this project's own route files (for any environment).
  const ownRouteFilePrefix = `${projectName.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}`;

  // Remove stale route files left by alias environment names of this project
  // (e.g. `project-dev.caddy` after `pegas deploy development` writes `project-development.caddy`).
  // They are superseded by the canonical file written below.
  const aliasEnvironmentRouteFiles: string[] = [];
  try {
    const existingFiles = await fs.readdir(confDir);
    for (const file of existingFiles) {
      if (!file.endsWith(".caddy") || file === currentProjectFileName) continue;
      if (!file.startsWith(`${ownRouteFilePrefix}-`) || !file.endsWith(".caddy")) continue;
      if (file.startsWith(`${ownRouteFilePrefix}-${env}`)) continue;
      const otherContent = await fs.readFile(path.join(confDir, file), "utf-8");
      const otherRoutes = parseCaddyProjectFile(otherContent, file);
      // The project comment carries the authoritative project name.
      const isOwn = otherRoutes.every((route) => route.projectName === projectName) && otherRoutes.length > 0;
      if (!isOwn) continue;
      // Only clean files whose upstreams point at this checkout's scoped aliases.
      const checkoutPrefix = `${runtimeId}-`;
      const ownUpstreams = otherRoutes.every((route) => route.upstream.startsWith(checkoutPrefix));
      if (!ownUpstreams) continue;
      await fs.unlink(path.join(confDir, file)).catch(() => {});
      aliasEnvironmentRouteFiles.push(path.join(confDir, file));
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {}
  }
  if (aliasEnvironmentRouteFiles.length > 0 && !isJson) {
    console.log(`\n🧹 Removed superseded route file(s) of this project (other environments):\n${aliasEnvironmentRouteFiles.map((f) => `   - ${f}`).join("\n")}`);
  }

  try {
    const existingFiles = await fs.readdir(confDir);
    for (const file of existingFiles) {
      if (!file.endsWith(".caddy") || file === currentProjectFileName) continue;
      const otherContent = await fs.readFile(path.join(confDir, file), "utf-8");
      const otherRoutes = parseCaddyProjectFile(otherContent, file);
      for (const route of otherRoutes) {
        // Never treat this project's own (other-environment) routes as conflicts.
        if (route.projectName === projectName) continue;
        for (const claimedDomain of route.domains) {
          if (requestedDomains.includes(claimedDomain)) {
            const conflictErr = `Domain '${claimedDomain}' is already owned by project '${route.projectName}' (in ${file}).`;
            if (isJson) console.log(JSON.stringify({ error: "Domain collision", domain: claimedDomain, ownerProject: route.projectName, ownerFile: file }));
            else {
              console.error(`\n❌ Error: ${conflictErr}`);
              console.error("   Deploy aborted to prevent route hijacking.");
            }
            if (!options.noExit) process.exit(1);
            return;
          }
        }
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {}
  }

  if (!skipDnsCheck && requestedDomains.length > 0) {
    const dnsResult = await validateDomains(requestedDomains, {
      skipDnsCheck, strictDns, serverIp: options.serverIp, json: isJson, noExit: options.noExit,
    });
    if (!dnsResult.valid && strictDns) {
      if (isJson) console.log(JSON.stringify({ error: "Strict DNS validation failed", warnings: dnsResult.warnings, serverIp: dnsResult.serverIp }));
      if (!options.noExit) process.exit(1);
      return;
    }
  }

  if (!options.skipUp) {
    if (!isJson) console.log(`\n🚀 [1/3] Starting project containers for scenario '${env}'...`);
    const primaryDomain = requestedDomains[0] || "";
    const deployEnv = {
      ...process.env,
      NODE_ENV: rawScenario === "development" ? "development" : "production",
      ...(primaryDomain ? { APP_DOMAIN: primaryDomain } : {}),
    };
    let composeFile: string | null = null;
    let gatewayPrepared = false;
    try {
      // Verify/start the shared edge before mutating the application stack.
      // A port conflict must fail before any project service is started.
      const gatewayResult = await ensureGatewayContainer(gatewayDir);
      if (!gatewayResult.success) throw new Error(gatewayResult.stderr || "Failed to ensure shared Gateway.");
      gatewayPrepared = true;
      // v3: манифест содержит только driver:"docker"-сервисы сценария; host-сервисы не поднимаем
      await runRuntimeCompose(contract, projectRoot, runtimeId, [
        "up", "-d", "--remove-orphans",
      ], { ...deployEnv, PEGAS_ENV: rawScenario });
    } catch (err: any) {
      if (gatewayPrepared) {
        // Do not leave an otherwise unused shared Gateway running after a failed first deploy.
        await stopGatewayIfUnused(gatewayDir).catch(() => {});
      }
      const message = "Failed to apply the declarative Docker runtime";
      if (isJson) console.log(JSON.stringify({ error: message, details: err.message }));
      else console.error(`❌ Error: ${message}:`, err.message);
      if (!options.noExit) process.exit(1);
      return;
    }

    if (!skipReadiness) {
      const servicesToCheck: string[] = [];
      for (const [sName, sCfg] of Object.entries(contract.services || {})) {
        if (getEnvironmentDomains(sCfg, env).length > 0) servicesToCheck.push(sName);
      }
      if (servicesToCheck.length > 0) {
        if (!isJson) console.log(`\n⏳ Checking container readiness for: ${servicesToCheck.join(", ")}...`);
        for (const sName of servicesToCheck) {
          const checkRes = await waitForContainerReadiness(projectRoot, sName, {
            timeoutMs: options.readinessTimeoutMs,
            gracePeriodMs: options.gracePeriodMs,
            projectId: runtimeId,
            environment: env,
          });
          if (!checkRes.ready) {
            const errMsg = `Service '${sName}' failed readiness check: ${checkRes.reason}`;
            if (isJson) console.log(JSON.stringify({ error: errMsg, service: sName, reason: checkRes.reason }));
            else {
              console.error(`\n❌ Error: ${errMsg}`);
              console.error("   Deployment aborted before updating Caddy routes.");
            }
            await stopGatewayIfUnused(gatewayDir).catch(() => {});
            if (!options.noExit) process.exit(1);
            return;
          }
          if (!isJson) console.log(`  🟢 Service '${sName}' is ready to accept traffic`);
        }
      }
    }
  }

  const snippets: string[] = [];
  const deployedRoutes: { service: string; domain: string; upstream: string }[] = [];

  // Collect all domains declared in env for this project to configure CORS
  const allProjectDomains: string[] = [];
  for (const [_, svc] of Object.entries(contract.services || {})) {
    const dList = getEnvironmentDomains(svc, env);
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
    const envDomains = getEnvironmentDomains(serviceConfig, env);
    if (!Array.isArray(envDomains) || envDomains.length === 0) continue;
    // v3: upstream строится из port-карты сценария; services без port валидатор не пропустит
    const svcPort = serviceConfig.port?.[env];
    const upstream = `${serviceName}:${svcPort}`;
    const prefix = `${runtimeId}-${env}`;
    const scopedUpstream = resolveScopedUpstream(upstream, prefix);

    // v3: cors — сценарная карта (boolean); по умолчанию включён для api-подобных имён
    const corsScenario = serviceConfig.cors?.[env];
    const isCorsEnabled =
      corsScenario !== false &&
      (Boolean(corsScenario) ||
        serviceName === "api" ||
        serviceName.startsWith("api") ||
        envDomains.some((d) => d.startsWith("api.")));

    for (const domain of envDomains) {
      const normDomain = normalizeDomain(domain);
      if (!normDomain || normDomain === "yourdomain.com") continue;
      snippets.push(generateCaddyfileSnippet({
        domain: normDomain,
        upstream: scopedUpstream,
        cors: isCorsEnabled ? true : false,
        corsOrigins: allProjectDomains,
      }));
      deployedRoutes.push({
        service: serviceName,
        domain: normDomain,
        upstream: scopedUpstream,
      });
    }
  }

  let originalContent: string | null = null;
  try { originalContent = await fs.readFile(projectRouteFile, "utf-8"); } catch {}
  let fileModified = false;
  if (snippets.length > 0) {
    const combinedCaddyfile =
      `# Auto-generated by Pegas for project: ${projectName} [${env}]\n# Do not edit manually; update pegas.json instead.\n\n` +
      snippets.join("\n\n") + "\n";
    await fs.mkdir(path.dirname(projectRouteFile), { recursive: true });
    await writeFileAtomically(projectRouteFile, combinedCaddyfile);
    fileModified = true;
    if (!isJson) {
      console.log(`\n📄 [2/3] Generated route config: ${projectRouteFile}`);
      for (const route of deployedRoutes) console.log(`  ✓ Route: https://${route.domain} -> ${route.upstream}`);
    }
  } else if (originalContent !== null) {
    await fs.unlink(projectRouteFile).catch(() => {});
    fileModified = true;
    if (!isJson) console.log(`\n🗑️  [2/3] Removed old project route config: ${projectRouteFile}`);
  } else if (!isJson) console.log(`\nℹ️  [2/3] No active ${env} domains found in 'pegas.json'.`);

  if (fileModified) {
    if (!isJson) console.log("\n🔄 [3/3] Validating and hot-reloading Caddy gateway...");
    const reloaded = await reloadGateway({ gatewayDir, json: options.json, silent: isJson, exitOnError: false });
    if (!reloaded) {
      if (!isJson) console.error("⚠️  Hot reload failed. Rolling back route configuration...");
      if (originalContent !== null) await writeFileAtomically(projectRouteFile, originalContent);
      else await fs.unlink(projectRouteFile).catch(() => {});
      if (!options.noExit) process.exit(1);
      return;
    }
  }

  if (isJson) {
    console.log(JSON.stringify({ status: "success", env, project: projectName, routeFile: projectRouteFile, routes: deployedRoutes }));
    return;
  }
  console.log(`\n🎉 Project '${projectName}' [${env}] successfully deployed to Pegas gateway!\n`);
}


export async function handleDeploy(options: DeployOptions = {}): Promise<void> {
  return withRuntimeLock(() => handleDeployUnlocked(options));
}
