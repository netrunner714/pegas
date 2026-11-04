import { describe, it, expect, beforeEach, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { PegasContract } from "../types.js";

const followLogsCalls: any[] = [];
let psContainersOutput = "container-123\n";
let throwInFollow = false;

const childProcessMock = {
  execFile: Object.assign(
    (...callArgs: any[]) => {
      const cb = callArgs[callArgs.length - 1];
      setImmediate(() => cb(null, "", ""));
    },
    { [util.promisify.custom]: () => Promise.resolve({ stdout: "", stderr: "" }) }
  ),
  execFileSync: (cmd: string, args: string[]) => {
    if (cmd === "docker" && args[0] === "ps") {
      return psContainersOutput;
    }
    return "";
  },
  spawn: () => ({ on: () => {} }),
  spawnSync: () => ({ status: 0 }),
  execSync: () => "",
};

mock.module("node:child_process", () => ({ ...childProcessMock, default: childProcessMock }));
mock.module("../runtime.js", () => ({
  runRuntimeCompose: async () => {},
  followRuntimeLogs: async (contract: any, projectRoot: string, projectId: string, options: any, env: any) => {
    if (throwInFollow) throw new Error("Docker daemon connection failed");
    followLogsCalls.push({ contract, projectRoot, projectId, options, env });
  },
  removeProjectContainers: async () => {},
}));

const { handleLogs } = await import("./logs.js");

const validContract: PegasContract = {
  projectName: "logapp",
  runtime: "docker",
  services: {
    web: {
      role: "app",
      port: 3000,
      domains: {
        development: ["web.logapp.localhost"],
        production: ["logapp.com"],
      },
    },
    api: {
      role: "app",
      port: 4000,
      domains: {
        development: ["api.logapp.localhost"],
        production: ["api.logapp.com"],
      },
    },
  },
};

describe("pegas logs", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pegas-logs-"));
    fs.writeFileSync(path.join(projectRoot, "pegas.json"), JSON.stringify(validContract, null, 2));
    followLogsCalls.length = 0;
    psContainersOutput = "container-123\n";
    throwInFollow = false;
  });

  it("fails fast when pegas.json does not exist", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pegas-empty-"));
    let stderr = "";
    const origErr = console.error;
    console.error = (...args) => { stderr = args.join(" "); };
    try {
      await handleLogs({ cwd: emptyDir, noExit: true });
    } finally {
      console.error = origErr;
    }
    expect(stderr).toContain("Contract 'pegas.json' not found");

    // JSON mode
    let stdout = "";
    const origLog = console.log;
    console.log = (...args) => { stdout = args.join(" "); };
    try {
      await handleLogs({ cwd: emptyDir, json: true, noExit: true });
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain("Contract 'pegas.json' not found");
  });

  it("fails when pegas.json has invalid JSON syntax", async () => {
    fs.writeFileSync(path.join(projectRoot, "pegas.json"), "{ invalid: json");
    let stderr = "";
    const origErr = console.error;
    console.error = (...args) => { stderr = args.join(" "); };
    try {
      await handleLogs({ cwd: projectRoot, noExit: true });
    } finally {
      console.error = origErr;
    }
    expect(stderr).toContain("Failed to parse 'pegas.json'");
  });

  it("validates requested service name against contract.services", async () => {
    let stderr = "";
    const origErr = console.error;
    console.error = (...args) => { stderr = args.join(" "); };
    try {
      await handleLogs({ cwd: projectRoot, service: "nonexistent", noExit: true });
    } finally {
      console.error = origErr;
    }
    expect(stderr).toContain("Service 'nonexistent' not found in pegas.json");
    expect(stderr).toContain("web, api");
  });

  it("handles when no containers are running in text mode and json mode", async () => {
    psContainersOutput = "";
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleLogs({ cwd: projectRoot, env: "production" });
      await handleLogs({ cwd: projectRoot, env: "development", service: "web" });
      await handleLogs({ cwd: projectRoot, env: "development", json: true });
    } finally {
      console.log = origLog;
    }

    expect(logs[0]).toContain("No running containers found for project 'logapp' in environment 'production'");
    expect(logs[1]).toContain("Run 'pegas deploy production' first");
    expect(logs[2]).toContain("No running containers found for service 'web'");
    const jsonOutput = JSON.parse(logs[4]);
    expect(jsonOutput.status).toBe("not_running");
    expect(jsonOutput.environment).toBe("development");
    expect(followLogsCalls.length).toBe(0);
  });

  it("streams logs with follow=false and default tail=100", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleLogs({ cwd: projectRoot, env: "development" });
    } finally {
      console.log = origLog;
    }

    expect(followLogsCalls.length).toBe(1);
    expect(followLogsCalls[0].options).toEqual({
      service: undefined,
      follow: false,
      tail: 100,
    });
    expect(followLogsCalls[0].env.PEGAS_ENV).toBe("development");
    expect(logs.some((l) => l.includes("Logs for project 'logapp' [development]"))).toBe(true);
    expect(logs.some((l) => l.includes("Tip: Use 'pegas logs -f'"))).toBe(true);
  });

  it("streams live logs with follow=true, custom tail, and specific service", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleLogs({
        cwd: projectRoot,
        env: "production",
        service: "api",
        follow: true,
        tail: 50,
      });
    } finally {
      console.log = origLog;
    }

    expect(followLogsCalls.length).toBe(1);
    expect(followLogsCalls[0].options).toEqual({
      service: "api",
      follow: true,
      tail: 50,
    });
    expect(followLogsCalls[0].env.PEGAS_ENV).toBe("production");
    expect(logs.some((l) => l.includes("Following logs for service 'api' [production]"))).toBe(true);
    expect(logs.some((l) => l.includes("Detached from logs"))).toBe(true);
  });

  it("handles errors thrown by followRuntimeLogs gracefully in text and json mode", async () => {
    throwInFollow = true;
    let stderr = "";
    const origErr = console.error;
    console.error = (...args) => { stderr = args.join(" "); };
    try {
      await handleLogs({ cwd: projectRoot, env: "development", noExit: true });
    } finally {
      console.error = origErr;
    }
    expect(stderr).toContain("Docker daemon connection failed");

    let stdout = "";
    const origLog = console.log;
    console.log = (...args) => { stdout = args.join(" "); };
    try {
      await handleLogs({ cwd: projectRoot, env: "development", json: true, noExit: true });
    } finally {
      console.log = origLog;
      throwInFollow = false;
    }
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain("Failed to stream logs");
    expect(parsed.details).toContain("Docker daemon connection failed");
  });
});
