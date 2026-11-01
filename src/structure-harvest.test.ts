import { describe, it, expect } from "bun:test";
import { detectStructureHarvest } from "../src/structure-harvest.js";
import { applyStructureHarvest } from "../src/contract.js";
import { createDefaultContract } from "../src/contract.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("structure harvest", () => {
  it("apps/* с Dockerfile и EXPOSE, package.json name со срезом scope", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sh-"));
    const apps = path.join(tmp, "apps");
    await fs.mkdir(path.join(apps, "api"), { recursive: true });
    await fs.mkdir(path.join(apps, "extension"), { recursive: true });
    await fs.writeFile(path.join(apps, "api", "Dockerfile"), "FROM node:24\nEXPOSE 4000\n");
    await fs.writeFile(path.join(apps, "api", "package.json"), JSON.stringify({ name: "@scope/api" }));

    const h = await detectStructureHarvest(tmp);
    expect(h.appsDir).toBe("apps");
    expect(h.candidates.length).toBe(2);
    const api = h.candidates.find((c) => c.name === "api")!;
    expect(api.hasDockerfile).toBe(true);
    expect(api.exposePort).toBe(4000);
    expect(api.packageName).toBe("api");
    const ext = h.candidates.find((c) => c.name === "extension")!;
    expect(ext.hasDockerfile).toBe(false);
    expect(ext.exposePort).toBeUndefined();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("корневой multi-target Dockerfile: runtime-стейджи без builder/deps", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sh-"));
    await fs.writeFile(path.join(tmp, "Dockerfile"), [
      "FROM oven/bun AS deps",
      "FROM deps AS builder",
      "FROM builder AS site-builder",
      "FROM node:22 AS site",
      "FROM node:22 AS booking-api",
    ].join("\n"));
    const h = await detectStructureHarvest(tmp);
    expect(h.rootDockerfile?.runtimeStages).toEqual(["site", "booking-api"]);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("проект без apps/ и без Dockerfile — пустой харвест, не бросает", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sh-"));
    const h = await detectStructureHarvest(tmp);
    expect(h.appsDir).toBeNull();
    expect(h.candidates).toEqual([]);
    expect(h.rootDockerfile).toBeNull();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("applyStructureHarvest: порт из EXPOSE сервису без порта; без Dockerfile — не добавляется", () => {
    const contract = createDefaultContract("proj", "worker", 3000);
    delete (contract.services.worker as any).port;
    const structure = {
      appsDir: "apps" as const,
      candidates: [
        { name: "worker", hasDockerfile: true, exposePort: 9099 },
        { name: "extension", hasDockerfile: false },
      ],
      rootDockerfile: null,
    };
    applyStructureHarvest(contract, structure);
    expect((contract.services.worker as any).port).toBe(9099);
    expect((contract.services as any).extension).toBeUndefined();
  });

  it("setupProjectContract: EXPOSE из apps/<svc>/Dockerfile заполняет порт compose-сервису без портов", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sh-"));
    await fs.writeFile(
      path.join(tmp, "docker-compose.yml"),
      "services:\n  worker:\n    build:\n      context: .\n      dockerfile: apps/worker/Dockerfile\n",
    );
    await fs.mkdir(path.join(tmp, "apps", "worker"), { recursive: true });
    await fs.writeFile(path.join(tmp, "apps", "worker", "Dockerfile"), "FROM node:24\nEXPOSE 9099\n");
    const { setupProjectContract } = await import("../src/contract.js");
    await setupProjectContract(tmp);
    const c = JSON.parse(await fs.readFile(path.join(tmp, "pegas.json"), "utf-8"));
    expect(c.services.worker.port).toBe(9099);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
