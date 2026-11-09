import { describe, it, expect } from "bun:test";
import os from "node:os";
import { createRuntimeCompose } from "./runtime-compose.js";
import { validatePegasContract } from "./contract.js";
import type { PegasContract } from "./types.js";

/** Контракт: web (bun в dev, docker в stage/prod), redis (docker), api (docker с dependsOn). */
function contract(): PegasContract {
  return {
    projectName: "my-app",
    scenarios: ["development", "stage", "production"],
    gateway: {
      development: { httpPort: 80, httpsPort: 443 },
      stage: { httpPort: 80, httpsPort: 443, acmeEmail: "a@b.co" },
      production: { httpPort: 80, httpsPort: 443, acmeEmail: "a@b.co" },
    },
    services: {
      web: {
        runtime: { development: { driver: "bun" }, stage: { driver: "docker" }, production: { driver: "docker" } },
        build: { development: null, stage: { context: "." }, production: { context: "." } },
        port: { development: 3000, stage: 3000, production: 3000 },
        domains: { development: ["web.my-app.localhost"], stage: ["web-stage.example.com"], production: ["web.example.com"] },
        secrets: ["SESSION_SECRET"],
        env: {
          LOG: { development: "pretty", stage: "json", production: "json" },
        },
      },
      redis: {
        runtime: { development: { driver: "docker" }, stage: { driver: "docker" }, production: { driver: "docker" } },
        image: { development: "redis:7", stage: "redis:7", production: "redis:7" },
        port: { development: 6379, stage: 6379, production: 6379 },
        ports: { development: ["6379:6379"], stage: [], production: [] },
      },
      api: {
        runtime: { development: { driver: "docker" }, stage: { driver: "docker" }, production: { driver: "docker" } },
        image: { development: "node:24", stage: "node:24", production: "node:24" },
        port: { development: 4000, stage: 4000, production: 4000 },
        dependsOn: {
          development: {},
          stage: { redis: { condition: "service_started" } },
          production: { redis: { condition: "service_healthy" } },
        },
        secrets: ["API_KEY"],
      },
    },
  };
}

const projectRoot = os.tmpdir();

