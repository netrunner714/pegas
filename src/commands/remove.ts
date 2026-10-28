import fs from "node:fs/promises";
import { findGatewayDir, getRouteFilePath } from "../gateway.js";
import { reloadCaddyConfig } from "../docker.js";

export async function handleRemove(options: { domain: string; gatewayDir?: string; json?: boolean }): Promise<void> {
  const isJson = options.json ?? false;

  if (!options.domain) {
    if (isJson) {
      console.log(JSON.stringify({ error: "Missing domain argument. Usage: pegas remove <domain>" }));
    } else {
      console.error("❌ Error: Missing domain argument. Usage: pegas remove <domain>");
    }
    process.exit(1);
  }

  const gatewayDir = await findGatewayDir(options.gatewayDir);
  const routeFilePath = getRouteFilePath(gatewayDir, options.domain);

  try {
    await fs.unlink(routeFilePath);
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ error: `Route for ${options.domain} not found.` }));
    } else {
      console.error(`❌ Route for '${options.domain}' not found at: ${routeFilePath}`);
    }
    process.exit(1);
  }

  const reloadRes = await reloadCaddyConfig(gatewayDir);
  if (!reloadRes.success) {
    if (isJson) {
      console.log(JSON.stringify({ error: "Failed to reload Caddy.", details: reloadRes.stderr }));
    } else {
      console.error("❌ Failed to reload Caddy:", reloadRes.stderr);
    }
    process.exit(1);
  }

  if (isJson) {
    console.log(JSON.stringify({ status: "success", domain: options.domain, removed: routeFilePath }));
  } else {
    console.log(`\n🗑️  Route for ${options.domain} removed and Caddy reloaded successfully.\n`);
  }
}
