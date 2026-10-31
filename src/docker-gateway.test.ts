import { describe, it, expect, beforeEach, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import * as realChildProcess from "node:child_process";

const execFileSyncCalls: { cmd: string; args: string[]; opts: any }[] = [];
let execSyncImpl: (cmd: string, args: string[]) => string = () => "";
let execFileImpl: (cmd: string, args: string[]) => string = () => "";

const childProcessMock = {
  execFile: Object.assign(
    (...callArgs: any[]) => {
      const cb = callArgs[callArgs.length - 1];
      try {
        const out = execFileImpl(callArgs[0], callArgs[1]);
        setImmediate(() => cb(null, out, ""));
      } catch (e: any) {
        setImmediate(() => cb(e, "", String(e.message)));
      }
    },
    { [util.promisify.custom]: (cmd: string, args: string[]) => Promise.resolve({ stdout: execFileImpl(cmd, args), stderr: "" }) }
  ),
  execFileSync: (cmd: string, args: string[], opts: any) => {
    execFileSyncCalls.push({ cmd, args, opts });
    return execSyncImpl(cmd, args);
  },
  spawn: () => ({ on: () => {} }),
  spawnSync: () => ({ status: 0 }),
  execSync: () => "",
};

mock.module("node:child_process", () => ({ ...childProcessMock, default: childProcessMock }));

const {
  ensureGatewayContainer,
  stopGatewayIfUnused,
  startGatewayContainer,
  getGatewayContainerStatus,
  validateCaddyConfig,
  reloadCaddyConfig,
} = await import("./docker.js");



describe("shared gateway container management", () => {
  let gatewayDir: string;

  beforeEach(() => {
    gatewayDir = fs.mkdtempSync(path.join(os.tmpdir(), "pegas-gw-"));
    execFileSyncCalls.length = 0;
    execSyncImpl = () => "";
    execFileImpl = () => "";
  });

  it("starts the gateway with an inline override passed via stdin", async () => {
    fs.writeFileSync(path.join(gatewayDir, "compose.yml"), "services: {}\n");
    execFileImpl = (cmd, args) => {
      if (args[0] === "network" && args[1] === "inspect") return '[{"Driver":"bridge","Internal":false}]';
      return "";
    };
    const res = await ensureGatewayContainer(gatewayDir);
    expect(res.success).toBe(true);
    const upCall = execFileSyncCalls.find((c) => c.args[0] === "compose" && c.args.includes("up"));
    expect(upCall).toBeDefined();
    const override = String(upCall!.opts.input);
    expect(override).toContain("pegas.gateway");
    expect(override).toContain("pegas-gateway");
    // the override is never persisted to disk
    expect(fs.readdirSync(gatewayDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).length).toBe(1);
  });

  it("fails when the gateway directory has no Compose file", async () => {
    const res = await ensureGatewayContainer(gatewayDir);
    expect(res.success).toBe(false);
    expect(res.stderr).toContain("No Compose file found");
  });

  it("translates docker bind errors into a clear gateway diagnostic", async () => {
    fs.writeFileSync(path.join(gatewayDir, "docker-compose.yml"), "services: {}\n");
    execFileImpl = (cmd, args) => {
      if (args[0] === "network" && args[1] === "inspect") return '[{"Driver":"bridge","Internal":false}]';
      return "";
    };
    execSyncImpl = (cmd, args) => {
      if (args[0] === "compose") throw Object.assign(new Error("bind failed"), { stderr: "Error response from daemon: driver failed binding: port is already allocated" });
      return "";
    };
    const res = await ensureGatewayContainer(gatewayDir);
    expect(res.success).toBe(false);
    expect(res.stderr).toContain("Shared Caddy Gateway cannot bind host port 80 or 443");
  });

  it("retains the gateway while other pegas project containers exist (including stopped ones)", async () => {
    execFileImpl = (cmd, args) => {
      if (args[0] === "ps" && args.includes("-aq")) return "abc123\n";
      return "";
    };
    const res = await stopGatewayIfUnused(gatewayDir);
    expect(res.success).toBe(true);
    expect(res.stdout).toContain("Gateway retained");
  });

  it("stops running gateway containers when no project holders remain", async () => {
    const stopped: string[] = [];
    execFileImpl = (cmd, args) => {
      if (args[0] === "ps" && args.includes("-aq")) return "";
      if (args[0] === "ps") return "gw1\ngw2\n";
      if (args[0] === "stop") { stopped.push(args.join(" ")); return ""; }
      return "";
    };
    const res = await stopGatewayIfUnused(gatewayDir);
    expect(res.success).toBe(true);
    expect(res.stdout).toContain("Shared Gateway stopped");
    expect(stopped[0]).toContain("gw1");
    expect(stopped[0]).toContain("gw2");
  });

  it("reports an already-stopped gateway without calling docker stop", async () => {
    const stopped: string[] = [];
    execFileImpl = (cmd, args) => {
      if (args[0] === "ps" && args.includes("-aq")) return "";
      if (args[0] === "ps") return "";
      if (args[0] === "stop") { stopped.push(args.join(" ")); return ""; }
      return "";
    };
    const res = await stopGatewayIfUnused(gatewayDir);
    expect(res.success).toBe(true);
    expect(res.stdout).toContain("Gateway is already stopped");
    expect(stopped.length).toBe(0);
  });

  it("delegates validate/reload/status to docker compose in the gateway directory", async () => {
    const seenExec: string[][] = [];
    execFileImpl = (cmd, args) => {
      seenExec.push(args);
      return "";
    };
    const validate = await validateCaddyConfig(gatewayDir);
    const reload = await reloadCaddyConfig(gatewayDir);
    const status = await getGatewayContainerStatus(gatewayDir);
    const started = await startGatewayContainer(gatewayDir);
    expect(validate.success).toBe(true);
    expect(reload.success).toBe(true);
    expect(status.success).toBe(true);
    expect(started.success).toBe(true);
    expect(seenExec.some((a) => a.includes("validate"))).toBe(true);
    expect(seenExec.some((a) => a.includes("reload"))).toBe(true);
    expect(seenExec.some((a) => a.includes("up") && a.includes("-d"))).toBe(true);
  });
});