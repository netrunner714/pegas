import { findGatewayDir } from "../gateway.js";
import { validateCaddyConfig, reloadCaddyConfig } from "../docker.js";

export async function handleReload(options: {
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
