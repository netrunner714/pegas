import { describe, it, expect, spyOn } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { auditRepository, handleCheck } from "./check.js";

/** Минимальный валидный v3-контракт для аудита. */
const validContract = {
  projectName: "clean-project",
  scenarios: ["development"],
  gateway: { development: { httpPort: 80, httpsPort: 443 } },
  services: {
    web: {
      runtime: { development: { driver: "docker" } },
      image: { development: "node:24" },
      port: { development: 3000 },
      secrets: ["DB_URL", "APP_KEY"],
    },
  },
};

describe("pegas check command (v3)", () => {
  it("auditRepository: валидный репозиторий — valid=true, ошибок нет", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-valid-"));
    try {
      await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify(validContract, null, 2));
      await fs.writeFile(path.join(tmp, ".gitignore"), ".env\n.pegas\n", "utf-8");
      await fs.writeFile(path.join(tmp, ".env"), "DB_URL=postgres://...\nAPP_KEY=secret123\n", "utf-8");
      await fs.writeFile(path.join(tmp, ".env.example"), "DB_URL=\nAPP_KEY=\n", "utf-8");

      const result = await auditRepository(tmp);
      expect(result.valid).toBe(true);
      expect(result.hasErrors).toBe(false);
      expect(result.contractExists).toBe(true);
      expect(result.contractIssues).toEqual([]);
      expect(result.gitignoreIssues).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("auditRepository: отсутствие контракта, секретов и .gitignore — ошибки", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-err-"));
    try {
      // Нет pegas.json
      const result1 = await auditRepository(tmp);
      expect(result1.valid).toBe(false);
      expect(result1.contractExists).toBe(false);

      // Контракт с секретами, но без .env и .gitignore
      await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify(validContract), "utf-8");
      const result2 = await auditRepository(tmp);
      expect(result2.valid).toBe(false);
      expect(result2.errors.some((e) => e.includes("not found"))).toBe(true);
      expect(result2.gitignoreIssues.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("auditRepository: v2-контракт (runtime в корне) отклоняется с подсказками", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-v2-"));
    try {
      const legacy = { projectName: "x", runtime: "docker", secrets: ["A"], services: { web: { port: 80 } } };
      await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify(legacy), "utf-8");
      await fs.writeFile(path.join(tmp, ".gitignore"), ".env\n", "utf-8");
      await fs.writeFile(path.join(tmp, ".env"), "A=1\n", "utf-8");

      const result = await auditRepository(tmp);
      expect(result.valid).toBe(false);
      const paths = result.contractIssues.map((i) => i.path);
      expect(paths).toContain("runtime");
      expect(paths).toContain("secrets");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("handleCheck: JSON-вывод и noExit", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-cli-"));
    try {
      await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify(validContract), "utf-8");
      await fs.writeFile(path.join(tmp, ".gitignore"), ".pegas\n.env\n", "utf-8");
      await fs.writeFile(path.join(tmp, ".env"), "DB_URL=1\nAPP_KEY=1\n", "utf-8");
      await fs.writeFile(path.join(tmp, ".env.example"), "DB_URL=\nAPP_KEY=\n", "utf-8");

      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));
      try {
        await handleCheck({ cwd: tmp, json: true, noExit: true });
      } finally {
        spy.mockRestore();
      }

      const parsed = JSON.parse(logs[0]);
      expect(parsed.valid).toBe(true);
      expect(parsed.contractExists).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("handleCheck: текстовый режим подсвечивает недостающие секреты", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-term-"));
    try {
      await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify(validContract), "utf-8");
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
      expect(allOutput.length).toBeGreaterThan(0);
      expect(allOutput).toContain("DB_URL");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("check: git-гигиена .env.example (шаблон секретов коммитится)", () => {
  it("маска .env* без !.env.example → warning с рецептом", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-ex-"));
    await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify({
      projectName: "ex-check",
      scenarios: ["development"],
      gateway: { development: { httpPort: 80, httpsPort: 443 } },
      services: {
        web: {
          runtime: { development: { driver: "docker" } },
          image: { development: "node:24" },
          port: { development: 3000 },
          secrets: ["A_SECRET"],
        },
      },
    }));
    await fs.writeFile(path.join(tmp, ".gitignore"), ".pegas\n.env*\n");
    await fs.writeFile(path.join(tmp, ".env.example"), "A_SECRET=\n");
    await fs.writeFile(path.join(tmp, ".env"), "A_SECRET=x\n");
    const result = await auditRepository(tmp);
    expect(result.gitignoreIssues.some((i) => i.includes(".env.example") && i.includes("!.env.example"))).toBe(true);
  });

  it("маска .env* с !.env.example → чисто", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-ex2-"));
    await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify({
      projectName: "ex-check2",
      scenarios: ["development"],
      gateway: { development: { httpPort: 80, httpsPort: 443 } },
      services: {
        web: {
          runtime: { development: { driver: "docker" } },
          image: { development: "node:24" },
          port: { development: 3000 },
          secrets: ["A_SECRET"],
        },
      },
    }));
    await fs.writeFile(path.join(tmp, ".gitignore"), ".pegas\n.env*\n!.env.example\n");
    await fs.writeFile(path.join(tmp, ".env.example"), "A_SECRET=\n");
    await fs.writeFile(path.join(tmp, ".env"), "A_SECRET=x\n");
    const result = await auditRepository(tmp);
    expect(result.gitignoreIssues.some((i) => i.includes(".env.example"))).toBe(false);
  });
});

describe("check: легаси Caddyfile в репо (маршруты — через pegas.json)", () => {
  async function repoWith(extra?: (dir: string) => Promise<void>) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-caddy-"));
    await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify({
      projectName: "caddy-check",
      scenarios: ["development"],
      gateway: { development: { httpPort: 80, httpsPort: 443 } },
      services: {
        web: {
          runtime: { development: { driver: "docker" } },
          image: { development: "node:24" },
          port: { development: 3000 },
          secrets: ["A_SECRET"],
        },
      },
    }));
    await fs.writeFile(path.join(tmp, ".gitignore"), ".pegas\n.env*\n!.env.example\n");
    await fs.writeFile(path.join(tmp, ".env.example"), "A_SECRET=\n");
    await fs.writeFile(path.join(tmp, ".env"), "A_SECRET=x\n");
    if (extra) await extra(tmp);
    return tmp;
  }

  it("Caddyfile в подкаталоге → warning с рецептом объявить через pegas.json", async () => {
    const tmp = await repoWith(async (dir) => {
      await fs.mkdir(path.join(dir, "game_client"), { recursive: true });
      await fs.writeFile(path.join(dir, "game_client", "Caddyfile"), "localhost {\n}\n");
    });
    const result = await auditRepository(tmp);
    expect(result.warnings.some((w) => w.includes("Caddyfile") && w.includes("game_client/Caddyfile"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("pegas.json"))).toBe(true);
  });

  it("caddy.json в корне — тоже ловится", async () => {
    const tmp = await repoWith(async (dir) => {
      await fs.writeFile(path.join(dir, "caddy.json"), "{}");
    });
    const result = await auditRepository(tmp);
    expect(result.warnings.some((w) => w.includes("caddy.json"))).toBe(true);
  });

  it("без Caddyfile — чисто (warning не появляется)", async () => {
    const tmp = await repoWith();
    const result = await auditRepository(tmp);
    expect(result.warnings.some((w) => w.includes("Caddyfile"))).toBe(false);
  });

  it("Caddyfile внутри .pegas/ или node_modules/ не считается легаси репо", async () => {
    const tmp = await repoWith(async (dir) => {
      await fs.mkdir(path.join(dir, ".pegas"), { recursive: true });
      await fs.writeFile(path.join(dir, ".pegas", "Caddyfile"), "# runtime\n");
    });
    const result = await auditRepository(tmp);
    expect(result.warnings.some((w) => w.includes("Caddyfile") && w.includes(".pegas"))).toBe(false);
  });
});

describe("check: Caddyfile, копируемый в Docker-образ — не легаси", () => {
  async function repoWith(extra?: (dir: string) => Promise<void>) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-chk-dk-"));
    await fs.writeFile(path.join(tmp, "pegas.json"), JSON.stringify({
      projectName: "dk-check",
      scenarios: ["development"],
      gateway: { development: { httpPort: 80, httpsPort: 443 } },
      services: {
        web: {
          runtime: { development: { driver: "docker" } },
          image: { development: "node:24" },
          port: { development: 3000 },
          secrets: ["A_SECRET"],
        },
      },
    }));
    await fs.writeFile(path.join(tmp, ".gitignore"), ".pegas\n.env*\n!.env.example\n");
    await fs.writeFile(path.join(tmp, ".env.example"), "A_SECRET=\n");
    await fs.writeFile(path.join(tmp, ".env"), "A_SECRET=x\n");
    if (extra) await extra(tmp);
    return tmp;
  }

  it("Caddyfile + Dockerfile с COPY этого файла → НЕ алерт (контейнерная статика)", async () => {
    const tmp = await repoWith(async (dir) => {
      await fs.writeFile(path.join(dir, "Dockerfile"), "FROM caddy:2-alpine\nCOPY game_client/Caddyfile /etc/caddy/Caddyfile\n");
      await fs.mkdir(path.join(dir, "game_client"), { recursive: true });
      await fs.writeFile(path.join(dir, "game_client", "Caddyfile"), ":80 {\n}\n");
    });
    const result = await auditRepository(tmp);
    expect(result.warnings.some((w) => w.includes("Caddyfile"))).toBe(false);
  });

  it("Caddyfile БЕЗ ссылки из Dockerfile → алерт остаётся", async () => {
    const tmp = await repoWith(async (dir) => {
      await fs.mkdir(path.join(dir, "game_client"), { recursive: true });
      await fs.writeFile(path.join(dir, "game_client", "Caddyfile"), ":80 {\n}\n");
    });
    const result = await auditRepository(tmp);
    expect(result.warnings.some((w) => w.includes("Caddyfile") && w.includes("game_client/Caddyfile"))).toBe(true);
  });
});
