import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import child_process from "node:child_process";
import { findProjectRoot } from "./gateway.js";
import {
  validateNodeVersion,
  ensureNodeVersion,
  tryLocalDelegation,
  main,
  VERSION,
  type MainDispatchers,
} from "./index.js";

describe("validateNodeVersion", () => {
  it("validates Node version correctly", () => {
    expect(validateNodeVersion("24.0.0")).toBe(true);
    expect(validateNodeVersion("24.19.0")).toBe(true);
    expect(validateNodeVersion("25.0.0")).toBe(true);
    expect(validateNodeVersion("26.0.0")).toBe(true);

    expect(validateNodeVersion("22.0.0")).toBe(false);
    expect(validateNodeVersion("20.10.0")).toBe(false);
    expect(validateNodeVersion("18.17.0")).toBe(false);

    expect(validateNodeVersion("")).toBe(true);
    expect(validateNodeVersion("invalid")).toBe(true);
  });
});

describe("ensureNodeVersion", () => {
  it("does nothing when Node version is 24+", () => {
    expect(() => ensureNodeVersion()).not.toThrow();
  });

  it("exits with 1 when Node version is < 24", () => {
    const origNode = process.versions.node;
    const origExit = process.exit;
    const origErr = console.error;

    let exitCode: number | null = null;
    const errors: string[] = [];

    console.error = (...args) => errors.push(args.join(" "));
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`EXIT_${exitCode}`);
    }) as any;

    try {
      Object.defineProperty(process.versions, "node", { value: "22.5.0", configurable: true });
      expect(() => ensureNodeVersion()).toThrow("EXIT_1");
      expect(exitCode).toBe(1);
      expect(errors.some((e) => e.includes("requires Node.js >= 24"))).toBe(true);
    } finally {
      Object.defineProperty(process.versions, "node", { value: origNode, configurable: true });
      process.exit = origExit;
      console.error = origErr;
    }
  });
});

