import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { handleLink } from "./link.js";
import { handleUnlink } from "./unlink.js";
import { CONTRACT_FILENAME } from "../contract.js";
import { getProjectRouteFilePath } from "../gateway.js";

describe("pegas link and unlink", () => {
  it("link generates development route file in conf.d with clean host.docker.internal upstreams", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-link-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-link-gw-"));
    const projectName = "test-link-app";

    await fs.writeFile(
      path.join(tmpProj, CONTRACT_FILENAME),
      JSON.stringify({
        projectName,
        services: {
          web: {
            port: 3000,
            domains: {
              development: ["test-link-app.localhost"],
            },
          },
          api: {
            port: 3001,
            cors: true,
            domains: {
              development: ["api.test-link-app.localhost"],
            },
          },
        },
      }),
      "utf-8"
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleLink({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        json: true,
        dryRun: false,
        noExit: true,
        skipGatewayEnsure: true,
        skipReload: true,
      });
    } finally {
      console.log = origLog;
    }

    const routeFile = getProjectRouteFilePath(tmpGateway, projectName, "development");
    const exists = await fs.access(routeFile).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(routeFile, "utf-8");
    expect(content).toContain("test-link-app.localhost");
    expect(content).toContain("host.docker.internal:3000");
    expect(content).toContain("api.test-link-app.localhost");
    expect(content).toContain("host.docker.internal:3001");

    const jsonRes = JSON.parse(logs[0]);
    expect(jsonRes.status).toBe("linked");
    expect(jsonRes.project).toBe(projectName);
    expect(jsonRes.urls.length).toBe(2);

    // Now test unlink removes the route file
    const unlinkLogs: string[] = [];
    console.log = (...args) => unlinkLogs.push(args.join(" "));

    try {
      await handleUnlink({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        json: true,
        dryRun: false,
        noExit: true,
        skipReload: true,
      });
    } finally {
      console.log = origLog;
    }

    const existsAfter = await fs.access(routeFile).then(() => true).catch(() => false);
    expect(existsAfter).toBe(false);

    const unlinkRes = JSON.parse(unlinkLogs[0]);
    expect(unlinkRes.status).toBe("unlinked");
    expect(unlinkRes.project).toBe(projectName);

    await fs.rm(tmpProj, { recursive: true, force: true });
    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("handles dry-run in link and unlink without modifying gateway files", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-link-dry-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-link-gw-"));
    const projectName = "dry-app";

    await fs.writeFile(
      path.join(tmpProj, CONTRACT_FILENAME),
      JSON.stringify({
        projectName,
        services: {
          web: {
            port: 3000,
            domains: {
              development: ["dry-app.localhost"],
            },
          },
        },
      }),
      "utf-8"
    );

    await handleLink({
      cwd: tmpProj,
      gatewayDir: tmpGateway,
      dryRun: true,
      json: true,
      noExit: true,
    });

    const routeFile = getProjectRouteFilePath(tmpGateway, projectName, "development");
    const exists = await fs.access(routeFile).then(() => true).catch(() => false);
    expect(exists).toBe(false);

    await handleUnlink({
      cwd: tmpProj,
      gatewayDir: tmpGateway,
      dryRun: true,
      json: true,
      noExit: true,
    });

    await fs.rm(tmpProj, { recursive: true, force: true });
    await fs.rm(tmpGateway, { recursive: true, force: true });
  });
});
