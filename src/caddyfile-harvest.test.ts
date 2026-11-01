import { describe, it, expect } from "bun:test";
import { parseCaddyfile, detectCaddyHarvest } from "../src/caddyfile-harvest.js";
import { applyCaddyHarvest, createDefaultContract } from "../src/contract.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("caddyfile harvest", () => {
  it("простой блок: домен → сервис из reverse_proxy", () => {
    const h = parseCaddyfile("example.com {\n  reverse_proxy site:3000\n}\n")!;
    expect(h.serviceToDomains.get("site")).toEqual(["example.com"]);
  });

  it("www-redirect блоки не копируются как домены сервиса", () => {
    const h = parseCaddyfile([
      "www.example.com {",
      "  redir https://example.com{uri} permanent",
      "}",
      "example.com {",
      "  reverse_proxy site:3000",
      "}",
    ].join("\n"))!;
    expect(h.serviceToDomains.get("site")).toEqual(["example.com"]);
    expect(h.serviceToDomains.has("www.example.com")).toBe(false);
  });

  it("multi-доменный блок: все домены привязываются к catch-all сервису", () => {
    const h = parseCaddyfile([
      "booking.815records.ru, app-tg.815records.ru, app-vk.815records.ru {",
      "  handle /api/* {",
      "    reverse_proxy booking-api:3002",
      "  }",
      "  handle {",
      "    reverse_proxy booking-client:80",
      "  }",
      "}",
    ].join("\n"))!;
    expect(h.serviceToDomains.get("booking-client")).toEqual([
      "booking.815records.ru",
      "app-tg.815records.ru",
      "app-vk.815records.ru",
    ]);
    expect(h.splitRoutingBlocks.length).toBe(1);
  });

  it("redirect-блок со сменой домена и respond-only блок пропускаются", () => {
    const h = parseCaddyfile([
      "it-murmansk.ru, www.it-murmansk.ru {",
      "  redir https://pc51.ru{uri} 301",
      "}",
      "pc51.ru {",
      "  reverse_proxy app:3000",
      "}",
      "pg.example.com {",
      '  respond "pg-endpoint" 200',
      "}",
    ].join("\n"))!;
    expect(h.serviceToDomains.get("app")).toEqual(["pc51.ru"]);
    expect(h.serviceToDomains.size).toBe(1);
  });

  it("возвращает null без полезных блоков / пустому файлу", () => {
    expect(parseCaddyfile("")).toBeNull();
    expect(parseCaddyfile("www.a.com {\n redir https://a.com\n}")).toBeNull();
  });

  it("detectCaddyHarvest находит файл по типовым именам", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "caddy-"));
    await fs.writeFile(path.join(tmp, "Caddyfile"), "a.com {\n reverse_proxy web:3000\n}\n");
    const h = await detectCaddyHarvest(tmp);
    expect(h?.serviceToDomains.get("web")).toEqual(["a.com"]);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("applyCaddyHarvest заменяет example.com-заглушки на реальные домены", () => {
    const contract = createDefaultContract("my-app", "site", 3000);
    const harvest = parseCaddyfile("my-app.ru {\n reverse_proxy site:3000\n}\n")!;
    applyCaddyHarvest(contract, harvest);
    expect(contract.services.site.domains.production).toEqual(["my-app.ru"]);
  });

  it("applyCaddyHarvest заполняет порт сервиса из upstream svc:port", () => {
    const contract = createDefaultContract("my-app", "site", 3000);
    delete (contract.services.site as any).port;
    const harvest = parseCaddyfile("my-app.ru {\n reverse_proxy site:3000\n}\n")!;
    applyCaddyHarvest(contract, harvest);
    expect((contract.services.site as any).port).toBe(3000);
  });

  it("applyCaddyHarvest пропускает сервис, которого нет в контракте", () => {
    const contract = createDefaultContract("my-app", "site", 3000);
    const harvest = parseCaddyfile("other.com {\n reverse_proxy ghost:3000\n}\n")!;
    applyCaddyHarvest(contract, harvest);
    expect(contract.services.site.domains.production).toEqual(["site.example.com"]);
  });

  it("setupProjectContract применяет харвест: прод-домен из Caddyfile", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "caddy-"));
    await fs.writeFile(
      path.join(tmp, "docker-compose.yml"),
      "services:\n  site:\n    build:\n      context: .\n",
    );
    await fs.writeFile(path.join(tmp, "Caddyfile"), "my-site.ru {\n  reverse_proxy site:3000\n}\n");
    const { setupProjectContract, CONTRACT_FILENAME } = await import("../src/contract.js");
    await setupProjectContract(tmp);
    const content = JSON.parse(await fs.readFile(path.join(tmp, CONTRACT_FILENAME), "utf-8"));
    expect(content.services.site.domains.production).toEqual(["my-site.ru"]);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
