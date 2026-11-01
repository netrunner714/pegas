import { describe, it, expect } from "bun:test";
import { validatePegasContract, createDefaultContract } from "../src/contract.js";
import { createRuntimeCompose } from "../src/runtime-compose.js";
import type { PegasContract } from "../src/types.js";
import fsx from "node:fs/promises";
import pathx from "node:path";
import osx from "node:os";

const ROOT = await fsx.mkdtemp(pathx.join(osx.tmpdir(), "envprof-"));
await fsx.mkdir(pathx.join(ROOT, "app"), { recursive: true });

function dockerContract(env?: PegasContract["env"]): PegasContract {
  return {
    projectName: "proj",
    runtime: "docker",
    ...(env ? { env } : {}),
    services: {
      app: {
        port: 3000,
        build: { context: "app" },
        domains: { production: ["proj.example"] },
      },
    },
  } as PegasContract;
}

describe("глобальный env-профили контракта", () => {
  it("валидация: строка и полная карта проходят", () => {
    expect(validatePegasContract(dockerContract({
      STATIC: "value",
      FEATURE: { development: "true", stage: "false", production: "false" },
    }))).toEqual([]);
  });

  it("валидация: частичная карта — ошибка с указанием профиля", () => {
    const issues = validatePegasContract(dockerContract({
      FEATURE: { development: "1", production: "3" } as any,
    }));
    expect(issues.some(i => i.path === "env.FEATURE" && i.message.includes('"stage"'))).toBe(true);
  });

  it("валидация: пустая строка и пустой объект значения — ошибки", () => {
    const issues = validatePegasContract(dockerContract({
      EMPTY: "",
      OBJ: {} as any,
    }));
    expect(issues.some(i => i.path === "env.EMPTY")).toBe(true);
    expect(issues.some(i => i.path === "env.OBJ")).toBe(true);
  });

  it("валидация: неизвестный профиль — ошибка", () => {
    const issues = validatePegasContract(dockerContract({
      FEATURE: { development: "1", stage: "2", production: "3", prod: "4" } as any,
    }));
    expect(issues.some(i => i.path === "env.FEATURE" && i.message.includes('"prod"'))).toBe(true);
  });

  it("дефолтный контракт содержит пустой env-блок", () => {
    expect(createDefaultContract("proj").env).toEqual({});
  });

  it("runtime: строка инжектится во все профили, карта — значением профиля", () => {
    const contract = dockerContract({
      STATIC: "value",
      FEATURE: { development: "true", stage: "false", production: "false" },
    });
    const dev = createRuntimeCompose(contract, { projectRoot: ROOT, projectId: "proj", environment: "development" });
    const prod = createRuntimeCompose(contract, { projectRoot: ROOT, projectId: "proj", environment: "production" });
    const devEnv = (dev.manifest.services as any).app.environment;
    const prodEnv = (prod.manifest.services as any).app.environment;
    expect(devEnv.STATIC).toBe("value");
    expect(devEnv.FEATURE).toBe("true");
    expect(prodEnv.FEATURE).toBe("false");
  });

  it("runtime: сервисный env перекрывает глобальный", () => {
    const contract = dockerContract({ PORT: "9999" });
    (contract.services.app as any).env = { PORT: "3000" };
    const res = createRuntimeCompose(contract, { projectRoot: ROOT, projectId: "proj", environment: "production" });
    expect((res.manifest.services as any).app.environment.PORT).toBe("3000");
  });

  it("runtime: контракты без env-блока работают как раньше (обратная совместимость)", () => {
    const res = createRuntimeCompose(dockerContract(), { projectRoot: ROOT, projectId: "proj", environment: "production" });
    const env = (res.manifest.services as any).app.environment;
    expect(env.PEGAS_ENV).toBe("production");
    expect(env.STATIC).toBeUndefined();
  });
});
