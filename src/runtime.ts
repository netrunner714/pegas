import child_process from "node:child_process";
import { PegasContract } from "./types.js";
import { createRuntimeCompose } from "./runtime-compose.js";
import { normalizeEnvironment } from "./contract.js";
import { ensureDockerNetwork, runCommand } from "./docker.js";
import { projectNetworkName } from "./naming.js";

export interface RuntimeLogOptions {
  service?: string;
  follow?: boolean;
  tail?: string | number;
}

/**
 * Follows service logs via an ephemeral Compose invocation. Ctrl+C (SIGINT) is
 * forwarded to Compose, which stops following but never touches the containers:
 * `logs` is read-only. Pegas itself exits cleanly afterwards.
 */
export async function followRuntimeLogs(
  contract: PegasContract,
  projectRoot: string,
  projectId: string,
  optionsOrEnv: RuntimeLogOptions | NodeJS.ProcessEnv = {},
  envArg: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const isEnv = (obj: any): obj is NodeJS.ProcessEnv =>
    obj &&
    (typeof obj.PATH === "string" || typeof obj.PEGAS_ENV === "string" || typeof obj.NODE_ENV === "string") &&
    !("follow" in obj) &&
    !("tail" in obj) &&
    !("service" in obj);

  const options: RuntimeLogOptions = isEnv(optionsOrEnv) ? {} : optionsOrEnv;
  const env: NodeJS.ProcessEnv = isEnv(optionsOrEnv) ? optionsOrEnv : envArg;

  const targetEnv = normalizeEnvironment(env.PEGAS_ENV || "development");
  const generated = createRuntimeCompose(contract, { projectRoot, projectId, environment: targetEnv });
  const tailArg = options.tail !== undefined ? String(options.tail) : "100";

  // Имя проекта берётся из манифеста, а не вычисляется заново (issue #27):
  // отдельный пересчёт при пустом PEGAS_ENV давал "development", тогда как
  // манифест брал scenarios[0] — имена расходились и контейнеры не находились.
  // Флаг оставлен явно — на старых версиях Compose `name:` из stdin-манифеста
  // мог игнорироваться.
  const args = [
    "compose",
    "--project-name",
    generated.composeProject,
    "--project-directory",
    projectRoot,
    "-f",
    "-",
    "logs",
  ];

  if (options.follow !== false) {
    args.push("--follow");
  }

  args.push("--tail", tailArg);

  if (options.service) {
    args.push(options.service);
  }

  await new Promise<void>((resolve, reject) => {
    const child = child_process.spawn("docker", args, {
      cwd: projectRoot,
      env: { ...env, PEGAS_ENV: targetEnv },
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
 * Миграция нейминга (issue #27): контейнеры, созданные схемой до 3.2.0,
 * принадлежат compose-проекту `${runtimeId}-${scenario}`. Новый deploy
 * поднимает проект `pegas-<проект>-<сценарий>-<runtimeId>`, и старые
 * контейнеры остались бы сиротами (compose --remove-orphans чужой проект
 * не видит). Снимаем их точечно: по метке compose-проекта старого имени
 * плюс pegas-меткам — чужие развёртывания не затрагиваются.
 */
export function removeLegacyComposeContainers(projectId: string, scenario: string): void {
  const legacyProject = `${projectId}-${scenario}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const filters = [
    `label=pegas.project=${projectId}`,
    `label=pegas.scenario=${scenario}`,
    `label=com.docker.compose.project=${legacyProject}`,
  ];
  let ids: string[] = [];
  try {
    const listed = child_process.execFileSync("docker", [
      "ps", "-aq", ...filters.flatMap((filter) => ["--filter", filter]),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    ids = listed.trim().split(/\s+/).filter(Boolean);
  } catch {
    // Docker недоступен — последующий compose up сообщит об этом явно.
    return;
  }
  if (ids.length === 0) return;
  child_process.execFileSync("docker", ["rm", "-f", ...ids], {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
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
  env: NodeJS.ProcessEnv = process.env,
  secretValues?: Record<string, string>
): Promise<void> {
  const generated = createRuntimeCompose(contract, { projectRoot, projectId, environment: env.PEGAS_ENV, secretValues });
  if (composeArgs[0] === "up") {
    const networkReady = await ensureDockerNetwork("pegas-network");
    if (!networkReady) {
      throw new Error("Could not create or inspect the shared Docker network 'pegas-network'.");
    }
    const projectNetwork = projectNetworkName({ runtimeId: projectId, scenario: generated.scenario });
    const projectNetworkReady = await ensureDockerNetwork(projectNetwork);
    if (!projectNetworkReady) {
      throw new Error(`Could not create or inspect project network '${projectNetwork}'.`);
    }
    // Одноразовая миграция со старой схемы имён: сироты старого compose-проекта
    // снимаются до up, чтобы новый проект занял их место без дублей.
    // Сценарий — из манифеста: при пустом PEGAS_ENV отдельное вычисление
    // давало "development" вместо scenarios[0] и чистило не тот проект.
    removeLegacyComposeContainers(projectId, generated.scenario);
  }

  // Имя проекта — из манифеста (issue #27): флаг и `name:` не могут разойтись.
  const args = ["compose", "--project-name", generated.composeProject, "--project-directory", projectRoot, "-f", "-", ...composeArgs];
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
  if (environment) filters.push("label=pegas.scenario=" + environment);
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

/**
 * Удаляет project-сети выбранного сценария (или все сети этого checkout'а).
 * Сеть удаляется только если из неё уже вышли все контейнеры; ошибки
 * игнорируются, чтобы down не падал из-за гонки с Docker.
 */
export async function removeProjectNetworks(projectId: string, environment?: string): Promise<string[]> {
  const prefix = `pegas-net-${projectId}-`;
  const listed = await runCommand("docker", ["network", "ls", "--format", "{{.Name}}"]);
  if (!listed.success) return [];
  const names = listed.stdout
    .split(/\s+/)
    .filter(Boolean)
    .filter((name) => name.startsWith(prefix))
    .filter((name) => environment === undefined || name === `${prefix}${environment}`);
  const removed: string[] = [];
  for (const name of names) {
    const res = await runCommand("docker", ["network", "rm", name]);
    if (res.success) removed.push(name);
  }
  return removed;
}
