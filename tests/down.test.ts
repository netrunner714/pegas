import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { handleDown } from "../src/commands/down.js";
import { getProjectRouteFilePath } from "../src/gateway.js";

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

    // Run handleDown with skipComposeDown: true (for unit test)
    await handleDown({
      cwd: tmpProj,
      gatewayDir: tmpGateway,
      skipComposeDown: true,
      json: true,
    });

    // Verify route file was removed
    const existsAfter = await fs.access(routeFile).then(() => true).catch(() => false);
    expect(existsAfter).toBe(false);

    await fs.rm(tmpProj, { recursive: true, force: true });
    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("handles missing route file gracefully", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-"));

    // Should not throw even if no route file exists
    await handleDown({
      cwd: tmpProj,
      gatewayDir: tmpGateway,
      skipComposeDown: true,
      json: true,
    });

    await fs.rm(tmpProj, { recursive: true, force: true });
    await fs.rm(tmpGateway, { recursive: true, force: true });
  });
});
