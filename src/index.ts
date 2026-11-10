#!/usr/bin/env node
import { parseArgs } from "node:util";
import { handleDeploy } from "./commands/deploy.js";
import { handleDown } from "./commands/down.js";
import { handleLogs } from "./commands/logs.js";
import { handleStatus } from "./commands/status.js";
import { handleLlms } from "./commands/llms.js";
import { handleCa } from "./commands/ca.js";
import { handleCheck } from "./commands/check.js";
import { handleUpdate } from "./commands/update.js";
import { handleConnect } from "./commands/connect.js";
import { handleInit } from "./commands/init.js";
import { handleDisconnect } from "./commands/disconnect.js";

import { VERSION } from "./version.js";
import { generateHelpText, getParseArgsOptions } from "./help.js";
export { VERSION, generateHelpText, getParseArgsOptions };
export { getPegasAllowedOrigins, isPegasOriginAllowed } from "./cors.js";
export { generateCaddyfileSnippet, buildCorsOriginRegex } from "./generator.js";

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

export interface MainDispatchers {
  handleInit?: typeof handleInit;
  handleConnect?: typeof handleConnect;
  handleDisconnect?: typeof handleDisconnect;
  handleDeploy?: typeof handleDeploy;
  handleDown?: typeof handleDown;
  handleLogs?: typeof handleLogs;
  handleStatus?: typeof handleStatus;
  handleLlms?: typeof handleLlms;
  handleCa?: typeof handleCa;
  handleCheck?: typeof handleCheck;
  handleUpdate?: typeof handleUpdate;
}

export interface MainOptions {
  noExit?: boolean;
  dispatchers?: MainDispatchers;
}

export async function main(argv = process.argv.slice(2), options: MainOptions = {}) {
  ensureNodeVersion();
  const normalizedArgs = argv.map((a) => {
    if (a === "-scenario") return "--scenario";
    if (a.startsWith("-scenario=")) return "--scenario=" + a.slice(10);
    return a;
  });
  const dispatch = {
    handleInit: options.dispatchers?.handleInit || handleInit,
    handleConnect: options.dispatchers?.handleConnect || handleConnect,
    handleDisconnect: options.dispatchers?.handleDisconnect || handleDisconnect,
    handleDeploy: options.dispatchers?.handleDeploy || handleDeploy,
    handleDown: options.dispatchers?.handleDown || handleDown,
    handleLogs: options.dispatchers?.handleLogs || handleLogs,
    handleStatus: options.dispatchers?.handleStatus || handleStatus,
    handleLlms: options.dispatchers?.handleLlms || handleLlms,
    handleCa: options.dispatchers?.handleCa || handleCa,
    handleCheck: options.dispatchers?.handleCheck || handleCheck,
    handleUpdate: options.dispatchers?.handleUpdate || handleUpdate,
  };

  const rawArgs = normalizedArgs;
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

  // Строгий контроль флагов: опечатка (--fxi) не должна выглядеть как "сработало".
  // Неизвестный флаг — явная ошибка со списком валидных (кроме внутренних, после "--").
  {
    const known = getParseArgsOptions();
    const longNames = new Set(Object.keys(known));
    const shorts = new Set(Object.values(known).map((o) => o.short).filter(Boolean) as string[]);
    const globalLongs = new Set(["--help", "--version"]);
    for (const arg of pegasArgs) {
      if (arg === "--") break;
      if (arg.startsWith("--") && arg.length > 2) {
        const name = arg.slice(2).split("=")[0];
        if (!longNames.has(name) && !globalLongs.has("--" + name)) {
          console.error(
            "Unknown option: '--" + name + "'. Valid options: " +
              Array.from(longNames).sort().map((n) => "--" + n).join(", ") +
              ". Run 'pegas --help' for details."
          );
          if (!options.noExit) process.exit(1);
          return;
        }
      } else if (arg.startsWith("-") && arg.length === 2 && !arg.startsWith("--")) {
        const s = arg.slice(1);
        if (!shorts.has(s) && s !== "h" && s !== "v") {
          console.error("Unknown option: '-" + s + "'. Run 'pegas --help' for usage.");
          if (!options.noExit) process.exit(1);
          return;
        }
      }
    }
  }

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
        dryRun: values["dry-run"] as boolean | undefined,
        force: values.force as boolean | undefined,
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "connect": {
      await dispatch.handleConnect({
        cwd: values.cwd as string | undefined,
        gatewayDir: values["gateway-dir"] as string | undefined,
        dryRun: values["dry-run"] as boolean | undefined,
        json: values.json as boolean | undefined,
        ...(options.noExit !== undefined ? { noExit: options.noExit } : {}),
      });
      break;
    }

    case "disconnect": {
      await dispatch.handleDisconnect({
        cwd: values.cwd as string | undefined,
        gatewayDir: values["gateway-dir"] as string | undefined,
        dryRun: values["dry-run"] as boolean | undefined,
        json: values.json as boolean | undefined,
        ...(options.noExit !== undefined ? { noExit: options.noExit } : {}),
      });
      break;
    }

    // v3: старые имена удалены без алиасов (breaking change, major 3.0.0)
    case "link":
    case "unlink":
    case "uninstall":
    case "migrate": {
      const replacement = command === "link" ? "pegas connect"
        : command === "unlink" ? "pegas disconnect"
        : command === "uninstall" ? "ручной выход (docs/how-to)"
        : "ручная правка pegas.json по подсказкам pegas check";
      console.error(`❌ Команда '${command}' удалена в pegas v3. Используйте: ${replacement}.`);
      if (!options.noExit) process.exit(1);
      return;
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

    case "deploy": {
      const scenario = values.scenario as string | undefined;
      await dispatch.handleDeploy({
        cwd: values.cwd as string | undefined,
        scenario,
        gatewayDir: values["gateway-dir"] as string | undefined,
        ...(values["skip-dns-check"] ? { skipDnsCheck: true } : {}),
        ...(values["strict-dns"] ? { strictDns: true } : {}),
        ...(values["skip-up"] ? { skipUp: true } : {}),
        ...(values["dry-run"] ? { dryRun: true } : {}),
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
        cwd: values.cwd as string | undefined,
      });
      break;
    }

    case "llms": {
      dispatch.handleLlms({
        json: values.json as boolean | undefined,
      });
      break;
    }

    case "update": {
      await dispatch.handleUpdate({
        cwd: values.cwd as string | undefined,
        latest: values.latest as boolean | undefined,
        json: values.json as boolean | undefined,
        ...(options.noExit !== undefined ? { noExit: options.noExit } : {}),
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

    case "check": {
      await dispatch.handleCheck({
        cwd: values.cwd as string | undefined,
        json: values.json as boolean | undefined,
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
