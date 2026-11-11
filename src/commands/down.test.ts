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

    await fs.writeFile(
      path.join(tmpProj, CONTRACT_FILENAME),
      JSON.stringify({ projectName, services: {} }),
      "utf-8"
    );

    // Pre-create project route file in gateway
    const routeFile = getProjectRouteFilePath(tmpGateway, projectName);
    await fs.mkdir(path.dirname(routeFile), { recursive: true });
    await fs.writeFile(
      routeFile,
      "# pegas:project=" + projectName + " | service=app | env=development | driver=docker | owner=deploy\n" +
        "mysite.ru {\n    reverse_proxy app:3000\n}\n",
      "utf-8"
    );

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
        noExit: true,
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

    await fs.writeFile(
      path.join(tmpProj, CONTRACT_FILENAME),
      JSON.stringify({ projectName: "test-app", services: {} }),
      "utf-8"
    );

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
        noExit: true,
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
    await fs.writeFile(
      routeFile,
      "# pegas:project=" + customProjectName + " | service=app | env=development | driver=docker | owner=deploy\n" +
        "custom.local {\n  reverse_proxy :3000\n}\n",
      "utf-8"
    );

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
        noExit: true,
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

    await fs.writeFile(
      path.join(tmpProj, CONTRACT_FILENAME),
      JSON.stringify({ projectName: "text-missing-app", services: {} }),
      "utf-8"
    );

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
        noExit: true,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("No route file found for project"))).toBe(true);
  });

  it("removes project containers via docker ps/rm labels when skipComposeDown is not set", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-down-exec-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-exec-"));

    await fs.writeFile(
      path.join(tmpProj, CONTRACT_FILENAME),
      JSON.stringify({
        projectName: "exec-app",
        scenarios: ["development"],
        gateway: { development: { httpPort: 80, httpsPort: 443 } },
        services: {
          web: { runtime: { development: { driver: "docker" } }, image: { development: "node:24" }, port: { development: 3000 } },
        },
      }),
      "utf-8"
    );

    const executed: string[] = [];
    const origExecFile = child_process.execFileSync;
    (child_process as any).execFileSync = (cmd: string, args: string[]) => {
      executed.push([cmd, ...(args || [])].join(" "));
      if (cmd === "docker" && args?.[0] === "ps") return "";
      return "";
    };

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleDown({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipComposeDown: false,
        json: false,
        noExit: true,
      });
    } finally {
      (child_process as any).execFileSync = origExecFile;
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    // Тикдаун через метки: docker ps -aq --filter label=pegas.project=...
    expect(executed.some((c) => c.startsWith("docker ps -aq") && c.includes("label=pegas.project="))).toBe(true);
    expect(logs.some((l) => l.includes("taken down"))).toBe(true);
  });

  it("handles docker compose down errors in json and text modes", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-down-err-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-err-"));

    await fs.writeFile(
      path.join(tmpProj, CONTRACT_FILENAME),
      JSON.stringify({ ...{
        projectName: "exec-app",
        scenarios: ["development"],
        gateway: { development: { httpPort: 80, httpsPort: 443 } },
        services: {
          web: { runtime: { development: { driver: "docker" } }, image: { development: "node:24" }, port: { development: 3000 } },
        },
      }, projectName: "err-app" }),
      "utf-8"
    );

    const origExecFileSync = child_process.execFileSync;
    (child_process as any).execFileSync = () => {
      throw new Error("docker daemon not running");
    };

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
      (child_process as any).execFileSync = origExecFileSync;
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    const jsonLog = logs.find((l) => l.includes("docker daemon not running"));
    expect(jsonLog).toBeDefined();
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.error).toContain("Failed to remove declarative runtime containers");
    expect(errors.some((e) => e.includes("Failed to remove declarative runtime containers"))).toBe(true);
  });

  it("aborts when no pegas.json or compose file is found", async () => {
    const tmpEmpty = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-down-empty-"));
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));

    try {
      await handleDown({
        cwd: tmpEmpty,
        noExit: true,
      });
    } finally {
      console.error = origError;
      await fs.rm(tmpEmpty, { recursive: true, force: true });
    }

    expect(errors.some((e) => e.includes("pegas.json not found"))).toBe(true);
  });
});
