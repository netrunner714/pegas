import { describe, it, expect } from "bun:test";
import { validatePegasContract, getDockerServices, getHostServices, getServiceRole, getServiceExposure, CONTRACT_SCHEMA_URL } from "./contract.js";
import type { PegasContract } from "./types.js";

/** Минимальный валидный v3-контракт — база для мутаций. */
function validContract(): PegasContract {
  return {
    $schema: CONTRACT_SCHEMA_URL,
    projectName: "my-app",
    scenarios: ["development", "stage", "production"],
    gateway: {
      development: { httpPort: 80, httpsPort: 443 },
      stage: { httpPort: 80, httpsPort: 443, acmeEmail: "a@b.co" },
      production: { httpPort: 80, httpsPort: 443, acmeEmail: "a@b.co" },
    },
    services: {
      web: {
        runtime: {
          development: { driver: "bun" },
          stage: { driver: "docker" },
          production: { driver: "docker" },
        },
        build: {
          development: null,
          stage: { context: "." },
          production: { context: "." },
        },
        port: { development: 3000, stage: 3000, production: 3000 },
        domains: {
          development: ["web.my-app.localhost"],
          stage: ["web-stage.example.com"],
          production: ["web.example.com"],
        },
        secrets: ["SESSION_SECRET"],
      },
      redis: {
        runtime: {
          development: { driver: "docker" },
          stage: { driver: "docker" },
          production: { driver: "docker" },
        },
        image: { development: "redis:7", stage: "redis:7", production: "redis:7" },
        port: { development: 6379, stage: 6379, production: 6379 },
        ports: { development: ["6379:6379"], stage: [], production: [] },
      },
    },
  };
}

const paths = (issues: { path: string; message: string }[]) => issues.map((i) => i.path);

describe("v3 валидатор: корень", () => {
  it("валидный контракт без issues", () => {
    expect(validatePegasContract(validContract())).toEqual([]);
  });

  it("scenarios обязателен и непуст", () => {
    for (const bad of [undefined, [], [""]]) {
      const c = validContract();
      (c as any).scenarios = bad;
      const issues = validatePegasContract(c);
      expect(issues.some((i) => i.path === "scenarios" || i.path.startsWith("scenarios"))).toBe(true);
    }
  });

  it("имена сценариев [a-z0-9-]+, без дублей", () => {
    const c = validContract();
    (c as any).scenarios = ["Development", "dev", "dev"];
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.path === "scenarios[0]")).toBe(true);
    expect(issues.some((i) => i.path === "scenarios")).toBe(true);
  });

  it("v2-поля корня отклоняются с подсказкой замены", () => {
    const c: any = validContract();
    c.env = { KEY: "v" };
    c.devGateway = { httpPort: 80 };
    c.runtime = "docker";
    c.secrets = ["A"];
    const issues = validatePegasContract(c);
    for (const p of ["env", "devGateway", "runtime", "secrets"]) {
      expect(issues.some((i) => i.path === p)).toBe(true);
    }
  });
});

describe("v3 валидатор: матрица сценариев (столп 2)", () => {
  it("отсутствующий ключ карты — ошибка", () => {
    const c = validContract();
    delete (c.services.web.port as any).stage;
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.path === "services.web.port" && i.message.includes("stage"))).toBe(true);
  });

  it("лишний ключ (опечатка) — ошибка, не игнор", () => {
    const c = validContract();
    (c.services.web.port as any).produсtion = 3000; // не production
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.path === "services.web.port" && i.message.includes("produсtion"))).toBe(true);
  });

  it("gateway-карта обязана совпадать со scenarios", () => {
    const c = validContract();
    (c.gateway as any).preview = { httpPort: 80, httpsPort: 443 };
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.path === "gateway" && i.message.includes("preview"))).toBe(true);
  });

  it("env-скаляр запрещён: каждый ключ — карта", () => {
    const c = validContract();
    (c.services.web as any).env = { LOG: "pretty" };
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.path === "services.web.env.LOG")).toBe(true);
  });

  it("env-значения — строки", () => {
    const c = validContract();
    (c.services.web as any).env = { LOG: { development: 1, stage: "x", production: "x" } };
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.path === "services.web.env.LOG.development")).toBe(true);
  });
});

