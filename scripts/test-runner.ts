#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { runCoverageCheck } from "./check-coverage.js";

async function main() {
  const forwardedArgs = process.argv.slice(2);

  // Run bun test (which picks up coverage from bunfig.toml).
  // NO_COLOR убираем: вместе с FORCE_COLOR он заставляет Node в дочерних процессах
  // писать warning в stderr и ломает тесты, ожидающие пустой stderr.
  const { NO_COLOR: _ignored, ...baseEnv } = process.env;
  const bunTest = spawn("bun", ["test", ...forwardedArgs], {
    stdio: "inherit",
    env: { ...baseEnv, FORCE_COLOR: "1" },
  });

  const exitCode = await new Promise<number>((resolve) => {
    bunTest.on("close", (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  // If a single file or pattern was targeted (e.g. bun run test dev.test.ts), skip threshold check
  const isTargetedTest = forwardedArgs.some((arg) => !arg.startsWith("-") && arg.includes(".test.ts"));
  if (!isTargetedTest) {
    await runCoverageCheck();
  }
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
