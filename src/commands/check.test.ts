import { describe, it, expect, spyOn } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { auditRepository, handleCheck } from "./check.js";

describe("pegas check command", () => {
  it("auditRepository returns valid when contract and secrets conform to standard", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-valid-"));
    try {
      const contract = {
        projectName: "clean-project",
        runtime: "docker",
        secrets: ["DB_URL", "APP_KEY"],
        services: { web: { port: 3000, upstream: "web:3000" } },
      };
      await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify(contract, null, 2), "utf-8");
      await fs.writeFile(path.join(tmp, ".gitignore"), ".env\n.pegas\n", "utf-8");
      await fs.writeFile(path.join(tmp, ".env"), "DB_URL=postgres://...\nAPP_KEY=secret123\n", "utf-8");
      await fs.writeFile(path.join(tmp, ".env.example"), "DB_URL=\nAPP_KEY=\n", "utf-8");

      const result = await auditRepository(tmp);
      expect(result.valid).toBe(true);
      expect(result.hasErrors).toBe(false);
      expect(result.contractExists).toBe(true);
      expect(result.contractIssues).toEqual([]);
      expect(result.legacyFiles).toEqual([]);
      expect(result.gitignoreIssues).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("auditRepository reports missing contract, missing secrets, and unignored .env", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-err-"));
    try {
      // No pegas.json
      const result1 = await auditRepository(tmp);
      expect(result1.valid).toBe(false);
      expect(result1.contractExists).toBe(false);
      expect(result1.errors.some((e) => e.includes("pegas.json contract file does not exist"))).toBe(true);

      // Add pegas.json with secrets, but no .env and no .gitignore
      const contract = {
        runtime: "docker",
        secrets: ["JWT_TOKEN"],
        services: { web: { port: 80 } },
      };
      await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify(contract), "utf-8");

      const result2 = await auditRepository(tmp);
      expect(result2.valid).toBe(false);
      expect(result2.errors.some((e) => e.includes("not found"))).toBe(true);
      expect(result2.gitignoreIssues.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("auditRepository flags legacy compose files, in-project caddy/nginx, and subproject envs", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-legacy-"));
    try {
      const contract = {
        runtime: "docker",
        services: { web: { port: 80 } },
      };
      await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify(contract), "utf-8");
      await fs.writeFile(path.join(tmp, ".gitignore"), ".env\n.pegas\n", "utf-8");
      await fs.writeFile(path.join(tmp, ".env"), "FOO=bar\n", "utf-8");

      // Add legacy files
      await fs.writeFile(path.join(tmp, "docker-compose.yml"), "version: '3'\n", "utf-8");
      await fs.writeFile(path.join(tmp, "Caddyfile"), ":80\n", "utf-8");
      await fs.writeFile(path.join(tmp, ".env.production"), "FOO=prod\n", "utf-8");

      // Monorepo subproject with rogue .env
      await fs.mkdir(path.join(tmp, "apps", "backend"), { recursive: true });
      await fs.writeFile(path.join(tmp, "apps", "backend", ".env"), "SECRET=nested\n", "utf-8");

      const result = await auditRepository(tmp);
      const legacyPaths = result.legacyFiles.map((f) => f.path);
      expect(legacyPaths).toContain("docker-compose.yml");
      expect(legacyPaths).toContain("Caddyfile");
      expect(legacyPaths).toContain(".env.production");
      expect(legacyPaths).toContain(path.join("apps", "backend", ".env"));
      expect(result.hasWarnings).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("handleCheck outputs JSON and handles noExit flag", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-cli-"));
    try {
      const contract = {
        projectName: "json-test",
        runtime: "docker",
        services: { web: { port: 80 } },
      };
      await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify(contract), "utf-8");
      await fs.writeFile(path.join(tmp, ".gitignore"), ".pegas\n.env\n", "utf-8");
      await fs.writeFile(path.join(tmp, ".env"), "A=1\n", "utf-8");

      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });

      try {
        await handleCheck({ cwd: tmp, json: true, noExit: true });
      } finally {
        spy.mockRestore();
      }

      expect(logs.length).toBeGreaterThan(0);
      const parsed = JSON.parse(logs[0]);
      expect(parsed.valid).toBe(true);
      expect(parsed.contractExists).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("handleCheck formats terminal output cleanly for passing and failing audits", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-term-"));
    try {
      const contract = {
        projectName: "term-test",
        runtime: "docker",
        secrets: ["MISSING_KEY"],
        services: { web: { port: 80 } },
      };
      await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify(contract), "utf-8");
      await fs.writeFile(path.join(tmp, ".gitignore"), ".pegas\n.env\n", "utf-8");
      await fs.writeFile(path.join(tmp, ".env"), "OTHER=val\n", "utf-8");

      const logs: string[] = [];
      const errors: string[] = [];
      const spyLog = spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));
      const spyErr = spyOn(console, "error").mockImplementation((msg) => errors.push(String(msg)));

      try {
        await handleCheck({ cwd: tmp, json: false, noExit: true });
      } finally {
        spyLog.mockRestore();
        spyErr.mockRestore();
      }

      const allOutput = [...logs, ...errors].join("\n");
      expect(allOutput).toContain("Pegas Repository Audit");
      expect(allOutput).toContain("Missing (1): MISSING_KEY");
      expect(allOutput).toContain("Pegas audit failed");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