describe("v3 валидатор: runtime и драйверы (столп 3)", () => {
  it("driver — только docker|bun; up-поле запрещено", () => {
    const c = validContract();
    (c.services.redis.runtime as any).development = { driver: "docker", up: "docker compose up" };
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.path === "services.redis.runtime.development.up")).toBe(true);
    (c.services.redis.runtime as any).development = { driver: "systemd" };
    expect(validatePegasContract(c).some((i) => i.path === "services.redis.runtime.development.driver")).toBe(true);
  });

  it("host-драйвер несовместим с image/build/command/volumes/ports", () => {
    const c = validContract();
    (c.services.web.image as any) = { development: "node:24", stage: "x", production: "x" };
    (c.services.web.volumes as any) = { development: ["v:/d"], stage: [], production: [] };
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.message.includes("image несовместим"))).toBe(true);
    expect(issues.some((i) => i.message.includes("volumes — тома контейнера"))).toBe(true);
  });

  it("docker-сервису нужен image или build в каждом сценарии", () => {
    const c = validContract();
    const api: any = { runtime: { development: { driver: "docker" }, stage: { driver: "docker" }, production: { driver: "docker" } } };
    c.services.api = api;
    const issues = validatePegasContract(c);
    expect(issues.filter((i) => i.message.includes("нужен image или build")).length).toBe(3);
  });
});

describe("v3 валидатор: наружность (столп 4a)", () => {
  it("domains без port — error", () => {
    const c = validContract();
    delete (c.services.web.port as any).stage;
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.message.includes("Домены требуют port"))).toBe(true);
  });

  it("domains при host-драйвере вне development — error; в development — легитимно", () => {
    const c = validContract();
    // development: bun + domains — норм (уже в базовом контракте)
    expect(validatePegasContract(c)).toEqual([]);
    // stage: делаем web host-драйвером с доменами — ошибка
    (c.services.web.runtime as any).stage = { driver: "bun" };
    (c.services.web.runtime as any).production = { driver: "bun" };
    (c.services.web.build as any).stage = null;
    (c.services.web.build as any).production = null;
    const issues = validatePegasContract(c);
    expect(issues.filter((i) => i.path.endsWith("domains") && i.message.includes("bun")).length).toBe(2);
  });

  it("непустой ports вне development без publicHost — error", () => {
    const c = validContract();
    (c.services.redis.ports as any).stage = ["6379:6379"];
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.message.includes("publicHost"))).toBe(true);
  });

  it("publicHost без ports — error; с ports — public-tcp", () => {
    const c = validContract();
    (c.services.redis as any).publicHost = { development: "", stage: "redis.example.com", production: "redis.example.com" };
    (c.services.redis.ports as any).stage = ["6379:6379"];
    (c.services.redis.ports as any).production = ["6379:6379"];
    // development: непустые ports + пустой publicHost допустимы (публичность регулируется по сценариям)
    expect(validatePegasContract(c)).toEqual([]);
    (c.services.redis as any).publicHost = { development: "redis.localhost", stage: "redis.example.com", production: "redis.example.com" };
    expect(validatePegasContract(c)).toEqual([]);
  });

  it("роль и наружность — производные", () => {
    const c = validContract();
    expect(getServiceRole(c.services.web)).toBe("web");
    expect(getServiceRole(c.services.redis)).toBe("infra");
    expect(getServiceExposure(c, "redis", "development")).toBe("public-tcp");
    expect(getServiceExposure(c, "redis", "production")).toBe("closed");
    expect(getServiceExposure(c, "web", "production")).toBe("web");
    expect(getServiceExposure(c, "web", "development")).toBe("web");
  });
});

