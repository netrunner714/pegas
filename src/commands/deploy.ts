import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import { findProjectRoot, findGatewayDir, getProjectRouteFilePath, getConfDir } from "../gateway.js";
import { CONTRACT_FILENAME, normalizeDomain, getEnvironmentDomains, getProjectRuntimeId, validatePegasContract } from "../contract.js";
import { PegasContract } from "../types.js";
import { parseCaddyProjectFile } from "./status.js";
import { validateDomains } from "../dns.js";
import { runRuntimeCompose } from "../runtime.js";
import { createRuntimeCompose } from "../runtime-compose.js";
import { ensureGatewayContainer, stopGatewayIfUnused } from "../docker.js";
import { withRuntimeLock } from "../runtime-lock.js";

/** Аргументы compose up для деплоя: --build обязателен — исходники меняются чаще контракта. */
export const DEPLOY_COMPOSE_ARGS = ["up", "-d", "--build", "--remove-orphans"] as const;
import { parseEnvContent, verifySecrets } from "../secrets.js";
import {
  classifySharedImage,
  createSharedInfraDeps,
  ensureSharedPool,
  provisionSharedTenant,
  sharedPoolKey,
  waitForSharedPoolReady,
  type SharedInfraDeps,
} from "../shared-infra.js";

export interface DeployOptions {
  scenario?: string;
  /**
   * Рид-онли валидация сценария без мутаций Docker: контракт → секреты → DNS
   * (не-strict) → генерация манифеста → `docker compose config -q` → план
   * (сервисы, маршруты). Контейнеры не создаются, маршруты не пишутся.
   */
  dryRun?: boolean;
  gatewayDir?: string;
  skipUp?: boolean;
  skipReadiness?: boolean;
  readinessTimeoutMs?: number;
  gracePeriodMs?: number;
  strictDns?: boolean;
  skipDnsCheck?: boolean;
  serverIp?: string;
  json?: boolean;
  cwd?: string;
  noExit?: boolean;
}

export interface ReadinessResult {
  ready: boolean;
  service: string;
  reason?: string;
  containerId?: string;
}

/**
 * Polls container status until running and healthy, preventing 502 Bad Gateway
 * errors during deployments before Caddy routes traffic to the container.
 */
export async function waitForContainerReadiness(
  projectRoot: string,
  serviceName: string,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    gracePeriodMs?: number;
    composeFile?: string;
    projectId?: string;
    environment?: string;
  } = {}
): Promise<ReadinessResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const defaultGrace = process.env.PEGAS_DEPLOY_GRACE_MS !== undefined
    ? parseInt(process.env.PEGAS_DEPLOY_GRACE_MS, 10)
    : 3000;
  const gracePeriodMs = options.gracePeriodMs ?? defaultGrace;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let containerId = "";
    try {
      const dockerArgs = options.projectId
        ? ["ps", "-q", "--filter", `label=pegas.project=${options.projectId}`, "--filter", `label=pegas.scenario=${options.environment || "development"}`, "--filter", `label=pegas.service=${serviceName}`]
        : [
            "compose",
            ...(options.composeFile
              ? ["--project-directory", projectRoot, "-f", options.composeFile]
              : []),
            "ps", "-q", serviceName,
          ];

      const psRes = child_process.execFileSync(
        "docker",
        dockerArgs,
        { cwd: projectRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000 }
      );
      containerId = psRes.trim().split("\n")[0]?.trim();
    } catch {}

    if (!containerId) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }

    try {
      const inspectRes = child_process.execFileSync(
        "docker",
        ["inspect", containerId],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
      );
      const inspectData = JSON.parse(inspectRes);
      if (Array.isArray(inspectData) && inspectData.length > 0) {
        const state = inspectData[0].State;
        if (state) {
          const status = state.Status?.toLowerCase();

          if (status === "exited" || status === "dead") {
            return {
              ready: false,
              service: serviceName,
              containerId,
              reason: `Container exited unexpectedly (exit code ${state.ExitCode})`,
            };
          }

          if (status === "running") {
            if (state.Health) {
              const healthStatus = state.Health.Status?.toLowerCase();
              if (healthStatus === "healthy") {
                return { ready: true, service: serviceName, containerId };
              }
              if (healthStatus === "unhealthy") {
                return {
                  ready: false,
                  service: serviceName,
                  containerId,
                  reason: `Container healthcheck failed: status is '${state.Health.Status}'`,
                };
              }
            } else {
              if (gracePeriodMs > 0) {
                await new Promise((r) => setTimeout(r, gracePeriodMs));
              }
              return { ready: true, service: serviceName, containerId };
            }
          }
        }
      }
    } catch {}

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return {
    ready: false,
    service: serviceName,
    reason: `Timed out waiting for service '${serviceName}' to become ready after ${timeoutMs / 1000}s`,
  };
}

