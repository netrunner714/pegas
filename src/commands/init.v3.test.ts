import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleInit, setupGitignore, setupAgentsMd, PEGAS_AGENT_RULES_MARKER_REGEX , setupDocsPegasMd, docsPegasMd} from "./init.js";

function tmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-"));
}

describe("pegas init v3 (тонкий scaffolder)", () => {
  it("первый запуск: AGENTS.md, docs/pegas.md, .pegas/, .gitignore", async () => {
    const dir = await tmpProject();
    await handleInit({ cwd: dir, noExit: true });
    expect(await fs.access(path.join(dir, "AGENTS.md")).then(() => true, () => false)).toBe(true);
    expect(await fs.access(path.join(dir, "docs", "pegas.md")).then(() => true, () => false)).toBe(true);
    expect(await fs.access(path.join(dir, ".pegas")).then(() => true, () => false)).toBe(true);
    const gi = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    expect(gi).toContain(".pegas");
    expect(gi).toContain(".env");
  });

  it("второй запуск идемпотентен: файлы не дублируются", async () => {
    const dir = await tmpProject();
    await handleInit({ cwd: dir, noExit: true });
    const agentsBefore = await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8");
    const giBefore = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    await handleInit({ cwd: dir, noExit: true });
    const agentsAfter = await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8");
    const giAfter = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    expect(agentsAfter).toBe(agentsBefore);
    expect(giAfter).toBe(giBefore);
  });

  it("контракт pegas.json не создаётся и не трогается", async () => {
    const dir = await tmpProject();
    await handleInit({ cwd: dir, noExit: true });
    expect(await fs.access(path.join(dir, "pegas.json")).then(() => true, () => false)).toBe(false);
    // пользовательский контракт остаётся нетронутым
    const custom = { hello: "world" };
    await fs.writeFile(path.join(dir, "pegas.json"), JSON.stringify(custom));
    await handleInit({ cwd: dir, noExit: true });
    expect(JSON.parse(await fs.readFile(path.join(dir, "pegas.json"), "utf-8"))).toEqual(custom);
  });

  it("существующий AGENTS.md с чужим контентом: блок добавляется, контент сохраняется", async () => {
    const dir = await tmpProject();
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# Мои правила\n\nНе кушать nucleus.\n");
    await handleInit({ cwd: dir, noExit: true });
    const content = await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8");
    expect(content).toContain("Не кушать nucleus.");
    expect(PEGAS_AGENT_RULES_MARKER_REGEX.test(content)).toBe(true);
  });

  it("dryRun не пишет файлы", async () => {
    const dir = await tmpProject();
    await handleInit({ cwd: dir, dryRun: true, noExit: true });
    expect(await fs.access(path.join(dir, "AGENTS.md")).then(() => true, () => false)).toBe(false);
  });

  it("setupGitignore дополняет существующий .gitignore без дублей (.env расширяется до маски)", async () => {
    const dir = await tmpProject();
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules\n.env\n");
    const res = await setupGitignore(dir);
    expect(res).toContain(".pegas");
    expect(res).toContain(".env*");
    expect(res).toContain("!.env.example");
    // голая строка .env не дублируется: маска .env* добавлена, .env осталась одна
    const after = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    expect(after.split("\n").filter((l) => l === ".env").length).toBe(1);
    expect(after.split("\n").filter((l) => l === ".env*").length).toBe(1);
    expect(after.split("\n").filter((l) => l === "!.env.example").length).toBe(1);
  });

  it("setupAgentsMd обновляет устаревший блок правил", async () => {
    const dir = await tmpProject();
    await fs.writeFile(path.join(dir, "AGENTS.md"), "<!-- BEGIN:pegas-rules -->\nстарые правила v2\n<!-- END:pegas-rules -->\n");
    await setupAgentsMd(dir);
    const content = await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8");
    expect(content).not.toContain("старые правила v2");
    expect(content).toContain("pegas check");
  });
});

describe("init: docs/pegas.md обновляется до канона (refresh при апдейте зависимости)", () => {
  it("отличающийся docs перезаписывается, action отражает обновление", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-doc-"));
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(dir, "docs", "pegas.md"), "# Pegas (старая версия доки)\n");
    const action = await setupDocsPegasMd(dir, "docproj");
    expect(action).toContain("Обновлён");
    const fresh = await fs.readFile(path.join(dir, "docs", "pegas.md"), "utf-8");
    expect(fresh).toBe(docsPegasMd("docproj"));
  });

  it("каноничный docs не трогается (null)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-doc2-"));
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(dir, "docs", "pegas.md"), docsPegasMd("docproj"));
    expect(await setupDocsPegasMd(dir, "docproj")).toBeNull();
  });

  it("отсутствующий docs создаётся", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-doc3-"));
    const action = await setupDocsPegasMd(dir, "docproj");
    expect(action).toContain("Создан");
  });
});

describe("setupGitignore: маска .env* + !.env.example (без дублей)", () => {
  it("создаёт .gitignore с .env* и !.env.example", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gi-"));
    const action = await setupGitignore(dir);
    const content = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    expect(action).toContain(".env*");
    expect(content).toContain(".env*");
    expect(content).toContain("!.env.example");
  });

  it("репо с парой .env + .env.* + !.env.example — env-дублей не добавляет (только .pegas)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gi2-"));
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules\n.env\n.env.*\n!.env.example\n");
    const res = await setupGitignore(dir);
    expect(res).toBe("Добавлена запись .pegas в .gitignore");
    const after = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    expect(after.split("\n").filter((l) => l === ".env").length).toBe(1);
    expect(after.split("\n").filter((l) => l === ".env.*").length).toBe(1);
    expect(after.split("\n").filter((l) => l === "!.env.example").length).toBe(1);
  });

  it("репо с голым .env дополняется маской и исключением (старый паттерн расширяем)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gi3-"));
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules\n.env\n");
    const action = await setupGitignore(dir);
    expect(action).toContain(".env*");
    expect(action).toContain("!.env.example");
    const after = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    expect(after).toContain("!.env.example");
  });

  it("репо с .env* без !.env.example — добавляется только исключение", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gi4-"));
    await fs.writeFile(path.join(dir, ".gitignore"), ".pegas\n.env*\n");
    const action = await setupGitignore(dir);
    expect(action).toContain("!.env.example");
    expect(action).not.toContain(".env*");
  });
});