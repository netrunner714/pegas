import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  patchExistingCompose,
  setupProjectCompose,
  DEFAULT_COMPOSE_CONTENT,
} from "./compose.js";

describe("compose surgery", () => {
  it("removes public web ports, adds expose, and connects web service to pegas-network with project-scoped alias", () => {
    const input = `version: "3.8"
services:
  web:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
`;
    const result = patchExistingCompose(input, "my-blog");

    expect(result).not.toContain('ports:\n      - "3000:3000"');
    expect(result).toContain('expose:\n      - "3000"');
    expect(result).toContain("pegas-network:\n        aliases:\n          - my-blog-web");
    expect(result).toContain("networks:\n  pegas-network:\n    external: true");
  });

  it("preserves infrastructure ports (postgres 5432 and redis 6379)", () => {
    const input = `services:
  web:
    build: .
    ports:
      - "3000:3000"
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
  redis:
    image: redis:7
    ports:
      - "6379:6379"
`;
    const result = patchExistingCompose(input, "store");

    // Web transformed
    expect(result).toContain('expose:\n      - "3000"');
    expect(result).not.toContain('ports:\n      - "3000:3000"');
    expect(result).toContain("store-web");

    // Postgres and Redis preserved
    expect(result).toContain('postgres:\n    image: postgres:16-alpine\n    ports:\n      - "5432:5432"');
    expect(result).toContain('redis:\n    image: redis:7\n    ports:\n      - "6379:6379"');
  });

  it("preserves existing networks in web service and appends pegas-network with scoped alias", () => {
    const input = `services:
  api:
    image: my-api:latest
    ports:
      - "8080:8080"
    networks:
      - backend

networks:
  backend:
`;
    const result = patchExistingCompose(input, "backend-service");

    expect(result).toContain('expose:\n      - "8080"');
    expect(result).not.toContain("8080:8080");
    expect(result).toContain("pegas-network:\n        aliases:\n          - backend-service-api");
    expect(result).toContain("networks:\n  pegas-network:\n    external: true\n  backend:");
  });

  it("does not attach background worker/cron without ports to pegas-network", () => {
    const input = `services:
  web:
    build: .
    ports:
      - "3000:3000"
  worker:
    build: .
    command: ["bun", "run", "worker.ts"]
    environment:
      - QUEUE=default
  telegram-bot:
    image: mybot:latest
`;
    const result = patchExistingCompose(input, "shop");

    // web is transformed and attached
    expect(result).toContain('expose:\n      - "3000"');
    expect(result).toContain("shop-web");

    // worker and telegram-bot have no ports -> not attached to pegas-network
    expect(result).not.toContain("shop-worker");
    expect(result).not.toContain("shop-telegram-bot");
    expect(result).toContain('command: ["bun", "run", "worker.ts"]');
  });

  it("handles Windows CRLF (\\r\\n) line endings seamlessly", () => {
    const input = "services:\r\n  web:\r\n    build: .\r\n    ports:\r\n      - \"3000:3000\"\r\n";
    const result = patchExistingCompose(input, "win-app");

    expect(result).toContain('expose:\n      - "3000"');
    expect(result).toContain("win-app-web");
    expect(result).not.toContain("\r");
  });

  it("is idempotent when applied multiple times", () => {
    const input = `services:
  web:
    build: .
    ports:
      - "3000:3000"
`;
    const once = patchExistingCompose(input, "app");
    const twice = patchExistingCompose(once, "app");

    expect(twice).toBe(once);
  });

  it("creates clean .pegas/docker-compose.yml if missing in directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-compose-"));
    const slug = path.basename(tmpDir).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const res = await setupProjectCompose(tmpDir, slug);

    expect(res.created).toBe(true);
    expect(res.file).toBe(path.join(".pegas", "docker-compose.yml"));

    const createdContent = await fs.readFile(path.join(tmpDir, res.file), "utf-8");
    expect(createdContent).toContain('expose:\n      - "3000"');
    expect(createdContent).toContain(`${slug}-web`);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("patches existing compose.yaml into .pegas/docker-compose.yml while leaving original untouched", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-compose-"));
    const originalContent = 'services:\n  app:\n    build: .\n    ports:\n      - "5000:5000"\n';
    await fs.writeFile(
      path.join(tmpDir, "compose.yaml"),
      originalContent,
      "utf-8"
    );

    const res = await setupProjectCompose(tmpDir, "my-service");
    expect(res.created).toBe(true);
    expect(res.updated).toBe(false);
    expect(res.file).toBe(path.join(".pegas", "docker-compose.yml"));

    // Root compose.yaml must remain completely untouched!
    const rootContent = await fs.readFile(path.join(tmpDir, "compose.yaml"), "utf-8");
    expect(rootContent).toBe(originalContent);

    // .pegas/docker-compose.yml contains non-invasive projection
    const pegasContent = await fs.readFile(path.join(tmpDir, res.file), "utf-8");
    expect(pegasContent).toContain('expose:\n      - "5000"');
    expect(pegasContent).not.toContain("5000:5000");
    expect(pegasContent).toContain("my-service-app");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("supports dryRun in setupProjectCompose without modifying files or creating new ones", async () => {
    // 1. Dry run when no compose exists
    const tmpEmpty = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-compose-empty-"));
    const emptyRes = await setupProjectCompose(tmpEmpty, "empty-proj", true);
    expect(emptyRes.created).toBe(true);
    expect(emptyRes.updated).toBe(false);
    expect(emptyRes.file).toBe(path.join(".pegas", "docker-compose.yml"));
    expect(await fs.access(path.join(tmpEmpty, ".pegas", "docker-compose.yml")).then(() => true).catch(() => false)).toBe(false);
    await fs.rm(tmpEmpty, { recursive: true, force: true });

    // 2. Dry run when compose exists
    const tmpExisting = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-compose-patch-"));
    const originalContent = 'services:\n  web:\n    image: node:alpine\n    ports:\n      - "3000:3000"\n';
    await fs.writeFile(path.join(tmpExisting, "docker-compose.yml"), originalContent, "utf-8");

    const patchRes = await setupProjectCompose(tmpExisting, "patch-proj", true);
    expect(patchRes.created).toBe(true);
    expect(patchRes.updated).toBe(false);
    expect(patchRes.file).toBe(path.join(".pegas", "docker-compose.yml"));

    const untouchedContent = await fs.readFile(path.join(tmpExisting, "docker-compose.yml"), "utf-8");
    expect(untouchedContent).toBe(originalContent);
    expect(await fs.access(path.join(tmpExisting, ".pegas", "docker-compose.yml")).then(() => true).catch(() => false)).toBe(false);
    await fs.rm(tmpExisting, { recursive: true, force: true });
  });

  it("omits reverse proxy services (caddy, nginx, traefik) and strips them from depends_on", () => {
    const input = `services:
  web:
    build: .
    ports:
      - "3000:3000"
    depends_on:
      - caddy
      - db
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
  db:
    image: postgres:17
    ports:
      - "5432:5432"
`;
    const result = patchExistingCompose(input, "my-app");
    expect(result).not.toContain("image: caddy:2-alpine");
    expect(result).not.toContain("- caddy");
    expect(result).toContain("- db");
    expect(result).toContain("5432:5432");
    expect(result).toContain('expose:\n      - "3000"');
    expect(result).toContain("my-app-web");
  });

  it("injects Docker logging rotation for web services and preserves custom logging", () => {
    const input = `services:
  web:
    image: node:alpine
    ports:
      - "80:80"
  custom-log:
    image: my-app
    ports:
      - "3000:3000"
    logging:
      driver: "syslog"
`;
    const result = patchExistingCompose(input, "my-app");
    expect(result).toContain('logging:\n      driver: "json-file"\n      options:\n        max-size: "50m"\n        max-file: "3"');
    expect(result).toContain('driver: "syslog"');
  });
});
