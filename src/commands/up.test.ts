import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { handleUp } from "./up.js";

describe("pegas up", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-up-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("fails gracefully when pegas.json is missing in text and json modes", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // 1. JSON mode
      await handleUp({ cwd: tmpDir, json: true, noExit: true });
      expect(logs.length).toBeGreaterThan(0);
      const jsonRes = JSON.parse(logs[0]);
      expect(jsonRes.error).toContain("Contract 'pegas.json' not found");

      // 2. Text mode
      await handleUp({ cwd: tmpDir, json: false, noExit: true });
      expect(errors.some((e) => e.includes("Contract 'pegas.json' not found"))).toBe(true);
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  });

  it("requires explicit --env flag and lists available environments from pegas.json", async () => {
    const contract = {
      projectName: "sample-app",
      services: {
        web: {
          port: 3000,
          domains: {
            development: ["sample.localhost"],
            stage: ["stage.sample.com"],
            production: ["sample.com"],
          },
        },
      },
    };
    await fs.writeFile(path.join(tmpDir, "pegas.json"), JSON.stringify(contract), "utf-8");

    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // JSON mode
      await handleUp({ cwd: tmpDir, json: true, noExit: true });
      const jsonRes = JSON.parse(logs[0]);
      expect(jsonRes.error).toBe("Missing required option '--env <name>'");
      expect(jsonRes.availableEnvironments).toEqual(expect.arrayContaining(["development", "stage", "production"]));

      // Text mode
      await handleUp({ cwd: tmpDir, json: false, noExit: true });
      expect(errors.some((e) => e.includes("Missing required option '--env <name>'"))).toBe(true);
      expect(errors.some((e) => e.includes("Available environments in pegas.json"))).toBe(true);
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  });

  it("dispatches to deploy mode with custom environment (e.g. stage)", async () => {
    const contract = {
      projectName: "sample-app",
      services: {
        web: {
          port: 3000,
          domains: {
            development: ["sample.localhost"],
            stage: ["stage.sample.com"],
          },
        },
      },
    };
    await fs.writeFile(path.join(tmpDir, "pegas.json"), JSON.stringify(contract), "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleUp({
        cwd: tmpDir,
        env: "stage",
        dryRun: true,
        json: true,
        noExit: true,
      });

      expect(logs.length).toBeGreaterThan(0);
      const jsonRes = JSON.parse(logs[0]);
      expect(jsonRes.status).toBe("dry-run");
      expect(jsonRes.env).toBe("stage");
      expect(jsonRes.routes[0].domain).toBe("stage.sample.com");
    } finally {
      console.log = origLog;
    }
  });
});