describe("tryLocalDelegation", () => {
  it("bypasses delegation if PEGAS_DELEGATED env is set", () => {
    const origDelegated = process.env.PEGAS_DELEGATED;
    try {
      process.env.PEGAS_DELEGATED = "1";
      expect(() => tryLocalDelegation()).not.toThrow();
    } finally {
      if (origDelegated === undefined) {
        delete process.env.PEGAS_DELEGATED;
      } else {
        process.env.PEGAS_DELEGATED = origDelegated;
      }
    }
  });

  it("bypasses delegation if no local pegas installation is found in cwd", () => {
    const origDelegated = process.env.PEGAS_DELEGATED;
    const origCwd = process.cwd();
    const tmpEmpty = syncFs.mkdtempSync(path.join(os.tmpdir(), "pegas-empty-delegation-"));

    try {
      delete process.env.PEGAS_DELEGATED;
      process.chdir(tmpEmpty);
      expect(() => tryLocalDelegation()).not.toThrow();
    } finally {
      process.chdir(origCwd);
      if (origDelegated !== undefined) {
        process.env.PEGAS_DELEGATED = origDelegated;
      }
      syncFs.rmSync(tmpEmpty, { recursive: true, force: true });
    }
  });

  it("delegates execution to local pegas when found in node_modules", () => {
    const origDelegated = process.env.PEGAS_DELEGATED;
    const origCwd = process.cwd();
    const origSpawnSync = child_process.spawnSync;
    const origExit = process.exit;

    const tmpDir = syncFs.mkdtempSync(path.join(os.tmpdir(), "pegas-local-delegation-"));
    const localPegasDir = path.join(tmpDir, "node_modules", "pegas", "dist");
    syncFs.mkdirSync(localPegasDir, { recursive: true });
    const localScript = path.join(localPegasDir, "index.js");
    syncFs.writeFileSync(localScript, "#!/usr/bin/env node\n", "utf-8");

    let spawnTarget = "";
    let exitCode: number | null = null;

    child_process.spawnSync = ((bin: string, args: string[]) => {
      spawnTarget = args[0];
      return { status: 0 };
    }) as any;

    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`EXIT_${exitCode}`);
    }) as any;

    try {
      delete process.env.PEGAS_DELEGATED;
      process.chdir(tmpDir);

      expect(() => tryLocalDelegation()).toThrow("EXIT_0");
      expect(spawnTarget).toBe(localScript);
      expect(exitCode).toBe(0);
    } finally {
      child_process.spawnSync = origSpawnSync;
      process.exit = origExit;
      process.chdir(origCwd);
      if (origDelegated !== undefined) {
        process.env.PEGAS_DELEGATED = origDelegated;
      }
      syncFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prevents self-delegation loop when current script is target script", () => {
    const origDelegated = process.env.PEGAS_DELEGATED;
    const origCwd = process.cwd();
    const origArgv1 = process.argv[1];

    const tmpDir = syncFs.mkdtempSync(path.join(os.tmpdir(), "pegas-self-delegation-"));
    const localPegasDir = path.join(tmpDir, "node_modules", "pegas", "dist");
    syncFs.mkdirSync(localPegasDir, { recursive: true });
    const localScript = path.join(localPegasDir, "index.js");
    syncFs.writeFileSync(localScript, "#!/usr/bin/env node\n", "utf-8");

    try {
      delete process.env.PEGAS_DELEGATED;
      process.chdir(tmpDir);
      process.argv[1] = localScript;

      expect(() => tryLocalDelegation()).not.toThrow();
    } finally {
      process.argv[1] = origArgv1;
      process.chdir(origCwd);
      if (origDelegated !== undefined) {
        process.env.PEGAS_DELEGATED = origDelegated;
      }
      syncFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("findProjectRoot", () => {
  it("finds git root from a nested subfolder", async () => {
    const nestedDir = path.resolve(import.meta.dir, "commands");
    const root = await findProjectRoot(nestedDir);
    expect(root).toBe(path.resolve(import.meta.dir, ".."));
  });

  it("finds package.json root when no .git exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-test-"));
    const subDir = path.join(tmpDir, "deep", "nested", "folder");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}", "utf-8");

    const root = await findProjectRoot(subDir);
    expect(root).toBe(tmpDir);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when neither .git nor package.json exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-empty-"));
    const subDir = path.join(tmpDir, "sub");
    await fs.mkdir(subDir, { recursive: true });

    const root = await findProjectRoot(subDir);
    expect(root).toBeNull();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe("main CLI command routing", () => {
  const origLog = console.log;
  const origError = console.error;

  it("prints help on --help, -h, or empty arguments", async () => {
    const logs: string[] = [];
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await main(["--help"]);
      await main(["-h"]);
      await main([]);
    } finally {
      console.log = origLog;
    }

    expect(logs.every((l) => l.includes("USAGE:") && l.includes(`pegas v${VERSION}`))).toBe(true);
  });

  it("prints version on --version or -v", async () => {
    const logs: string[] = [];
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await main(["--version"]);
      await main(["-v"]);
    } finally {
      console.log = origLog;
    }

    expect(logs.every((l) => l.includes(`pegas v${VERSION}`))).toBe(true);
  });

  it("handles unknown commands with error message and exit code", async () => {
    const errors: string[] = [];
    console.error = (...args) => errors.push(args.join(" "));

    try {
      await main(["invalid-command"], { noExit: true });
    } finally {
      console.error = origError;
    }

    expect(errors.some((e) => e.includes("Unknown command: 'invalid-command'"))).toBe(true);
  });

  it("dispatches 'init' command with parsed options", async () => {
    const calls: Record<string, any> = {};
    const dispatchers: MainDispatchers = {
      handleInit: async (opts) => {
        calls.init = opts;
      },
    };

    await main(
      [
        "init",
        "--gateway-dir",
        "/etc/pegas",
        "--server",
        "--project",
        "--email",
        "test@pegas.io",
        "--network",
        "custom-net",
        "--dry-run",
        "--json",
      ],
      { dispatchers }
    );

    expect(calls.init).toEqual({
      gatewayDir: "/etc/pegas",
      server: true,
      project: true,
      email: "test@pegas.io",
      networkName: "custom-net",
      dryRun: true,
      json: true,
    });
  });

  it("dispatches 'dev' command with positional and double-dash arguments", async () => {
    const calls: Record<string, any> = {};
    const dispatchers: MainDispatchers = {
      handleDev: async (opts) => {
        calls.dev = opts;
      },
    };

    // With double-dash and infra flag
    await main(["dev", "--infra", "--", "next", "dev", "--port", "3000"], { dispatchers });
    expect(calls.dev).toEqual({
      command: ["next", "dev", "--port", "3000"],
      infra: true,
    });

    // Without double-dash and no-infra flag
    await main(["dev", "--no-infra", "vite"], { dispatchers });
    expect(calls.dev).toEqual({
      command: ["vite"],
      infra: false,
    });
  });

  it("dispatches 'deploy' command with parsed options", async () => {
    const calls: Record<string, any> = {};
    const dispatchers: MainDispatchers = {
      handleDeploy: async (opts) => {
        calls.deploy = opts;
      },
    };

    await main(
      [
        "deploy",
        "--gateway-dir",
        "/var/caddy",
        "--dry-run",
        "--skip-up",
        "--skip-readiness",
        "--strict-dns",
        "--skip-dns-check",
        "--json",
      ],
      { dispatchers }
    );

    expect(calls.deploy).toEqual({
      gatewayDir: "/var/caddy",
      dryRun: true,
      skipUp: true,
      skipReadiness: true,
      strictDns: true,
      skipDnsCheck: true,
      json: true,
    });
  });

  it("dispatches 'down' command with options", async () => {
    const calls: Record<string, any> = {};
    const dispatchers: MainDispatchers = {
      handleDown: async (opts) => {
        calls.down = opts;
      },
    };

    await main(["down", "--gateway-dir", "/srv/gw", "--json"], { dispatchers });

    expect(calls.down).toEqual({
      gatewayDir: "/srv/gw",
      json: true,
    });
  });

  it("dispatches 'add' command with domain and options", async () => {
    const calls: Record<string, any> = {};
    const dispatchers: MainDispatchers = {
      handleAdd: async (opts) => {
        calls.add = opts;
      },
    };

    await main(
      [
        "add",
        "app.example.com",
        "-u",
        "web:3000",
        "--spa",
        "--api-upstream",
        "api:8000",
        "--api-prefix",
        "/api/*",
        "--no-www",
        "--force",
        "--dry-run",
        "--gateway-dir",
        "/opt/pegas",
        "--json",
      ],
      { dispatchers }
    );

    expect(calls.add).toEqual({
      domain: "app.example.com",
      upstream: "web:3000",
      spa: true,
      apiUpstream: "api:8000",
      apiPrefix: "/api/*",
      noWww: true,
      force: true,
      dryRun: true,
      gatewayDir: "/opt/pegas",
      json: true,
    });
  });

  it("dispatches 'list' and 'ls' command aliases", async () => {
    const calls: Record<string, any> = {};
    const dispatchers: MainDispatchers = {
      handleList: async (opts) => {
        calls.list = opts;
      },
    };

    await main(["list", "--gateway-dir", "/etc/caddy", "--json"], { dispatchers });
    expect(calls.list).toEqual({
      gatewayDir: "/etc/caddy",
      json: true,
    });

    calls.list = null;
    await main(["ls", "--gateway-dir", "/etc/caddy2", "--json"], { dispatchers });
    expect(calls.list).toEqual({
      gatewayDir: "/etc/caddy2",
      json: true,
    });
  });

  it("dispatches 'remove' and 'rm' command aliases", async () => {
    const calls: Record<string, any> = {};
    const dispatchers: MainDispatchers = {
      handleRemove: async (opts) => {
        calls.remove = opts;
      },
    };

    await main(["remove", "demo.com", "--gateway-dir", "/var/pegas", "--json"], { dispatchers });
    expect(calls.remove).toEqual({
      domain: "demo.com",
      gatewayDir: "/var/pegas",
      json: true,
    });

    calls.remove = null;
    await main(["rm", "demo.com", "--gateway-dir", "/var/pegas2", "--json"], { dispatchers });
    expect(calls.remove).toEqual({
      domain: "demo.com",
      gatewayDir: "/var/pegas2",
      json: true,
    });
  });

  it("dispatches 'reload' command", async () => {
    const calls: Record<string, any> = {};
    const dispatchers: MainDispatchers = {
      handleReload: async (opts) => {
        calls.reload = opts;
        return true;
      },
    };

    await main(["reload", "--gateway-dir", "/var/pegas", "--json"], { dispatchers });
    expect(calls.reload).toEqual({
      gatewayDir: "/var/pegas",
      json: true,
    });
  });

  it("dispatches 'status' command", async () => {
    const calls: Record<string, any> = {};
    const dispatchers: MainDispatchers = {
      handleStatus: async (opts) => {
        calls.status = opts;
      },
    };

    await main(["status", "--gateway-dir", "/var/pegas", "--json"], { dispatchers });
    expect(calls.status).toEqual({
      gatewayDir: "/var/pegas",
      json: true,
    });
  });

  it("dispatches 'llms' command", async () => {
    const calls: Record<string, any> = {};
    const dispatchers: MainDispatchers = {
      handleLlms: (opts) => {
        calls.llms = opts;
      },
    };

    await main(["llms", "--json"], { dispatchers });
    expect(calls.llms).toEqual({
      json: true,
    });
  });
});