describe("v3 валидатор: dependsOn (столп 4b)", () => {
  it("массив строк v2 — ошибка формы", () => {
    const c = validContract();
    (c.services.web as any).dependsOn = ["redis"];
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.path.startsWith("services.web.dependsOn"))).toBe(true);
  });

  it("при host-драйвере допустим только {}", () => {
    const c = validContract();
    (c.services.web as any).dependsOn = {
      development: { redis: { condition: "service_healthy" } },
      stage: {},
      production: {},
    };
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.message.includes("host-драйвер"))).toBe(true);
  });

  it("condition обязателен и валиден; ссылка на несуществующий сервис — error", () => {
    const c = validContract();
    (c.services.redis as any).dependsOn = {
      development: {},
      stage: { ghost: {} },
      production: { web: { condition: "service_restarted" } },
    };
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.path.includes("dependsOn.ghost"))).toBe(true);
    expect(issues.some((i) => i.path.includes("dependsOn.web.condition"))).toBe(true);
  });

  it("зависимость от host-сервиса сценария — error", () => {
    const c = validContract();
    (c.services.redis as any).dependsOn = {
      development: {},
      stage: {},
      production: { web: { condition: "service_started" } },
    };
    // web в production — docker, всё ок
    expect(validatePegasContract(c)).toEqual([]);
    (c.services.web.runtime as any).production = { driver: "bun" };
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.message.includes("docker-сервиса"))).toBe(true);
  });
});

describe("v3 валидатор: secrets (столп 5)", () => {
  it("имена [A-Z0-9_]+", () => {
    const c = validContract();
    (c.services.web as any).secrets = ["lowercase"];
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.path === "services.web.secrets")).toBe(true);
  });

  it("healthcheck-формы по драйверу", () => {
    const c = validContract();
    (c.services.web as any).healthcheck = { development: { test: ["CMD", "x"] }, stage: "http://x/health", production: "http://x/health" };
    // development — bun: объект вместо строки — ошибка
    const issues = validatePegasContract(c);
    expect(issues.some((i) => i.message.includes("host-сервиса healthcheck"))).toBe(true);
    (c.services.web as any).healthcheck = { development: "http://localhost:3000/h", stage: { test: ["CMD", "x"] }, production: null };
    expect(validatePegasContract(c)).toEqual([]);
  });
});

describe("v3: выборка сервисов по драйверу", () => {
  it("getDockerServices/getHostServices делят контракт по сценарию", () => {
    const c = validContract();
    expect(Object.keys(getDockerServices(c, "development"))).toEqual(["redis"]);
    expect(Object.keys(getHostServices(c, "development"))).toEqual(["web"]);
    expect(Object.keys(getDockerServices(c, "production"))).toEqual(["web", "redis"]);
    expect(Object.keys(getHostServices(c, "production"))).toEqual([]);
  });
});

describe("v3: service discovery (pegas://)", () => {
  const base = {
    projectName: "disc",
    scenarios: ["development", "production"],
    gateway: {
      development: { httpPort: 80, httpsPort: 443 },
      production: { httpPort: 80, httpsPort: 443 },
    },
    services: {
      redis: {
        runtime: { development: { driver: "docker" }, production: { driver: "docker" } },
        image: { development: "redis:7-alpine", production: "redis:7-alpine" },
        port: { development: 6379, production: 6379 },
      },
      worker: {
        runtime: { development: { driver: "docker" }, production: { driver: "docker" } },
        image: { development: "node:24", production: "node:24" },
        env: {
          REDIS_URL: { development: "pegas://redis", production: "pegas://redis" },
        },
      },
    },
  };

  it("pegas:// на docker-сервис с port — валиден", () => {
    expect(validatePegasContract(base as any)).toEqual([]);
  });

  it("pegas:// на несуществующий сервис — ошибка с подсказкой", () => {
    const bad = JSON.parse(JSON.stringify(base));
    bad.services.worker.env.REDIS_URL = { development: "pegas://no-such", production: "pegas://no-such" };
    const issues = validatePegasContract(bad as any);
    expect(issues.some((i: any) => i.message.includes("no-such"))).toBe(true);
  });

  it("pegas:// на сервис без port — ошибка", () => {
    const bad = JSON.parse(JSON.stringify(base));
    delete bad.services.redis.port;
    const issues = validatePegasContract(bad as any);
    expect(issues.some((i: any) => i.message.includes("internalUrl требует логический порт"))).toBe(true);
  });

  it("pegas:// на host-драйвер (bun) — ошибка", () => {
    const bad = JSON.parse(JSON.stringify(base));
    bad.services.redis.runtime = { development: { driver: "bun" }, production: { driver: "bun" } };
    delete bad.services.redis.image;
    delete bad.services.redis.port;
    const issues = validatePegasContract(bad as any);
    expect(issues.some((i: any) => i.message.includes("host-драйвер"))).toBe(true);
  });
});

