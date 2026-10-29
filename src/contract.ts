import fs from "node:fs/promises";
import path from "node:path";
import { PegasContract, ServiceContract } from "./types.js";
import { isProxyService, isInfraService } from "./compose.js";
import { VERSION, compareSemver } from "./version.js";

export const CONTRACT_FILENAME = "pegas.json";

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
      httpPort: 8080,
      httpsPort: 8443,
      skipInstallTrust: true,
      admin: false,
    },
    services: {
      [serviceName]: {
        port: portNum,
        domains: {
          development: [`${slug}.localhost`],
          stage: [`stage.${slug}.com`],
          production: [`${slug}.com`],
        },
      },
    },
  };
}

export const DEFAULT_CONTRACT: PegasContract = createDefaultContract("app", "web", 3000);

export async function setupProjectContract(
  projectDir: string,
  dryRun = false
): Promise<{ created: boolean; file: string; slug: string; contract?: PegasContract }> {
  const contractPath = path.join(projectDir, CONTRACT_FILENAME);
  const slug = await detectProjectSlug(projectDir);

  try {
    await fs.access(contractPath);
    return { created: false, file: CONTRACT_FILENAME, slug };
  } catch {
    const detected = await detectComposeWebService(projectDir);
    const serviceName = detected?.name || "web";
    const port = detected?.port || "3000";

    const defaultContract = createDefaultContract(slug, serviceName, port);
    if (!dryRun) {
      await fs.writeFile(
        contractPath,
        JSON.stringify(defaultContract, null, 2) + "\n",
        "utf-8"
      );
    }
    return { created: true, file: CONTRACT_FILENAME, slug, contract: defaultContract };
  }
}

export async function updatePackageJson(
  projectDir: string,
  dryRun = false
): Promise<string[]> {
  const actions: string[] = [];
  const pkgPath = path.join(projectDir, "package.json");

  try {
    const raw = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);

    if (!pkg.scripts) {
      pkg.scripts = {};
    }

    // 1. Update dev script with pegas wrapper
    if (pkg.scripts.dev) {
      if (!pkg.scripts.dev.includes("pegas up") && !pkg.scripts.dev.includes("pegas dev")) {
        pkg.scripts.dev = `pegas up --env development -- ${pkg.scripts.dev}`;
        actions.push("Обновлён скрипт 'dev' в package.json: обёрнут в 'pegas up --env development --'");
      }
    } else {
      pkg.scripts.dev = "pegas up --env development";
      actions.push("Добавлен скрипт 'dev': 'pegas up --env development' в package.json");
    }

    // 2. Add deploy script
    if (!pkg.scripts.deploy || (!pkg.scripts.deploy.includes("pegas up") && !pkg.scripts.deploy.includes("pegas deploy"))) {
      pkg.scripts.deploy = "pegas up --env production";
      actions.push("Добавлен скрипт 'deploy': 'pegas up --env production' в package.json");
    }

    // 3. Add or upgrade pegas in devDependencies
    if (!pkg.devDependencies) {
      pkg.devDependencies = {};
    }
    const currentDep = pkg.devDependencies["@netrunner714/pegas"] || pkg.devDependencies.pegas;
    const targetDep = `^${VERSION}`;

    if (!currentDep) {
      pkg.devDependencies["@netrunner714/pegas"] = targetDep;
      actions.push(`Добавлен '@netrunner714/pegas' (${targetDep}) в devDependencies в package.json`);
    } else if (compareSemver(VERSION, currentDep) > 0) {
      pkg.devDependencies["@netrunner714/pegas"] = targetDep;
      if (pkg.devDependencies.pegas && pkg.devDependencies["@netrunner714/pegas"]) {
        delete pkg.devDependencies.pegas;
      }
      actions.push(`Обновлен '@netrunner714/pegas' в devDependencies: ${currentDep} -> ${targetDep}`);
    }

    if (!dryRun) {
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    }
  } catch {}

  return actions;
}
