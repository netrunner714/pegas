#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { parseArgs } from "node:util";
import { handleInit } from "./commands/init.js";
import { handleDeploy } from "./commands/deploy.js";
import { handleDown } from "./commands/down.js";
import { handleDev } from "./commands/dev.js";
import { handleAdd } from "./commands/add.js";
import { handleList } from "./commands/list.js";
import { handleRemove } from "./commands/remove.js";
import { handleReload } from "./commands/reload.js";
import { handleStatus } from "./commands/status.js";
import { handleLlms } from "./commands/llms.js";

const VERSION = "1.0.1";

export function validateNodeVersion(current = process.versions.node): boolean {
  if (!current) return true;
  const major = parseInt(current.split(".")[0], 10);
  if (isNaN(major)) return true;
  return major >= 24;
}

export function ensureNodeVersion(): void {
  const current = process.versions.node;
  if (!validateNodeVersion(current)) {
    console.error(`\x1b[31m❌ Error: Pegas requires Node.js >= 24.0.0 (detected v${current || "unknown"}).\x1b[0m`);
    console.error(`Please upgrade Node.js to version 24 or newer: https://nodejs.org/\n`);
    process.exit(1);
  }
}

const HELP_TEXT = `pegas v${VERSION} — Agent-native Caddy gateway for multi-app VPS

USAGE:
  $ pegas <command> [options]

COMMANDS:
  init                     Init Pegas in current project (or --server for host)
  dev [-- <command>]       Run local dev HTTPS proxy and start dev command (e.g. pegas dev -- next dev)
  deploy                   Declarative deploy: configure Caddy routes from pegas.json and start containers
  down                     Tear down project containers and remove Caddy routes
  add <domain> [options]   Route a domain to an internal container upstream
  list, ls                 List all active domain routes
  remove, rm <domain>      Delete route and reload Caddy
  reload                   Validate and hot-reload Caddy configuration
  status                   Check Docker and gateway health
  llms                     Print machine-readable LLM context

OPTIONS FOR 'add':
  -u, --upstream <target>  Upstream container:port (e.g. web:3000)
      --spa                SPA mode (separate frontend and API proxying)
      --api-upstream <tgt> Upstream for API backend (e.g. api:8000)
      --api-prefix <pfx>   API path prefix (default: /api/*)
      --no-www             Do not auto-generate www redirect
      --force              Overwrite existing route file
      --dry-run            Print generated config without applying

OPTIONS FOR 'dev':
      --infra              Boot infrastructure services defined in docker-compose.yml
      --no-infra           Do not boot infrastructure services even if enabled in pegas.json

OPTIONS FOR 'deploy':
      --strict-dns         Abort deployment if DNS records do not match server IP
      --skip-dns-check     Bypass DNS pre-flight verification

GLOBAL OPTIONS:
      --gateway-dir <path> Override path to gateway directory
      --json               Output machine-readable JSON (ideal for AI agents)
  -h, --help               Show this help message
  -v, --version            Show version

EXAMPLES:
  $ pegas init
  $ pegas add myapp.ru --upstream web:3000
  $ pegas add api.myapp.ru --upstream api:8000
  $ pegas list
`;

function tryLocalDelegation(): void {
  if (process.env.PEGAS_DELEGATED) {
    return;
  }

  const scopedTarget = path.join(process.cwd(), "node_modules", "@netrunner714", "pegas", "dist", "index.js");
  const unscopedTarget = path.join(process.cwd(), "node_modules", "pegas", "dist", "index.js");
  const localPegas = fs.existsSync(scopedTarget) ? scopedTarget : (fs.existsSync(unscopedTarget) ? unscopedTarget : null);
  if (!localPegas) {
    return;
  }

  // Prevent self-delegation if this script itself is already the local target
  try {
    const currentScript = fs.realpathSync(process.argv[1] || "");
    const targetScript = fs.realpathSync(localPegas);
    if (currentScript === targetScript) {
      return;
    }
  } catch {}

  const result = child_process.spawnSync(
    process.execPath,
    [localPegas, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PEGAS_DELEGATED: "1",
      },
    }
  );

  process.exit(result.status ?? (result.signal ? 1 : 0));
}

