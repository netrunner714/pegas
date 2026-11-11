import fs from "node:fs/promises";
import path from "node:path";
import { findProjectRoot, findGatewayDir, getProjectRouteFilePath, reloadGateway } from "../gateway.js";
import { CONTRACT_FILENAME, getProjectRuntimeId } from "../contract.js";
import { stopGatewayIfUnused } from "../docker.js";
import { PegasContract } from "../types.js";
import { stripOwnerBlocks, writeRouteFileAtomically } from "../route-merge.js";

export interface DisconnectOptions {
  cwd?: string;
  scenario?: string;
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

  const scenario = options.scenario || "development";
  const gatewayDir = await findGatewayDir(options.gatewayDir);
  const routeFilePath = getProjectRouteFilePath(gatewayDir, projectName, scenario);
  const runtimeId = getProjectRuntimeId(projectRoot, projectName);
  const deployUpstreamPrefix = `${runtimeId}-${scenario}`;

  let removed = false;
  let removedDomains: string[] = [];
  let keptRouteFile: string | null = null;
  let originalContent: string | null = null;
  try {
    originalContent = await fs.readFile(routeFilePath, "utf-8");
  } catch {}

  if (originalContent !== null) {
    // issue #24: disconnect снимает только connect-блоки (upstream host.docker.internal);
    // deploy-блоки (docker-сервисы) и внешние блоки остаются в общем файле проекта.
    const stripped = stripOwnerBlocks(originalContent, "connect", deployUpstreamPrefix);
    if (!options.dryRun) {
      if (stripped.content === null) {
        await fs.unlink(routeFilePath).catch(() => {});
        removed = true;
      } else {
        await writeRouteFileAtomically(routeFilePath, stripped.content);
        keptRouteFile = routeFilePath;
        removed = stripped.removedDomains.length > 0;
      }
    } else {
      removed = true;
    }
    removedDomains = stripped.removedDomains;
  }

  // Host-контекст SDK актуален только для development (host-запуски).
  if (!options.dryRun && scenario === "development") {
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
        scenario,
        removedRouteFile: removed ? routeFilePath : null,
        removedDomains,
        keptRouteFile,
        gatewayStopped,
      }),
    );
  } else {
    if (removed) {
      console.log(`\n🔌 [1;33mProject '${projectName}' disconnected from Pegas Gateway.[0m`);
      if (keptRouteFile) {
        console.log(`   [90mDeploy routes kept in ${keptRouteFile} (docker-сервисы; issue #24).[0m`);
      }
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
