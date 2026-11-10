import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { findEnvBranches, auditEnvBranches } from "./env-branch-audit.js";

describe("env-branch-audit: findEnvBranches", () => {
  it("if по NODE_ENV — branch", () => {
    const issues = findEnvBranches(`if (process.env.NODE_ENV === "development") { console.log(1); }`, "a.ts");
    expect(issues.length).toBe(1);
    expect(issues[0].kind).toBe("branch");
    expect(issues[0].key).toBe("NODE_ENV");
    expect(issues[0].line).toBe(1);
  });

  it("тернарник по PEGAS_SCENARIO — branch", () => {
    const issues = findEnvBranches(`const x = process.env.PEGAS_SCENARIO === "production" ? "a" : "b";`, "a.ts");
    expect(issues.length).toBe(1);
    expect(issues[0].key).toBe("PEGAS_SCENARIO");
  });

  it("switch по NODE_ENV — branch", () => {
    const issues = findEnvBranches(`switch (process.env.NODE_ENV) { case "development": break; }`, "a.ts");
    expect(issues.length).toBe(1);
  });

  it("PORT, HOST, APP_DOMAIN, CLIENT_ORIGINS — banned-key без ветвления", () => {
    expect(findEnvBranches(`const p = process.env.PORT;`, "a.ts")[0]?.kind).toBe("banned-key");
    expect(findEnvBranches(`const h = process.env["HOST"];`, "a.ts")[0]?.kind).toBe("banned-key");
    expect(findEnvBranches(`const d = process.env.APP_DOMAIN;`, "a.ts")[0]?.kind).toBe("banned-key");
    expect(findEnvBranches(`const c = process.env.CLIENT_ORIGINS;`, "a.ts")[0]?.kind).toBe("banned-key");
  });

  it("Bun.env тоже детектится", () => {
    const issues = findEnvBranches(`if (Bun.env.NODE_ENV === "production") {}`, "a.ts");
    expect(issues.length).toBe(1);
  });

  it("логирование сценария — не флаг", () => {
    expect(findEnvBranches(`console.log("env:", process.env.NODE_ENV);`, "a.ts")).toEqual([]);
    expect(findEnvBranches(`console.log(process.env.PEGAS_SCENARIO);`, "a.ts")).toEqual([]);
  });

  it("обычный конфиг и ?? — не флаг", () => {
    expect(findEnvBranches(`const k = process.env.MY_KEY ?? "x";`, "a.ts")).toEqual([]);
    expect(findEnvBranches(`const s = process.env.SESSION_COOKIE_SECURE === 'true';`, "a.ts")).toEqual([]);
  });

  it("комментарии и строки — не флаг", () => {
    expect(findEnvBranches(`// if (process.env.NODE_ENV === "development") {}`, "a.ts")).toEqual([]);
    expect(findEnvBranches(`const s = "if (process.env.NODE_ENV === 'development')";`, "a.ts")).toEqual([]);
  });

  it("815records: secure-флаг по NODE_ENV — branch", () => {
    const src = `secure: isEmbedded || process.env.NODE_ENV === 'production',`;
    const issues = findEnvBranches(src, "actions.ts");
    expect(issues.length).toBe(1);
    expect(issues[0].kind).toBe("branch");
  });
});

describe("env-branch-audit: auditEnvBranches", () => {
  it("находит ветвление в проекте, чистый проект — ok", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-env-branch-"));
    try {
      await fs.writeFile(path.join(dir, "app.ts"), `if (process.env.NODE_ENV === "development") { console.log(1); }\n`);
      const found = await auditEnvBranches(dir);
      expect(found.status).toBe("found");
      expect(found.totalIssues).toBe(1);
      expect(found.issues[0].file).toBe("app.ts");
      expect(found.warning).toContain("config(KEY)");

      await fs.writeFile(path.join(dir, "app.ts"), `import { config } from "@netrunner714/pegas/runtime";\nconst v = config("MY_KEY");\n`);
      const clean = await auditEnvBranches(dir);
      expect(clean.status).toBe("ok");
      expect(clean.totalIssues).toBe(0);
      expect(clean.warning).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("тесты и node_modules не сканируются", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-env-branch-skip-"));
    try {
      await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
      await fs.writeFile(path.join(dir, "node_modules", "x.js"), `if (process.env.NODE_ENV === "development") {}\n`);
      await fs.writeFile(path.join(dir, "app.test.ts"), `if (process.env.NODE_ENV === "development") {}\n`);
      const result = await auditEnvBranches(dir);
      expect(result.status).toBe("ok");
      expect(result.filesScanned).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
