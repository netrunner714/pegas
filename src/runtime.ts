import child_process from "node:child_process";
import { PegasContract } from "./types.js";
import { createRuntimeCompose } from "./runtime-compose.js";
import { ensureDockerNetwork } from "./docker.js";

/**
 * Apply a declarative runtime operation using an ephemeral Compose document.
 * The manifest is passed over stdin: no generated Compose file is persisted
 * in the project or in .pegas.
 */
export async function runRuntimeCompose(
  contract: PegasContract,
  projectRoot: string,
  projectId: string,
  composeArgs: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const generated = createRuntimeCompose(contract, { projectRoot, projectId });
  if (composeArgs[0] === "up") {
    const networkReady = await ensureDockerNetwork("pegas-network");
    if (!networkReady) {
      throw new Error("Could not create or inspect the shared Docker network 'pegas-network'.");
    }
  }

  const args = ["compose", "--project-directory", projectRoot, "-f", "-", ...composeArgs];
  try {
    child_process.execFileSync("docker", args, {
      cwd: projectRoot,
      env,
      input: generated.content,
      encoding: "utf-8",
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.().trim();
    const stdout = error?.stdout?.toString?.().trim();
    const details = [stderr, stdout, error?.message].filter(Boolean).join("\n");
    throw new Error(details || "Docker Compose runtime operation failed.");
  }
}
