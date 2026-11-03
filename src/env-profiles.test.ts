import { describe, it, expect } from "bun:test";
import { validatePegasContract, createDefaultContract } from "../src/contract.js";
import { createRuntimeCompose } from "../src/runtime-compose.js";
import type { PegasContract } from "../src/types.js";
import fsx from "node:fs/promises";
import pathx from "node:path";
import osx from "node:os";

const ROOT = await fsx.mkdtemp(pathx.join(osx.tmpdir(), "envprof-"));
await fsx.mkdir(pathx.join(ROOT, "app"), { recursive: true });

function dockerContract(
  env?: PegasContract["env"],
  domains: Record<string, string[]> = {
    development: ["dev.proj.example"],
    stage: ["stage.proj.example"],
    production: ["proj.example"],
  }
): PegasContract {
  return {
    projectName: "proj",
    runtime: "docker",
    ...(env ? { env } : {}),
    services: {
      app: {
        port: 3000,
        build: { context: "app" },
        domains,
      },
    },
  } as PegasContract;
}

describe("глобальный env-профили контракта", () => {
  it("валидация: полная карта профилей проходит", () => {
    expect(validatePegasContract(dockerContract({
      FEATURE: { development: "true", stage: "false", production: "false" },
    }))).toEqual([]);
  });

  it("валидация: скалярные строки в глобальном env запрещены", () => {
    const issues = validatePegasContract(dockerContract({
      STATIC: "value" as any,
    }));
    expect(issues.some(i => i.path === "env.STATIC" && i.message.includes("Scalar values are not allowed"))).toBe(true);
  });

  it("валидация: произвольные текстовые имена профилей (stage11, devel22222opment) полностью поддерживаются", () => {
    const customContract = dockerContract(
      {
        API_URL: {
          devel22222opment: "http://dev.custom",
          stage11: "https://stage11.custom",
          custom_prod: "https://custom.ru",
        },
      },
      {
        devel22222opment: ["dev.custom"],
        stage11: ["stage11.custom"],
        custom_prod: ["custom.ru"],
      }
    );
    expect(validatePegasContract(customContract)).toEqual([]);
  });

  it("валидация: частичная карта — ошибка с указанием недостающего профиля проекта", () => {
    const issues = validatePegasContract(dockerContract({
      FEATURE: { development: "1", production: "3" } as any,
    }));
    expect(issues.some(i => i.path === "env.FEATURE" && i.message.includes('"stage"'))).toBe(true);
  });

  it("валидация: пустой объект значения — ошибка", () => {
    const issues = validatePegasContract(dockerContract({
      OBJ: {} as any,
    }));
    expect(issues.some(i => i.path === "env.OBJ")).toBe(true);
  });

  it("дефолтный контракт содержит пустой env-блок", () => {
    expect(createDefaultContract("proj").env).toEqual({});
  });

  it("runtime: карта разворачивается в значение активного профиля", () => {
    const contract = dockerContract({
      FEATURE: { development: "true", stage: "false", production: "false" },
    });
    const dev = createRuntimeCompose(contract, { projectRoot: ROOT, projectId: "proj", environment: "development" });
    const prod = createRuntimeCompose(contract, { projectRoot: ROOT, projectId: "proj", environment: "production" });
    const devEnv = (dev.manifest.services as any).app.environment;
    const prodEnv = (prod.manifest.services as any).app.environment;
    expect(devEnv.FEATURE).toBe("true");
    expect(prodEnv.FEATURE).toBe("false");
  });

  it("runtime: сервисный env перекрывает глобальный и поддерживает скаляры для инвариантов контейнера", () => {
    const contract = dockerContract({
      PORT: { development: "9999", stage: "9999", production: "9999" },
    });
    (contract.services.app as any).env = {
      PORT: "3000",
      HOSTNAME: "0.0.0.0",
      NEXT_TELEMETRY_DISABLED: "1",
    };
    const res = createRuntimeCompose(contract, { projectRoot: ROOT, projectId: "proj", environment: "production" });
    const env = (res.manifest.services as any).app.environment;
    expect(env.PORT).toBe("3000");
    expect(env.HOSTNAME).toBe("0.0.0.0");
    expect(env.NEXT_TELEMETRY_DISABLED).toBe("1");
  });

  it("runtime: контракты без env-блока работают как раньше (обратная совместимость)", () => {
    const res = createRuntimeCompose(dockerContract(), { projectRoot: ROOT, projectId: "proj", environment: "production" });
    const env = (res.manifest.services as any).app.environment;
    expect(env.PEGAS_ENV).toBe("production");
    expect(env.STATIC).toBeUndefined();
  });
});
