import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RouteInfo } from "./types.js";
import { toAsciiDomain } from "./contract.js";
import { validateCaddyConfig, reloadCaddyConfig } from "./docker.js";

export async function findProjectRoot(startDir: string = process.cwd()): Promise<string | null> {
  let currentDir = path.resolve(startDir);
  let packageJsonDir: string | null = null;

  while (true) {
    // 1. Check for .git folder (definitive repo root)
    try {
      await fs.access(path.join(currentDir, ".git"));
      return currentDir;
    } catch {}

    // 2. Check for package.json
    if (!packageJsonDir) {
      try {
        await fs.access(path.join(currentDir, "package.json"));
        packageJsonDir = currentDir;
      } catch {}
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return packageJsonDir;
}

export async function findGatewayDir(explicitDir?: string): Promise<string> {
  if (explicitDir) {
    return path.resolve(explicitDir);
  }

  if (process.env.PEGAS_DIR) {
    return path.resolve(process.env.PEGAS_DIR);
  }

  const cwd = process.cwd();
  try {
    await fs.access(path.join(cwd, "Caddyfile"));
    await fs.access(path.join(cwd, "conf.d"));
    return cwd;
  } catch {}

  const homeGateway = path.join(os.homedir(), "gateway");
  try {
    await fs.access(path.join(homeGateway, "Caddyfile"));
    return homeGateway;
  } catch {}

  const homePegas = path.join(os.homedir(), "pegas-server");
  try {
    await fs.access(path.join(homePegas, "Caddyfile"));
    return homePegas;
  } catch {}

  // Fallback default
  return homeGateway;
}

export function getConfDir(gatewayDir: string): string {
  return path.join(gatewayDir, "conf.d");
}

export function getRouteFilePath(gatewayDir: string, domain: string): string {
  const ascii = toAsciiDomain(domain);
  const sanitized = ascii.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  return path.join(getConfDir(gatewayDir), `${sanitized}.caddy`);
}

export function getProjectRouteFilePath(gatewayDir: string, projectName: string, env?: string): string {
  const sanitized = projectName.toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  if (env && env.toLowerCase() !== "production" && env.toLowerCase() !== "prod") {
    const sanitizedEnv = env.toLowerCase().replace(/[^a-z0-9._-]/g, "_");
    return path.join(getConfDir(gatewayDir), `${sanitized}-${sanitizedEnv}.caddy`);
  }
  return path.join(getConfDir(gatewayDir), `${sanitized}.caddy`);
}

export async function listRoutes(gatewayDir: string): Promise<RouteInfo[]> {
  const confDir = getConfDir(gatewayDir);
  const routes: RouteInfo[] = [];

  try {
    const files = await fs.readdir(confDir);
    for (const file of files) {
      if (!file.endsWith(".caddy")) continue;
      const filePath = path.join(confDir, file);
      const content = await fs.readFile(filePath, "utf-8");

      const domain = file.replace(/\.caddy$/, "");
      const isSpa = content.includes("handle /api/*");
      const hasWwwRedirect = content.includes(`www.${domain}`);

      // Extract reverse_proxy targets
      const proxyMatches = [...content.matchAll(/reverse_proxy\s+([^\s\n]+)/g)];
      const upstreams = proxyMatches.map((m) => m[1]);

      let upstream = upstreams[0] || "unknown";
      let apiUpstream: string | undefined = undefined;

      if (isSpa && upstreams.length >= 2) {
        apiUpstream = upstreams[0];
        upstream = upstreams[1];
      }

      routes.push({
        domain,
        upstream,
        apiUpstream,
        filePath,
        hasWwwRedirect,
        isSpa,
      });
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  return routes;
}

export async function reloadGateway(options: {
  gatewayDir?: string;
  json?: boolean;
  silent?: boolean;
  exitOnError?: boolean;
}): Promise<boolean> {
  const isJson = options.json ?? false;
  const exitOnError = options.exitOnError ?? true;
  const gatewayDir = await findGatewayDir(options.gatewayDir);

  const validateRes = await validateCaddyConfig(gatewayDir);
  if (!validateRes.success) {
    if (isJson) {
      console.log(JSON.stringify({ error: "Validation failed", details: validateRes.stderr || validateRes.stdout }));
    } else {
      console.error("❌ Validation failed:");
      console.error(validateRes.stderr || validateRes.stdout);
    }
    if (exitOnError) {
      process.exit(1);
    }
    return false;
  }

  const reloadRes = await reloadCaddyConfig(gatewayDir);
  if (!reloadRes.success) {
    if (isJson) {
      console.log(JSON.stringify({ error: "Reload failed", details: reloadRes.stderr }));
    } else {
      console.error("❌ Reload failed:", reloadRes.stderr);
    }
    if (exitOnError) {
      process.exit(1);
    }
    return false;
  }

  if (!options.silent) {
    if (isJson) {
      console.log(JSON.stringify({ status: "success", message: "Caddy configuration reloaded" }));
    } else {
      console.log("\n🔄 Caddy configuration reloaded with zero downtime.\n");
    }
  }

  return true;
}

