import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createOrUpdateRouteFile, handleAdd } from "./add.js";

describe("pegas add", () => {
  it("createOrUpdateRouteFile generates and writes route snippet to conf.d", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-add-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const res = await createOrUpdateRouteFile({
      domain: "mysite.com",
      upstream: "web:3000",
      gatewayDir: tmpGateway,
    });

    expect(res.alreadyExists).toBe(false);
    expect(res.routeFilePath).toBe(path.join(confDir, "mysite.com.caddy"));
    expect(res.snippet).toContain("mysite.com {");
    expect(res.snippet).toContain("reverse_proxy web:3000");

    const content = await fs.readFile(res.routeFilePath, "utf-8");
    expect(content).toBe(res.snippet);

    // Second call: alreadyExists should be true
    const res2 = await createOrUpdateRouteFile({
      domain: "mysite.com",
      upstream: "web:4000",
      gatewayDir: tmpGateway,
    });
    expect(res2.alreadyExists).toBe(true);
    expect(res2.originalContent).toBe(res.snippet);

    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("createOrUpdateRouteFile supports SPA and API options", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-add-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const res = await createOrUpdateRouteFile({
      domain: "dashboard.app.com",
      upstream: "client:80",
      gatewayDir: tmpGateway,
      spa: true,
      apiUpstream: "server:8000",
      apiPrefix: "/v1/*",
    });

    expect(res.snippet).toContain("handle /v1/* {");
    expect(res.snippet).toContain("reverse_proxy server:8000");
    expect(res.snippet).toContain("handle {");
    expect(res.snippet).toContain("reverse_proxy client:80");

    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("handleAdd dry-run prints preview and does not create file", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-add-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleAdd({
        domain: "dry-run.com",
        upstream: "api:3000",
        gatewayDir: tmpGateway,
        dryRun: true,
        json: true,
      });
    } finally {
      console.log = origLog;
    }

    const json = JSON.parse(logs[0]);
    expect(json.domain).toBe("dry-run.com");
    expect(json.snippet).toContain("reverse_proxy api:3000");

    // File must NOT exist on disk
    const exists = await fs.access(path.join(confDir, "dry-run.com.caddy")).then(() => true).catch(() => false);
    expect(exists).toBe(false);

    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("handleAdd validates missing domain and missing upstream", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleAdd({ domain: "", upstream: "app:3000", noExit: true, json: true });
      await handleAdd({ domain: "app.com", upstream: "", noExit: true, json: true });
    } finally {
      console.log = origLog;
    }

    expect(logs.length).toBe(2);
    expect(JSON.parse(logs[0]).error).toContain("Missing domain argument");
    expect(JSON.parse(logs[1]).error).toContain("Missing --upstream argument");
  });

  it("handleAdd detects existing route collision and requires --force", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-add-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");

    await fs.writeFile(path.join(confDir, "collision.com.caddy"), "collision.com { ... }");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleAdd({
        domain: "collision.com",
        upstream: "new:3000",
        gatewayDir: tmpGateway,
        force: false,
        noExit: true,
        json: true,
      });
    } finally {
      console.log = origLog;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(logs.length).toBe(1);
    expect(JSON.parse(logs[0]).error).toContain("already exists");
  });
});
