import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { setupGitignore, handleProjectInit, handleInit } from "./init.js";

describe("pegas init (unit)", () => {
  it("setupGitignore adds .pegas if missing and is idempotent", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-git-"));

    // 1. Missing file: creates .gitignore
    const res1 = await setupGitignore(tmpProj);
    expect(res1).toBe("Создан .gitignore с записью .pegas");
    const content1 = await fs.readFile(path.join(tmpProj, ".gitignore"), "utf-8");
    expect(content1).toContain(".pegas");

    // 2. Existing file with .pegas: returns null (no-op)
    const res2 = await setupGitignore(tmpProj);
    expect(res2).toBeNull();

    // 3. Existing file without .pegas: appends .pegas
    await fs.writeFile(path.join(tmpProj, ".gitignore"), "node_modules/\ndist/\n", "utf-8");
    const res3 = await setupGitignore(tmpProj);
    expect(res3).toBe("Добавлена запись .pegas в .gitignore");
    const content3 = await fs.readFile(path.join(tmpProj, ".gitignore"), "utf-8");
    expect(content3).toContain("node_modules/\ndist/\n.pegas");

    await fs.rm(tmpProj, { recursive: true, force: true });
  });

  it("handleProjectInit initializes project contract, package.json, docs, and compose", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-proj-"));
    await fs.writeFile(
      path.join(tmpProj, "package.json"),
      JSON.stringify({ name: "my-microservice", scripts: { dev: "vite" } }, null, 2)
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleProjectInit(tmpProj, true);
    } finally {
      console.log = origLog;
    }

    const res = JSON.parse(logs[0]);
    expect(res.status).toBe("success");
    expect(res.actions.length).toBeGreaterThan(0);

    // Verify created files
    expect(await fs.access(path.join(tmpProj, "pegas.json")).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(path.join(tmpProj, "docs", "pegas.md")).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(path.join(tmpProj, "docker-compose.yml")).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(path.join(tmpProj, ".gitignore")).then(() => true).catch(() => false)).toBe(true);

    const contract = JSON.parse(await fs.readFile(path.join(tmpProj, "pegas.json"), "utf-8"));
    expect(contract.projectName).toBe("my-microservice");

    await fs.rm(tmpProj, { recursive: true, force: true });
  });

  it("handleProjectInit handles pre-existing files and text output cleanly", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-preexist-"));
    await fs.writeFile(
      path.join(tmpProj, "package.json"),
      JSON.stringify({ name: "pre-existing-app" }, null, 2)
    );
    await fs.writeFile(path.join(tmpProj, "pegas.json"), JSON.stringify({ projectName: "pre-existing-app" }), "utf-8");
    await fs.writeFile(path.join(tmpProj, "docker-compose.yml"), "services:\n  app:\n    image: node:20\n", "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleProjectInit(tmpProj, false);
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("Project initialized with Pegas"))).toBe(true);
    expect(logs.some((l) => l.includes("уже существует"))).toBe(true);
  });

  it("handleProjectInit supports dry-run mode in json and terminal text modes without touching disk", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-dry-"));
    await fs.writeFile(
      path.join(tmpProj, "package.json"),
      JSON.stringify({ name: "dry-run-project", scripts: { dev: "next dev" } }, null, 2)
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      // 1. JSON dry-run mode
      await handleProjectInit(tmpProj, true, true);

      // 2. Terminal text dry-run mode
      await handleProjectInit(tmpProj, false, true);
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }

    const jsonLog = logs.find((l) => l.includes('"status":"dry-run"'));
    expect(jsonLog).toBeDefined();
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.project).toBe("dry-run-project");
    expect(parsed.actions.length).toBeGreaterThan(0);

    expect(logs.some((l) => l.includes("[dry-run] Pegas project initialization preview:"))).toBe(true);
    expect(logs.some((l) => l.includes("No changes were written to disk"))).toBe(true);

    // Verify disk was completely untouched
    expect(await fs.access(path.join(tmpProj, "pegas.json")).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(path.join(tmpProj, "docs", "pegas.md")).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(path.join(tmpProj, "docker-compose.yml")).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(path.join(tmpProj, ".gitignore")).then(() => true).catch(() => false)).toBe(false);
  });

  it("handleInit initializes project and respects options", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-dispatch-proj-"));

    await fs.writeFile(
      path.join(tmpProj, "package.json"),
      JSON.stringify({ name: "dispatch-app", scripts: { dev: "vite" } }, null, 2)
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      // 1. Standard init
      await handleInit({ cwd: tmpProj, json: true });

      // 2. Dry run init
      await handleInit({ cwd: tmpProj, dryRun: true, json: true });
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes('"status":"success"'))).toBe(true);
    expect(logs.some((l) => l.includes('"status":"dry-run"'))).toBe(true);
  });
});
