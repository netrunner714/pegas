import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import child_process from "node:child_process";
import { resolveTargetVersion, handleUpdate } from "./update.js";
import { VERSION } from "../version.js";

describe("pegas update", () => {
  describe("resolveTargetVersion", () => {
    it("stays within the current major version by default", async () => {
      // current 1.0.0, available 1.1.1 and 2.0.0
      const res = await resolveTargetVersion("1.0.0", false, "2.0.0");
      expect(res.targetVer).toBe(VERSION); // stays within 1.x
      expect(res.hasNewerMajor).toBe(true);
      expect(res.availableMajor).toBe("2.0.0");
    });

    it("allows major upgrade when allowMajor is true", async () => {
      const res = await resolveTargetVersion("1.0.0", true, "2.0.0");
      expect(res.targetVer).toBe("2.0.0");
      expect(res.hasNewerMajor).toBe(false);
    });

    it("identifies when already on latest version", async () => {
      const res = await resolveTargetVersion(VERSION, false, VERSION);
      expect(res.targetVer).toBe(VERSION);
      expect(res.hasNewerMajor).toBe(false);
    });
  });

  describe("handleUpdate execution", () => {
    it("reports up-to-date when version matches target", async () => {
      const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-up-to-date-"));
      await fs.writeFile(
        path.join(tmpProj, "package.json"),
        JSON.stringify(
          {
            name: "my-app",
            devDependencies: { "@netrunner714/pegas": `^${VERSION}` },
          },
          null,
          2
        )
      );

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args) => logs.push(args.join(" "));

      try {
        await handleUpdate({ cwd: tmpProj, json: true });
      } finally {
        console.log = origLog;
        await fs.rm(tmpProj, { recursive: true, force: true });
      }

      const res = JSON.parse(logs[0]);
      expect(res.status).toBe("up-to-date");
      expect(res.current).toBe(VERSION);
    });

    it("updates package.json, executes package manager command, and refreshes docs", async () => {
      const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-update-live-"));
      await fs.writeFile(
        path.join(tmpProj, "package.json"),
        JSON.stringify(
          {
            name: "my-app",
            devDependencies: { "@netrunner714/pegas": "^1.0.0" },
          },
          null,
          2
        )
      );

      const origSpawnSync = child_process.spawnSync;
      let executedCmd = "";

      child_process.spawnSync = ((bin: string, args: string[]) => {
        executedCmd = `${bin} ${args.join(" ")}`;
        return { status: 0 };
      }) as any;

      try {
        await handleUpdate({ cwd: tmpProj, json: true, noExit: true });
      } finally {
        child_process.spawnSync = origSpawnSync;
        await fs.rm(tmpProj, { recursive: true, force: true });
      }

      expect(executedCmd).toContain("update @netrunner714/pegas");
    });

    it("errors gracefully when package.json is missing or lacks pegas", async () => {
      const tmpEmpty = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-empty-upd-"));
      const errors: string[] = [];
      const origError = console.error;
      console.error = (...args) => errors.push(args.join(" "));

      try {
        // 1. Missing package.json
        await handleUpdate({ cwd: tmpEmpty, noExit: true });
        expect(errors.some((e) => e.includes("package.json' не найден"))).toBe(true);

        // 2. package.json without pegas
        await fs.writeFile(path.join(tmpEmpty, "package.json"), JSON.stringify({ name: "app" }));
        await handleUpdate({ cwd: tmpEmpty, noExit: true });
        expect(errors.some((e) => e.includes("не найден в зависимостях"))).toBe(true);
      } finally {
        console.error = origError;
        await fs.rm(tmpEmpty, { recursive: true, force: true });
      }
    });
  });
});