describe("runtime-compose v3: манифест сценария", () => {
  it("футболка: базовый контракт валиден", () => {
    expect(validatePegasContract(contract())).toEqual([]);
  });

  it("development: host-сервисы (bun) в манифест не попадают", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "myapp", environment: "development" });
    expect(Object.keys(manifest.services)).toEqual(["redis", "api"]);
    expect((manifest.services as any).web).toBeUndefined();
  });

  it("production: все три сервиса docker — все в манифесте", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "myapp", environment: "production" });
    expect(Object.keys(manifest.services).sort()).toEqual(["api", "redis", "web"]);
  });

  it("labels: pegas.project/scenario/service, manifest-hash присутствует", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "myapp", environment: "stage" });
    const api = manifest.services.api as any;
    expect(api.labels["pegas.project"]).toBe("myapp");
    expect(api.labels["pegas.scenario"]).toBe("stage");
    expect(api.labels["pegas.service"]).toBe("api");
    expect(typeof api.labels["pegas.manifest-hash"]).toBe("string");
  });

  it("dependsOn-карта → compose-формат с condition", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "myapp", environment: "production" });
    const api = manifest.services.api as any;
    expect(api.depends_on).toEqual({ redis: { condition: "service_healthy" } });
  });

  it("dependsOn-пустая карта → без dependsOn в сервисе", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "myapp", environment: "development" });
    const api = manifest.services.api as any;
    expect(api.depends_on).toBeUndefined();
  });

  it("env: посервисные карты + PEGAS_SCENARIO/PEGAS_SECRETS инжектятся", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "myapp", environment: "stage" });
    const web = manifest.services.web as any;
    expect(web.environment.LOG).toBe("json");
    expect(web.environment.PEGAS_SCENARIO).toBe("stage");
    expect(typeof web.environment.PEGAS_SECRETS).toBe("string");
  });

  it("ports пробрасываются как есть; port логический — как expose", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "myapp", environment: "development" });
    const redis = manifest.services.redis as any;
    expect(redis.ports).toEqual(["6379:6379"]);
    expect(redis.expose).toContain("6379");
  });

  it("build → тег pegas/<projectId>/<service>:<hash>", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "myapp", environment: "production" });
    const web = manifest.services.web as any;
    expect(web.build.context).toBe(projectRoot);
    expect(web.image).toMatch(/^pegas\/myapp\/web:[0-9a-f]{12}$/);
  });

  it("неизвестный сценарий — явная ошибка, а не фолбэк development", () => {
    expect(() =>
      createRuntimeCompose(contract(), { projectRoot, projectId: "myapp", environment: "preview" }),
    ).toThrow(/preview/);
  });

  it("issue #27: имя compose-проекта — pegas-<проект>-<сценарий>-<runtimeId>", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "0a1b0e24d9", environment: "development" });
    expect(manifest.name).toBe("pegas-my-app-development-0a1b0e24d9");
  });

  it("issue #27: container_name каждого сервиса — pegas-<проект>-<сервис>-<сценарий>-<runtimeId>", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "0a1b0e24d9", environment: "development" });
    expect((manifest.services as any).redis.container_name).toBe("pegas-my-app-redis-development-0a1b0e24d9");
    expect((manifest.services as any).api.container_name).toBe("pegas-my-app-api-development-0a1b0e24d9");
    // имена уникальны в пределах проекта и читаемы в docker ps
    const names = Object.values<any>(manifest.services).map((s) => s.container_name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^pegas-[a-z0-9_-]+$/);
  });

  it("issue #27: явные имена томов закрепляют исторический префикс <runtimeId>-<scenario>", () => {
    const c = contract();
    c.services.redis.volumes = { development: ["pgdata:/var/lib/postgresql"], stage: [], production: [] };
    const { manifest } = createRuntimeCompose(c, { projectRoot, projectId: "0a1b0e24d9", environment: "development" });
    expect((manifest.volumes as any).pgdata).toEqual({ name: "0a1b0e24d9-development_pgdata" });
    // short syntax сервиса не меняется — только объявление тома
    expect((manifest.services as any).redis.volumes).toEqual(["pgdata:/var/lib/postgresql"]);
  });

  it("issue #27: сетевые алиасы не меняются (upstream'ы маршрутов и pegas:// стабильны)", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "0a1b0e24d9", environment: "development" });
    const redis = (manifest.services as any).redis;
    expect(redis.networks["pegas-network"].aliases).toEqual(["0a1b0e24d9-development-redis"]);
  });

  it("все сервисы в shared pegas-network, gateway не в сервисах", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "myapp", environment: "stage" });
    expect(Object.keys(manifest.services).sort()).toEqual(["api", "redis", "web"]);
    for (const svc of Object.values<any>(manifest.services)) {
      expect(Object.keys(svc.networks)).toEqual(["pegas-network"]);
      expect(svc.networks["pegas-network"].aliases.length).toBe(1);
    }
    expect((manifest.services as any).gateway).toBeUndefined();
  });
});

describe("v3: разворачивание pegas:// в манифесте", () => {
  const discContract: PegasContract = {
    projectName: "disc-app",
    scenarios: ["development", "production"],
    gateway: {
      development: { httpPort: 80, httpsPort: 443 },
      production: { httpPort: 80, httpsPort: 443 },
    },
    services: {
      "redis-queue": {
        runtime: { development: { driver: "docker" }, production: { driver: "docker" } },
        image: { development: "redis:7-alpine", production: "redis:7-alpine" },
        port: { development: 6379, production: 6379 },
      },
      api: {
        runtime: { development: { driver: "docker" }, production: { driver: "docker" } },
        build: { development: { context: "." }, production: { context: "." } },
        port: { development: 4000, production: 4000 },
        env: {
          REDIS_QUEUE_URL: { development: "pegas://redis-queue", production: "pegas://redis-queue" },
          STATIC_FLAG: { development: "plain", production: "plain" },
        },
      },
    },
  } as unknown as PegasContract;

  it("pegas://redis-queue → redis://<projectId>-<scenario>-redis-queue:6379", () => {
    const { manifest } = createRuntimeCompose(discContract, {
      projectRoot: os.tmpdir(),
      projectId: "prj123",
      environment: "development",
    });
    const env = (manifest.services as any)["api"].environment;
    expect(env.REDIS_QUEUE_URL).toBe("redis://prj123-development-redis-queue:6379");
    expect(env.STATIC_FLAG).toBe("plain");
  });

  it("http-scheme для не-redis/postgres образа", () => {
    const { manifest } = createRuntimeCompose(discContract, {
      projectRoot: os.tmpdir(),
      projectId: "prj123",
      environment: "development",
    });
    // api сам с build (без image) — http. Проверим через ссылку на api:
    const withApiRef = JSON.parse(JSON.stringify(discContract));
    withApiRef.services["web-next"] = {
      runtime: { development: { driver: "docker" }, production: { driver: "docker" } },
      build: { development: { context: "." }, production: { context: "." } },
      env: { API_INTERNAL_URL: { development: "pegas://api", production: "pegas://api" } },
    };
    const { manifest: m2 } = createRuntimeCompose(withApiRef as any, {
      projectRoot: os.tmpdir(),
      projectId: "prj123",
      environment: "development",
    });
    expect((m2.services as any)["web-next"].environment.API_INTERNAL_URL).toBe("http://prj123-development-api:4000");
  });

  it("pegas:// на несуществующий сервис — ошибка с путём", () => {
    const bad = JSON.parse(JSON.stringify(discContract));
    bad.services.api.env.REDIS_QUEUE_URL = { development: "pegas://ghost", production: "pegas://ghost" };
    expect(() =>
      createRuntimeCompose(bad as any, { projectRoot: os.tmpdir(), projectId: "prj123", environment: "development" })
    ).toThrow("ghost");
  });
});

