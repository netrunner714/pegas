import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import { findProjectRoot, findGatewayDir, getProjectRouteFilePath, getConfDir, reloadGateway } from "../gateway.js";
import { CONTRACT_FILENAME, normalizeDomain, getEnvironmentDomains, getServiceUpstream, listAvailableEnvironments, getProjectRuntimeId } from "../contract.js";
import { findPegasCompose, setupProjectCompose } from "../compose.js";
import { PegasContract } from "../types.js";
import { generateCaddyfileSnippet } from "../generator.js";
import { parseCaddyProjectFile } from "./status.js";
import { validateDomains } from "../dns.js";
import { runRuntimeCompose } from "../runtime.js";
import { ensureGatewayContainer } from "../docker.js";
import { withRuntimeLock } from "../runtime-lock.js";

export interface DeployOptions {
  env?: string;
  gatewayDir?: string;
  dryRun?: boolean;
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
        ? ["ps", "-q", "--filter", `label=pegas.project=${options.projectId}`, "--filter", `label=pegas.service=${serviceName}`]
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
  const env = options.env;

  if (!env) {
    if (isJson) console.log(JSON.stringify({ error: "Environment contour is required for deploy (e.g. 'production' or 'stage')." }));
    else {
      console.error("❌ Error: Environment contour is required for deploy.");
      console.error("   Usage: pegas deploy <environment> (e.g. 'pegas deploy production' or 'pegas deploy stage')");
    }
    if (!options.noExit) process.exit(1);
    return;
  }

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

  const projectName = contract.projectName || path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  const runtimeId = getProjectRuntimeId(projectRoot, projectName);
  const gatewayDir = await findGatewayDir(options.gatewayDir);
  const confDir = getConfDir(gatewayDir);
  if (!options.dryRun) await fs.mkdir(confDir, { recursive: true });

  const strictDns = contract.deploy?.strictDns ?? options.strictDns ?? false;
  const skipDnsCheck = contract.deploy?.skipDnsCheck ?? options.skipDnsCheck ?? false;
  const skipReadiness = contract.deploy?.skipReadiness ?? options.skipReadiness ?? false;

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
    const available = listAvailableEnvironments(contract);
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

  try {
    const existingFiles = await fs.readdir(confDir);
    for (const file of existingFiles) {
      if (!file.endsWith(".caddy") || file === currentProjectFileName) continue;
      const otherContent = await fs.readFile(path.join(confDir, file), "utf-8");
      const otherRoutes = parseCaddyProjectFile(otherContent, file);
      for (const route of otherRoutes) {
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

  if (!options.dryRun && !options.skipUp) {
    if (!isJson) console.log(`\n🚀 [1/3] Starting project containers for environment '${env}'...`);
    const primaryDomain = requestedDomains[0] || "";
    const deployEnv = {
      ...process.env,
      PEGAS_ENV: env,
      NODE_ENV: contract.runtime === "docker" && env === "development" ? "development" : "production",
      ...(primaryDomain ? { APP_DOMAIN: primaryDomain } : {}),
    };
    let composeFile: string | null = null;
    try {
      if (contract.runtime === "docker") {
        await runRuntimeCompose(contract, projectRoot, runtimeId, ["up", "-d", "--remove-orphans"], deployEnv);
        const gatewayResult = await ensureGatewayContainer(gatewayDir);
        if (!gatewayResult.success) throw new Error(gatewayResult.stderr || "Failed to ensure shared Gateway.");
      } else {
        await setupProjectCompose(projectRoot, projectName);
        composeFile = await findPegasCompose(projectRoot);
        const composeCmd = composeFile
          ? `docker compose --project-directory . -f ${composeFile} up -d`
          : "docker compose up -d";
        child_process.execSync(composeCmd, { stdio: "inherit", cwd: projectRoot, env: deployEnv });
      }
    } catch (err: any) {
      const message = contract.runtime === "docker" ? "Failed to apply the declarative Docker runtime" : "Failed to execute Docker Compose";
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
            composeFile: composeFile || undefined,
            projectId: contract.runtime === "docker" ? runtimeId : undefined,
          });
          if (!checkRes.ready) {
            const errMsg = `Service '${sName}' failed readiness check: ${checkRes.reason}`;
            if (isJson) console.log(JSON.stringify({ error: errMsg, service: sName, reason: checkRes.reason }));
            else {
              console.error(`\n❌ Error: ${errMsg}`);
              console.error("   Deployment aborted before updating Caddy routes.");
            }
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
  for (const [serviceName, serviceConfig] of Object.entries(contract.services || {})) {
    const envDomains = getEnvironmentDomains(serviceConfig, env);
    const upstream = getServiceUpstream(serviceName, serviceConfig);
    if (!Array.isArray(envDomains) || envDomains.length === 0) continue;
    const scopedUpstream = resolveScopedUpstream(upstream, contract.runtime === "docker" ? runtimeId : projectName);
    for (const domain of envDomains) {
      const normDomain = normalizeDomain(domain);
      if (!normDomain || normDomain === "yourdomain.com") continue;
      snippets.push(generateCaddyfileSnippet({ domain: normDomain, upstream: scopedUpstream }));
      deployedRoutes.push({ service: serviceName, domain: normDomain, upstream: scopedUpstream });
    }
  }

  if (options.dryRun) {
    if (!isJson) {
      console.log(`\n📋 [dry-run] Target project route file: ${projectRouteFile}`);
      for (const route of deployedRoutes) console.log(`  - Route: https://${route.domain} -> ${route.upstream}`);
      if (snippets.length === 0) console.log(`  (No ${env} domains to configure)`);
    } else console.log(JSON.stringify({ status: "dry-run", env, project: projectName, file: projectRouteFile, routes: deployedRoutes }));
    return;
  }

  let originalContent: string | null = null;
  try { originalContent = await fs.readFile(projectRouteFile, "utf-8"); } catch {}
  let fileModified = false;
  if (snippets.length > 0) {
    const combinedCaddyfile =
      `# Auto-generated by Pegas for project: ${projectName} [${env}]\n# Do not edit manually; update pegas.json instead.\n\n` +
      snippets.join("\n\n") + "\n";
    await fs.mkdir(path.dirname(projectRouteFile), { recursive: true });
    await fs.writeFile(projectRouteFile, combinedCaddyfile, "utf-8");
    await fs.chmod(projectRouteFile, 0o644).catch(() => {});
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
      if (originalContent !== null) await fs.writeFile(projectRouteFile, originalContent, "utf-8");
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
