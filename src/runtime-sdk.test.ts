import { describe, it, expect, beforeEach, afterEach } from "bun:test";

const ctx = {
  project: "exogram",
  projectId: "exogram-996be8f985fb",
  scenario: "development",
  service: "web",
  services: {
    web: {
      driver: "docker",
      port: 3100,
      alias: "exogram-996be8f985fb-development-web",
      scheme: "http",
      internalUrl: "http://exogram-996be8f985fb-development-web:3100",
      domains: ["web.exogram.localhost"],
      url: "https://web.exogram.localhost",
    },
    db: {
      driver: "docker",
      port: 5432,
      alias: "exogram-996be8f985fb-development-db",
      scheme: "postgresql",
      internalUrl: "postgresql://exogram-996be8f985fb-development-db:5432",
    },
  },
};

describe("@netrunner714/pegas/runtime", () => {
  beforeEach(async () => {
    const { _resetForTests } = await import("./runtime-sdk.js");
    _resetForTests();
    process.env.PEGAS_CONTEXT = JSON.stringify(ctx);
    process.env.PEGAS_SECRETS = "GATE_API_KEY,POSTGRES_PASSWORD";
    process.env.GATE_API_KEY = "k-123";
    delete process.env.MISSING_SECRET;
  });
  afterEach(() => {
    delete process.env.PEGAS_CONTEXT;
    delete process.env.PEGAS_SECRETS;
    delete process.env.GATE_API_KEY;
  });

  it("services(): карта сервисов с internalUrl и url", async () => {
    const { services } = await import("./runtime-sdk.js");
    const map = services();
    expect(map.db.internalUrl).toBe("postgresql://exogram-996be8f985fb-development-db:5432");
    expect(map.web.url).toBe("https://web.exogram.localhost");
  });

  it("currentService(): port, домены, rootDomain для cookie", async () => {
    const { currentService } = await import("./runtime-sdk.js");
    const cur = currentService();
    expect(cur.name).toBe("web");
    expect(cur.port).toBe(3100);
    expect(cur.rootDomain).toBe("localhost");
    expect(cur.domains).toEqual(["web.exogram.localhost"]);
  });

  it("currentService(): rootDomain производного домена — точка + две метки", async () => {
    const { currentService, _resetForTests } = await import("./runtime-sdk.js");
    const custom = JSON.parse(JSON.stringify(ctx));
    custom.services.web.domains = ["app.tf2-exchange.com"];
    process.env.PEGAS_CONTEXT = JSON.stringify(custom);
    _resetForTests();
    expect(currentService().rootDomain).toBe(".tf2-exchange.com");
  });

  it("secret(): значение из env; отсутствующий — ошибка со списком ожидаемых", async () => {
    const { secret,
  optionalSecret, PegasRuntimeError } = await import("./runtime-sdk.js");
    expect(secret("GATE_API_KEY")).toBe("k-123");
    expect(() => secret("MISSING_SECRET")).toThrow(PegasRuntimeError);
    try {
      secret("MISSING_SECRET");
    } catch (e) {
      expect((e as Error).message).toContain("GATE_API_KEY");
    }
  });

  it("нет контекста — PegasRuntimeError с инструкцией", async () => {
    delete process.env.PEGAS_CONTEXT;
    const { getContext, _resetForTests } = await import("./runtime-sdk.js");
    _resetForTests();
    expect(() => getContext()).toThrow(/вне pegas-оркестрации/);
  });

  it("битый JSON — понятная ошибка", async () => {
    process.env.PEGAS_CONTEXT = "{oops";
    const { getContext, _resetForTests } = await import("./runtime-sdk.js");
    _resetForTests();
    expect(() => getContext()).toThrow(/невалидный JSON/);
  });
});

it("optionalSecret: задан → значение, не задан → undefined без ошибки", async () => {
  const { optionalSecret } = await import("./runtime-sdk.js");
  process.env["OPT_SEC_TEST"] = "val";
  expect(optionalSecret("OPT_SEC_TEST")).toBe("val");
  delete process.env["OPT_SEC_TEST"];
  expect(optionalSecret("OPT_SEC_TEST")).toBeUndefined();
});
