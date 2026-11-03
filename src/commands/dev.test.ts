import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let mockGatewayStarted = true;
let reloadCalls: any[] = [];
let execFileCalls: any[] = [];
let spawnSyncCalls: any[] = [];

mock.module("../docker.js", () => ({
  ensureGatewayContainer: async () => ({
    success: mockGatewayStarted,
    stdout: "",
    stderr: mockGatewayStarted ? "" : "Docker not running",
  }),
}));

mock.module("../gateway.js", () => ({
  findProjectRoot: async (cwd: string) => cwd,
  findGatewayDir: async (override?: string) => override || "/mock/gateway",
  getProjectRouteFilePath: (gatewayDir: string, projectName: string, env?: string) => {
    const sanitized = projectName.toLowerCase().replace(/[^a-z0-9._-]/g, "_");
    const suffix = env ? `-${env.toLowerCase()}` : "";
    return path.join(gatewayDir, "conf.d", `${sanitized}${suffix}.caddy`);
  },
  reloadGateway: async (opts: any) => {
    reloadCalls.push(opts);
    return { success: true };
  },
}));

mock.module("node:child_process", () => ({
  execFileSync: (cmd: string, args: string[], options: any) => {
    execFileCalls.push({ cmd, args, options });
    return "";
  },
  spawnSync: (cmd: string, args: string[], options: any) => {
    spawnSyncCalls.push({ cmd, args, options });
    return { status: 0, signal: null };
  },
  default: {
    execFileSync: (cmd: string, args: string[], options: any) => {
      execFileCalls.push({ cmd, args, options });
      return "";
    },
    spawnSync: (cmd: string, args: string[], options: any) => {
      spawnSyncCalls.push({ cmd, args, options });
      return { status: 0, signal: null };
    },
  },
}));

const { handleDev } = await import("./dev.js");

