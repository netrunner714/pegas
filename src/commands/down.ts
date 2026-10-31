import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import { findProjectRoot, findGatewayDir, getConfDir, reloadGateway } from "../gateway.js";
import { CONTRACT_FILENAME, normalizeEnvironment } from "../contract.js";
import { findPegasCompose } from "../compose.js";
import { getProjectRuntimeId } from "../contract.js";
import { removeProjectContainers } from "../runtime.js";
import { runCommand, stopGatewayIfUnused } from "../docker.js";
import { PegasContract } from "../types.js";
import { withRuntimeLock } from "../runtime-lock.js";

export interface DownOptions {
  gatewayDir?: string;
  cwd?: string;
  json?: boolean;
  skipComposeDown?: boolean;
  noExit?: boolean;
  env?: string;
}

async function handleDownUnlocked(options: DownOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd || process.cwd();
  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);

  let projectName = path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  let contract: PegasContract | null = null;
  let runtimeId: string | undefined;
  try {
    const rawContract = await fs.readFile(contractPath, "utf-8");
    contract = JSON.parse(rawContract) as PegasContract;
    if (contract.projectName) projectName = contract.projectName;
    if (contract.runtime === "docker") runtimeId = getProjectRuntimeId(projectRoot, projectName);
  } catch {
    // Recover ownership from Docker labels if pegas.json was removed or corrupted.
    const defaultRuntimeId = getProjectRuntimeId(projectRoot, projectName);
    const checkoutDigest = defaultRuntimeId.slice(defaultRuntimeId.lastIndexOf("-") + 1);
    const listed = await runCommand("docker", ["ps", "-aq", "--filter", "label=pegas.project"]);
    let recovered: any;
    if (listed.success && listed.stdout.trim()) {
      const ids = listed.stdout.split(/\s+/).filter(Boolean);
      const inspected = await runCommand("docker", ["inspect", ...ids]);
      if (inspected.success) {
        try {
          const containers = JSON.parse(inspected.stdout);
          recovered = containers.find((container: any) => {
            const labels = container.Config?.Labels || {};
            const id = labels["pegas.project"];
            return typeof id === "string" && id.endsWith("-" + checkoutDigest);
          });
        } catch {}
      }
    }
    if (recovered) {
      const labels = recovered.Config?.Labels || {};
      runtimeId = labels["pegas.project"];
      if (typeof labels["pegas.project-name"] === "string") projectName = labels["pegas.project-name"];
      contract = { runtime: "docker", services: {} } as PegasContract;
    } else {
      const composeFile = await findPegasCompose(projectRoot);
      if (!composeFile) {
        const message = "Contract " + CONTRACT_FILENAME + " not found in " + projectRoot + ", and no matching Pegas Docker containers were found."; 
        if (isJson) console.log(JSON.stringify({ error: message }));
        else console.error("❌ Error: " + message);
        if (!options.noExit) process.exit(1);
        return;
      }
    }
  }

  const requestedEnvironment = options.env ? normalizeEnvironment(options.env) : undefined;
  const gatewayDir = await findGatewayDir(options.gatewayDir);
  const confDir = getConfDir(gatewayDir);
  const sanitizedProject = projectName.toLowerCase().replace(/[^a-z0-9._-]/g, "_");

  const removedFiles: string[] = [];
  const previousRouteFiles = new Map<string, string>();
  try {
    const files = await fs.readdir(confDir);
    for (const f of files) {
      const isOwnRouteFile = f === `${sanitizedProject}.caddy` || (f.startsWith(`${sanitizedProject}-`) && f.endsWith(".caddy"));
      const isRequestedEnvironmentFile = requestedEnvironment === undefined
        ? true
        : f === `${sanitizedProject}-${requestedEnvironment}.caddy`
          || (requestedEnvironment === "production" && f === `${sanitizedProject}.caddy`);
      if (isOwnRouteFile && isRequestedEnvironmentFile) {
        const fullPath = path.join(confDir, f);
        previousRouteFiles.set(fullPath, await fs.readFile(fullPath, "utf-8"));
        await fs.unlink(fullPath);
        removedFiles.push(fullPath);
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const fileRemoved = removedFiles.length > 0;
  if (!isJson) {
    if (fileRemoved) {
      console.log(`\n🗑️  [1/2] Removed project route file(s):\n${removedFiles.map((f) => `   - ${f}`).join("\n")}`);
    } else {
      console.log(`\nℹ️  [1/2] No route file found for project '${projectName}' in ${confDir}`);
    }
  }

  // Reload Caddy to remove routes from memory
  if (fileRemoved) {
    if (!isJson) {
      console.log("🔄 Reloading Caddy gateway...");
    }
    let gatewayNeedsReload = true;
    if (contract?.runtime === "docker") {
      const runningGateway = await runCommand("docker", ["ps", "-q", "--filter", "label=pegas.gateway=true"]);
      if (!runningGateway.success) {
        throw new Error(runningGateway.stderr || "Could not inspect the shared Gateway before removing routes.");
      }
      gatewayNeedsReload = Boolean(runningGateway.stdout.trim());
    }
    // A gateway directory without a Compose file has no reloadable Caddy: treat it
    // like a stopped gateway (persisted route removal is enough).
    const hasComposeFile = await fs.readdir(gatewayDir).then(
      (files) => files.some((f) => /^(docker-)?compose\.ya?ml$/.test(f)),
      () => false,
    );
    if (!hasComposeFile) gatewayNeedsReload = false;
    // A stopped Gateway has no in-memory routes to refresh. Removing the
    // persisted route file is sufficient and lets down recover after a crash.
    const reloaded = !gatewayNeedsReload || await reloadGateway({
      gatewayDir,
      json: options.json,
      silent: isJson,
      exitOnError: false,
    });
    if (!reloaded) {
      for (const [file, previousContent] of previousRouteFiles) {
        await fs.writeFile(file, previousContent, "utf-8");
      }
      if (isJson) {
        console.log(JSON.stringify({ error: "Failed to reload Gateway after removing project routes; route files were restored and containers were left running." }));
      } else {
        console.error("❌ Gateway reload failed. Route files were restored; project containers were left running.");
      }
      if (!options.noExit) process.exit(1);
      return;
    }
  }

  // Remove only this project's containers. External pegas-network and named
  // dependency volumes are intentionally preserved.
  if (!options.skipComposeDown) {
    try {
      if (contract?.runtime === "docker") {
        runtimeId ||= getProjectRuntimeId(projectRoot, projectName);
        await removeProjectContainers(runtimeId, requestedEnvironment);
        const gatewayResult = await stopGatewayIfUnused(gatewayDir);
        if (!gatewayResult.success) {
          throw new Error(gatewayResult.stderr || "Failed to reconcile shared Gateway lifecycle.");
        }
      } else {
        const composeFile = await findPegasCompose(projectRoot);
        const composeCmd = composeFile
          ? `docker compose --project-directory . -f ${composeFile} down`
          : "docker compose down";
        if (!isJson) {
          console.log(`\n🛑 [2/2] Stopping project containers with '${composeCmd}'...\n`);
        }
        child_process.execSync(composeCmd, { stdio: "inherit", cwd: projectRoot });
      }
    } catch (err: any) {
      const message = contract?.runtime === "docker"
        ? "Failed to remove declarative runtime containers"
        : "Failed to execute Docker Compose down";
      if (isJson) {
        console.log(JSON.stringify({ error: message, details: err.message }));
      } else {
        console.error(`❌ Error: ${message}:`, err.message);
      }
      if (!options.noExit) process.exit(1);
      return;
    }
  }

  if (isJson) {
    console.log(
      JSON.stringify({
        status: "success",
        project: projectName,
        routeFiles: removedFiles,
        fileRemoved,
      })
    );
    return;
  }

  console.log(`\n✨ Project '${projectName}' taken down and routes cleaned up successfully.\n`);
}


export async function handleDown(options: DownOptions = {}): Promise<void> {
  return withRuntimeLock(() => handleDownUnlocked(options));
}
