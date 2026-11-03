#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { parseArgs } from "node:util";
import { handleInit } from "./commands/init.js";
import { handleDeploy } from "./commands/deploy.js";
import { handleDown } from "./commands/down.js";
import { handleLogs } from "./commands/logs.js";
import { handleDev } from "./commands/dev.js";
import { handleStatus } from "./commands/status.js";
import { handleLlms } from "./commands/llms.js";
import { handleUpdate } from "./commands/update.js";
import { handleCa } from "./commands/ca.js";
import { handleUninstall } from "./commands/uninstall.js";
import { handleCheck } from "./commands/check.js";

import { VERSION, compareSemver } from "./version.js";
import { generateHelpText, getParseArgsOptions } from "./help.js";
export { VERSION, generateHelpText, getParseArgsOptions };
export { getPegasAllowedOrigins, isPegasOriginAllowed } from "./cors.js";

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

  // Never delegate `init`, `update`, or `check` to local node_modules.
  // Running `pegas init`, `pegas update`, or `pegas check` is intended to audit or update the project
  // using the currently invoked CLI, avoiding entrapment in outdated node_modules.
  if (
    args[0] === "init" ||
    args.includes("init") ||
    args[0] === "update" ||
    args.includes("update") ||
    args[0] === "check" ||
    args.includes("check")
  ) {
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

  // Do not delegate if local version is older or same as this binary
  try {
    const pkgDir = path.dirname(path.dirname(localPegas));
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    if (pkgJson.version && compareSemver(pkgJson.version, VERSION) <= 0) {
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
  handleLogs?: typeof handleLogs;
  handleDev?: typeof handleDev;
  handleStatus?: typeof handleStatus;
  handleLlms?: typeof handleLlms;
  handleUpdate?: typeof handleUpdate;
  handleCa?: typeof handleCa;
  handleUninstall?: typeof handleUninstall;
  handleCheck?: typeof handleCheck;
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
    handleLogs: options.dispatchers?.handleLogs || handleLogs,
    handleDev: options.dispatchers?.handleDev || handleDev,
    handleStatus: options.dispatchers?.handleStatus || handleStatus,
    handleLlms: options.dispatchers?.handleLlms || handleLlms,
    handleUpdate: options.dispatchers?.handleUpdate || handleUpdate,
    handleCa: options.dispatchers?.handleCa || handleCa,
    handleUninstall: options.dispatchers?.handleUninstall || handleUninstall,
    handleCheck: options.dispatchers?.handleCheck || handleCheck,
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

  const explicitScenario = (values.scenario as string | undefined) ||
    (values.target as string | undefined);

  if (!command && explicitScenario) {
    await dispatch.handleDeploy({
      cwd: values.cwd as string | undefined,
      scenario: explicitScenario,
      target: explicitScenario,
      env: explicitScenario,
      gatewayDir: values["gateway-dir"] as string | undefined,
      ...(values["dry-run"] ? { dryRun: true } : {}),
      ...(values["skip-dns-check"] ? { skipDnsCheck: true } : {}),
      ...(values["strict-dns"] ? { strictDns: true } : {}),
      ...(values["skip-up"] ? { skipUp: true } : {}),
      json: values.json as boolean | undefined,
      ...(options.noExit !== undefined ? { noExit: options.noExit } : {}),
    });
    return;
  }

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

    case "logs": {
      const knownEnvs = new Set(["development", "dev", "stage", "staging", "production", "prod", "test"]);
      let targetEnv = (values.env as string | undefined) ||
        (values.scenario as string | undefined) ||
        (values.target as string | undefined);
      let targetService: string | undefined;

      const pos1 = positionals[1] as string | undefined;
      const pos2 = positionals[2] as string | undefined;

      if (targetEnv) {
        targetService = pos1;
      } else if (pos1 && knownEnvs.has(pos1.toLowerCase())) {
        targetEnv = pos1;
        targetService = pos2;
      } else if (pos2 && knownEnvs.has(pos2.toLowerCase())) {
        targetEnv = pos2;
        targetService = pos1;
      } else {
        targetService = pos1;
      }

      await dispatch.handleLogs({
        cwd: values.cwd as string | undefined,
        env: targetEnv,
        service: targetService,
        follow: values.follow as boolean | undefined,
        tail: values.tail as string | number | undefined,
        json: values.json as boolean | undefined,
        ...(options.noExit !== undefined ? { noExit: options.noExit } : {}),
      });
      break;
    }

    case "dev": {
      const userCmd = doubleDashIdx !== -1 ? rawArgs.slice(doubleDashIdx + 1) : positionals.slice(1);
      await dispatch.handleDev({
        cwd: values.cwd as string | undefined,
        gatewayDir: values["gateway-dir"] as string | undefined,
        noRun: values["no-run"] as boolean | undefined,
        dryRun: values["dry-run"] as boolean | undefined,
        json: values.json as boolean | undefined,
        command: userCmd.length > 0 ? userCmd : undefined,
        ...(options.noExit !== undefined ? { noExit: options.noExit } : {}),
      });
      break;
    }

    case "deploy": {
      const targetScenario = (values.scenario as string | undefined) ||
        (values.target as string | undefined) ||
        (values.env as string | undefined) ||
        (positionals[1] as string | undefined);
      await dispatch.handleDeploy({
        cwd: values.cwd as string | undefined,
        scenario: targetScenario,
        target: targetScenario,
        env: targetScenario,
        gatewayDir: values["gateway-dir"] as string | undefined,
        ...(values["dry-run"] ? { dryRun: true } : {}),
        ...(values["skip-dns-check"] ? { skipDnsCheck: true } : {}),
        ...(values["strict-dns"] ? { strictDns: true } : {}),
        ...(values["skip-up"] ? { skipUp: true } : {}),
        json: values.json as boolean | undefined,
        ...(options.noExit !== undefined ? { noExit: options.noExit } : {}),
      });
      break;
    }

    case "down": {
      const downEnvPositional = positionals[1] as string | undefined;
      const targetEnv = (values.scenario as string | undefined) ||
        (values.target as string | undefined) ||
        (values.env as string | undefined) ||
        downEnvPositional;
      await dispatch.handleDown({
        cwd: values.cwd as string | undefined,
        gatewayDir: values["gateway-dir"] as string | undefined,
        env: targetEnv,
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

    case "uninstall": {
      await dispatch.handleUninstall({
        cwd: values.cwd as string | undefined,
        dryRun: values["dry-run"] as boolean | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "check": {
      await dispatch.handleCheck({
        cwd: values.cwd as string | undefined,
        json: values.json as boolean | undefined,
        ...(values.fix ? { fix: true } : {}),
        noExit: options.noExit,
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
