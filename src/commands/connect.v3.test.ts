import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleConnect } from "./connect.js";
import { generateCaddyfileSnippet } from "../generator.js";

// Герметичность: docker и reload мокаем — реальные Caddy-контейнеры в юнит-тестах недопустимы.
let routeFiles: Record<string, string> = {};

const contract = {
  projectName: "smoke-app",
  scenarios: ["development"],
  gateway: { development: { httpPort: 80, httpsPort: 443 } },
  services: {
    web: {
      runtime: { development: { driver: "bun" } },
      port: { development: 3000 },
      domains: { development: ["web.smoke-app.localhost"] },
    },
    api: {
      runtime: { development: { driver: "bun" } },
      port: { development: 4000 },
      domains: { development: ["api.smoke-app.localhost"] },
      cors: { development: true },
    },
    redis: {
      runtime: { development: { driver: "docker" } },
      image: { development: "redis:7" },
      port: { development: 6379 },
      ports: { development: ["6379:6379"] },
    },
  },
};

async function tmpProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-connect-"));
  routeFiles = {};
  await fs.writeFile(path.join(dir, "pegas.json"), JSON.stringify(contract));
  return dir;
}

describe("pegas connect v3", () => {
  it("маршруты создаются для host-сервисов с dev-доменами; docker-сервис без доменов не маршрутизируется", async () => {
    const dir = await tmpProject();
    // Герметичность: gatewayDir всегда во временном каталоге теста — иначе роут утекает в ~/.pegas.
    const gwDir = path.join(dir, "gateway");
    await handleConnect({ cwd: dir, gatewayDir: gwDir, skipGatewayEnsure: true, skipReload: true, noExit: true });

    const routePath = path.join(gwDir, "conf.d", "smoke-app-development.caddy");
    expect(await fs.access(routePath).then(() => true, () => false)).toBe(true);
    const content = await fs.readFile(routePath, "utf-8");
    expect(content).toContain("web.smoke-app.localhost");
    expect(content).toContain("api.smoke-app.localhost");
    expect(content).toContain("host.docker.internal:3000");
    expect(content).toContain("host.docker.internal:4000");
    expect(content).not.toContain("6379");
  });

  it("domains без port — контракт отклоняется валидатором ДО генерации (никакого дефолта 3000)", async () => {
    const dir = await tmpProject();
    const broken = JSON.parse(JSON.stringify(contract));
    delete broken.services.web.port;
    await fs.writeFile(path.join(dir, "pegas.json"), JSON.stringify(broken));

    const out: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => out.push(args.join(" "));
    console.error = (...args: unknown[]) => out.push(args.join(" "));
    try {
      await handleConnect({ cwd: dir, skipGatewayEnsure: true, skipReload: true, noExit: true, json: true });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    expect(out.join("\n")).toContain("Домены требуют port");
  });

  it("issue #23: docker-сервис с dev-доменами не маршрутизируется — connect пишет только bun", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-connect-driver-"));
    const mixed = JSON.parse(JSON.stringify(contract)) as any;
    // redis становится docker-сервисом С доменами — раньше connect направил бы его на host.
    mixed.services.redis.domains = { development: ["redis.smoke-app.localhost"] };
    await fs.writeFile(path.join(dir, "pegas.json"), JSON.stringify(mixed));
    const gwDir = path.join(dir, "gateway");
    await handleConnect({ cwd: dir, gatewayDir: gwDir, skipGatewayEnsure: true, skipReload: true, noExit: true });

    const routePath = path.join(gwDir, "conf.d", "smoke-app-development.caddy");
    const content = await fs.readFile(routePath, "utf-8");
    expect(content).toContain("web.smoke-app.localhost");
    expect(content).toContain("host.docker.internal:3000");
    expect(content).not.toContain("redis.smoke-app.localhost");
  });

  it("issue #23: connect без единого bun-сервиса с доменами — файл маршрутов не пишется, выводится предупреждение", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-connect-nobun-"));
    const dockerOnly = {
      ...JSON.parse(JSON.stringify(contract)),
      services: {
        web: {
          runtime: { development: { driver: "docker" } },
          image: { development: "node:24" },
          port: { development: 3000 },
          domains: { development: ["web.smoke-app.localhost"] },
        },
      } as any,
    };
    await fs.writeFile(path.join(dir, "pegas.json"), JSON.stringify(dockerOnly));
    const gwDir = path.join(dir, "gateway");

    const out: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => out.push(args.join(" "));
    console.error = (...args: unknown[]) => out.push(args.join(" "));
    try {
      await handleConnect({ cwd: dir, gatewayDir: gwDir, skipGatewayEnsure: true, skipReload: true, noExit: true });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const routePath = path.join(gwDir, "conf.d", "smoke-app-development.caddy");
    expect(await fs.access(routePath).then(() => true, () => false)).toBe(false);
    expect(out.join("\n")).toContain("регистрировать нечего");
  });

  it("json-режим: urls для каждого dev-домена", async () => {
    const dir = await tmpProject();
    const gwDir = path.join(dir, "gateway2");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await handleConnect({ cwd: dir, gatewayDir: gwDir, skipGatewayEnsure: true, skipReload: true, noExit: true, json: true });
    } finally {
      console.log = orig;
    }
    const out = JSON.parse(logs.join("\n"));
    expect(out.status).toBe("connected");
    expect(out.urls.map((u: any) => u.url).sort()).toEqual([
      "https://api.smoke-app.localhost",
      "https://web.smoke-app.localhost",
    ]);
  });
});

