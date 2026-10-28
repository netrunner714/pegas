import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { findProjectRoot } from "../src/gateway.js";

describe("findProjectRoot", () => {
  it("finds git root from a nested subfolder", async () => {
    // pegas repo has a .git folder in its root
    const nestedDir = path.resolve(import.meta.dir, "../src/commands");
    const root = await findProjectRoot(nestedDir);

    expect(root).toBe(path.resolve(import.meta.dir, ".."));
  });

  it("finds package.json root when no .git exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-test-"));
    const subDir = path.join(tmpDir, "deep", "nested", "folder");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}", "utf-8");

    const root = await findProjectRoot(subDir);
    expect(root).toBe(tmpDir);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when neither .git nor package.json exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-empty-"));
    const subDir = path.join(tmpDir, "sub");
    await fs.mkdir(subDir, { recursive: true });

    const root = await findProjectRoot(subDir);
    expect(root).toBeNull();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
