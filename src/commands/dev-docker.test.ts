import { describe, it, expect, beforeEach, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import * as realChildProcess from "node:child_process";
import { PegasContract } from "../types.js";

const inspectCalls: string[][] = [];
const logsAttach: string[] = [];
let listedContainers = "";
let inspectedContainers = "[]";

const childProcessMock = {
  execFile: Object.assign(
    (...callArgs: any[]) => {
      const cb = callArgs[callArgs.length - 1];
      setImmediate(() => cb(null, "", ""));
    },
    { [util.promisify.custom]: () => Promise.resolve({ stdout: "", stderr: "" }) }
  ),
  execFileSync: (cmd: string, args: string[]) => {
    inspectCalls.push(args);
    if (args[0] === "ps") return listedContainers;
    if (args[0] === "inspect") return inspectedContainers;
    return "";
  },
  spawn: () => ({ on: () => {} }),
  spawnSync: () => ({ status: 0 }),
  execSync: () => "",
};

mock.module("node:child_process", () => ({ ...childProcessMock, default: childProcessMock }));
mock.module("../runtime.js", () => ({
  runRuntimeCompose: async () => {},
  followRuntimeLogs: async (...callArgs: any[]) => { logsAttach.push(String(callArgs[3]?.PEGAS_ENV)); },
}));
mock.module("../runtime-lock.js", () => ({
  withRuntimeLock: async (op: any) => op(),
}));
mock.module("../docker.js", () => ({
  runCommand: async () => ({ success: true, stdout: "gateway-id", stderr: "" }),
  ensureGatewayContainer: async () => ({ success: true, stdout: "", stderr: "" }),
  ensureDockerNetwork: async () => true,
  validateCaddyConfig: async () => ({ success: true, stdout: "", stderr: "" }),
  reloadCaddyConfig: async () => ({ success: true, stdout: "", stderr: "" }),
  startGatewayContainer: async () => ({ success: true, stdout: "", stderr: "" }),
  getGatewayContainerStatus: async () => ({ success: true, stdout: "", stderr: "" }),
}));

const { handleDev } = await import("./dev.js");

const contract: PegasContract = {
  projectName: "devapp",
  runtime: "docker",
  services: {
    web: { role: "app", port: 3000, build: { context: ".", dockerfile: "Dockerfile" }, domains: { development: ["devapp.localhost"] } },
  },
};



describe("pegas dev (docker runtime)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pegas-dev-"));
    fs.writeFileSync(path.join(projectRoot, "pegas.json"), JSON.stringify(contract));
    fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "devapp", scripts: { dev: "bun dev" } }));
    fs.writeFileSync(path.join(projectRoot, "Dockerfile"), "FROM oven/bun:1\n");
    inspectCalls.length = 0;
    logsAttach.length = 0;
    listedContainers = "container-1";
  });

  it("fails fast when the docker environment is not deployed", async () => {
    listedContainers = "";
    let stderr = "";
    const orig = console.error;
    console.error = (...args: any[]) => { stderr = args.join(" "); };
    try {
      await handleDev({ cwd: projectRoot, noExit: true });
    } finally {
      console.error = orig;
    }
    expect(stderr).toContain("not deployed");
  });

  it("attaches to logs when the deployed environment matches the contract", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    console.warn = () => {};
    console.error = () => {};
    try {
      // hash labels match the generated manifest: build manifest first via createRuntimeCompose logic is complex;
      // instead the drift checks require matching hashes. Simpler: make container labels match by computing them.
      const { createRuntimeCompose } = await import("../runtime-compose.js");
      const generated = createRuntimeCompose(contract as any, {
        projectRoot,
        projectId: (await import("../contract.js")).getProjectRuntimeId(projectRoot, "devapp"),
        environment: "development",
      });
      const webService = (generated.manifest.services as any).web;
      inspectedContainers = JSON.stringify([{
        Config: { Labels: webService.labels },
        State: { Status: "running" },
      }]);
      await handleDev({ cwd: projectRoot, noExit: true });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    }
    expect(logsAttach.length).toBe(1);
    expect(logsAttach[0]).toBe("development");
    expect(logs.some((l) => l.includes("devapp.localhost"))).toBe(true);
    expect(logs.some((l) => l.includes("Ctrl+C"))).toBe(true);
  });

  it("reports drift instead of running destructive changes", async () => {
    inspectedContainers = JSON.stringify([{
      Config: { Labels: { "pegas.service": "web", "pegas.manifest-hash": "stale-hash" } },
      State: { Status: "running" },
    }]);
    let stderr = "";
    const orig = console.error;
    console.error = (...args: any[]) => { stderr = args.join(" "); };
    try {
      await handleDev({ cwd: projectRoot, noExit: true });
    } finally {
      console.error = orig;
    }
    expect(stderr).toContain("does not match");
    expect(stderr).toContain("configuration drift");
    // dev must not attach to logs when the environment drifted
    expect(logsAttach.length).toBe(0);
  });

  it("warns about host node_modules shadowed by the dependency volume", async () => {
    fs.mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
    let warned = "";
    const orig = console.warn;
    console.warn = (...args: any[]) => { warned += args.join(" "); };
    try {
      listedContainers = "";
      await handleDev({ cwd: projectRoot, noExit: true });
    } finally {
      console.warn = orig;
    }
    expect(warned).toContain("does NOT update the container");
  });

  it("requires a pegas.json contract before anything else", async () => {
    fs.rmSync(path.join(projectRoot, "pegas.json"));
    let stderr = "";
    const orig = console.error;
    console.error = (...args: any[]) => { stderr = args.join(" "); };
    try {
      await handleDev({ cwd: projectRoot, noExit: true });
    } finally {
      console.error = orig;
    }
    expect(stderr).toContain("Run 'pegas init' first");
  });
});