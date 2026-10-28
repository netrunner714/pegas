import { describe, it, expect, mock } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// Mock docker module for reload tests
let mockValidateSuccess = false;
let mockReloadSuccess = false;

mock.module("../docker.js", () => ({
  validateCaddyConfig: async () => ({
    success: mockValidateSuccess,
    stdout: mockValidateSuccess ? "valid" : "",
    stderr: mockValidateSuccess ? "" : "validation error details",
  }),
  reloadCaddyConfig: async () => ({
    success: mockReloadSuccess,
    stdout: mockReloadSuccess ? "reloaded" : "",
    stderr: mockReloadSuccess ? "" : "reload error details",
  }),
}));

// Import handleReload AFTER mock.module
import { handleReload } from "./reload.js";

describe("pegas reload", () => {
  it("handles validation failure in json mode", async () => {
    mockValidateSuccess = false;
    mockReloadSuccess = false;
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-reload-"));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      const ok = await handleReload({
        gatewayDir: tmpGateway,
        json: true,
        exitOnError: false,
      });
      expect(ok).toBe(false);
    } finally {
      console.log = origLog;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    const res = JSON.parse(logs[0]);
    expect(res.error).toBe("Validation failed");
    expect(res.details).toBe("validation error details");
  });

  it("handles validation failure in terminal text mode", async () => {
    mockValidateSuccess = false;
    mockReloadSuccess = false;
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-reload-"));

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));

    try {
      const ok = await handleReload({
        gatewayDir: tmpGateway,
        json: false,
        exitOnError: false,
      });
      expect(ok).toBe(false);
    } finally {
      console.error = origError;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(errors.some((e) => e.includes("Validation failed"))).toBe(true);
  });

  it("handles reload failure in json mode", async () => {
    mockValidateSuccess = true;
    mockReloadSuccess = false;
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-reload-"));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      const ok = await handleReload({
        gatewayDir: tmpGateway,
        json: true,
        exitOnError: false,
      });
      expect(ok).toBe(false);
    } finally {
      console.log = origLog;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    const res = JSON.parse(logs[0]);
    expect(res.error).toBe("Reload failed");
    expect(res.details).toBe("reload error details");
  });

  it("handles reload failure in terminal text mode", async () => {
    mockValidateSuccess = true;
    mockReloadSuccess = false;
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-reload-"));

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));

    try {
      const ok = await handleReload({
        gatewayDir: tmpGateway,
        json: false,
        exitOnError: false,
      });
      expect(ok).toBe(false);
    } finally {
      console.error = origError;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(errors.some((e) => e.includes("Reload failed"))).toBe(true);
  });

  it("handles successful reload in json mode", async () => {
    mockValidateSuccess = true;
    mockReloadSuccess = true;
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-reload-"));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      const ok = await handleReload({
        gatewayDir: tmpGateway,
        json: true,
        exitOnError: false,
      });
      expect(ok).toBe(true);
    } finally {
      console.log = origLog;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    const res = JSON.parse(logs[0]);
    expect(res.status).toBe("success");
    expect(res.message).toBe("Caddy configuration reloaded");
  });

  it("handles successful reload in terminal text mode and respects silent flag", async () => {
    mockValidateSuccess = true;
    mockReloadSuccess = true;
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-reload-"));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      // With silent: true -> no output
      const okSilent = await handleReload({
        gatewayDir: tmpGateway,
        json: false,
        silent: true,
      });
      expect(okSilent).toBe(true);
      expect(logs.length).toBe(0);

      // Without silent -> outputs reload banner
      const okBanner = await handleReload({
        gatewayDir: tmpGateway,
        json: false,
        silent: false,
      });
      expect(okBanner).toBe(true);
      expect(logs.some((l) => l.includes("Caddy configuration reloaded with zero downtime"))).toBe(true);
    } finally {
      console.log = origLog;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }
  });
});