describe("pegas dev command", () => {
  let tmpDir: string;
  let tmpGateway: string;
  const origLog = console.log;
  const origError = console.error;
  let loggedOutput: string[] = [];
  let errorOutput: string[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pegas-dev-test-"));
    tmpGateway = path.join(tmpDir, "gateway");
    fs.mkdirSync(path.join(tmpGateway, "conf.d"), { recursive: true });

    mockGatewayStarted = true;
    reloadCalls = [];
    execFileCalls = [];
    spawnSyncCalls = [];
    loggedOutput = [];
    errorOutput = [];

    console.log = (...args) => loggedOutput.push(args.join(" "));
    console.error = (...args) => errorOutput.push(args.join(" "));
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origError;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("fails gracefully when pegas.json is missing", async () => {
    await handleDev({ cwd: tmpDir, noExit: true });
    expect(errorOutput.join(" ")).toContain("Contract pegas.json not found");

    loggedOutput = [];
    await handleDev({ cwd: tmpDir, json: true, noExit: true });
    const parsed = JSON.parse(loggedOutput.join("\n"));
    expect(parsed.error).toContain("Contract pegas.json not found");
  });

  it("fails gracefully when pegas.json contains invalid JSON", async () => {
    fs.writeFileSync(path.join(tmpDir, "pegas.json"), "{ invalid: json ");
    await handleDev({ cwd: tmpDir, noExit: true });
    expect(errorOutput.join(" ")).toContain("Invalid JSON");

    loggedOutput = [];
    await handleDev({ cwd: tmpDir, json: true, noExit: true });
    const parsed = JSON.parse(loggedOutput.join("\n"));
    expect(parsed.error).toContain("Invalid JSON");
  });

  it("fails gracefully when pegas.json has validation errors", async () => {
    fs.writeFileSync(path.join(tmpDir, "pegas.json"), JSON.stringify({ projectName: "Bad Project!" }));
    await handleDev({ cwd: tmpDir, noExit: true });
    expect(errorOutput.join(" ")).toContain("Invalid pegas.json");

    loggedOutput = [];
    await handleDev({ cwd: tmpDir, json: true, noExit: true });
    const parsed = JSON.parse(loggedOutput.join("\n"));
    expect(parsed.error).toContain("Invalid pegas.json");
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("fails when gateway fails to start in non-dry-run mode", async () => {
    mockGatewayStarted = false;
    fs.writeFileSync(
      path.join(tmpDir, "pegas.json"),
      JSON.stringify({
        projectName: "gwfail",
        services: { web: { port: 3000, domains: { development: ["gwfail.localhost"] } } },
      })
    );

    await handleDev({ cwd: tmpDir, gatewayDir: tmpGateway, noExit: true });
    expect(errorOutput.join(" ")).toContain("Could not start shared Pegas Gateway");
  });

  it("prepares Caddy routes proxying to host.docker.internal and reloads gateway", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "pegas.json"),
      JSON.stringify({
        projectName: "myapp",
        services: {
          site: {
            port: 3000,
            routes: {
              "/api/*": "api:3002",
            },
            domains: {
              development: ["myapp.localhost", "site.myapp.localhost"],
            },
          },
          api: {
            port: 3002,
            domains: {
              development: ["api.myapp.localhost"],
            },
          },
          redis: {
            role: "infra",
            image: "redis:7-alpine",
          },
        },
      })
    );

    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "myapp",
        scripts: { dev: "vite" },
      })
    );

    await handleDev({
      cwd: tmpDir,
      gatewayDir: tmpGateway,
      noRun: true,
      noExit: true,
    });

    // Check route file
    const routeFile = path.join(tmpGateway, "conf.d", "myapp-development.caddy");
    expect(fs.existsSync(routeFile)).toBe(true);
    const content = fs.readFileSync(routeFile, "utf-8");

    // Routes point to host.docker.internal
    expect(content).toContain("reverse_proxy host.docker.internal:3000");
    expect(content).toContain("reverse_proxy host.docker.internal:3002");
    expect(content).toContain("myapp.localhost");
    expect(content).toContain("api.myapp.localhost");

    // Check gateway reload called
    expect(reloadCalls.length).toBe(1);

    // Check infra service was started via docker compose up -d redis
    expect(execFileCalls.length).toBe(1);
    expect(execFileCalls[0].cmd).toBe("docker");
    expect(execFileCalls[0].args).toContain("up");
    expect(execFileCalls[0].args).toContain("-d");
    expect(execFileCalls[0].args).toContain("redis");

    // noRun prevented spawnSync
    expect(spawnSyncCalls.length).toBe(0);
  });

  it("supports dry-run mode without writing files or calling docker", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "pegas.json"),
      JSON.stringify({
        projectName: "dryapp",
        services: {
          web: {
            port: 3000,
            domains: { development: ["dryapp.localhost"] },
          },
          redis: {
            role: "infra",
            image: "redis:7-alpine",
          },
        },
      })
    );

    await handleDev({
      cwd: tmpDir,
      gatewayDir: tmpGateway,
      dryRun: true,
      noExit: true,
    });

    const routeFile = path.join(tmpGateway, "conf.d", "dryapp-development.caddy");
    expect(fs.existsSync(routeFile)).toBe(false);
    expect(reloadCalls.length).toBe(0);
    expect(execFileCalls.length).toBe(0);
    expect(spawnSyncCalls.length).toBe(0);
  });

  it("launches detected dev server or custom command when not noRun", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "pegas.json"),
      JSON.stringify({
        projectName: "runapp",
        services: {
          web: { port: 3000, domains: { development: ["runapp.localhost"] } },
        },
      })
    );

    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: { dev: "vite" },
      })
    );

    // Test default script detection
    await handleDev({
      cwd: tmpDir,
      gatewayDir: tmpGateway,
      noExit: true,
    });

    expect(spawnSyncCalls.length).toBe(1);
    expect(spawnSyncCalls[0].args).toEqual(["run", "dev"]);

    // Test explicit command override
    spawnSyncCalls = [];
    await handleDev({
      cwd: tmpDir,
      gatewayDir: tmpGateway,
      command: ["bun", "run", "custom-script"],
      noExit: true,
    });

    expect(spawnSyncCalls.length).toBe(1);
    expect(spawnSyncCalls[0].cmd).toBe("bun");
    expect(spawnSyncCalls[0].args).toEqual(["run", "custom-script"]);
  });

  it("outputs machine-readable JSON with json: true", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "pegas.json"),
      JSON.stringify({
        projectName: "jsonapp",
        services: {
          web: { port: 3000, domains: { development: ["jsonapp.localhost"] } },
        },
      })
    );

    await handleDev({
      cwd: tmpDir,
      gatewayDir: tmpGateway,
      noRun: true,
      json: true,
      noExit: true,
    });

    const parsed = JSON.parse(loggedOutput.join("\n"));
    expect(parsed.status).toBe("ready");
    expect(parsed.project).toBe("jsonapp");
    expect(parsed.urls[0].url).toBe("https://jsonapp.localhost");
    expect(parsed.urls[0].upstream).toBe("127.0.0.1:3000");
  });
});
