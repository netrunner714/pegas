import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { PegasContract, ServiceContract } from "./types.js";
import { isProxyService, isInfraService } from "./compose.js";
import { VERSION, compareSemver } from "./version.js";

export const CONTRACT_FILENAME = "pegas.json";

/**
 * Canonical environment name: `dev` -> `development`, `prod` -> `production`,
 * anything else is lowercased as-is. One shared definition keeps Docker labels,
 * Compose project names, DNS aliases and route files consistent.
 */
export function normalizeEnvironment(env: string | undefined): string {
  const value = (env || "").trim().toLowerCase();
  if (!value) return "development";
  if (value === "dev") return "development";
  if (value === "prod") return "production";
  return value;
}

export interface ContractValidationIssue {
  path: string;
  message: string;
}

/**
 * Validates the opt-in Docker contract fields. Legacy host contracts remain
 * valid and are deliberately not subjected to new Docker-only requirements.
 */
export function validatePegasContract(value: unknown): ContractValidationIssue[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ path: "$", message: "Contract must be a JSON object." }];
  }

  const contract = value as Record<string, unknown>;
  const issues: ContractValidationIssue[] = [];
  const add = (field: string, message: string) => issues.push({ path: field, message });

  if (contract.runtime !== undefined && contract.runtime !== "host" && contract.runtime !== "docker") {
    add("runtime", 'Expected "host" or "docker".');
  }

  if (!contract.services || typeof contract.services !== "object" || Array.isArray(contract.services)) {
    add("services", "Expected an object containing service definitions.");
    return issues;
  }

  if (contract.runtime !== "docker") return issues;

  const services = contract.services as Record<string, unknown>;
  if (Object.keys(services).length === 0) add("services", "Docker runtime requires at least one service.");

  for (const [name, rawService] of Object.entries(services)) {
    const base = `services.${name}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
      add(base, "Service names must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens.");
    }
    if (!rawService || typeof rawService !== "object" || Array.isArray(rawService)) {
      add(base, "Expected a service object.");
      continue;
    }

    const service = rawService as Record<string, unknown>;
    if (service.domains !== undefined) {
      if (!service.domains || typeof service.domains !== "object" || Array.isArray(service.domains)) {
        add(`${base}.domains`, "Expected an object mapping environment names to domain arrays.");
      } else {
        for (const [environment, domains] of Object.entries(service.domains as Record<string, unknown>)) {
          if (!environment.trim() || !Array.isArray(domains) || domains.some((domain) => typeof domain !== "string" || !domain.trim())) {
            add(`${base}.domains.${environment}`, "Expected an array of non-empty domain strings.");
          }
        }
      }
    }

    if (service.port !== undefined) {
      const port = typeof service.port === "string" && String(Number(service.port)) === service.port ? Number(service.port) : service.port;
      if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) {
        add(`${base}.port`, "Expected a TCP port number between 1 and 65535.");
      }
    }
    if (service.upstream !== undefined && (typeof service.upstream !== "string" || !service.upstream.trim())) {
      add(`${base}.upstream`, "Expected a non-empty upstream target.");
    }

    if (service.build !== undefined && service.image !== undefined) {
      add(base, '"build" and "image" are mutually exclusive.');
    }

    if (service.build !== undefined) {
      if (!service.build || typeof service.build !== "object" || Array.isArray(service.build)) {
        add(`${base}.build`, "Expected an object with a context path.");
      } else {
        const build = service.build as Record<string, unknown>;
        if (typeof build.context !== "string" || !build.context.trim()) {
          add(`${base}.build.context`, "Expected a non-empty project-relative path.");
        } else if (path.isAbsolute(build.context) || path.win32.isAbsolute(build.context) ||
          path.posix.normalize(build.context).split("/").includes("..") ||
          path.win32.normalize(build.context).split(/[\\/]/).includes("..")) {
          add(`${base}.build.context`, "Build context must stay inside the project and cannot be absolute or traverse to a parent directory.");
        }
        if (build.dockerfile !== undefined) {
          if (typeof build.dockerfile !== "string" || !build.dockerfile.trim()) {
            add(`${base}.build.dockerfile`, "Expected a non-empty path.");
          } else if (path.isAbsolute(build.dockerfile) || path.win32.isAbsolute(build.dockerfile) ||
            path.posix.normalize(build.dockerfile).split("/").includes("..") ||
            path.win32.normalize(build.dockerfile).split(/[\\/]/).includes("..")) {
            add(`${base}.build.dockerfile`, "Dockerfile path must stay inside its build context.");
          }
        }
      }
    }

    if (service.image !== undefined && (typeof service.image !== "string" || !service.image.trim())) {
      add(`${base}.image`, "Expected a non-empty image reference.");
    }

    if (service.command !== undefined &&
      (!Array.isArray(service.command) || service.command.length === 0 ||
        service.command.some((part) => typeof part !== "string" || !part.trim()))) {
      add(`${base}.command`, "Expected a non-empty array of command strings.");
    }

    if (service.env !== undefined) {
      if (!service.env || typeof service.env !== "object" || Array.isArray(service.env)) {
        add(`${base}.env`, "Expected an object of non-secret string values.");
      } else {
        for (const [key, val] of Object.entries(service.env as Record<string, unknown>)) {
          if (!key.trim() || typeof val !== "string") add(`${base}.env.${key}`, "Environment keys and values must be strings.");
        }
      }
    }

    for (const field of ["envFile", "bindMount"] as const) {
      if (service[field] !== undefined) {
        const value = service[field];
        if (typeof value !== "string" || !value.trim()) {
          add(`${base}.${field}`, "Expected a non-empty path.");
        } else if (
          path.isAbsolute(value) || path.win32.isAbsolute(value) ||
          path.posix.normalize(value).split("/").includes("..") ||
          path.win32.normalize(value).split(/[\\/]/).includes("..")
        ) {
          add(`${base}.${field}`, field === "envFile"
            ? "Secret envFile must be a project-relative path."
            : "bindMount must be a project-relative path that stays inside the project.");
        }
      }
    }

    if (service.volumes !== undefined &&
      (!Array.isArray(service.volumes) || service.volumes.some((item) => typeof item !== "string" || !item.trim()))) {
      add(`${base}.volumes`, "Expected an array of non-empty volume specifications.");
    }

    if (service.role !== undefined && service.role !== "app" && service.role !== "infra") {
      add(`${base}.role`, 'Expected "app" or "infra".');
    }

    if (service.hmr !== undefined) {
      if (!service.hmr || typeof service.hmr !== "object" || Array.isArray(service.hmr)) {
        add(`${base}.hmr`, "Expected an object.");
      } else {
        const mode = (service.hmr as Record<string, unknown>).fileWatch;
        if (mode !== undefined && mode !== "auto" && mode !== "events" && mode !== "polling") {
          add(`${base}.hmr.fileWatch`, 'Expected "auto", "events", or "polling".');
        }
      }
    }
    if (service.dependsOn !== undefined) {
      const dependencyNames = Array.isArray(service.dependsOn)
        ? service.dependsOn
        : service.dependsOn && typeof service.dependsOn === "object"
          ? Object.keys(service.dependsOn as Record<string, unknown>)
          : null;
      if (!dependencyNames || dependencyNames.some((dependency) => typeof dependency !== "string" || !dependency.trim())) {
        add(`${base}.dependsOn`, "Expected an array of service names or a dependency map.");
      } else {
        for (const dependency of dependencyNames) {
          if (!Object.prototype.hasOwnProperty.call(services, dependency)) {
            add(`${base}.dependsOn`, `Unknown service dependency "${dependency}".`);
          }
        }
      }
      if (service.dependsOn && !Array.isArray(service.dependsOn) && typeof service.dependsOn === "object") {
        for (const [dependency, config] of Object.entries(service.dependsOn as Record<string, unknown>)) {
          if (!config || typeof config !== "object" || Array.isArray(config)) {
            add(`${base}.dependsOn.${dependency}`, "Expected a dependency configuration object.");
            continue;
          }
          const condition = (config as Record<string, unknown>).condition;
          if (condition !== undefined && !["service_started", "service_healthy", "service_completed_successfully"].includes(String(condition))) {
            add(`${base}.dependsOn.${dependency}.condition`, "Unsupported dependency condition.");
          }
        }
      }
    }

    if (service.healthcheck !== undefined) {
      const healthcheck = service.healthcheck as Record<string, unknown>;
      if (!healthcheck || typeof healthcheck !== "object" || Array.isArray(healthcheck)) {
        add(`${base}.healthcheck`, "Expected a healthcheck object.");
      } else {
        if (!Array.isArray(healthcheck.test) || healthcheck.test.length === 0 || healthcheck.test.some((item) => typeof item !== "string" || !item.trim())) {
          add(`${base}.healthcheck.test`, "Expected a non-empty command array.");
        }
        for (const field of ["interval", "timeout", "startPeriod"] as const) {
          if (healthcheck[field] !== undefined && (typeof healthcheck[field] !== "string" || !(healthcheck[field] as string).trim())) {
            add(`${base}.healthcheck.${field}`, "Expected a non-empty duration string.");
          }
        }
        if (healthcheck.retries !== undefined && (!Number.isInteger(healthcheck.retries) || Number(healthcheck.retries) < 1)) {
          add(`${base}.healthcheck.retries`, "Expected a positive integer.");
        }
      }
    }
  }

  return issues;
}

/**
 * Stable, checkout-specific identifier for Docker labels. It intentionally
 * differs between two clones with the same projectName, while remaining
 * stable across invocations from the same checkout.
 */
export function getProjectRuntimeId(projectRoot: string, projectName: string): string {
  const canonicalRoot = path.resolve(projectRoot);
  const digest = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 12);
  return `${slugify(projectName)}-${digest}`;
}

/**
 * Normalizes a domain name, stripping protocols, paths, query strings, and ports.
 * e.g. "https://my-domain.com:443/test" -> "my-domain.com"
 */
export function normalizeDomain(raw: string): string {
  let domain = raw.trim().toLowerCase();
  // Strip protocol (http:// or https://)
  domain = domain.replace(/^https?:\/\//, "");
  // Strip auth credentials (user:pass@)
  domain = domain.replace(/^.*@/, "");
  // Strip path, query, hash
  domain = domain.replace(/[/?#].*$/, "");
  // Strip port (:80, :443, etc.)
  domain = domain.replace(/:\d+$/, "");
  // Strip trailing dots
  domain = domain.replace(/\.+$/, "");
  return domain;
}

/**
 * Resolves the upstream target for a service (e.g. "web:3000").
 * Prefers explicit `upstream` if defined, otherwise constructs from `serviceName:port`.
 */
export function getServiceUpstream(serviceName: string, serviceConfig: ServiceContract): string {
  if (serviceConfig.upstream) return serviceConfig.upstream;
  const port = serviceConfig.port ?? 3000;
  return `${serviceName}:${port}`;
}

/**
 * Extracts numeric port from service configuration.
 */
export function getServicePort(serviceConfig: ServiceContract): number {
  if (serviceConfig.port !== undefined) {
    const p = typeof serviceConfig.port === "string" ? parseInt(serviceConfig.port, 10) : serviceConfig.port;
    if (!isNaN(p)) return p;
  }
  if (serviceConfig.upstream) {
    const match = serviceConfig.upstream.match(/:(\d+)$/);
    if (match) return parseInt(match[1], 10);
  }
  return 3000;
}

/**
 * Returns domains configured for the specified environment name,
 * with standard aliases (dev <-> development, prod <-> production).
 */
export function getEnvironmentDomains(
  serviceConfig: ServiceContract,
  env: string
): string[] {
  if (!serviceConfig.domains) return [];
  if (Array.isArray(serviceConfig.domains[env])) {
    return serviceConfig.domains[env]!;
  }
  if (env === "dev" && Array.isArray(serviceConfig.domains.development)) {
    return serviceConfig.domains.development!;
  }
  if (env === "development" && Array.isArray(serviceConfig.domains.dev)) {
    return serviceConfig.domains.dev!;
  }
  if (env === "prod" && Array.isArray(serviceConfig.domains.production)) {
    return serviceConfig.domains.production!;
  }
  if (env === "production" && Array.isArray(serviceConfig.domains.prod)) {
    return serviceConfig.domains.prod!;
  }
  return [];
}

/**
 * Lists all environment names configured in any service in the contract.
 */
export function listAvailableEnvironments(contract: PegasContract): string[] {
  const envs = new Set<string>();
  for (const sCfg of Object.values(contract.services || {})) {
    if (sCfg.domains) {
      for (const [env, domains] of Object.entries(sCfg.domains)) {
        if (Array.isArray(domains) && domains.length > 0) {
          envs.add(env);
        }
      }
    }
  }
  return Array.from(envs);
}

/**
 * Converts an Internationalized Domain Name (IDN) to its Punycode ASCII representation.
 * e.g. "россия.рф" -> "xn--h1alffa9f.xn--p1ai"
 */
export function toAsciiDomain(domain: string): string {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return domain;
  }
}

/**
 * Normalizes a project name into a clean, URL-safe slug containing only lowercase
 * alphanumeric characters and hyphens.
 */
export function slugify(name: string): string {
  const unscope = name.replace(/^@[^/]+\//, "");
  const slug = unscope
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}

/**
 * Detects the project name from package.json or the current directory name,
 * returning a normalized slug.
 */
export async function detectProjectSlug(projectDir: string): Promise<string> {
  const pkgPath = path.join(projectDir, "package.json");
  try {
    const raw = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    if (pkg.name && typeof pkg.name === "string" && pkg.name.trim()) {
      return slugify(pkg.name.trim());
    }
  } catch {}

  const dirName = path.basename(path.resolve(projectDir));
  return slugify(dirName);
}

/**
 * Inspects any existing compose file in projectDir to detect the primary web service name and port.
 */
export async function detectComposeWebService(
  projectDir: string
): Promise<{ name: string; port: string } | null> {
  const composeFiles = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ];

  for (const f of composeFiles) {
    try {
      const content = await fs.readFile(path.join(projectDir, f), "utf-8");
      const normalized = content.replace(/\r\n/g, "\n");
      const lines = normalized.split("\n");

      interface ParsedSvc {
        name: string;
        lines: string[];
        ports: string[];
        envPort?: string;
      }

      const services: ParsedSvc[] = [];
      let inServices = false;
      let serviceIndent: number | null = null;
      let currentSvc: ParsedSvc | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        const indent = line.search(/\S/);

        if (indent === 0 && /^services:\s*$/.test(line)) {
          inServices = true;
          continue;
        }

        if (indent === 0 && inServices && /^[a-zA-Z0-9_-]+:\s*$/.test(line)) {
          if (currentSvc) {
            services.push(currentSvc);
            currentSvc = null;
          }
          break;
        }

        if (inServices) {
          if (serviceIndent === null && indent > 0 && /^[a-zA-Z0-9._-]+:\s*$/.test(trimmed)) {
            serviceIndent = indent;
          }

          if (serviceIndent !== null && indent === serviceIndent && /^[a-zA-Z0-9._-]+:\s*$/.test(trimmed)) {
            if (currentSvc) {
              services.push(currentSvc);
            }
            currentSvc = {
              name: trimmed.replace(/:\s*$/, ""),
              lines: [],
              ports: [],
            };
            continue;
          }

          if (currentSvc) {
            currentSvc.lines.push(line);
            if (/^\s*-\s*["']?\d+/.test(line)) {
              currentSvc.ports.push(trimmed);
            }
            const portEnvMatch =
              trimmed.match(/^-\s*PORT\s*=\s*["']?(\d+)["']?/i) ||
              trimmed.match(/^PORT\s*:\s*["']?(\d+)["']?/i);
            if (portEnvMatch) {
              currentSvc.envPort = portEnvMatch[1];
            }
          }
        }
      }

      if (currentSvc) {
        services.push(currentSvc);
      }

      // Filter out proxies and infra
      const candidates = services.filter(
        (s) => !isProxyService(s.name, s.lines) && !isInfraService(s.name, s.lines)
      );

      if (candidates.length === 0) continue;

      // Prefer candidate matching standard web names: web, app, site, frontend, etc.
      const preferredNames = ["web", "app", "site", "frontend", "server", "backend"];
      let chosen = candidates.find((c) => preferredNames.includes(c.name.toLowerCase()));
      if (!chosen) {
        // Otherwise prefer one with ports
        chosen = candidates.find((c) => c.ports.length > 0) || candidates[0];
      }

      let port = "3000";
      if (chosen.ports.length > 0) {
        const clean = chosen.ports[0].replace(/['"]/g, "").trim();
        const portMatch = clean.match(/:(\d+)$/) || clean.match(/(\d+)$/);
        if (portMatch) port = portMatch[1];
      } else if (chosen.envPort) {
        port = chosen.envPort;
      }

      return { name: chosen.name, port };
    } catch {}
  }

  return null;
}

/**
 * Generates the standard default Pegas contract for a given project slug.
 *
 * Dev-домены следуют стандарту `[service].[project].localhost` с алиасом
 * `[project].localhost` для основного сервиса. Порты dev-шлюза по умолчанию —
 * стандартные 443/80 (чистые URL без `:порт` в браузере).
 */
export function createDefaultContract(
  slug: string,
  serviceName = "web",
  port: number | string = 3000
): PegasContract {
  const portNum = typeof port === "string" ? parseInt(port, 10) || 3000 : port;
  return {
    projectName: slug,
    devGateway: {
      httpPort: 80,
      httpsPort: 443,
      skipInstallTrust: false,
      admin: false,
    },
    services: {
      [serviceName]: {
        port: portNum,
        domains: {
          development: [`${serviceName}.${slug}.localhost`, `${slug}.localhost`],
          stage: [`stage.${slug}.com`],
          production: [`${slug}.com`],
        },
      },
    },
  };
}

/**
 * Safely reconciles an existing contract with default contract schema,
 * filling in missing standard blocks (e.g. devGateway) without overwriting
 * or modifying user-configured domains, ports, services, or custom fields.
 */
export function reconcileContract(
  existing: any,
  defaultContract: PegasContract
): { contract: PegasContract; addedFields: string[] } {
  const addedFields: string[] = [];
  const result: any = { ...existing };

  if (!result.projectName && defaultContract.projectName) {
    result.projectName = defaultContract.projectName;
    addedFields.push("projectName");
  }

  if (!result.devGateway && defaultContract.devGateway) {
    result.devGateway = { ...defaultContract.devGateway };
    addedFields.push("devGateway");
  } else if (result.devGateway && defaultContract.devGateway) {
    let subAdded = false;
    for (const [key, val] of Object.entries(defaultContract.devGateway)) {
      if (result.devGateway[key] === undefined) {
        result.devGateway[key] = val;
        subAdded = true;
      }
    }
    if (subAdded) {
      addedFields.push("devGateway");
    }
  }

  if (!result.services || Object.keys(result.services).length === 0) {
    result.services = { ...defaultContract.services };
    addedFields.push("services");
  }

  return { contract: result as PegasContract, addedFields };
}

export const DEFAULT_CONTRACT: PegasContract = createDefaultContract("app", "web", 3000);

export async function setupProjectContract(
  projectDir: string,
  dryRun = false,
  force = false,
  runtime: "host" | "docker" | undefined = undefined
): Promise<{
  created: boolean;
  overwritten?: boolean;
  updated?: boolean;
  addedFields?: string[];
  backupFile?: string;
  file: string;
  slug: string;
  contract?: PegasContract;
  dockerOptInRequired?: boolean;
}> {
  const existingJsonLike = (content: string | null): PegasContract | undefined => {
    try { return content ? JSON.parse(content) as PegasContract : undefined; } catch { return undefined; }
  };
  const contractPath = path.join(projectDir, CONTRACT_FILENAME);
  const backupPath = path.join(projectDir, `${CONTRACT_FILENAME}.bak`);
  const slug = await detectProjectSlug(projectDir);

  const detected = await detectComposeWebService(projectDir);
  const serviceName = detected?.name || "web";
  const port = detected?.port || "3000";
  const defaultContract = createDefaultContract(slug, serviceName, port);

  let existingContent: string | null = null;
  try {
    existingContent = await fs.readFile(contractPath, "utf-8");
  } catch {}

  const exists = existingContent !== null;

  if (exists && force) {
    const resetContract = runtime === "docker"
      ? { ...defaultContract, runtime: "docker" as const }
      : defaultContract;
    if (!dryRun) {
      await fs.copyFile(contractPath, backupPath);
      await fs.writeFile(
        contractPath,
        JSON.stringify(resetContract, null, 2) + "\n",
        "utf-8"
      );
    }
    return {
      created: false,
      overwritten: true,
      backupFile: `${CONTRACT_FILENAME}.bak`,
      file: CONTRACT_FILENAME,
      slug,
      contract: resetContract,
    };
  }

  // Explicit opt-in on an existing contract is a user decision: init reports it
  // as a notice instead of silently rewriting pegas.json.
  if (exists && !force && runtime === "docker") {
    const existingRuntime = (() => { try { return JSON.parse(existingContent!).runtime; } catch { return undefined; } })();
    if (existingRuntime !== "docker") {
      return {
        created: false,
        updated: false,
        file: CONTRACT_FILENAME,
        slug,
        contract: existingJsonLike(existingContent),
        dockerOptInRequired: true,
      };
    }
  }

  if (exists && !force) {
    try {
      const existingJson = JSON.parse(existingContent!);
      const { contract: reconciled, addedFields } = reconcileContract(existingJson, defaultContract);

      if (addedFields.length > 0) {
        if (!dryRun) {
          await fs.writeFile(
            contractPath,
            JSON.stringify(reconciled, null, 2) + "\n",
            "utf-8"
          );
        }
        return {
          created: false,
          updated: true,
          addedFields,
          file: CONTRACT_FILENAME,
          slug,
          contract: reconciled,
        };
      }

      return {
        created: false,
        updated: false,
        file: CONTRACT_FILENAME,
        slug,
        contract: existingJson,
      };
    } catch {
      return { created: false, updated: false, file: CONTRACT_FILENAME, slug };
    }
  }

  const newContract = runtime === "docker" ? { ...defaultContract, runtime: "docker" as const } : defaultContract;
  if (!dryRun) {
    await fs.writeFile(
      contractPath,
      JSON.stringify(newContract, null, 2) + "\n",
      "utf-8"
    );
  }
  return { created: true, file: CONTRACT_FILENAME, slug, contract: newContract };
}

export async function updatePackageJson(
  projectDir: string,
  dryRun = false,
  runtime?: "host" | "docker"
): Promise<string[]> {
  const actions: string[] = [];
  const pkgPath = path.join(projectDir, "package.json");

  try {
    const raw = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);

    if (!pkg.scripts) {
      pkg.scripts = {};
    }

    // Host runtime wraps the user command. Docker runtime keeps the real app command
    // untouched because it is executed inside the service container.
    if (runtime === "docker") {
      if (typeof pkg.scripts.dev === "string" && pkg.scripts.dev.startsWith("pegas dev -- ")) {
        pkg.scripts.dev = pkg.scripts.dev.replace(/^pegas dev --\s*/, "");
        actions.push("Восстановлен исходный dev-скрипт для запуска внутри Docker");
      } else if (pkg.scripts.dev === "pegas dev") {
        delete pkg.scripts.dev;
        actions.push("Удалён host-wrapper dev-скрипта; Docker runtime использует command из pegas.json или package.json");
      }
    } else if (pkg.scripts.dev) {
      if (!pkg.scripts.dev.includes("pegas dev")) {
        const cleanDev = pkg.scripts.dev.replace(/^pegas up --env development --\s*/, "");
        pkg.scripts.dev = "pegas dev -- " + cleanDev;
        actions.push("Обновлён скрипт 'dev' в package.json: обёрнут в 'pegas dev --'");
      }
    } else {
      pkg.scripts.dev = "pegas dev";
      actions.push("Добавлен скрипт 'dev': 'pegas dev' в package.json");
    }
    // 2. Add deploy script
    if (!pkg.scripts.deploy || !pkg.scripts.deploy.includes("pegas deploy")) {
      pkg.scripts.deploy = "pegas deploy production";
      actions.push("Добавлен скрипт 'deploy': 'pegas deploy production' в package.json");
    }

    // 3. Add pegas to devDependencies if missing (init does not bump version automatically)
    if (!pkg.devDependencies) {
      pkg.devDependencies = {};
    }
    const currentDep = pkg.devDependencies["@netrunner714/pegas"] || pkg.devDependencies.pegas;
    const targetDep = `^${VERSION}`;

    if (!currentDep) {
      pkg.devDependencies["@netrunner714/pegas"] = targetDep;
      actions.push(`Добавлен '@netrunner714/pegas' (${targetDep}) в devDependencies в package.json`);
    }

    if (actions.length > 0 && !dryRun) {
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    }
  } catch {}

  return actions;
}

/**
 * Upgrades the @netrunner714/pegas dependency in package.json to the target version.
 * Called explicitly by `pegas update`.
 */
export async function upgradePackageJson(
  projectDir: string,
  targetVersion: string,
  dryRun = false
): Promise<{ updated: boolean; oldVersion: string; newVersion: string }> {
  const pkgPath = path.join(projectDir, "package.json");
  const raw = await fs.readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(raw);
  if (!pkg.devDependencies) {
    pkg.devDependencies = {};
  }

  const current = pkg.devDependencies["@netrunner714/pegas"] || pkg.devDependencies.pegas || "";
  const cleanTarget = targetVersion.replace(/^[^0-9]*/, "");
  const targetDep = `^${cleanTarget}`;

  pkg.devDependencies["@netrunner714/pegas"] = targetDep;
  if (pkg.devDependencies.pegas && pkg.devDependencies["@netrunner714/pegas"]) {
    delete pkg.devDependencies.pegas;
  }

  if (!dryRun) {
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  }

  return { updated: true, oldVersion: current, newVersion: targetDep };
}
