import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  findProjectRoot,
  findGatewayDir,
  getConfDir,
  getRouteFilePath,
  getProjectRouteFilePath,
  listRoutes,
} from "./gateway.js";

describe("gateway utilities", () => {
  it("getConfDir returns conf.d subfolder", () => {
    expect(getConfDir("/etc/gateway")).toBe("/etc/gateway/conf.d");
  });

  it("getRouteFilePath normalizes unicode and cleans domain name", () => {
    expect(getRouteFilePath("/gateway", "my-app.com")).toBe("/gateway/conf.d/my-app.com.caddy");
    expect(getRouteFilePath("/gateway", "президент.рф")).toBe("/gateway/conf.d/xn--d1abbgf6aiiy.xn--p1ai.caddy");
  });

  it("getProjectRouteFilePath normalizes project name", () => {
    expect(getProjectRouteFilePath("/gateway", "my_app")).toBe("/gateway/conf.d/my_app.caddy");
    expect(getProjectRouteFilePath("/gateway", "@scope/repo")).toBe("/gateway/conf.d/_scope_repo.caddy");
  });

  it("findGatewayDir respects explicitDir and PEGAS_DIR env variable", async () => {
    const explicit = await findGatewayDir("/custom/path");
    expect(explicit).toBe(path.resolve("/custom/path"));

    const origEnv = process.env.PEGAS_DIR;
    try {
      process.env.PEGAS_DIR = "/env/gateway";
      const envDir = await findGatewayDir();
      expect(envDir).toBe(path.resolve("/env/gateway"));
    } finally {
      if (origEnv !== undefined) {
        process.env.PEGAS_DIR = origEnv;
      } else {
        delete process.env.PEGAS_DIR;
      }
    }
  });

  it("listRoutes parses active .caddy files in gateway conf.d", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-list-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    // Standard route
    await fs.writeFile(
      path.join(confDir, "app.com.caddy"),
      "app.com {\n    reverse_proxy app-web:3000\n}\nwww.app.com {\n    redir https://app.com{uri}\n}\n"
    );

    // SPA + API route
    await fs.writeFile(
      path.join(confDir, "portal.org.caddy"),
      "portal.org {\n    handle /api/* {\n        reverse_proxy backend:8000\n    }\n    handle {\n        reverse_proxy frontend:80\n    }\n}\n"
    );

    const routes = await listRoutes(tmpGateway);
    expect(routes.length).toBe(2);

    const appRoute = routes.find((r) => r.domain === "app.com");
    expect(appRoute).toBeDefined();
    expect(appRoute?.upstream).toBe("app-web:3000");
    expect(appRoute?.hasWwwRedirect).toBe(true);
    expect(appRoute?.isSpa).toBe(false);

    const spaRoute = routes.find((r) => r.domain === "portal.org");
    expect(spaRoute).toBeDefined();
    expect(spaRoute?.isSpa).toBe(true);
    expect(spaRoute?.apiUpstream).toBe("backend:8000");
    expect(spaRoute?.upstream).toBe("frontend:80");

    await fs.rm(tmpGateway, { recursive: true, force: true });
  });

  it("listRoutes returns empty array if conf.d does not exist", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-empty-"));
    const routes = await listRoutes(emptyDir);
    expect(routes).toEqual([]);
    await fs.rm(emptyDir, { recursive: true, force: true });
  });
});
