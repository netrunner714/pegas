import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { setupGitignore, handleProjectInit } from "./init.js";

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

    const pkg = JSON.parse(await fs.readFile(path.join(tmpProj, "package.json"), "utf-8"));
    expect(pkg.scripts.dev).toBe("pegas dev -- vite");
    expect(pkg.scripts.deploy).toBe("pegas deploy");

    await fs.rm(tmpProj, { recursive: true, force: true });
  });

  it("handleInit dispatches to handleProjectInit when in project workspace", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-dispatch-"));
    await fs.writeFile(
      path.join(tmpProj, "package.json"),
      JSON.stringify({ name: "dispatch-app" }, null, 2)
    );

    const origCwd = process.cwd();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      process.chdir(tmpProj);
      const { handleInit } = await import("./init.js");
      await handleInit({ project: true, json: true });
    } finally {
      process.chdir(origCwd);
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }

    expect(logs.length).toBe(1);
    const res = JSON.parse(logs[0]);
    expect(res.status).toBe("success");
  });
});
