import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import { findProjectRoot, findGatewayDir, getProjectRouteFilePath, getConfDir } from "../gateway.js";
import { CONTRACT_FILENAME, normalizeDomain } from "../contract.js";
import { PegasContract } from "../types.js";
import { generateCaddyfileSnippet } from "../generator.js";
import { handleReload } from "./reload.js";
import { parseCaddyProjectFile } from "./list.js";
import { validateDomains } from "../dns.js";

export interface DeployOptions {
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
      const psRes = child_process.execFileSync(
        "docker",
        ["compose", "ps", "-q", serviceName],
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
              // If "starting", continue polling until timeout
            } else {
              // No built-in healthcheck: wait brief grace period for app to bind port
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

/**
 * Resolves a service upstream into a project-scoped network alias to prevent
 * Docker DNS Round-Robin collisions across multiple projects on pegas-network.
 * e.g. "web:3000" in project "my-app" -> "my-app-web:3000"
 */
export function resolveScopedUpstream(upstream: string, projectName: string): string {
  const parts = upstream.split(":");
  const host = parts[0];
  const port = parts[1] || "3000";

  if (!host) return upstream;
  if (host.startsWith(`${projectName}-`)) {
    return upstream;
  }
  if (host === "localhost" || host === "127.0.0.1" || /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return upstream;
  }

  return `${projectName}-${host}:${port}`;
}

export async function handleDeploy(options: DeployOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd || process.cwd();

  // 1. Find project root and contract
  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);

  let rawContract: string;
  try {
    rawContract = await fs.readFile(contractPath, "utf-8");
  } catch {
    if (isJson) {
      console.log(
        JSON.stringify({
          error: `Contract '${CONTRACT_FILENAME}' not found. Run 'pegas init' first.`,
        })
      );
    } else {
      console.error(`❌ Error: Contract '${CONTRACT_FILENAME}' not found in project root (${projectRoot}).`);
      console.error(`   Run 'pegas init' to generate it.`);
    }
    if (!options.noExit) {
      if (!options.noExit) {
        process.exit(1);
      }
      return;
    }
    return;
  }

  let contract: PegasContract;
  try {
    contract = JSON.parse(rawContract);
  } catch (err: any) {
    if (isJson) {
      console.log(
        JSON.stringify({
          error: `Failed to parse '${path.basename(contractPath)}': Invalid JSON syntax.`,
          details: err.message,
        })
      );
    } else {
      console.error(`❌ Error: Failed to parse '${path.basename(contractPath)}': Invalid JSON syntax.`);
      console.error(`   ${err.message}`);
    }
    if (!options.noExit) {
      if (!options.noExit) {
        process.exit(1);
      }
      return;
    }
    return;
  }

  const projectName =
    contract.projectName || path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]/g, "_");

  const gatewayDir = await findGatewayDir(options.gatewayDir);
  const confDir = getConfDir(gatewayDir);
  if (!options.dryRun) {
    await fs.mkdir(confDir, { recursive: true });
  }

  // Anti-Hijacking Domain Collision Check
  const requestedDomains: string[] = [];
  for (const [, serviceConfig] of Object.entries(contract.services || {})) {
    for (const d of serviceConfig.domains?.prod || []) {
      const norm = normalizeDomain(d);
      if (norm && norm !== "yourdomain.com") {
        if (!requestedDomains.includes(norm)) {
          requestedDomains.push(norm);
        }
        const parts = norm.split(".");
        if (!norm.startsWith("www.") && parts.length === 2) {
          const wwwVar = `www.${norm}`;
          if (!requestedDomains.includes(wwwVar)) {
            requestedDomains.push(wwwVar);
          }
        }
      }
    }
  }

  const projectRouteFile = getProjectRouteFilePath(gatewayDir, projectName);
  const currentProjectFileName = path.basename(projectRouteFile);

  try {
    const existingFiles = await fs.readdir(confDir);
    for (const file of existingFiles) {
      if (!file.endsWith(".caddy") || file === currentProjectFileName) {
        continue;
      }
      const otherFilePath = path.join(confDir, file);
      const otherContent = await fs.readFile(otherFilePath, "utf-8");
      const otherRoutes = parseCaddyProjectFile(otherContent, file);

      for (const route of otherRoutes) {
        for (const claimedDomain of route.domains) {
          if (requestedDomains.includes(claimedDomain)) {
            const conflictErr = `Domain '${claimedDomain}' is already owned by project '${route.projectName}' (in ${file}).`;
            if (isJson) {
              console.log(
                JSON.stringify({
                  error: "Domain collision",
                  domain: claimedDomain,
                  ownerProject: route.projectName,
                  ownerFile: file,
                })
              );
            } else {
              console.error(`\n❌ Error: ${conflictErr}`);
              console.error(`   Deploy aborted to prevent route hijacking.`);
            }
            if (!options.noExit) {
              process.exit(1);
            }
            return;
          }
        }
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      // ignore
    }
  }

  // 3. DNS Pre-flight Validation: Verify domains resolve to server IP before deployment
  if (!options.skipDnsCheck && requestedDomains.length > 0) {
    const dnsResult = await validateDomains(requestedDomains, {
      skipDnsCheck: options.skipDnsCheck,
      strictDns: options.strictDns,
      serverIp: options.serverIp,
      json: isJson,
      noExit: options.noExit,
    });

    if (!dnsResult.valid && options.strictDns) {
      if (isJson) {
        console.log(
          JSON.stringify({
            error: "Strict DNS validation failed",
            warnings: dnsResult.warnings,
            serverIp: dnsResult.serverIp,
          })
        );
      }
      if (!options.noExit) {
        process.exit(1);
      }
      return;
    }
  }

  // 4. Cold Start: Start project containers FIRST so they begin spinning up
  if (!options.dryRun && !options.skipUp) {
    if (!isJson) {
      console.log("\n🚀 [1/3] Starting project containers with Docker Compose...");
    }
    try {
      child_process.execSync("docker compose up -d", {
        stdio: "inherit",
        cwd: projectRoot,
      });
    } catch (err: any) {
      if (isJson) {
        console.log(
          JSON.stringify({
            error: "Failed to execute 'docker compose up -d'",
            details: err.message,
          })
        );
      } else {
        console.error("❌ Error: Failed to execute 'docker compose up -d':", err.message);
      }
      if (!options.noExit) {
        process.exit(1);
      }
      return;
    }

    // Readiness Probe: verify containers are running and healthy before updating Caddy routes
    if (!options.skipReadiness) {
      const servicesToCheck: string[] = [];
      for (const [sName, sCfg] of Object.entries(contract.services || {})) {
        if (Array.isArray(sCfg.domains?.prod) && sCfg.domains.prod.length > 0) {
          servicesToCheck.push(sName);
        }
      }

      if (servicesToCheck.length > 0) {
        if (!isJson) {
          console.log(`\n⏳ Checking container readiness for: ${servicesToCheck.join(", ")}...`);
        }
        for (const sName of servicesToCheck) {
          const checkRes = await waitForContainerReadiness(projectRoot, sName, {
            timeoutMs: options.readinessTimeoutMs,
            gracePeriodMs: options.gracePeriodMs,
          });
          if (!checkRes.ready) {
            const errMsg = `Service '${sName}' failed readiness check: ${checkRes.reason}`;
            if (isJson) {
              console.log(JSON.stringify({ error: errMsg, service: sName, reason: checkRes.reason }));
            } else {
              console.error(`\n❌ Error: ${errMsg}`);
              console.error(`   Deployment aborted before updating Caddy routes.`);
            }
            if (!options.noExit) {
              if (!options.noExit) {
        process.exit(1);
      }
      return;
            }
            return;
          }
          if (!isJson) {
            console.log(`  🟢 Service '${sName}' is ready to accept traffic`);
          }
        }
      }
    }
  }

  // 3. Garbage Collection: Generate ONE combined file per project in conf.d/<projectName>.caddy
  const snippets: string[] = [];
  const deployedRoutes: {
    service: string;
    domain: string;
    upstream: string;
  }[] = [];

  const services = contract.services || {};
  for (const [serviceName, serviceConfig] of Object.entries(services)) {
    const prodDomains = serviceConfig.domains?.prod;
    const upstream = serviceConfig.upstream;

    if (!Array.isArray(prodDomains) || prodDomains.length === 0) {
      continue;
    }

    if (!upstream) {
      if (!isJson) {
        console.warn(`⚠️  Warning: Service '${serviceName}' has prod domains but no upstream. Skipping.`);
      }
      continue;
    }

    const scopedUpstream = resolveScopedUpstream(upstream, projectName);

    for (const domain of prodDomains) {
      const normDomain = normalizeDomain(domain);
      if (!normDomain) continue;

      if (normDomain === "yourdomain.com") {
        if (!isJson) {
          console.warn(`⚠️  Warning: Service '${serviceName}' has placeholder domain 'yourdomain.com'. Skipping.`);
        }
        continue;
      }

      const snippet = generateCaddyfileSnippet({
        domain: normDomain,
        upstream: scopedUpstream,
      });
      snippets.push(snippet);
      deployedRoutes.push({
        service: serviceName,
        domain: normDomain,
        upstream: scopedUpstream,
      });
    }
  }

  if (options.dryRun) {
    if (!isJson) {
      console.log(`\n📋 [dry-run] Target project route file: ${projectRouteFile}`);
      for (const r of deployedRoutes) {
        console.log(`  - Route: https://${r.domain} -> ${r.upstream}`);
      }
      if (snippets.length === 0) {
        console.log("  (No production domains to configure)");
      }
    } else {
      console.log(JSON.stringify({ status: "dry-run", project: projectName, file: projectRouteFile, routes: deployedRoutes }));
    }
    return;
  }

  // Check if original project file existed for rollback
  let originalContent: string | null = null;
  try {
    originalContent = await fs.readFile(projectRouteFile, "utf-8");
  } catch {}

  let fileModified = false;
  if (snippets.length > 0) {
    const combinedCaddyfile =
      `# Auto-generated by Pegas for project: ${projectName}\n# Do not edit manually; update pegas.json instead.\n\n` +
      snippets.join("\n\n") +
      "\n";

    await fs.mkdir(path.dirname(projectRouteFile), { recursive: true });
    await fs.writeFile(projectRouteFile, combinedCaddyfile, "utf-8");
    await fs.chmod(projectRouteFile, 0o644).catch(() => {});
    fileModified = true;

    if (!isJson) {
      console.log(`\n📄 [2/3] Generated route config: ${projectRouteFile}`);
      for (const r of deployedRoutes) {
        console.log(`  ✓ Route: https://${r.domain} -> ${r.upstream}`);
      }
    }
  } else if (originalContent !== null) {
    // If all prod routes were removed, delete old project caddyfile
    await fs.unlink(projectRouteFile).catch(() => {});
    fileModified = true;
    if (!isJson) {
      console.log(`\n🗑️  [2/3] Removed old project route config: ${projectRouteFile}`);
    }
  } else {
    if (!isJson) {
      console.log("\nℹ️  [2/3] No active production domains found in 'pegas.json'.");
    }
  }

  // 4. Hot reload Caddy gateway
  if (fileModified) {
    if (!isJson) {
      console.log("\n🔄 [3/3] Validating and hot-reloading Caddy gateway...");
    }

    const reloaded = await handleReload({
      gatewayDir,
      json: options.json,
      silent: isJson,
      exitOnError: false,
    });

    if (!reloaded) {
      if (!isJson) {
        console.error("⚠️  Hot reload failed. Rolling back route configuration...");
      }
      if (originalContent !== null) {
        await fs.writeFile(projectRouteFile, originalContent, "utf-8");
      } else {
        await fs.unlink(projectRouteFile).catch(() => {});
      }
      if (!options.noExit) {
        process.exit(1);
      }
      return;
    }
  }

  if (isJson) {
    console.log(
      JSON.stringify({
        status: "success",
        project: projectName,
        routeFile: projectRouteFile,
        routes: deployedRoutes,
      })
    );
    return;
  }

  console.log(`\n🎉 Project '${projectName}' successfully deployed to Pegas gateway!\n`);
}
