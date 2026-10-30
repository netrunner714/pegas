#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { parseArgs } from "node:util";
import { handleInit } from "./commands/init.js";
import { handleDeploy } from "./commands/deploy.js";
import { handleDown } from "./commands/down.js";
import { handleDev } from "./commands/dev.js";
import { handleStatus } from "./commands/status.js";
import { handleLlms } from "./commands/llms.js";
import { handleUpdate } from "./commands/update.js";
import { handleCa } from "./commands/ca.js";

import { VERSION } from "./version.js";
import { generateHelpText, getParseArgsOptions } from "./help.js";
export { VERSION, generateHelpText, getParseArgsOptions };

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

export function tryLocalDelegation(args = process.argv.slice(2)): void {
  if (process.env.PEGAS_DELEGATED) {
    return;
  }

  // Never delegate `init` or `update` to local node_modules.
  // Running `pegas init` or `pegas update` is intended to initialize or update the project
  // using the currently invoked CLI, avoiding entrapment in outdated node_modules.
  if (args[0] === "init" || args.includes("init") || args[0] === "update" || args.includes("update")) {
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

export interface MainDispatchers {
  handleInit?: typeof handleInit;
  handleDeploy?: typeof handleDeploy;
  handleDown?: typeof handleDown;
  handleDev?: typeof handleDev;
  handleStatus?: typeof handleStatus;
  handleLlms?: typeof handleLlms;
  handleUpdate?: typeof handleUpdate;
  handleCa?: typeof handleCa;
}

export interface MainOptions {
  noExit?: boolean;
  dispatchers?: MainDispatchers;
}

export async function main(argv = process.argv.slice(2), options: MainOptions = {}) {
  ensureNodeVersion();
  tryLocalDelegation(argv);

  const dispatch = {
    handleInit: options.dispatchers?.handleInit || handleInit,
    handleDeploy: options.dispatchers?.handleDeploy || handleDeploy,
    handleDown: options.dispatchers?.handleDown || handleDown,
    handleDev: options.dispatchers?.handleDev || handleDev,
    handleStatus: options.dispatchers?.handleStatus || handleStatus,
    handleLlms: options.dispatchers?.handleLlms || handleLlms,
    handleUpdate: options.dispatchers?.handleUpdate || handleUpdate,
    handleCa: options.dispatchers?.handleCa || handleCa,
  };

  const rawArgs = argv;
  const doubleDashIdx = rawArgs.indexOf("--");
  const pegasArgs = doubleDashIdx !== -1 ? rawArgs.slice(0, doubleDashIdx) : rawArgs;

  if (pegasArgs.length === 0) {
    console.log(generateHelpText());
    return;
  }

  if (pegasArgs.includes("-v") || pegasArgs.includes("--version")) {
    console.log(`pegas v${VERSION}`);
    return;
  }

  const { values, positionals } = parseArgs({
    args: pegasArgs,
    options: getParseArgsOptions(),
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0]?.toLowerCase();

  if (command === "help" || values.help || pegasArgs.includes("-h") || pegasArgs.includes("--help")) {
    const targetCommand = command === "help" ? positionals[1]?.toLowerCase() : command;
    console.log(generateHelpText(targetCommand));
    return;
  }

  switch (command) {
    case "init": {
      await dispatch.handleInit({
        cwd: values.cwd as string | undefined,
        gatewayDir: values["gateway-dir"] as string | undefined,
        dryRun: values["dry-run"] as boolean | undefined,
        force: values.force as boolean | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "update": {
      await dispatch.handleUpdate({
        cwd: values.cwd as string | undefined,
        latest: values.latest as boolean | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "dev": {
      const userCmd = doubleDashIdx !== -1 ? rawArgs.slice(doubleDashIdx + 1) : positionals.slice(1);
      await dispatch.handleDev({
        cwd: values.cwd as string | undefined,
        command: userCmd,
      });
      break;
    }

    case "deploy": {
      const targetEnv = (positionals[1] as string | undefined) || (values.env as string | undefined);
      await dispatch.handleDeploy({
        cwd: values.cwd as string | undefined,
        env: targetEnv,
        gatewayDir: values["gateway-dir"] as string | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "down": {
      await dispatch.handleDown({
        cwd: values.cwd as string | undefined,
        gatewayDir: values["gateway-dir"] as string | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "status": {
      await dispatch.handleStatus({
        gatewayDir: values["gateway-dir"] as string | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "llms": {
      dispatch.handleLlms({
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "ca": {
      const action = (positionals[1] as string | undefined)?.toLowerCase();
      await dispatch.handleCa({
        action,
        json: values.json as boolean | undefined,
        dryRun: values["dry-run"] as boolean | undefined,
      });
      break;
    }

    default: {
      console.error(`Unknown command: '${command}'. Run 'pegas --help' for usage.`);
      if (!options.noExit) {
        process.exit(1);
      }
      return;
    }
  }
}

const isDirectCli = Boolean(
  process.argv[1] &&
    (process.argv[1].endsWith("dist/index.js") ||
      process.argv[1].endsWith("src/index.ts") ||
      process.argv[1].endsWith("bin/pegas") ||
      process.argv[1].endsWith("bin/pegas.js"))
);

if (isDirectCli) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
