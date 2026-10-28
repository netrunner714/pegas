import fs from "node:fs/promises";
import path from "node:path";
import { AddOptions } from "../types.js";
import { generateCaddyfileSnippet } from "../generator.js";
import { findGatewayDir, getRouteFilePath } from "../gateway.js";
import { validateCaddyConfig, reloadCaddyConfig } from "../docker.js";
import { handleServerInit } from "./init.js";

export async function createOrUpdateRouteFile(options: {
  domain: string;
  upstream: string;
  gatewayDir: string;
  spa?: boolean;
  apiUpstream?: string;
  apiPrefix?: string;
  noWww?: boolean;
  security?: boolean;
}): Promise<{ routeFilePath: string; snippet: string; alreadyExists: boolean; originalContent: string | null }> {
  const routeFilePath = getRouteFilePath(options.gatewayDir, options.domain);
  let alreadyExists = false;
  let originalContent: string | null = null;
  try {
    originalContent = await fs.readFile(routeFilePath, "utf-8");
    alreadyExists = true;
  } catch {}

  const snippet = generateCaddyfileSnippet(options);
  await fs.writeFile(routeFilePath, snippet, "utf-8");

  return { routeFilePath, snippet, alreadyExists, originalContent };
}

export async function handleAdd(options: AddOptions): Promise<void> {
  const isJson = options.json ?? false;

  if (!options.domain) {
    if (isJson) {
      console.log(JSON.stringify({ error: "Missing domain argument. Usage: pegas add <domain> --upstream <service:port>" }));
    } else {
      console.error("❌ Error: Missing domain name. Usage: pegas add <domain> --upstream <service:port>");
    }
    process.exit(1);
  }

  if (!options.upstream) {
    if (isJson) {
      console.log(JSON.stringify({ error: "Missing --upstream argument. Usage: pegas add <domain> --upstream <service:port>" }));
    } else {
      console.error("❌ Error: Missing --upstream argument. Usage: pegas add <domain> --upstream <service:port>");
    }
    process.exit(1);
  }

  const gatewayDir = await findGatewayDir(options.gatewayDir);

  // Auto-bootstrap server gateway if not yet initialized
  const caddyfilePath = path.join(gatewayDir, "Caddyfile");
  try {
    await fs.access(caddyfilePath);
  } catch {
    if (!options.dryRun) {
      if (!isJson) {
        console.log("ℹ️  Server gateway not initialized yet. Auto-bootstrapping Pegas on the fly...");
      }
      await handleServerInit({ gatewayDir, json: options.json });
    }
  }

  const routeFilePath = getRouteFilePath(gatewayDir, options.domain);

  // Check if already exists
  let alreadyExists = false;
  try {
    await fs.access(routeFilePath);
    alreadyExists = true;
  } catch {}

  if (alreadyExists && !options.force && !options.dryRun) {
    if (isJson) {
      console.log(JSON.stringify({ error: `Route for ${options.domain} already exists. Use --force to overwrite.` }));
    } else {
      console.error(`⚠️  Route for '${options.domain}' already exists at: ${routeFilePath}`);
      console.error(`   Use '--force' flag to overwrite.`);
    }
    process.exit(1);
  }

  if (options.dryRun) {
    const snippet = generateCaddyfileSnippet(options);
    if (isJson) {
      console.log(JSON.stringify({ domain: options.domain, snippet }));
    } else {
      console.log(`\n--- Preview of ${routeFilePath} ---\n`);
      console.log(snippet);
      console.log("--- End of preview (dry run) ---\n");
    }
    return;
  }

  const { originalContent } = await createOrUpdateRouteFile({
    domain: options.domain,
    upstream: options.upstream,
    gatewayDir,
    spa: options.spa,
    apiUpstream: options.apiUpstream,
    apiPrefix: options.apiPrefix,
    noWww: options.noWww,
    security: options.security,
  });

  // Validate Caddy
  const validateRes = await validateCaddyConfig(gatewayDir);
  if (!validateRes.success) {
    // Rollback!
    if (originalContent !== null) {
      await fs.writeFile(routeFilePath, originalContent, "utf-8");
    } else {
      await fs.unlink(routeFilePath).catch(() => {});
    }

    if (isJson) {
      console.log(
        JSON.stringify({
          error: "Caddy configuration validation failed. Changes were rolled back.",
          details: validateRes.stderr || validateRes.stdout,
        })
      );
    } else {
      console.error("❌ Caddy configuration validation failed! Changes have been rolled back.");
      console.error(validateRes.stderr || validateRes.stdout);
    }
    process.exit(1);
  }

  // Reload Caddy
  const reloadRes = await reloadCaddyConfig(gatewayDir);
  if (!reloadRes.success) {
    if (isJson) {
      console.log(
        JSON.stringify({
          error: "Failed to reload Caddy.",
          details: reloadRes.stderr,
        })
      );
    } else {
      console.error("❌ Failed to reload Caddy:", reloadRes.stderr);
    }
    process.exit(1);
  }

  const composePatch = `services:
  ${(options.upstream || "app:3000").split(":")[0]}:
    networks:
      pegas-network:
        aliases:
          - ${(options.upstream || "app:3000").split(":")[0]}

networks:
  pegas-network:
    external: true`;

  if (isJson) {
    console.log(
      JSON.stringify({
        status: "success",
        domain: options.domain,
        upstream: options.upstream || "app:3000",
        configFile: routeFilePath,
        composePatch,
      })
    );
  } else {
    console.log(`\n✅ Route for https://${options.domain} successfully configured and live!`);
    console.log(`   Config:   ${routeFilePath}`);
    console.log(`   Upstream: ${options.upstream || "app:3000"}`);
    console.log(`   SSL:      Automatic Let's Encrypt (issued on first HTTP/HTTPS request)\n`);
    console.log("📋 Add this to your project's docker-compose.yml:\n");
    console.log(composePatch);
    console.log("\n");
  }
}
