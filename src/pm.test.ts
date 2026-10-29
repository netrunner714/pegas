import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { detectPackageManager, getUpdateCommand } from "./pm.js";

describe("package manager detection and commands", () => {
  it("detects bun from packageManager field in package.json", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-test-bun-field-"));
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "app", packageManager: "bun@1.4.4" })
    );

    const pm = await detectPackageManager(tmpDir);
    expect(pm).toBe("bun");
    expect(getUpdateCommand(pm)).toBe("bun update @netrunner714/pegas");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects pnpm from lockfile", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-test-pnpm-lock-"));
    await fs.writeFile(path.join(tmpDir, "pnpm-lock.yaml"), "");

    const pm = await detectPackageManager(tmpDir);
    expect(pm).toBe("pnpm");
    expect(getUpdateCommand(pm)).toBe("pnpm update @netrunner714/pegas");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects yarn from lockfile", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-test-yarn-lock-"));
    await fs.writeFile(path.join(tmpDir, "yarn.lock"), "");

    const pm = await detectPackageManager(tmpDir);
    expect(pm).toBe("yarn");
    expect(getUpdateCommand(pm)).toBe("yarn upgrade @netrunner714/pegas");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("falls back to npm when no lockfile or packageManager field is found", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-test-npm-fallback-"));

    const pm = await detectPackageManager(tmpDir);
    expect(pm).toBe("npm");
    expect(getUpdateCommand(pm)).toBe("npm update @netrunner714/pegas");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