describe("v3: инжект PEGAS_CONTEXT (Runtime SDK, столп 6)", () => {
  const discContract: PegasContract = {
    projectName: "disc-app",
    scenarios: ["development", "production"],
    gateway: {
      development: { httpPort: 80, httpsPort: 443 },
      production: { httpPort: 80, httpsPort: 443 },
    },
    services: {
      "redis-queue": {
        runtime: { development: { driver: "docker" }, production: { driver: "docker" } },
        image: { development: "redis:7-alpine", production: "redis:7-alpine" },
        port: { development: 6379, production: 6379 },
      },
      api: {
        runtime: { development: { driver: "docker" }, production: { driver: "docker" } },
        build: { development: { context: "." }, production: { context: "." } },
        port: { development: 4000, production: 4000 },
        domains: { development: ["api.disc-app.localhost"], production: ["api.disc-app.ru"] },
      },
    },
  } as unknown as PegasContract;

  function contextOf(manifest: any, service: string): any {
    return JSON.parse(manifest.services[service].environment.PEGAS_CONTEXT);
  }

  it("контейнер получает контекст всех сервисов сценария с internalUrl", () => {
    const { manifest } = createRuntimeCompose(discContract, {
      projectRoot: os.tmpdir(),
      projectId: "prj123",
      environment: "development",
    });
    const ctx = contextOf(manifest, "api");
    expect(ctx.service).toBe("api");
    expect(ctx.scenario).toBe("development");
    expect(ctx.services["redis-queue"].internalUrl).toBe("redis://prj123-development-redis-queue:6379");
    expect(ctx.services["redis-queue"].scheme).toBe("redis");
    expect(ctx.services.api.url).toBe("https://api.disc-app.localhost");
    expect(ctx.services.api.alias).toBe("prj123-development-api");
  });

  it("сценарий переключает контекст: production-домены и внутренние адреса", () => {
    const { manifest } = createRuntimeCompose(discContract, {
      projectRoot: os.tmpdir(),
      projectId: "prj123",
      environment: "production",
    });
    const ctx = contextOf(manifest, "redis-queue");
    expect(ctx.scenario).toBe("production");
    expect(ctx.services.api.url).toBe("https://api.disc-app.ru");
    expect(ctx.services.api.internalUrl).toBe("http://prj123-production-api:4000");
  });
});

describe("runtime-compose v3: платформенная инъекция PORT", () => {
  it("docker-сервис с port получает env PORT из контракта (не из env-карты)", () => {
    const { manifest } = createRuntimeCompose(contract(), { projectRoot, projectId: "myapp", environment: "stage" });
    const api = (manifest.services as any).api;
    expect(api.environment.PORT).toBe("4000");
    const redis = (manifest.services as any).redis;
    expect(redis.environment.PORT).toBe("6379");
    // Платформенные инъекции на месте
    expect(api.environment.PEGAS_CONTEXT).toContain("api");
    expect(typeof api.environment.PEGAS_SCENARIO).toBe("string");
  });

  it("env-ключ PORT в контракте перекрывается инъекцией контракта (без рассинхрона)", () => {
    const c = contract();
    (c.services.api as any).env = { PORT: { development: "9999", stage: "8888", production: "4000" } };
    const { manifest } = createRuntimeCompose(c, { projectRoot, projectId: "myapp", environment: "stage" });
    const api = (manifest.services as any).api;
    expect(api.environment.PORT).toBe("4000"); // port-карта контракта — источник истины
  });
});
