import fs from "node:fs/promises";
import path from "node:path";
import { PegasContract } from "./types.js";

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
      const lines = content.replace(/\r\n/g, "\n").split("\n");
      let inServices = false;
      let serviceIndent: number | null = null;
      let currentService: string | null = null;
      let currentPorts: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        const indent = line.search(/\S/);
        if (indent === 0 && /^services:\s*$/.test(line)) {
          inServices = true;
          continue;
        }
        if (indent === 0 && inServices && /^[a-zA-Z0-9_-]+:\s*$/.test(line)) {
          break;
        }
        if (inServices) {
          if (serviceIndent === null && indent > 0 && /^[a-zA-Z0-9._-]+:\s*$/.test(trimmed)) {
            serviceIndent = indent;
          }
          if (serviceIndent !== null && indent === serviceIndent && /^[a-zA-Z0-9._-]+:\s*$/.test(trimmed)) {
            if (currentService && currentPorts.length > 0) {
              const clean = currentPorts[0].replace(/['"]/g, "").trim();
              const portMatch = clean.match(/:(\d+)$/) || clean.match(/(\d+)$/);
              return { name: currentService, port: portMatch ? portMatch[1] : "3000" };
            }
            currentService = trimmed.replace(/:\s*$/, "");
            currentPorts = [];
          } else if (currentService && /^\s*-\s*["']?\d+/.test(line)) {
            currentPorts.push(line.trim());
          }
        }
      }
      if (currentService && currentPorts.length > 0) {
        const clean = currentPorts[0].replace(/['"]/g, "").trim();
        const portMatch = clean.match(/:(\d+)$/) || clean.match(/(\d+)$/);
        return { name: currentService, port: portMatch ? portMatch[1] : "3000" };
      }
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
  port = "3000"
): PegasContract {
  return {
    projectName: slug,
    services: {
      [serviceName]: {
        upstream: `${serviceName}:${port}`,
        domains: {
          dev: [`${slug}.localhost`],
          prod: [`${slug}.com`],
        },
      },
    },
  };
}

export const DEFAULT_CONTRACT: PegasContract = createDefaultContract("app", "web", "3000");

export async function setupProjectContract(
  projectDir: string
): Promise<{ created: boolean; file: string; slug: string }> {
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
    await fs.writeFile(
      contractPath,
      JSON.stringify(defaultContract, null, 2) + "\n",
      "utf-8"
    );
    return { created: true, file: CONTRACT_FILENAME, slug };
  }
}

export async function updatePackageJson(
  projectDir: string
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
      if (!pkg.scripts.dev.includes("pegas dev")) {
        pkg.scripts.dev = `pegas dev -- ${pkg.scripts.dev}`;
        actions.push("Обновлён скрипт 'dev' в package.json: обёрнут в 'pegas dev --'");
      }
    } else {
      pkg.scripts.dev = "pegas dev";
      actions.push("Добавлен скрипт 'dev': 'pegas dev' в package.json");
    }

    // 2. Add deploy script
    if (!pkg.scripts.deploy || !pkg.scripts.deploy.includes("pegas deploy")) {
      pkg.scripts.deploy = "pegas deploy";
      actions.push("Добавлен скрипт 'deploy': 'pegas deploy' в package.json");
    }

    // 3. Add pegas to devDependencies
    if (!pkg.devDependencies) {
      pkg.devDependencies = {};
    }
    if (!pkg.devDependencies.pegas) {
      pkg.devDependencies.pegas = "^1.0.0";
      actions.push("Добавлен 'pegas' в devDependencies в package.json");
    }

    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  } catch {}

  return actions;
}
