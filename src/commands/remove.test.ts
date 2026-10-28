import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { handleRemove } from "./remove.js";
import { getRouteFilePath } from "../gateway.js";

describe("pegas remove", () => {
  it("removes existing domain route file from gateway conf.d", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-rm-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const routeFile = getRouteFilePath(tmpGateway, "old-site.com");
    await fs.writeFile(routeFile, "old-site.com { reverse_proxy app:3000 }\n", "utf-8");
    expect(await fs.access(routeFile).then(() => true).catch(() => false)).toBe(true);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleRemove({
        domain: "old-site.com",
        gatewayDir: tmpGateway,
        skipReload: true,
        json: true,
      });
    } finally {
      console.log = origLog;
    }

    const exists = await fs.access(routeFile).then(() => true).catch(() => false);
    expect(exists).toBe(false);

    const res = JSON.parse(logs[0]);
    expect(res.status).toBe("success");
    expect(res.domain).toBe("old-site.com");

    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("handles non-existent domain gracefully with error output", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-rm-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleRemove({
        domain: "non-existent.com",
        gatewayDir: tmpGateway,
        skipReload: true,
        noExit: true,
        json: true,
      });
    } finally {
      console.log = origLog;
    }

    const res = JSON.parse(logs[0]);
    expect(res.error).toContain("not found");

    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("handles missing domain argument gracefully", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleRemove({
        domain: "",
        noExit: true,
        json: true,
      });
    } finally {
      console.log = origLog;
    }

    const res = JSON.parse(logs[0]);
    expect(res.error).toContain("Missing domain argument");
  });
});
