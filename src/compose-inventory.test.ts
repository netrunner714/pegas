import { describe, it, expect } from "bun:test";
import {
  parseComposeServices,
  detectComposeInventory,
  createContractFromInventory,
} from "../src/compose-inventory.js";
import { createContractFromInventory as fromContract } from "../src/contract.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("compose inventory parser", () => {
  it("парсит полный compose: build с target, image, ports, env, healthcheck, dependsOn map-формой", () => {
    const content = [
      "services:",
      "  site:",
      "    build:",
      "      context: .",
      "      dockerfile: Dockerfile",
      "      target: site",
      "    restart: always",
      "    environment:",
      "      NODE_ENV: production",
      "      PORT: \"3000\"",
      "    depends_on:",
      "      api:",
      "        condition: service_healthy",
      "    healthcheck:",
      "      test: [\"CMD\", \"curl\", \"-f\", \"http://localhost:3000\"]",
      "  api:",
      "    build: .",
      "    ports:",
      "      - \"4000:4000\"",
      "    env_file: .env",
      "  redis:",
      "    image: redis:7-alpine",
      "    volumes:",
      "      - redisdata:/data",
      "    profiles: [\"cache\"]",
      "  caddy:",
      "    image: caddy:2-alpine",
      "    ports:",
      "      - \"80:80\"",
      "      - \"443:443\"",
    ].join("\n");

    const services = parseComposeServices(content)!;
    expect(services.length).toBe(4);

    const site = services.find((s) => s.name === "site")!;
    expect(site.build).toEqual({ context: ".", dockerfile: "Dockerfile", target: "site" });
    expect(site.env.NODE_ENV).toBe("production");
    expect(site.env.PORT).toBe("3000");
    expect(site.dependsOn).toEqual(["api"]);
    expect(site.hasHealthcheck).toBe(true);

    const api = services.find((s) => s.name === "api")!;
    expect(api.build).toEqual({ context: "." });
    expect(api.ports).toEqual([4000]);
    expect(api.hostPorts).toEqual([4000]);
    expect(api.envFile).toBe(".env");

    const redis = services.find((s) => s.name === "redis")!;
    expect(redis.profiles).toEqual(["cache"]);
    expect(redis.kind).toBe("profile");

    const caddy = services.find((s) => s.name === "caddy")!;
    expect(caddy.kind).toBe("proxy");
    expect(caddy.hostPorts).toEqual([80, 443]);
  });

  it("помечает значения с подстановками ${VAR} как неразрешённые — не попадают в контракт", () => {
    const content = [
      "services:",
      "  app:",
      "    image: myapp:${TAG}",
      "    env_file: ${ENV_FILE:-.env}",
      "    environment:",
      "      - SECRET=${DB_PASSWORD}",
      "      - LITERAL=ok",
    ].join("\n");
    const [app] = parseComposeServices(content)!;
    expect(app.image).toBeUndefined();
    expect(app.envFile).toBeUndefined();
    expect(app.env.LITERAL).toBe("ok");
    expect(app.env.SECRET).toBeUndefined();
  });

  it("возвращает null без секции services:", () => {
    expect(parseComposeServices("volumes:\n  data:\n")).toBeNull();
  });

  it("detectComposeInventory читает первый существующий compose-файл", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "inv-"));
    await fs.writeFile(path.join(tmp, "compose.yaml"), "services:\n  web:\n    image: a:1\n");
    const inv = await detectComposeInventory(tmp);
    expect(inv?.file).toBe("compose.yaml");
    expect(inv?.services[0].name).toBe("web");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("createContractFromInventory: все app-сервисы с доменами, infra с image/volumes, proxy и profiles пропускаются", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "inv-"));
    await fs.writeFile(path.join(tmp, "docker-compose.yml"), [
      "services:",
      "  site:",
      "    build:",
      "      context: .",
      "      dockerfile: Dockerfile",
      "      target: site",
      "  booking-api:",
      "    build:",
      "      context: .",
      "      dockerfile: Dockerfile",
      "      target: booking-api",
      "  db:",
      "    image: postgres:18",
      "    volumes:",
      "      - pgdata:/var/lib/postgresql",
      "      - ./certs:/certs",
      "  caddy:",
      "    image: caddy:2-alpine",
      "  metrics:",
      "    image: prom/prometheus",
      "    profiles: [\"observability\"]",
    ].join("\n"));

    const inv = (await detectComposeInventory(tmp))!;
    const contract = fromContract("my-shop", inv);

    expect(Object.keys(contract.services).sort()).toEqual(["booking-api", "db", "site"]);

    expect(contract.services.site.build).toEqual({
      context: ".",
      dockerfile: "Dockerfile",
      target: "site",
    });
    expect(contract.services.site.domains.development).toEqual([
      "site.my-shop.localhost",
      "my-shop.localhost",
    ]);
    expect(contract.services["booking-api"].domains.development).toEqual([
      "booking-api.my-shop.localhost",
    ]);
    expect(contract.services.db.role).toBe("infra");
    expect(contract.services.db.image).toBe("postgres:18");
    expect(contract.services.db.volumes).toEqual(["pgdata:/var/lib/postgresql"]);

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("setupProjectContract собирает multi-service контракт из реального compose", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "inv-"));
    await fs.writeFile(
      path.join(tmp, "docker-compose.yml"),
      "services:\n  site:\n    build:\n      context: .\n      target: site\n  api:\n    build:\n      context: .\n      target: api\n",
    );
    const { setupProjectContract, CONTRACT_FILENAME } = await import("../src/contract.js");
    const res = await setupProjectContract(tmp);
    expect(res.created).toBe(true);
    const content = JSON.parse(await fs.readFile(path.join(tmp, CONTRACT_FILENAME), "utf-8"));
    expect(Object.keys(content.services).sort()).toEqual(["api", "site"]);
    expect(content.services.site.build.target).toBe("site");
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
