import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  setupGitignore,
  setupAgentsMd,
  setupDevBinary,
  checkInstalledVersion,
  checkNpmLatestVersion,
  PEGAS_AGENT_RULES,
  handleProjectInit,
  handleInit,
} from "./init.js";
import { VERSION } from "../version.js";

describe("pegas init (unit)", () => {
  it("setupAgentsMd creates, appends, and updates AGENTS.md idempotently", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-agents-"));

    // 1. Missing file: creates AGENTS.md with rules
    const res1 = await setupAgentsMd(tmpProj);
    expect(res1).toBe("Создан AGENTS.md с правилами Pegas");
    const content1 = await fs.readFile(path.join(tmpProj, "AGENTS.md"), "utf-8");
    expect(content1).toBe(`${PEGAS_AGENT_RULES}\n`);

    // 2. Existing file with exact rules: returns null (no-op)
    const res2 = await setupAgentsMd(tmpProj);
    expect(res2).toBeNull();

    // 3. Existing file with other rules (e.g. Next.js): appends Pegas block
    const nextRules = `<!-- BEGIN:nextjs-agent-rules -->\n# Next.js\n<!-- END:nextjs-agent-rules -->`;
    await fs.writeFile(path.join(tmpProj, "AGENTS.md"), nextRules, "utf-8");
    const res3 = await setupAgentsMd(tmpProj);
    expect(res3).toBe("Добавлен блок правил Pegas в AGENTS.md");
    const content3 = await fs.readFile(path.join(tmpProj, "AGENTS.md"), "utf-8");
    expect(content3).toBe(`${nextRules}\n\n${PEGAS_AGENT_RULES}\n`);

    // 4. Existing file with outdated pegas block: updates block in place
    const oldPegas = `${nextRules}\n\n<!-- BEGIN:pegas-rules -->\nстарые правила\n<!-- END:pegas-rules -->`;
    await fs.writeFile(path.join(tmpProj, "AGENTS.md"), oldPegas, "utf-8");
    const res4 = await setupAgentsMd(tmpProj);
    expect(res4).toBe("Обновлен блок правил Pegas в AGENTS.md");
    const content4 = await fs.readFile(path.join(tmpProj, "AGENTS.md"), "utf-8");
    expect(content4).toBe(`${nextRules}\n\n${PEGAS_AGENT_RULES}\n`);

    // 5. Dry run: does not write to disk
    await fs.rm(path.join(tmpProj, "AGENTS.md"));
    const res5 = await setupAgentsMd(tmpProj, true);
    expect(res5).toBe("Создан AGENTS.md с правилами Pegas");
    expect(await fs.access(path.join(tmpProj, "AGENTS.md")).then(() => true).catch(() => false)).toBe(false);

    await fs.rm(tmpProj, { recursive: true, force: true });
  });

  it("setupDevBinary pre-warms Caddy or reports dry-run/fallback gracefully", async () => {
    // 1. Dry run
    const resDry = await setupDevBinary(true);
    expect(resDry).toContain("dry-run: пропущено");

    // 2. Normal run (succeeds or warns gracefully without throwing)
    const resLive = await setupDevBinary(false);
    expect(
      resLive.includes("Подготовлен локальный Caddy") ||
      resLive.includes("Предупреждение:")
    ).toBe(true);
  });

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
    expect(await fs.access(path.join(tmpProj, "AGENTS.md")).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(path.join(tmpProj, ".pegas", "docker-compose.yml")).then(() => true).catch(() => false)).toBe(true);
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

    expect(logs.some((l) => l.includes("Проект инициализирован с Pegas"))).toBe(true);
    expect(logs.some((l) => l.includes("контракт pegas.json") || l.includes("Контракт pegas.json"))).toBe(true);
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

    expect(logs.some((l) => l.includes("[dry-run] Предпросмотр инициализации проекта Pegas:"))).toBe(true);
    expect(logs.some((l) => l.includes("Изменения не записаны на диск"))).toBe(true);

    // Verify disk was completely untouched
    expect(await fs.access(path.join(tmpProj, "pegas.json")).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(path.join(tmpProj, "docs", "pegas.md")).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(path.join(tmpProj, "AGENTS.md")).then(() => true).catch(() => false)).toBe(false);
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

      // 3. Force init (resets contract)
      await handleInit({ cwd: tmpProj, force: true, json: true });
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes('"status":"success"'))).toBe(true);
    expect(logs.some((l) => l.includes('"status":"dry-run"'))).toBe(true);
    expect(logs.some((l) => l.includes("Сброшен на дефолт контракт"))).toBe(true);
  });

  it("checkInstalledVersion detects local version in node_modules", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-installed-check-"));
    const pkgDir = path.join(tmpProj, "node_modules", "@netrunner714", "pegas");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ version: "1.0.0" }), "utf-8");

    const ver = await checkInstalledVersion(tmpProj);
    expect(ver).toBe("1.0.0");

    await fs.rm(tmpProj, { recursive: true, force: true });
  });

  it("handleProjectInit warns when node_modules has older pegas version", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-outdated-"));
    await fs.writeFile(
      path.join(tmpProj, "package.json"),
      JSON.stringify({ name: "outdated-app", devDependencies: { "@netrunner714/pegas": "^1.0.0" } }, null, 2)
    );
    const pkgDir = path.join(tmpProj, "node_modules", "@netrunner714", "pegas");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ version: "1.0.0" }), "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleProjectInit(tmpProj, true, false, { skipNpmCheck: true });

      const json = JSON.parse(logs[0]);
      expect(json.actions.some((a: string) => a.includes("Текущая: v1.0.0") && a.includes(`актуальная: v${VERSION}`))).toBe(true);

      // Verify init does NOT bump the version automatically
      const unchangedPkg = JSON.parse(await fs.readFile(path.join(tmpProj, "package.json"), "utf-8"));
      expect(unchangedPkg.devDependencies["@netrunner714/pegas"]).toBe("^1.0.0");
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }
  });
});
