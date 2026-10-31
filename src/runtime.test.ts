import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PegasContract } from "./types.js";
import { runRuntimeCompose, removeProjectContainers, followRuntimeLogs } from "./runtime.js";

const FIXTURE_BIN = path.join(import.meta.dir, "..", ".testfixtures", "bin");
const logFile = path.join(os.tmpdir(), "pegas-runtime-test-docker.log");
let originalPath: string | undefined;

function dockerCalls(): string[] {
  try {
    return fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("runtime compose execution", () => {
  let projectRoot: string;

  beforeAll(() => {
    originalPath = process.env.PATH;
    process.env.PATH = `${FIXTURE_BIN}:${process.env.PATH}`;
    process.env.PEGAS_FAKE_DOCKER_LOG = logFile;
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pegas-runtime-"));
    fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "rt",
      scripts: { dev: "bun dev", start: "bun start" },
    }));
    fs.writeFileSync(path.join(projectRoot, "Dockerfile"), "FROM oven/bun:1\n");
  });

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    delete process.env.PEGAS_FAKE_DOCKER_LOG;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const contract: PegasContract = {
    runtime: "docker",
    services: {
      web: { role: "app", port: 3000, build: { context: ".", dockerfile: "Dockerfile" }, domains: {} },
    },
  };

  it("runs a non-up compose operation without touching the shared network", async () => {
    fs.rmSync(logFile, { force: true });
    await runRuntimeCompose(contract, projectRoot, "rt-abc123", ["ps", "services"], { ...process.env, PEGAS_ENV: "dev" });
    const calls = dockerCalls();
    expect(calls.some((c) => c.startsWith("compose") && c.includes("rt-abc123-development"))).toBe(true);
    expect(calls.some((c) => c.startsWith("network"))).toBe(false);
    // no compose manifest is written to the project
    expect(fs.readdirSync(projectRoot).filter((f) => f.includes("compose")).length).toBe(0);
  });

  it("ensures the shared network before an up operation", async () => {
    fs.rmSync(logFile, { force: true });
    await runRuntimeCompose(contract, projectRoot, "rt-abc123", ["up", "-d"], { ...process.env, PEGAS_ENV: "production" });
    const calls = dockerCalls();
    expect(calls.some((c) => c.startsWith("network inspect") || c.startsWith("network create"))).toBe(true);
    expect(calls.some((c) => c.startsWith("compose") && c.includes("rt-abc123-production"))).toBe(true);
  });

  it("surfaces docker compose stderr on failure", async () => {
    fs.rmSync(logFile, { force: true });
    const previous = process.env.PEGAS_FAKE_COMPOSE_FAIL;
    process.env.PEGAS_FAKE_COMPOSE_FAIL = "1";
    let message = "";
    try {
      await runRuntimeCompose(contract, projectRoot, "rt-abc123", ["up", "-d"], { ...process.env, PEGAS_ENV: "development" });
    } catch (e: any) {
      message = e.message;
    } finally {
      if (previous === undefined) delete process.env.PEGAS_FAKE_COMPOSE_FAIL;
      else process.env.PEGAS_FAKE_COMPOSE_FAIL = previous;
    }
    expect(message).toContain("port is already allocated");
  });

  it("removes listed containers with the environment label filter", async () => {
    fs.rmSync(logFile, { force: true });
    await removeProjectContainers("rt-abc123", "prod");
    const calls = dockerCalls();
    expect(calls.some((c) => c.includes("label=pegas.project=rt-abc123"))).toBe(true);
    expect(calls.some((c) => c.includes("label=pegas.environment=production"))).toBe(true);
    expect(calls.some((c) => c.startsWith("rm -f"))).toBe(true);
  });

  it("attaches to logs through the read-only compose logs command", async () => {
    fs.rmSync(logFile, { force: true });
    await followRuntimeLogs(contract, projectRoot, "rt-abc123", { ...process.env, PEGAS_ENV: "development" });
    const calls = dockerCalls();
    const logsCall = calls.find((c) => c.startsWith("compose") && c.includes("logs"));
    expect(logsCall).toBeDefined();
    expect(logsCall).toContain("--follow");
    expect(logsCall).toContain("rt-abc123-development");
    // nothing destructive was spawned
    expect(calls.some((c) => c.startsWith("rm") || c.includes(" down"))).toBe(false);
  });
});