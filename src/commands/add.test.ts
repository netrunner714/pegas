import { describe, it, expect, mock } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

let mockValidateSuccess = true;
let mockReloadSuccess = true;

mock.module("../docker.js", () => ({
  validateCaddyConfig: async () => ({
    success: mockValidateSuccess,
    stderr: mockValidateSuccess ? "" : "invalid caddyfile syntax",
  }),
  reloadCaddyConfig: async () => ({
    success: mockReloadSuccess,
    stderr: mockReloadSuccess ? "" : "docker reload error",
  }),
}));

import { createOrUpdateRouteFile, handleAdd } from "./add.js";

describe("pegas add", () => {
  it("createOrUpdateRouteFile generates and writes route snippet to conf.d", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-add-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const res = await createOrUpdateRouteFile({
      domain: "mysite.com",
      upstream: "web:3000",
      gatewayDir: tmpGateway,
    });

    expect(res.alreadyExists).toBe(false);
    expect(res.routeFilePath).toBe(path.join(confDir, "mysite.com.caddy"));
    expect(res.snippet).toContain("mysite.com {");
    expect(res.snippet).toContain("reverse_proxy web:3000");

    const content = await fs.readFile(res.routeFilePath, "utf-8");
    expect(content).toBe(res.snippet);

    // Second call: alreadyExists should be true
    const res2 = await createOrUpdateRouteFile({
      domain: "mysite.com",
      upstream: "web:4000",
      gatewayDir: tmpGateway,
    });
    expect(res2.alreadyExists).toBe(true);
    expect(res2.originalContent).toBe(res.snippet);

    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("createOrUpdateRouteFile supports SPA and API options", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-add-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const res = await createOrUpdateRouteFile({
      domain: "dashboard.app.com",
      upstream: "client:80",
      gatewayDir: tmpGateway,
      spa: true,
      apiUpstream: "server:8000",
      apiPrefix: "/v1/*",
    });

    expect(res.snippet).toContain("handle /v1/* {");
    expect(res.snippet).toContain("reverse_proxy server:8000");
    expect(res.snippet).toContain("handle {");
    expect(res.snippet).toContain("reverse_proxy client:80");

    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("handleAdd dry-run prints preview in json and text modes", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-add-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      // JSON dry run
      await handleAdd({
        domain: "dry-run.com",
        upstream: "api:3000",
        gatewayDir: tmpGateway,
        dryRun: true,
        json: true,
      });

      // Text dry run
      await handleAdd({
        domain: "dry-run.com",
        upstream: "api:3000",
        gatewayDir: tmpGateway,
        dryRun: true,
        json: false,
      });
    } finally {
      console.log = origLog;
    }

    const json = JSON.parse(logs[0]);
    expect(json.domain).toBe("dry-run.com");
    expect(json.snippet).toContain("reverse_proxy api:3000");
    expect(logs.some((l) => l.includes("--- Preview of"))).toBe(true);

    // File must NOT exist on disk
    const exists = await fs.access(path.join(confDir, "dry-run.com.caddy")).then(() => true).catch(() => false);
    expect(exists).toBe(false);

    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("handleAdd validates missing domain and missing upstream in json and text mode", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // JSON mode
      await handleAdd({ domain: "", upstream: "app:3000", noExit: true, json: true });
      await handleAdd({ domain: "app.com", upstream: "", noExit: true, json: true });

      // Text mode
      await handleAdd({ domain: "", upstream: "app:3000", noExit: true, json: false });
      await handleAdd({ domain: "app.com", upstream: "", noExit: true, json: false });
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    expect(logs.length).toBe(2);
    expect(JSON.parse(logs[0]).error).toContain("Missing domain argument");
    expect(JSON.parse(logs[1]).error).toContain("Missing --upstream argument");
    expect(errors.some((e) => e.includes("Missing domain name"))).toBe(true);
    expect(errors.some((e) => e.includes("Missing --upstream argument"))).toBe(true);
  });

  it("handleAdd detects existing route collision and requires --force in json and text mode", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-add-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");
    await fs.writeFile(path.join(confDir, "collision.com.caddy"), "collision.com { ... }");

    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // JSON mode
      await handleAdd({
        domain: "collision.com",
        upstream: "new:3000",
        gatewayDir: tmpGateway,
        force: false,
        noExit: true,
        json: true,
      });

      // Text mode
      await handleAdd({
        domain: "collision.com",
        upstream: "new:3000",
        gatewayDir: tmpGateway,
        force: false,
        noExit: true,
        json: false,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(JSON.parse(logs[0]).error).toContain("already exists");
    expect(errors.some((e) => e.includes("already exists"))).toBe(true);
  });

  it("rolls back changes on Caddy validation failure", async () => {
    mockValidateSuccess = false;
    mockReloadSuccess = true;

    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-add-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");

    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // Brand new file: should be deleted upon validation failure
      await handleAdd({
        domain: "bad-syntax.com",
        upstream: "app:3000",
        gatewayDir: tmpGateway,
        noExit: true,
        json: true,
      });

      const exists = await fs.access(path.join(confDir, "bad-syntax.com.caddy")).then(() => true).catch(() => false);
      expect(exists).toBe(false);

      // Overwriting existing file: should be restored upon validation failure
      const existingFile = path.join(confDir, "existing.com.caddy");
      await fs.writeFile(existingFile, "original-content", "utf-8");

      await handleAdd({
        domain: "existing.com",
        upstream: "new:3000",
        gatewayDir: tmpGateway,
        force: true,
        noExit: true,
        json: false,
      });

      const restoredContent = await fs.readFile(existingFile, "utf-8");
      expect(restoredContent).toBe("original-content");
    } finally {
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("Caddy configuration validation failed"))).toBe(true);
    expect(errors.some((e) => e.includes("Caddy configuration validation failed"))).toBe(true);
  });

  it("handles reload failure and full success in json and text mode", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-add-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");

    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // Reload failure (json and text)
      mockValidateSuccess = true;
      mockReloadSuccess = false;

      await handleAdd({
        domain: "reload-fail.com",
        upstream: "web:3000",
        gatewayDir: tmpGateway,
        noExit: true,
        json: true,
      });

      await handleAdd({
        domain: "reload-fail-text.com",
        upstream: "web:3000",
        gatewayDir: tmpGateway,
        noExit: true,
        json: false,
      });

      // Full success (json and text)
      mockReloadSuccess = true;

      await handleAdd({
        domain: "success.com",
        upstream: "web:3000",
        gatewayDir: tmpGateway,
        noExit: true,
        json: true,
      });

      await handleAdd({
        domain: "success-text.com",
        upstream: "web:3000",
        gatewayDir: tmpGateway,
        noExit: true,
        json: false,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("Failed to reload Caddy"))).toBe(true);
    expect(errors.some((e) => e.includes("Failed to reload Caddy"))).toBe(true);
    expect(logs.some((l) => l.includes('"status":"success"') && l.includes("success.com"))).toBe(true);
    expect(logs.some((l) => l.includes("successfully configured and live"))).toBe(true);
  });
});
