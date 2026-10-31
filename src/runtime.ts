import child_process from "node:child_process";
import { PegasContract } from "./types.js";
import { createRuntimeCompose } from "./runtime-compose.js";
import { normalizeEnvironment } from "./contract.js";
import { ensureDockerNetwork } from "./docker.js";

/**
 * Follows service logs via an ephemeral Compose invocation. Ctrl+C (SIGINT) is
 * forwarded to Compose, which stops following but never touches the containers:
 * `logs --follow` is read-only. Pegas itself exits cleanly afterwards.
 */
export async function followRuntimeLogs(
  contract: PegasContract,
  projectRoot: string,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const generated = createRuntimeCompose(contract, { projectRoot, projectId, environment: env.PEGAS_ENV });
  const environmentName = normalizeEnvironment(env.PEGAS_ENV).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const composeProjectName = `${projectId}-${environmentName}`;
  const args = [
    "compose", "--project-name", composeProjectName, "--project-directory", projectRoot,
    "-f", "-", "logs", "--follow", "--tail", "100",
  ];
  await new Promise<void>((resolve, reject) => {
    const child = child_process.spawn("docker", args, {
      cwd: projectRoot,
      env,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.stdin.on("error", () => {});
    child.stdin.end(generated.content);
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
      // Compose exits 0 after SIGINT-detach; any zero exit is a clean detach.
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") resolve();
      else reject(new Error(`Docker Compose log follow failed (exit code ${code}).`));
    });
  });
}

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
  const generated = createRuntimeCompose(contract, { projectRoot, projectId, environment: env.PEGAS_ENV });
  if (composeArgs[0] === "up") {
    const networkReady = await ensureDockerNetwork("pegas-network");
    if (!networkReady) {
      throw new Error("Could not create or inspect the shared Docker network 'pegas-network'.");
    }
  }

  const environmentName = normalizeEnvironment(env.PEGAS_ENV).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const composeProjectName = `${projectId}-${environmentName}`;
  const args = ["compose", "--project-name", composeProjectName, "--project-directory", projectRoot, "-f", "-", ...composeArgs];
  // stdout живёт в терминале (inherit), stderr захватывается в pipe:
  // при провале он попадает в текст ошибки, при успехе — пробрасывается в
  // process.stderr, чтобы warning'и Compose не терялись.
  const result = child_process.spawnSync("docker", args, {
    cwd: projectRoot,
    env,
    input: generated.content,
    encoding: "utf-8",
    stdio: ["pipe", "inherit", "pipe"],
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const details = [stderr, result.error?.message, result.status !== 0 ? "exit code " + String(result.status) : null]
      .filter(Boolean)
      .join("\n");
    throw new Error(details || "Docker Compose runtime operation failed.");
  }
}

/**
 * Remove every container belonging to this checkout, including stopped ones.
 * Docker labels are the authoritative registry; no Compose manifest is needed
 * for teardown, so a changed or partially invalid contract cannot block down.
 * When `environment` is given, only that environment's containers are removed
 * (labels keep environments isolated even though each has its own stack).
 */
export async function removeProjectContainers(projectId: string, environment?: string): Promise<void> {
  const filters = ["label=pegas.project=" + projectId];
  if (environment) filters.push("label=pegas.environment=" + normalizeEnvironment(environment));
  const listed = child_process.execFileSync("docker", [
    "ps", "-aq", ...filters.flatMap((filter) => ["--filter", filter]),
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ids = listed.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) return;
  child_process.execFileSync("docker", ["rm", "-f", ...ids], {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
  });
}
