import { describe, it, expect } from "bun:test";
import { getContractSecretKeys } from "./secrets.js";
import { validatePegasContract } from "./contract.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("secrets v3: посервисный интерфейс", () => {
  it("getContractSecretKeys: объединение services.*.secrets", () => {
    const c: any = {
      projectName: "p",
      scenarios: ["development"],
      gateway: { development: { httpPort: 80, httpsPort: 443 } },
      services: {
        a: { runtime: { development: { driver: "bun" } }, port: { development: 3000 }, secrets: ["AAA", "SHARED"] },
        b: { runtime: { development: { driver: "docker" } }, image: { development: "x" }, secrets: ["BBB"] },
      },
    };
    expect(getContractSecretKeys(c).sort()).toEqual(["AAA", "BBB", "SHARED"]);
  });

  it("эталон example.json валиден по v3-валидатору", async () => {
    // cwd тестов = корень репо (bun test)
    const raw = await fs.readFile(path.join(process.cwd(), "example.json"), "utf-8");
    const contract = JSON.parse(raw);
    expect(validatePegasContract(contract)).toEqual([]);
  });
});
