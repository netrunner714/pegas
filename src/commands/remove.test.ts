import { describe, it, expect, mock } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

let mockReloadSuccess = true;
mock.module("../docker.js", () => ({
  reloadCaddyConfig: async () => ({
    success: mockReloadSuccess,
    stderr: mockReloadSuccess ? "" : "reload docker failure",
  }),
}));

import { handleRemove } from "./remove.js";
import { getRouteFilePath } from "../gateway.js";

describe("pegas remove", () => {
  it("removes existing domain route file from gateway conf.d with json: true", async () => {
    mockReloadSuccess = true;
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-rm-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const routeFile = getRouteFilePath(tmpGateway, "old-site.com");
    await fs.writeFile(routeFile, "old-site.com { reverse_proxy app:3000 }\n", "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleRemove({
        domain: "old-site.com",
        gatewayDir: tmpGateway,
        skipReload: false,
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

  it("removes existing domain route file with text output", async () => {
    mockReloadSuccess = true;
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-rm-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const routeFile = getRouteFilePath(tmpGateway, "text-site.com");
    await fs.writeFile(routeFile, "text-site.com { reverse_proxy app:3000 }\n", "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleRemove({
        domain: "text-site.com",
        gatewayDir: tmpGateway,
        skipReload: false,
        json: false,
      });
    } finally {
      console.log = origLog;
    }

    expect(logs.some((l) => l.includes("Route for text-site.com removed"))).toBe(true);
    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("handles non-existent domain gracefully in json and text mode", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-rm-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // JSON mode
      await handleRemove({
        domain: "non-existent.com",
        gatewayDir: tmpGateway,
        skipReload: true,
        noExit: true,
        json: true,
      });

      // Text mode
      await handleRemove({
        domain: "non-existent.com",
        gatewayDir: tmpGateway,
        skipReload: true,
        noExit: true,
        json: false,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    const res = JSON.parse(logs[0]);
    expect(res.error).toContain("not found");
    expect(errors.some((e) => e.includes("Route for 'non-existent.com' not found"))).toBe(true);
  });

  it("handles missing domain argument in json and text mode", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // JSON mode
      await handleRemove({
        domain: "",
        noExit: true,
        json: true,
      });

      // Text mode
      await handleRemove({
        domain: "",
        noExit: true,
        json: false,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    const res = JSON.parse(logs[0]);
    expect(res.error).toContain("Missing domain argument");
    expect(errors.some((e) => e.includes("Missing domain argument"))).toBe(true);
  });

  it("handles reload failure in json and text mode", async () => {
    mockReloadSuccess = false;
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-rm-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const routeFile = getRouteFilePath(tmpGateway, "fail-site.com");
    await fs.writeFile(routeFile, "fail-site.com { reverse_proxy app:3000 }\n", "utf-8");

    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // JSON reload failure
      await handleRemove({
        domain: "fail-site.com",
        gatewayDir: tmpGateway,
        skipReload: false,
        noExit: true,
        json: true,
      });

      // Text reload failure
      await fs.writeFile(routeFile, "fail-site.com { reverse_proxy app:3000 }\n", "utf-8");
      await handleRemove({
        domain: "fail-site.com",
        gatewayDir: tmpGateway,
        skipReload: false,
        noExit: true,
        json: false,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    const res = JSON.parse(logs[0]);
    expect(res.error).toContain("Failed to reload Caddy");
    expect(errors.some((e) => e.includes("Failed to reload Caddy"))).toBe(true);
  });
});