describe("v3: publicHost — строка, не объект", () => {
  it("объект {host, port} в publicHost — ошибка с подсказкой", () => {
    const bad: any = {
      projectName: "ph",
      scenarios: ["development", "production"],
      gateway: {
        development: { httpPort: 80, httpsPort: 443 },
        production: { httpPort: 80, httpsPort: 443 },
      },
      services: {
        db: {
          runtime: { development: { driver: "docker" }, production: { driver: "docker" } },
          image: { development: "postgres:18-alpine", production: "postgres:18-alpine" },
          port: { development: 5432, production: 5432 },
          ports: { development: ["5432:5432"], production: ["5432:5432"] },
          publicHost: {
            development: { host: "db.example.localhost", port: 5432 },
            production: { host: "db.example.com", port: 5432 },
          },
        },
      },
    };
    const issues = validatePegasContract(bad);
    expect(issues.some((i: any) => i.path.includes("publicHost") && i.message.includes("DNS-имя"))).toBe(true);
  });
});

describe("v3 валидатор: scope/shared — разделяемый пул (issue #29)", () => {
  function sharedRedis(): PegasContract {
    const c = validContract();
    (c.services.redis as any).scope = { development: "shared", stage: "isolated", production: "isolated" };
    (c.services.redis as any).shared = { development: { name: "myapp_cache" }, stage: null, production: null };
    return c;
  }

  it("валидный shared redis — без issues", () => {
    expect(validatePegasContract(sharedRedis())).toEqual([]);
  });

  it("валидный shared postgres с объявленным секретом — без issues", () => {
    const c = validContract();
    (c.services as any).db = {
      runtime: { development: { driver: "docker" }, stage: { driver: "docker" }, production: { driver: "docker" } },
      image: { development: "postgres:18-alpine", stage: "postgres:18-alpine", production: "postgres:18-alpine" },
      port: { development: 5432, stage: 5432, production: 5432 },
      scope: { development: "shared", stage: "isolated", production: "isolated" },
      shared: { development: { name: "myapp_db", secret: "DB_PASSWORD" }, stage: null, production: null },
      secrets: ["DB_PASSWORD"],
    };
    expect(validatePegasContract(c)).toEqual([]);
  });

  it("неизвестное значение scope — ошибка", () => {
    const c = sharedRedis();
    (c.services.redis as any).scope.development = "cluster";
    expect(validatePegasContract(c).some((i) => i.message.includes("других значений нет"))).toBe(true);
  });

  it("shared без shared-объекта — ошибка", () => {
    const c = sharedRedis();
    (c.services.redis as any).shared = { development: null, stage: null, production: null };
    expect(validatePegasContract(c).some((i) => i.message.includes("требует объект"))).toBe(true);
  });

  it("shared без scope — ошибка", () => {
    const c = validContract();
    (c.services.redis as any).shared = { development: { name: "myapp_cache" }, stage: null, production: null };
    expect(validatePegasContract(c).some((i) => i.message.includes("без scope"))).toBe(true);
  });

  it("имя арендатора вне [a-z_][a-z0-9_]* — ошибка", () => {
    const c = sharedRedis();
    (c.services.redis as any).shared.development.name = "My-App";
    expect(validatePegasContract(c).some((i) => i.message.includes("Имя арендатора"))).toBe(true);
  });

  it("shared с bun-драйвером — ошибка", () => {
    const c = sharedRedis();
    (c.services.redis.runtime as any).development = { driver: "bun" };
    expect(validatePegasContract(c).some((i) => i.message.includes('несовместим с driver: "bun"'))).toBe(true);
  });

  it("shared с build — ошибка", () => {
    const c = sharedRedis();
    (c.services.redis as any).build = { development: { context: "." }, stage: null, production: null };
    expect(validatePegasContract(c).some((i) => i.message.includes("build несовместим"))).toBe(true);
  });

  it("shared с неподдерживаемым образом и без образа — ошибка", () => {
    const c = sharedRedis();
    (c.services.redis.image as any).development = "nginx:1";
    expect(validatePegasContract(c).some((i) => i.message.includes("не является поддерживаемой разделяемой инфраструктурой"))).toBe(true);
    const noImage = sharedRedis();
    delete (noImage.services.redis.image as any).development;
    expect(validatePegasContract(noImage).some((i) => i.message.includes("требует публичный образ"))).toBe(true);
  });

  it("shared без port — ошибка", () => {
    const c = sharedRedis();
    delete (c.services.redis.port as any).development;
    expect(validatePegasContract(c).some((i) => i.message.includes("требует port"))).toBe(true);
  });

  it("shared с volumes и dependsOn — ошибка", () => {
    const c = sharedRedis();
    (c.services.redis as any).volumes = { development: ["data:/data"], stage: [], production: [] };
    expect(validatePegasContract(c).some((i) => i.message.includes("volumes несовместимы"))).toBe(true);
    const d = sharedRedis();
    (d.services.redis as any).dependsOn = { development: { web: { condition: "service_started" } }, stage: {}, production: {} };
    expect(validatePegasContract(d).some((i) => i.message.includes("dependsOn несовместим"))).toBe(true);
  });

  it("shared.secret: необъявленный и плохой формат — ошибка, объявленный — ок", () => {
    const undeclared = sharedRedis();
    (undeclared.services.redis as any).shared.development.secret = "REDIS_PASSWORD";
    expect(validatePegasContract(undeclared).some((i) => i.message.includes("не объявлен в services.redis.secrets"))).toBe(true);
    const badFormat = sharedRedis();
    (badFormat.services.redis as any).shared.development.secret = "lowercase";
    expect(validatePegasContract(badFormat).some((i) => i.message.includes("имя секретного ключа"))).toBe(true);
    const ok = sharedRedis();
    (ok.services.redis as any).shared.development.secret = "REDIS_PASSWORD";
    (ok.services.redis as any).secrets = ["REDIS_PASSWORD"];
    expect(validatePegasContract(ok)).toEqual([]);
  });
});

