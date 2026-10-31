#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { runCoverageCheck } from "./check-coverage.js";

async function main() {
  const forwardedArgs = process.argv.slice(2);

  // Run bun test (which picks up coverage from bunfig.toml).
  // --isolate: каждый файл в свежем global object (mock.module("node:child_process")
  // в dev-docker/docker-gateway тестах иначе протекает в остальные файлы).
  // --bail=1: падение на первом же проваленном тесте, а не после полного прогона.
  // --preload ./src/test-silence.ts: глушит console-диагностику CLI-команд
  // в тестах (PEGAS_LOUD_TESTS=1 — вернуть вывод).
  // NO_COLOR убираем: вместе с FORCE_COLOR он заставляет Node в дочерних процессах
  // писать warning в stderr и ломает тесты, ожидающие пустой stderr.
  const { NO_COLOR: _ignored, ...baseEnv } = process.env;
  const hasIsolate = forwardedArgs.some((a) => a.startsWith("--isolate") || a.startsWith("--no-isolate") || a.startsWith("--parallel"));
  const hasPreload = forwardedArgs.some((a) => a.startsWith("--preload"));
  const args = [
    "test",
    ...(hasIsolate ? [] : ["--isolate"]),
    "--bail=1",
    ...(hasPreload ? [] : ["--preload", "./src/test-silence.ts"]),
    ...forwardedArgs,
  ];
  const bunTest = spawn("bun", args, {
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