describe("generateCaddyfileSnippet: v3-вызов без routes", () => {
  it("сниппет содержит upstream и cors-заголовки", () => {
    const snippet = generateCaddyfileSnippet({
      domain: "api.smoke-app.localhost",
      upstream: "host.docker.internal:4000",
      cors: true,
      corsOrigins: ["web.smoke-app.localhost"],
    });
    expect(snippet).toContain("api.smoke-app.localhost");
    expect(snippet).toContain("host.docker.internal:4000");
    expect(snippet).toContain("header_down -Access-Control-Allow-Origin");
  });
});

describe("connect: host-контекст для Runtime SDK (.pegas/context.json)", () => {
  it("connect пишет context.json: первый host-сервис + все сервисы сценария", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-ctx-"));
    await fs.writeFile(path.join(dir, "pegas.json"), JSON.stringify(contract));
    const gwDir = path.join(dir, "gw");
    await handleConnect({ cwd: dir, gatewayDir: gwDir, skipGatewayEnsure: true, skipReload: true, noExit: true });
    const ctxPath = path.join(dir, ".pegas", "context.json");
    const ctx = JSON.parse(await fs.readFile(ctxPath, "utf-8"));
    expect(ctx.service).toBe("web"); // первый host-сервис (driver: bun)
    expect(ctx.scenario).toBe("development");
    expect(Object.keys(ctx.services).sort()).toEqual(["api", "redis", "web"]);
    expect(ctx.services.redis.internalUrl).toBeString();
    expect(ctx.services.web.port).toBe(3000);
  });

  it("dryRun не пишет context.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-ctx-dry-"));
    await fs.writeFile(path.join(dir, "pegas.json"), JSON.stringify(contract));
    const gwDir = path.join(dir, "gw");
    await handleConnect({ cwd: dir, gatewayDir: gwDir, skipGatewayEnsure: true, skipReload: true, noExit: true, dryRun: true });
    const exists = await fs.access(path.join(dir, ".pegas", "context.json")).then(() => true, () => false);
    expect(exists).toBe(false);
  });
});

describe("connect: TLS-готовность", () => {
  it("docker-шлюз недоступен → tlsTrusted null, маршруты не блокируются", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-tls-"));
    await fs.writeFile(path.join(dir, "pegas.json"), JSON.stringify(contract));
    const gwDir = path.join(dir, "gw");
    const spy = (await import("bun:test")).spyOn((await import("node:child_process")).default, "spawnSync").mockImplementation((() => {
      // docker exec — отказ: шлюза нет
      return { status: 1, stdout: Buffer.alloc(0), stderr: "no container" };
    }) as any);
    try {
      const json = await captureJson(() => handleConnect({ cwd: dir, gatewayDir: gwDir, skipGatewayEnsure: true, skipReload: true, noExit: true, json: true }));
      expect(json.tlsTrusted).toBeNull();
      expect(json.status).toBe("connected");
    } finally {
      spy.mockRestore();
    }
  });
});

async function captureJson(fn: () => Promise<void>): Promise<any> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = ((...args: unknown[]) => { logs.push(args.join(" ")); }) as typeof console.log;
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return JSON.parse(logs.find((l) => l.startsWith("{")) ?? "{}");
}