describe("v3 валидатор: networkAliases", () => {
  it("валидная DNS-метка принимается", () => {
    const c = validContract();
    (c.services.redis as any).networkAliases = {
      development: ["egress-proxy"],
      stage: ["egress-proxy"],
      production: ["egress-proxy"],
    };
    expect(validatePegasContract(c)).toEqual([]);
  });

  it("некорректная DNS-метка — ошибка", () => {
    for (const bad of ["Egress", "egress_proxy", "-egress", "egress-", "a".repeat(64)]) {
      const c = validContract();
      (c.services.redis as any).networkAliases = { development: [bad], stage: [], production: [] };
      expect(validatePegasContract(c).some((i) => i.message.includes("Некорректный алиас"))).toBe(true);
    }
  });

  it("дубликат алиаса внутри сценария — ошибка", () => {
    const c = validContract();
    (c.services.redis as any).networkAliases = { development: [], stage: ["egress-proxy"], production: [] };
    (c.services.web as any).networkAliases = { development: [], stage: ["egress-proxy"], production: [] };
    expect(validatePegasContract(c).some((i) => i.message.includes("уже занят сервисом"))).toBe(true);
  });

  it("один алиас в разных сценариях — не конфликт", () => {
    const c = validContract();
    (c.services.redis as any).networkAliases = { development: [], stage: ["egress-proxy"], production: [] };
    (c.services.web as any).networkAliases = { development: [], stage: [], production: ["egress-proxy"] };
    expect(validatePegasContract(c)).toEqual([]);
  });

  it("host-сервису алиас в сети не нужен — ошибка", () => {
    const c = validContract();
    (c.services.web as any).networkAliases = { development: ["egress-proxy-dev"], stage: [], production: [] };
    expect(validatePegasContract(c).some((i) => i.message.includes('несовместимы с driver: "bun"'))).toBe(true);
  });
});
