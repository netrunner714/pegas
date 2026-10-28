import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import child_process from "node:child_process";
import { handleDown } from "./down.js";
import { getProjectRouteFilePath } from "../gateway.js";
import { CONTRACT_FILENAME } from "../contract.js";

describe("pegas down", () => {
  it("removes project route file conf.d/<projectName>.caddy and cleans up", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-"));
    const projectName = path.basename(tmpProj).toLowerCase().replace(/[^a-z0-9._-]/g, "_");

    // Pre-create project route file in gateway
    const routeFile = getProjectRouteFilePath(tmpGateway, projectName);
    await fs.mkdir(path.dirname(routeFile), { recursive: true });
    await fs.writeFile(routeFile, "mysite.ru {\n    reverse_proxy app:3000\n}\n", "utf-8");

    expect(await fs.access(routeFile).then(() => true).catch(() => false)).toBe(true);

    const origLog = console.log;
    const origError = console.error;
    console.log = () => {};
    console.error = () => {};

    try {
      // Run handleDown with skipComposeDown: true (for unit test)
      await handleDown({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipComposeDown: true,
        json: true,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    // Verify route file was removed
    const existsAfter = await fs.access(routeFile).then(() => true).catch(() => false);
    expect(existsAfter).toBe(false);

    await fs.rm(tmpProj, { recursive: true, force: true });
    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("handles missing route file gracefully", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-"));

    const origLog = console.log;
    const origError = console.error;
    console.log = () => {};
    console.error = () => {};

    try {
      // Should not throw even if no route file exists
      await handleDown({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipComposeDown: true,
        json: true,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    await fs.rm(tmpProj, { recursive: true, force: true });
    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("reads projectName from pegas.json contract and works in terminal text mode", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-down-contract-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-contract-"));
    const customProjectName = "custom-project-slug";

    // Write contract with custom projectName
    await fs.writeFile(
      path.join(tmpProj, CONTRACT_FILENAME),
      JSON.stringify({ projectName: customProjectName, services: {} }),
      "utf-8"
    );

    const routeFile = getProjectRouteFilePath(tmpGateway, customProjectName);
    await fs.mkdir(path.dirname(routeFile), { recursive: true });
    await fs.writeFile(routeFile, "custom.local {\n  reverse_proxy :3000\n}\n", "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = () => {};

    try {
      await handleDown({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipComposeDown: true,
        json: false,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("Removed project route file"))).toBe(true);
    expect(logs.some((l) => l.includes("Reloading Caddy gateway"))).toBe(true);
    expect(logs.some((l) => l.includes("taken down and routes cleaned up successfully"))).toBe(true);
  });

  it("prints missing route info message in terminal text mode", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-down-text-missing-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-text-missing-"));

    const logs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = () => {};

    try {
      await handleDown({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipComposeDown: true,
        json: false,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("No route file found for project"))).toBe(true);
  });

  it("executes docker compose down when skipComposeDown is not set", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-down-exec-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-exec-"));

    let executedCommand = "";
    const origExecSync = child_process.execSync;
    child_process.execSync = ((cmd: string) => {
      executedCommand = cmd;
      return Buffer.from("");
    }) as any;

    const logs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = () => {};

    try {
      await handleDown({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipComposeDown: false,
        json: false,
      });
    } finally {
      child_process.execSync = origExecSync;
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(executedCommand).toBe("docker compose down");
    expect(logs.some((l) => l.includes("Stopping project containers"))).toBe(true);
  });

  it("handles docker compose down errors in json and text modes", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-down-err-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-err-"));

    const origExecSync = child_process.execSync;
    child_process.execSync = (() => {
      throw new Error("docker daemon not running");
    }) as any;

    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // JSON mode
      await handleDown({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipComposeDown: false,
        noExit: true,
        json: true,
      });

      // Text mode
      await handleDown({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipComposeDown: false,
        noExit: true,
        json: false,
      });
    } finally {
      child_process.execSync = origExecSync;
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    const jsonLog = logs.find((l) => l.includes("docker daemon not running"));
    expect(jsonLog).toBeDefined();
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.error).toContain("Failed to execute 'docker compose down'");
    expect(errors.some((e) => e.includes("Failed to execute 'docker compose down'"))).toBe(true);
  });
});