async function main() {
  ensureNodeVersion();
  tryLocalDelegation();

  const rawArgs = process.argv.slice(2);
  const doubleDashIdx = rawArgs.indexOf("--");
  const pegasArgs = doubleDashIdx !== -1 ? rawArgs.slice(0, doubleDashIdx) : rawArgs;

  if (pegasArgs.length === 0 || pegasArgs.includes("-h") || pegasArgs.includes("--help")) {
    console.log(HELP_TEXT);
    return;
  }

  if (pegasArgs.includes("-v") || pegasArgs.includes("--version")) {
    console.log(`pegas v${VERSION}`);
    return;
  }

  const { values, positionals } = parseArgs({
    args: pegasArgs,
    options: {
      upstream: { type: "string", short: "u" },
      spa: { type: "boolean", default: false },
      "api-upstream": { type: "string" },
      "api-prefix": { type: "string", default: "/api/*" },
      "no-www": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "skip-up": { type: "boolean", default: false },
      "skip-readiness": { type: "boolean", default: false },
      "strict-dns": { type: "boolean", default: false },
      "skip-dns-check": { type: "boolean", default: false },
      infra: { type: "boolean" },
      "no-infra": { type: "boolean" },
      "gateway-dir": { type: "string" },
      server: { type: "boolean", default: false },
      project: { type: "boolean", default: false },
      email: { type: "string" },
      network: { type: "string" },
      write: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0]?.toLowerCase();

  switch (command) {
    case "init": {
      await handleInit({
        gatewayDir: values["gateway-dir"] as string | undefined,
        server: values.server as boolean | undefined,
        project: values.project as boolean | undefined,
        email: values.email as string | undefined,
        networkName: values.network as string | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "dev": {
      const userCmd = doubleDashIdx !== -1 ? rawArgs.slice(doubleDashIdx + 1) : positionals.slice(1);
      let infra: boolean | undefined = undefined;
      if (values["no-infra"]) {
        infra = false;
      } else if (values.infra) {
        infra = true;
      }
      await handleDev({
        command: userCmd,
        infra,
      });
      break;
    }

    case "deploy": {
      await handleDeploy({
        gatewayDir: values["gateway-dir"] as string | undefined,
        dryRun: values["dry-run"] as boolean | undefined,
        skipUp: values["skip-up"] as boolean | undefined,
        skipReadiness: values["skip-readiness"] as boolean | undefined,
        strictDns: values["strict-dns"] as boolean | undefined,
        skipDnsCheck: values["skip-dns-check"] as boolean | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "down": {
      await handleDown({
        gatewayDir: values["gateway-dir"] as string | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "add": {
      const domain = positionals[1];
      await handleAdd({
        domain: domain || "",
        upstream: values.upstream as string | undefined,
        spa: values.spa as boolean | undefined,
        apiUpstream: values["api-upstream"] as string | undefined,
        apiPrefix: values["api-prefix"] as string | undefined,
        noWww: values["no-www"] as boolean | undefined,
        force: values.force as boolean | undefined,
        dryRun: values["dry-run"] as boolean | undefined,
        gatewayDir: values["gateway-dir"] as string | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "list":
    case "ls": {
      await handleList({
        gatewayDir: values["gateway-dir"] as string | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "remove":
    case "rm": {
      const domain = positionals[1];
      await handleRemove({
        domain: domain || "",
        gatewayDir: values["gateway-dir"] as string | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "reload": {
      await handleReload({
        gatewayDir: values["gateway-dir"] as string | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "status": {
      await handleStatus({
        gatewayDir: values["gateway-dir"] as string | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "llms": {
      handleLlms({
        json: values.json as boolean | undefined,
      });
      break;
    }

    default: {
      console.error(`Unknown command: '${command}'. Run 'pegas --help' for usage.`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