export function resolveScopedUpstream(upstream: string, projectName: string): string {
  const parts = upstream.split(":");
  const host = parts[0];
  const port = parts[1] || "3000";

  if (!host) return upstream;
  if (host.startsWith(`${projectName}-`)) return upstream;
  if (host === "localhost" || host === "127.0.0.1" || /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return upstream;
  return `${projectName}-${host}:${port}`;
}

/**
 * Разделяемые пулы сценария (issue #29): поднимает инстансы и готовит арендаторов
 * до compose up, чтобы pegas:// в манифесте уже указывал на живой пул.
 * Идемпотентно; секреты читаются из .env в память и никуда не записываются.
 */
async function ensureSharedPoolsForDeploy(args: {
  contract: PegasContract;
  projectRoot: string;
  projectName: string;
  runtimeId: string;
  env: string;
  deps?: SharedInfraDeps;
}): Promise<void> {
  const { contract, projectRoot, projectName, runtimeId, env } = args;
  const deps = args.deps ?? createSharedInfraDeps();
  const sharedServices = Object.entries(contract.services ?? {}).filter(
    ([, svc]) => svc.scope?.[env] === "shared"
  );
  if (sharedServices.length === 0) return;
  let envValues = new Map<string, string>();
  try {
    envValues = parseEnvContent(await fs.readFile(path.join(projectRoot, ".env"), "utf-8"));
  } catch {}
  for (const [serviceName, svc] of sharedServices) {
    const tenant = svc.shared?.[env];
    if (!tenant) throw new Error(`services.${serviceName}: scope: "shared" требует shared в сценарии "${env}".`);
    const profile = classifySharedImage(svc.image?.[env]);
    if (!profile) throw new Error(`services.${serviceName}: образ не является поддерживаемой разделяемой инфраструктурой.`);
    const port = svc.port?.[env];
    const ensured = await ensureSharedPool(deps, {
      profile,
      scenario: env,
      publishHostPort: env === "development",
      ...(typeof port === "number" ? { hostPort: port, port } : {}),
    });
    if (ensured.created) await waitForSharedPoolReady(deps, profile, env);
    const secretValue = tenant.secret ? envValues.get(tenant.secret) : undefined;
    await provisionSharedTenant(
      deps,
      sharedPoolKey(profile, env),
      profile,
      env,
      { project: runtimeId, projectName, scenario: env, service: serviceName, name: tenant.name },
      tenant,
      secretValue
    );
  }
}

async function handleDeployUnlocked(options: DeployOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd || process.cwd();
  const rawScenario = options.scenario;
  if (!rawScenario) {
    const errorMsg = "Scenario is required for deploy. Option -s or --scenario is missing.";
    if (isJson) console.log(JSON.stringify({ error: errorMsg }));
    else {
      console.error(`❌ Error: ${errorMsg}`);
      console.error("   Usage: pegas deploy -s <scenario>");
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  const env = rawScenario;

  const projectRoot = (await findProjectRoot(cwd)) || cwd;
  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);
  let rawContract: string;
  try {
    rawContract = await fs.readFile(contractPath, "utf-8");
  } catch {
    if (isJson) console.log(JSON.stringify({ error: `Contract '${CONTRACT_FILENAME}' not found. Run 'pegas init' first.` }));
    else {
      console.error(`❌ Error: Contract '${CONTRACT_FILENAME}' not found in project root (${projectRoot}).`);
      console.error("   Run 'pegas init' to generate it.");
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  let contract: PegasContract;
  try {
    contract = JSON.parse(rawContract);
  } catch (err: any) {
    if (isJson) console.log(JSON.stringify({ error: `Failed to parse '${path.basename(contractPath)}': Invalid JSON syntax.`, details: err.message }));
    else {
      console.error(`❌ Error: Failed to parse '${path.basename(contractPath)}': Invalid JSON syntax.`);
      console.error(`   ${err.message}`);
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  const contractIssues = validatePegasContract(contract);
  if (contractIssues.length > 0) {
    const details = contractIssues.map((issue) => `${issue.path}: ${issue.message}`);
    if (isJson) console.log(JSON.stringify({ error: "Invalid Pegas contract", details }));
    else {
      console.error("❌ Invalid Pegas contract:");
      for (const detail of details) console.error(`  - ${detail}`);
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  const secretsCheck = await verifySecrets(projectRoot, contract);
  if (!secretsCheck.valid) {
    if (isJson) console.log(JSON.stringify({ error: "Secrets verification failed", details: secretsCheck.errors }));
    else {
      console.error("❌ Secrets verification failed:");
      for (const err of secretsCheck.errors) console.error(`  - ${err}`);
    }
    if (!options.noExit) process.exit(1);
    return;
  }

  const projectName = contract.projectName || path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  const runtimeId = getProjectRuntimeId(projectRoot, projectName);
  let secretValues: Record<string, string> = {};
  try {
    secretValues = Object.fromEntries(parseEnvContent(await fs.readFile(path.join(projectRoot, ".env"), "utf-8")));
  } catch {}
  const gatewayDir = await findGatewayDir(options.gatewayDir);
  const confDir = getConfDir(gatewayDir);
  await fs.mkdir(confDir, { recursive: true });

  const strictDns = options.strictDns ?? false;
  const skipDnsCheck = options.skipDnsCheck ?? false;
  const skipReadiness = options.skipReadiness ?? false;

  const requestedDomains: string[] = [];
  for (const [, serviceConfig] of Object.entries(contract.services || {})) {
    for (const d of getEnvironmentDomains(serviceConfig, env)) {
      const norm = normalizeDomain(d);
      if (norm && norm !== "yourdomain.com") {
        if (!requestedDomains.includes(norm)) requestedDomains.push(norm);
        const parts = norm.split(".");
        if (!norm.startsWith("www.") && parts.length === 2 && !requestedDomains.includes(`www.${norm}`)) {
          requestedDomains.push(`www.${norm}`);
        }
      }
    }
  }

  // Проект может не иметь HTTP-доменов вовсе: внутренние сервисы (egress-прокси,
  // очереди) живут только в pegas-network. Маршруты шлюза им не нужны.
  const hasDomains = requestedDomains.length > 0;
  if (!hasDomains && !isJson) {
    console.log(`\nℹ️  Сценарий '${env}' без HTTP-доменов: только внутренние сервисы, маршруты шлюза не нужны.`);
  }

  const projectRouteFile = getProjectRouteFilePath(gatewayDir, projectName, env);
  const currentProjectFileName = path.basename(projectRouteFile);

  try {
    const existingFiles = await fs.readdir(confDir);
    for (const file of existingFiles) {
      if (!file.endsWith(".caddy") || file === currentProjectFileName) continue;
      const otherContent = await fs.readFile(path.join(confDir, file), "utf-8");
      const otherRoutes = parseCaddyProjectFile(otherContent, file);
      for (const route of otherRoutes) {
        // Never treat this project's own (other-environment) routes as conflicts.
        if (route.projectName === projectName) continue;
        for (const claimedDomain of route.domains) {
          if (requestedDomains.includes(claimedDomain)) {
            const conflictErr = `Domain '${claimedDomain}' is already owned by project '${route.projectName}' (in ${file}).`;
            if (isJson) console.log(JSON.stringify({ error: "Domain collision", domain: claimedDomain, ownerProject: route.projectName, ownerFile: file }));
            else {
              console.error(`\n❌ Error: ${conflictErr}`);
              console.error("   Deploy aborted to prevent route hijacking.");
            }
            if (!options.noExit) process.exit(1);
            return;
          }
        }
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {}
  }

  if (!skipDnsCheck && requestedDomains.length > 0) {
    const dnsResult = await validateDomains(requestedDomains, {
      skipDnsCheck, strictDns, serverIp: options.serverIp, json: isJson, noExit: options.noExit,
    });
    if (!dnsResult.valid && strictDns) {
      if (isJson) console.log(JSON.stringify({ error: "Strict DNS validation failed", warnings: dnsResult.warnings, serverIp: dnsResult.serverIp }));
      if (!options.noExit) process.exit(1);
      return;
    }
  }

  if (options.dryRun) {
    // Рид-онли валидация: манифест сценария прогоняется через docker compose config -q
    // (валидация синтаксиса/интерполяции без создания контейнеров), затем печатается план.
    const generated = createRuntimeCompose(contract, {
      projectRoot,
      projectId: runtimeId,
      environment: env,
      secretValues,
    });
    // issue #27: имя compose-проекта — из генератора манифеста (единый источник
    // истины; отдельное вычисление `${runtimeId}-${env}` расходилось с ним).
    const composeProject = generated.composeProject;
    const configArgs = [
      "compose", "--project-name", composeProject,
      "--project-directory", projectRoot,
      "-f", "-", "config", "-q",
    ];
    const result = child_process.spawnSync("docker", configArgs, {
      cwd: projectRoot,
      input: generated.content,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      const details = (result.stderr ?? "").trim() || result.error?.message || "docker compose config failed";
      if (isJson) console.log(JSON.stringify({ status: "invalid", env, details }));
      else {
        console.error(`❌ Docker Compose validation failed for scenario '${env}':
   ${details.split("\n").join("\n   ")}`);
      }
      if (!options.noExit) process.exit(1);
      return;
    }

    // План: docker-сервисы манифеста + host-сервисы (не попадают в манифест) + маршруты.
    const dockerServices = Object.keys((generated.manifest as any).services ?? {});
    const hostServices = Object.entries(contract.services ?? {})
      .filter(([, svc]) => {
        const rt = (svc as any).runtime?.[env];
        return rt && rt.driver !== "docker";
      })
      .map(([name]) => name);
    // issue #27: имена контейнеров читаемы — показываем их в плане, чтобы агент
    // заранее видел, как сервисы будут называться в `docker ps`.
    const containerNames: Record<string, string> = {};
    for (const [svcName, svcDef] of Object.entries<any>((generated.manifest as any).services ?? {})) {
      if (svcDef?.container_name) containerNames[svcName] = svcDef.container_name;
    }
    if (isJson) {
      console.log(JSON.stringify({
        status: "valid",
        env,
        project: projectName,
        composeProject,
        dockerServices,
        containerNames,
        hostServices,
        domains: requestedDomains,
      }));
    } else {
      console.log(`\n🧪 Dry-run: сценарий '${env}' проекта '${projectName}' валиден (docker compose config -q прошёл).\n`);
      console.log(`   Compose-проект: ${composeProject}`);
      console.log(`   Docker-сервисы (поднимутся): ${dockerServices.length > 0 ? dockerServices.join(", ") : "—"}`);
      if (dockerServices.length > 0) {
        console.log(`   Имена контейнеров: ${dockerServices.map((s) => containerNames[s] ?? s).join(", ")}`);
      }
      if (hostServices.length > 0) console.log(`   Host-сервисы (вне манифеста, запускает разработчик): ${hostServices.join(", ")}`);
      console.log(`   Домены: ${requestedDomains.join(", ")}`);
      console.log(`   Секреты (имена, не значения): ${Object.values(contract.services ?? {}).flatMap((s: any) => s.secrets ?? []).join(", ") || "—"}`);
      console.log(`\nℹ️  Ничего не изменено: контейнеры не созданы, маршруты не записаны.`);
    }
    return;
  }

  if (!options.skipUp) {
    if (!isJson) console.log(`\n🚀 [1/3] Starting project containers for scenario '${env}'...`);
    const primaryDomain = requestedDomains[0] || "";
    const deployEnv = {
      ...process.env,
      NODE_ENV: rawScenario === "development" ? "development" : "production",
      ...(primaryDomain ? { APP_DOMAIN: primaryDomain } : {}),
    };
    let gatewayPrepared = false;
    try {
      // Verify/start the shared edge before mutating the application stack.
      // A port conflict must fail before any project service is started.
      const gatewayResult = await ensureGatewayContainer(gatewayDir);
      if (!gatewayResult.success) throw new Error(gatewayResult.stderr || "Failed to ensure shared Gateway.");
      gatewayPrepared = true;
      // issue #29: разделяемые пулы живут вне compose-проекта и должны быть
      // готовы до up — потребители резолвят pegas:// на алиас пула.
      await ensureSharedPoolsForDeploy({ contract, projectRoot, projectName, runtimeId, env });
      // v3: манифест содержит только driver:"docker"-сервисы сценария; host-сервисы не поднимаем
      await runRuntimeCompose(contract, projectRoot, runtimeId, [...DEPLOY_COMPOSE_ARGS], { ...deployEnv, PEGAS_ENV: rawScenario }, secretValues);
    } catch (err: any) {
      if (gatewayPrepared) {
        // Do not leave an otherwise unused shared Gateway running after a failed first deploy.
        await stopGatewayIfUnused(gatewayDir).catch(() => {});
      }
      const message = "Failed to apply the declarative Docker runtime";
      if (isJson) console.log(JSON.stringify({ error: message, details: err.message }));
      else console.error(`❌ Error: ${message}:`, err.message);
      if (!options.noExit) process.exit(1);
      return;
    }

    if (!skipReadiness) {
      // issue #23: readiness проверяет только контейнерные сервисы — манифест
      // поднимает лишь driver:"docker"; host-сервис (bun) контейнера не имеет и
      // ждать его deploy не может (маршруты host-сервисов — зона pegas connect).
      const servicesToCheck: string[] = [];
      for (const [sName, sCfg] of Object.entries(contract.services || {})) {
        if (getEnvironmentDomains(sCfg, env).length > 0 && (sCfg.runtime?.[env]?.driver ?? "docker") !== "bun") {
          servicesToCheck.push(sName);
        }
      }
      if (servicesToCheck.length > 0) {
        if (!isJson) console.log(`\n⏳ Checking container readiness for: ${servicesToCheck.join(", ")}...`);
        for (const sName of servicesToCheck) {
          const checkRes = await waitForContainerReadiness(projectRoot, sName, {
            timeoutMs: options.readinessTimeoutMs,
            gracePeriodMs: options.gracePeriodMs,
            projectId: runtimeId,
            environment: env,
          });
          if (!checkRes.ready) {
            const errMsg = `Service '${sName}' failed readiness check: ${checkRes.reason}`;
            if (isJson) console.log(JSON.stringify({ error: errMsg, service: sName, reason: checkRes.reason }));
            else {
              console.error(`\n❌ Error: ${errMsg}`);
              console.error("   Deployment aborted before updating Caddy routes.");
            }
            await stopGatewayIfUnused(gatewayDir).catch(() => {});
            if (!options.noExit) process.exit(1);
            return;
          }
          if (!isJson) console.log(`  🟢 Service '${sName}' is ready to accept traffic`);
        }
      }
    }
  }

  // Маршруты — зона pegas connect. Deploy только поднимает docker-сервисы
  // сценария; файлы conf.d он не пишет и не удаляет.
  if (isJson) {
    console.log(JSON.stringify({
      status: "success",
      env,
      project: projectName,
      containers: Object.keys(createRuntimeCompose(contract, { projectRoot, projectId: runtimeId, environment: env, secretValues }).manifest.services ?? {}),
      routes: "managed by pegas connect",
    }));
    return;
  }
  console.log(`\n🎉 Project '${projectName}' [${env}] containers are up.`);
  console.log(`   Routes are managed by connect: pegas connect -s ${env}\n`);
}

export async function handleDeploy(options: DeployOptions = {}): Promise<void> {
  return withRuntimeLock(() => handleDeployUnlocked(options));
}
