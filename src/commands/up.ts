import fs from "node:fs/promises";
import path from "node:path";
import { findProjectRoot } from "../gateway.js";
import { CONTRACT_FILENAME, listAvailableEnvironments } from "../contract.js";
import { PegasContract, UpOptions } from "../types.js";
import { handleDev } from "./dev.js";
import { handleDeploy } from "./deploy.js";

export async function handleUp(
  options: UpOptions & { command?: string[] } = {}
): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd || process.cwd();
  const projectRoot = (await findProjectRoot(cwd)) || cwd;

  // 1. Read pegas.json to discover environments
  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);
  let contract: PegasContract | null = null;
  try {
    const rawContract = await fs.readFile(contractPath, "utf-8");
    contract = JSON.parse(rawContract);
  } catch (err: any) {
    if (isJson) {
      console.log(
        JSON.stringify({
          error: `Contract '${CONTRACT_FILENAME}' not found in ${projectRoot}. Run 'pegas init' first.`,
        })
      );
    } else {
      console.error(`❌ Error: Contract '${CONTRACT_FILENAME}' not found in project root (${projectRoot}).`);
      console.error(`   Run 'pegas init' to generate it.`);
    }
    if (!options.noExit) {
      process.exit(1);
    }
    return;
  }

  const availableEnvs = contract ? listAvailableEnvironments(contract) : [];
  const env = options.env?.trim().toLowerCase();

  // 2. Strict explicit environment requirement (no implicit default!)
  if (!env) {
    const envListStr =
      availableEnvs.length > 0
        ? availableEnvs.join(", ")
        : "development, stage, production";

    if (isJson) {
      console.log(
        JSON.stringify({
          error: "Missing required option '--env <name>'",
          availableEnvironments: availableEnvs,
        })
      );
    } else {
      console.error(`\n❌ Error: Missing required option '--env <name>' (-e <name>).`);
      console.error(`   Please specify which environment to bring up.`);
      console.error(`   Available environments in ${CONTRACT_FILENAME}: ${envListStr}\n`);
      console.error(`   Examples:`);
      console.error(`     pegas up --env development`);
      console.error(`     pegas up --env production`);
      console.error(`     pegas up --env stage\n`);
    }
    if (!options.noExit) {
      process.exit(1);
    }
    return;
  }

  // 3. Dispatch based on environment
  if (env === "dev" || env === "development") {
    await handleDev({
      cwd: projectRoot,
      command: options.command,
      noExit: options.noExit,
      caddyPath: options.caddyPath,
      systemCaddy: options.systemCaddy,
    });
  } else {
    // Production, Stage, or any custom environment contour (qa, demo, etc.)
    await handleDeploy({
      ...options,
      env,
      cwd: projectRoot,
    });
  }
}
