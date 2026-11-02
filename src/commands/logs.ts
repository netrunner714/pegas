import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import { findProjectRoot } from "../gateway.js";
import { CONTRACT_FILENAME, normalizeEnvironment, getProjectRuntimeId } from "../contract.js";
import { PegasContract } from "../types.js";
import { followRuntimeLogs } from "../runtime.js";

export interface LogsOptions {
  cwd?: string;
  env?: string;
  service?: string;
  follow?: boolean;
  tail?: string | number;
  json?: boolean;
  noExit?: boolean;
}

export async function handleLogs(options: LogsOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd || process.cwd();
  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);

  let contractRaw: string;
  try {
    contractRaw = await fs.readFile(contractPath, "utf-8");
  } catch {
    const msg = `Contract '${CONTRACT_FILENAME}' not found in project root (${projectRoot}). Run 'pegas init' first.`;
    if (isJson) console.log(JSON.stringify({ error: msg }));
    else console.error(`❌ Error: ${msg}`);
    if (!options.noExit) process.exit(1);
    return;
  }

  let contract: PegasContract;
  try {
    contract = JSON.parse(contractRaw);
  } catch (err: any) {
    const msg = `Failed to parse '${CONTRACT_FILENAME}': ${err.message}`;
    if (isJson) console.log(JSON.stringify({ error: msg }));
    else console.error(`❌ Error: ${msg}`);
    if (!options.noExit) process.exit(1);
    return;
  }

  if (contract.runtime !== "docker") {
    const msg = `'pegas logs' requires a Docker runtime project ('runtime: "docker"' in ${CONTRACT_FILENAME}).`;
    if (isJson) console.log(JSON.stringify({ error: msg }));
    else console.error(`❌ Error: ${msg}`);
    if (!options.noExit) process.exit(1);
    return;
  }

  const targetEnv = normalizeEnvironment(options.env || "development");
  const service = options.service;
  const services = contract.services || {};

  if (service && !services[service]) {
    const available = Object.keys(services).join(", ");
    const msg = `Service '${service}' not found in ${CONTRACT_FILENAME}. Available services: ${available || "none"}`;
    if (isJson) console.log(JSON.stringify({ error: msg }));
    else console.error(`❌ Error: ${msg}`);
    if (!options.noExit) process.exit(1);
    return;
  }

  const projectName = contract.projectName || path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  const projectId = getProjectRuntimeId(projectRoot, projectName);

  // Check if containers exist for this project and environment
  const filters = [
    `label=pegas.project=${projectId}`,
    `label=pegas.environment=${targetEnv}`,
  ];
  if (service) {
    filters.push(`label=pegas.service=${service}`);
  }

  let matchingContainerIds: string[] = [];
  try {
    const psResult = child_process.execFileSync(
      "docker",
      ["ps", "-aq", ...filters.flatMap((f) => ["--filter", f])],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
    );
    matchingContainerIds = psResult.trim().split(/\s+/).filter(Boolean);
  } catch {}

  if (matchingContainerIds.length === 0) {
    if (isJson) {
      console.log(
        JSON.stringify({
          status: "not_running",
          project: projectName,
          environment: targetEnv,
          service: service || null,
        })
      );
    } else {
      if (service) {
        console.log(`ℹ️ No running containers found for service '${service}' (project '${projectName}', environment '${targetEnv}').`);
      } else {
        console.log(`ℹ️ No running containers found for project '${projectName}' in environment '${targetEnv}'.`);
      }
      console.log(`   Run 'pegas deploy ${targetEnv}' first.\n`);
    }
    return;
  }

  const follow = options.follow ?? false;
  const tail = options.tail ?? 100;

  if (!isJson) {
    if (follow) {
      console.log(`📋 Following logs for ${service ? `service '${service}'` : `project '${projectName}'`} [${targetEnv}] (press Ctrl+C to detach)...\n`);
    } else {
      console.log(`📋 Logs for ${service ? `service '${service}'` : `project '${projectName}'`} [${targetEnv}] (last ${tail} lines):\n`);
    }
  }

  try {
    await followRuntimeLogs(
      contract,
      projectRoot,
      projectId,
      {
        service,
        follow,
        tail,
      },
      {
        ...process.env,
        PEGAS_ENV: targetEnv,
      }
    );
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ error: "Failed to stream logs", details: err.message }));
    } else {
      console.error(`❌ Error streaming logs: ${err.message}`);
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  if (!isJson) {
    if (follow) {
      console.log("\n👋 Detached from logs. Pegas containers keep running in the background.\n");
    } else {
      console.log(`💡 Tip: Use 'pegas logs -f' to follow logs in real time.\n`);
    }
  }
}
