import fs from "node:fs/promises";
import path from "node:path";
import { findProjectRoot, findGatewayDir, getProjectRouteFilePath, reloadGateway } from "../gateway.js";
import { CONTRACT_FILENAME } from "../contract.js";
import { stopGatewayIfUnused } from "../docker.js";
import { PegasContract } from "../types.js";

export interface DisconnectOptions {
  cwd?: string;
  gatewayDir?: string;
  json?: boolean;
  dryRun?: boolean;
  noExit?: boolean;
  skipReload?: boolean;
}

export async function handleDisconnect(options: DisconnectOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd || process.cwd();
  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);

  let projectName = path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  try {
    const rawContract = await fs.readFile(contractPath, "utf-8");
    const contract = JSON.parse(rawContract) as PegasContract;
    if (contract.projectName) projectName = contract.projectName;
  } catch {}

  const gatewayDir = await findGatewayDir(options.gatewayDir);
  const routeFilePath = getProjectRouteFilePath(gatewayDir, projectName, "development");

  let removed = false;
  try {
    await fs.access(routeFilePath);
    if (!options.dryRun) {
      await fs.unlink(routeFilePath);
    }
    removed = true;
  } catch {}

  // Host-контекст SDK больше не актуален: сессия завершена.
  if (!options.dryRun) {
    try {
      const ctxPath = path.join(projectRoot, ".pegas", "context.json");
      await fs.access(ctxPath);
      await fs.unlink(ctxPath);
    } catch {}
  }

  let gatewayStopped = false;
  if (!options.dryRun) {
    if (removed && !options.skipReload) {
      await reloadGateway({ gatewayDir, json: isJson, silent: true, exitOnError: false });
    }
    // Check if gateway is unused now (stops Caddy if no other route files and no project containers)
    const stopRes = await stopGatewayIfUnused(gatewayDir);
    if (stopRes.success && stopRes.stdout.includes("Shared Gateway stopped")) {
      gatewayStopped = true;
    }
  }

  if (isJson) {
    console.log(
      JSON.stringify({
        status: "disconnected",
        project: projectName,
        removedRouteFile: removed ? routeFilePath : null,
        gatewayStopped,
      }),
    );
  } else {
    if (removed) {
      console.log(`\n🔌 \x1b[1;33mProject '${projectName}' disconnected from Pegas Gateway.\x1b[0m`);
    } else {
      console.log(`\nℹ️ Project '${projectName}' was not connected.`);
    }
    if (gatewayStopped) {
      console.log(`   🛑 Shared Gateway stopped: no other projects are using it.\n`);
    } else {
      console.log();
    }
  }
}
