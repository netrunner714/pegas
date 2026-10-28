import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import child_process from "node:child_process";
import { findProjectRoot } from "./gateway.js";
import { validateNodeVersion } from "./index.js";

describe("validateNodeVersion", () => {
  it("validates Node version correctly", () => {
    expect(validateNodeVersion("24.0.0")).toBe(true);
    expect(validateNodeVersion("24.19.0")).toBe(true);
    expect(validateNodeVersion("25.0.0")).toBe(true);
    expect(validateNodeVersion("26.0.0")).toBe(true);

    expect(validateNodeVersion("22.0.0")).toBe(false);
    expect(validateNodeVersion("20.10.0")).toBe(false);
    expect(validateNodeVersion("18.17.0")).toBe(false);
  });
});

describe("findProjectRoot", () => {
  it("finds git root from a nested subfolder", async () => {
    // pegas repo has a .git folder in its root
    const nestedDir = path.resolve(import.meta.dir, "commands");
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

describe("cli entry point", () => {
  const binPath = path.resolve(import.meta.dir, "../dist/index.js");

  it("prints help on --help or -h", () => {
    const res = child_process.spawnSync("node", [binPath, "--help"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("pegas v1.0.1");
    expect(res.stdout).toContain("USAGE:");
  });

  it("prints version on --version or -v", () => {
    const res = child_process.spawnSync("node", [binPath, "--version"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("1.0.1");
  });

  it("runs llms command via CLI", () => {
    const res = child_process.spawnSync("node", [binPath, "llms", "--json"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    const json = JSON.parse(res.stdout);
    expect(json.llms).toContain("# pegas");
  });

  it("main function dispatches commands directly", async () => {
    const { main } = await import("./index.js");
    const logs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => logs.push(args.join(" "));

    try {
      await main(["--help"]);
      await main(["--version"]);
      await main(["llms", "--json"]);
      await main(["unknown-command"], { noExit: true });
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    expect(logs.some((l) => typeof l === "string" && l.includes("USAGE:"))).toBe(true);
    expect(logs.some((l) => typeof l === "string" && l.includes("pegas v1.0.1"))).toBe(true);
    expect(logs.some((l) => typeof l === "string" && l.includes("# pegas"))).toBe(true);
  });
});
