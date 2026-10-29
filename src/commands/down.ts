import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import { findProjectRoot, findGatewayDir, getProjectRouteFilePath } from "../gateway.js";
import { CONTRACT_FILENAME } from "../contract.js";
import { findPegasCompose } from "../compose.js";
import { handleReload } from "./reload.js";

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

  let projectName = path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  try {
    const rawContract = await fs.readFile(path.join(projectRoot, CONTRACT_FILENAME), "utf-8");
    const contract = JSON.parse(rawContract);
    if (contract.projectName) {
      projectName = contract.projectName;
    }
  } catch {}

  const gatewayDir = await findGatewayDir(options.gatewayDir);
  const routeFilePath = getProjectRouteFilePath(gatewayDir, projectName);

  let fileRemoved = false;
  try {
    await fs.unlink(routeFilePath);
    fileRemoved = true;
    if (!isJson) {
      console.log(`\n🗑️  [1/2] Removed project route file: ${routeFilePath}`);
    }
  } catch {
    if (!isJson) {
      console.log(`\nℹ️  [1/2] No route file found for project '${projectName}' at ${routeFilePath}`);
    }
  }

  // Reload Caddy to remove routes from memory
  if (fileRemoved) {
    if (!isJson) {
      console.log("🔄 Reloading Caddy gateway...");
    }
    await handleReload({
      gatewayDir,
      json: options.json,
      silent: false,
      exitOnError: false,
    });
  }

  // Stop containers with docker compose down
  if (!options.skipComposeDown) {
    const composeFile = await findPegasCompose(projectRoot);
    const composeCmd = composeFile
      ? `docker compose --project-directory . -f ${composeFile} down`
      : "docker compose down";

    if (!isJson) {
      console.log(`\n🛑 [2/2] Stopping project containers with '${composeCmd}'...\n`);
    }
    try {
      child_process.execSync(composeCmd, {
        stdio: "inherit",
        cwd: projectRoot,
      });
    } catch (err: any) {
      if (isJson) {
        console.log(
          JSON.stringify({
            error: `Failed to execute '${composeCmd}'`,
            details: err.message,
          })
        );
      } else {
        console.error(`❌ Error: Failed to execute '${composeCmd}':`, err.message);
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
        routeFile: routeFilePath,
        fileRemoved,
      })
    );
    return;
  }

  console.log(`\n✨ Project '${projectName}' taken down and routes cleaned up successfully.\n`);
}
