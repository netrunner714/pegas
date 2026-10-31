import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import { findProjectRoot, findGatewayDir, getConfDir, reloadGateway } from "../gateway.js";
import { CONTRACT_FILENAME } from "../contract.js";
import { findPegasCompose } from "../compose.js";
import { getProjectRuntimeId } from "../contract.js";
import { runRuntimeCompose } from "../runtime.js";
import { PegasContract } from "../types.js";

export interface DownOptions {
  gatewayDir?: string;
  cwd?: string;
  json?: boolean;
  skipComposeDown?: boolean;
  noExit?: boolean;
}

export async function handleDown(options: DownOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd || process.cwd();
  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);

  let projectName = path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  let contract: PegasContract | null = null;
  try {
    const rawContract = await fs.readFile(contractPath, "utf-8");
    contract = JSON.parse(rawContract) as PegasContract;
    if (contract.projectName) {
      projectName = contract.projectName;
    }
  } catch {
    const composeFile = await findPegasCompose(projectRoot);
    if (!composeFile) {
      if (isJson) {
        console.log(
          JSON.stringify({
            error: `Contract '${CONTRACT_FILENAME}' not found in '${projectRoot}'. Run this command inside a Pegas project.`,
          })
        );
      } else {
        console.error(`❌ Error: Contract '${CONTRACT_FILENAME}' not found in project root (${projectRoot}).`);
        console.error(`   Run this command inside a Pegas project.`);
      }
      if (!options.noExit) {
        process.exit(1);
      }
      return;
    }
  }

  const gatewayDir = await findGatewayDir(options.gatewayDir);
  const confDir = getConfDir(gatewayDir);
  const sanitizedProject = projectName.toLowerCase().replace(/[^a-z0-9._-]/g, "_");

  const removedFiles: string[] = [];
  try {
    const files = await fs.readdir(confDir);
    for (const f of files) {
      if (f === `${sanitizedProject}.caddy` || (f.startsWith(`${sanitizedProject}-`) && f.endsWith(".caddy"))) {
        const fullPath = path.join(confDir, f);
        await fs.unlink(fullPath);
        removedFiles.push(fullPath);
      }
    }
  } catch {}

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
    await reloadGateway({
      gatewayDir,
      json: options.json,
      silent: false,
      exitOnError: false,
    });
  }

  // Remove only this project's containers. External pegas-network and named
  // dependency volumes are intentionally preserved.
  if (!options.skipComposeDown) {
    try {
      if (contract?.runtime === "docker") {
        const runtimeId = getProjectRuntimeId(projectRoot, projectName);
        await runRuntimeCompose(contract, projectRoot, runtimeId, ["down", "--remove-orphans"]);
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
