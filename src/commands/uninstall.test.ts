import { describe, it, expect, spyOn } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import child_process from "node:child_process";
import {
  handleUninstall,
  removePegasFiles,
  removePegasFromPackageJson,
  stripPegasBlockFromAgentsMd,
  unwrapDevScript,
} from "./uninstall.js";
import { CONTRACT_FILENAME } from "../contract.js";

/**
 * handleUninstall запускает пакетный менеджер (bun remove ...) — в тестах этот
 * вызов мокается: spawnSync не должен реально трогать node_modules/lockfile.
 */
function mockPmRemove(exitCode = 0): ReturnType<typeof spyOn> {
  return spyOn(child_process, "spawnSync").mockImplementation((() => ({
    status: exitCode,
    stdout: "",
    stderr: "",
  })) as any);
}

async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-uninstall-"));
  for (const [rel, content] of Object.entries(files)) {
    const fullPath = path.join(dir, rel);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }
  return dir;
}

const PEGAS_BLOCK = `<!-- BEGIN:pegas-rules -->
## Pegas
- Правила
<!-- END:pegas-rules -->`;

describe("pegas uninstall (unit)", () => {
  it("stripPegasBlockFromAgentsMd removes only the Pegas block, preserving other rules", () => {
    const other = `<!-- BEGIN:nextjs-rules -->\nNext rules\n<!-- END:nextjs-rules -->`;
    const content = `${other}\n\n${PEGAS_BLOCK}\n`;
    const stripped = stripPegasBlockFromAgentsMd(content);
    expect(stripped).toBe(other);
    expect(stripped).not.toContain("pegas-rules");
  });

  it("stripPegasBlockFromAgentsMd returns null when no Pegas block exists", () => {
    expect(stripPegasBlockFromAgentsMd("# Просто AGENTS.md\n")).toBeNull();
  });

  it("stripPegasBlockFromAgentsMd returns empty string when file is only the block", () => {
    expect(stripPegasBlockFromAgentsMd(`${PEGAS_BLOCK}\n`)).toBe("");
  });

  it("unwrapDevScript unfolds the pegas wrapper", () => {
    expect(unwrapDevScript("pegas dev -- next dev")).toBe("next dev");
    expect(unwrapDevScript("pegas dev --")).toBe("");
    // Не обёрнуто — возвращаем как есть
    expect(unwrapDevScript("next dev")).toBe("next dev");
    expect(unwrapDevScript("pegas dev --vite")).toBe("pegas dev --vite");
  });

  it("removePegasFiles backs up contract, removes files and cleans gitignore", async () => {
    const dir = await makeProject({
      [CONTRACT_FILENAME]: JSON.stringify({ projectName: "x", services: {} }),
      "docs/pegas.md": "# Pegas\n",
      "AGENTS.md": `# My agents\n\n${PEGAS_BLOCK}\n`,
      ".gitignore": "node_modules/\n.pegas\n",
      ".pegas/docker-compose.yml": "services: {}",
    });

    const actions = await removePegasFiles(dir);

    expect(actions.removed).toContain(CONTRACT_FILENAME);
    expect(actions.removed).toContain("docs/pegas.md");
    expect(actions.removed).toContain("блок правил Pegas в AGENTS.md");
    expect(actions.removed).toContain(".pegas/");
    expect(actions.removed).toContain("запись .pegas в .gitignore");
    expect(actions.backupFile).toBe(`${CONTRACT_FILENAME}.bak`);

    // Контракт забэкаплен, оригинал удалён
    const backup = await fs.readFile(path.join(dir, `${CONTRACT_FILENAME}.bak`), "utf-8");
    expect(backup).toContain('"projectName"');
    await expect(fs.access(path.join(dir, CONTRACT_FILENAME))).rejects.toThrow();

    // .pegas удалён
    await expect(fs.access(path.join(dir, ".pegas"))).rejects.toThrow();

    // gitignore чист
    const gi = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    expect(gi).not.toContain(".pegas");

    // AGENTS.md сохранён без блока
    const agents = await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("# My agents");
    expect(agents).not.toContain("pegas-rules");

    // docs/pegas.md удалён
    await expect(fs.access(path.join(dir, "docs", "pegas.md"))).rejects.toThrow();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("removePegasFiles deletes AGENTS.md entirely when it contained only the block", async () => {
    const dir = await makeProject({
      [CONTRACT_FILENAME]: "{}",
      "AGENTS.md": `${PEGAS_BLOCK}\n`,
    });

    await removePegasFiles(dir);
    await expect(fs.access(path.join(dir, "AGENTS.md"))).rejects.toThrow();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("removePegasFiles dry-run touches nothing on disk", async () => {
    const dir = await makeProject({
      [CONTRACT_FILENAME]: "{}",
      ".pegas/docker-compose.yml": "services: {}",
    });

    const actions = await removePegasFiles(dir, true);
    expect(actions.removed.length).toBeGreaterThan(0);

    // Диск нетронут
    await fs.access(path.join(dir, CONTRACT_FILENAME));
    await fs.access(path.join(dir, ".pegas", "docker-compose.yml"));

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("removePegasFromPackageJson unwraps dev, removes exact deploy and devDependency", async () => {
    const dir = await makeProject({
      "package.json": JSON.stringify(
        {
          name: "app",
          scripts: {
            dev: "pegas dev -- next dev",
            deploy: "pegas deploy production",
            build: "next build",
          },
          devDependencies: {
            "@netrunner714/pegas": "^1.3.0",
            typescript: "^5.0.0",
          },
        },
        null,
        2
      ),
    });

    const actions = await removePegasFromPackageJson(dir);

    expect(actions.removed.some((r) => r.includes("next dev"))).toBe(true);
    expect(actions.removed).toContain("скрипт 'deploy'");

    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
    expect(pkg.scripts.dev).toBe("next dev");
    expect(pkg.scripts.deploy).toBeUndefined();
    expect(pkg.scripts.build).toBe("next build");
    expect(pkg.devDependencies["@netrunner714/pegas"]).toBeUndefined();
    expect(pkg.devDependencies.typescript).toBe("^5.0.0");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("removePegasFromPackageJson preserves customized deploy script and non-wrapped dev", async () => {
    const dir = await makeProject({
      "package.json": JSON.stringify(
        {
          name: "app",
          scripts: {
            dev: "vite",
            deploy: "pegas deploy stage && echo done",
          },
          dependencies: {
            "@netrunner714/pegas": "^1.3.0",
          },
        },
        null,
        2
      ),
    });

    const actions = await removePegasFromPackageJson(dir);

    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
    // Пользовательский deploy не тронут
    expect(pkg.scripts.deploy).toBe("pegas deploy stage && echo done");
    // dev не был обёрнут — не тронут
    expect(pkg.scripts.dev).toBe("vite");
    // Зависимость вычищена из dependencies
    expect(pkg.dependencies["@netrunner714/pegas"]).toBeUndefined();
    expect(actions.removed.some((r) => r.includes("dependencies"))).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("removePegasFromPackageJson removes dev script when it is only the wrapper", async () => {
    const dir = await makeProject({
      "package.json": JSON.stringify({ name: "app", scripts: { dev: "pegas dev -- " } }, null, 2),
    });

    await removePegasFromPackageJson(dir);
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
    expect(pkg.scripts.dev).toBeUndefined();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("handleUninstall reports not-initialized without contract", async () => {
    const dir = await makeProject();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleUninstall({ cwd: dir, json: true });
    } finally {
      console.log = origLog;
    }

    const res = JSON.parse(logs[0]);
    expect(res.status).toBe("not-initialized");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("handleUninstall full flow in json mode removes everything and runs pm remove", async () => {
    const dir = await makeProject({
      [CONTRACT_FILENAME]: JSON.stringify({ projectName: "x", services: {} }),
      "package.json": JSON.stringify(
        {
          name: "app",
          scripts: { dev: "pegas dev -- next dev", deploy: "pegas deploy production" },
          devDependencies: { "@netrunner714/pegas": "^1.3.0" },
        },
        null,
        2
      ),
      "bun.lock": "",
      ".gitignore": ".pegas\n",
      "docs/pegas.md": "# Pegas\n",
    });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    let removeCalled = false;
    const pmSpy = spyOn(child_process, "spawnSync").mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === "bun" && args.includes("remove")) {
        removeCalled = true;
      }
      return { status: 0, stdout: "", stderr: "" };
    }) as any);

    try {
      await handleUninstall({ cwd: dir, json: true });
    } finally {
      pmSpy.mockRestore();
      console.log = origLog;
    }

    const res = JSON.parse(logs[0]);
    expect(res.status).toBe("success");
    expect(res.removeCommand).toBe("bun remove @netrunner714/pegas");
    expect(res.removeCommandExitCode).toBe(0);
    expect(res.backupFile).toBe("pegas.json.bak");
    expect(res.removed.length).toBeGreaterThan(3);

    // Пакетный менеджер реально запущен одной командой
    expect(removeCalled).toBe(true);

    // Всё реально удалено
    await expect(fs.access(path.join(dir, CONTRACT_FILENAME))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "docs", "pegas.md"))).rejects.toThrow();
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
    expect(pkg.scripts.dev).toBe("next dev");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("handleUninstall reports partial status when pm remove fails", async () => {
    const dir = await makeProject({
      [CONTRACT_FILENAME]: JSON.stringify({ projectName: "x", services: {} }),
      "package.json": JSON.stringify(
        { name: "app", scripts: { dev: "pegas dev -- next dev" } },
        null,
        2
      ),
      "bun.lock": "",
    });

    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => logs.push(args.join(" "));

    const pmSpy = mockPmRemove(1); // remove падает

    try {
      await handleUninstall({ cwd: dir, json: true });
    } finally {
      pmSpy.mockRestore();
      console.log = origLog;
      console.error = origErr;
    }

    const res = JSON.parse(logs[0]);
    expect(res.status).toBe("partial");
    expect(res.removeCommandExitCode).toBe(1);

    // Артефакты при этом удалены
    await expect(fs.access(path.join(dir, CONTRACT_FILENAME))).rejects.toThrow();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("handleUninstall dry-run leaves project intact", async () => {
    const dir = await makeProject({
      [CONTRACT_FILENAME]: JSON.stringify({ projectName: "x", services: {} }),
      "package.json": JSON.stringify(
        { name: "app", scripts: { dev: "pegas dev -- next dev" }, devDependencies: { "@netrunner714/pegas": "^1.3.0" } },
        null,
        2
      ),
    });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleUninstall({ cwd: dir, json: true, dryRun: true });
    } finally {
      console.log = origLog;
    }

    const res = JSON.parse(logs[0]);
    expect(res.status).toBe("dry-run");

    // Ничего не удалено
    await fs.access(path.join(dir, CONTRACT_FILENAME));
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
    expect(pkg.scripts.dev).toBe("pegas dev -- next dev");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
