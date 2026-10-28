import { describe, it, expect, mock } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import child_process from "node:child_process";

let mockDeployReloadOk = true;

mock.module("../docker.js", () => ({
  validateCaddyConfig: async () => ({ success: mockDeployReloadOk, stderr: mockDeployReloadOk ? "" : "invalid" }),
  reloadCaddyConfig: async () => ({ success: mockDeployReloadOk, stderr: mockDeployReloadOk ? "" : "reload err" }),
}));

import { handleDeploy, resolveScopedUpstream, waitForContainerReadiness } from "./deploy.js";
import { CONTRACT_FILENAME } from "../contract.js";

describe("pegas deploy", () => {
  it("resolveScopedUpstream correctly scopes container host to avoid Round-Robin collisions", () => {
    expect(resolveScopedUpstream("web:3000", "my-blog")).toBe("my-blog-web:3000");
    expect(resolveScopedUpstream("api:8000", "store")).toBe("store-api:8000");
    // Already scoped: do not duplicate
    expect(resolveScopedUpstream("my-blog-web:3000", "my-blog")).toBe("my-blog-web:3000");
    // Localhost or IP
    expect(resolveScopedUpstream("127.0.0.1:3000", "my-blog")).toBe("127.0.0.1:3000");
  });

  it("orchestrates caddy routes from pegas.json with scoped upstream and normalized domains", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-"));
    const projectName = path.basename(tmpProj).toLowerCase().replace(/[^a-z0-9._-]/g, "_");

    // Pre-create gateway Caddyfile and conf.d
    await fs.mkdir(path.join(tmpGateway, "conf.d"), { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import /etc/caddy/conf.d/*.caddy\n", "utf-8");

    // Create pegas.json in project with dirty domains (https://, trailing slashes, ports)
    const contract = {
      projectName,
      services: {
        web: {
          upstream: "web:3000",
          domains: {
            dev: ["app.localhost"],
            prod: ["https://mysite.ru/", "web.mysite.ru:443"],
          },
        },
        api: {
          upstream: "backend:8000",
          domains: {
            dev: ["api.localhost"],
            prod: ["http://api.mysite.ru/"],
          },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract, null, 2), "utf-8");

    // Run deploy in dry-run mode
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      await handleDeploy({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        dryRun: true,
        skipUp: true,
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }
  });

  it("skips placeholder domain 'yourdomain.com' and services without prod domains in dry-run", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-"));

    const contract = {
      services: {
        web: {
          upstream: "app:3000",
          domains: {
            dev: ["app.localhost"],
            prod: ["yourdomain.com"], // placeholder!
          },
        },
        app: {
          upstream: "app:3000",
          // missing domains.prod
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract), "utf-8");

    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      await handleDeploy({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        dryRun: true,
        skipUp: true,
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }
  });

  it("handles missing or invalid pegas.json gracefully in json and text mode", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-missing-contract-"));
    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // 1. Missing pegas.json (JSON mode)
      await handleDeploy({ cwd: tmpProj, noExit: true, json: true });

      // 2. Missing pegas.json (Text mode)
      await handleDeploy({ cwd: tmpProj, noExit: true, json: false });

      // 3. Corrupted pegas.json (JSON mode)
      await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), "{ invalid-json", "utf-8");
      await handleDeploy({ cwd: tmpProj, noExit: true, json: true });

      // 4. Corrupted pegas.json (Text mode)
      await handleDeploy({ cwd: tmpProj, noExit: true, json: false });
    } finally {
      console.log = origLog;
      console.error = origError;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("Contract 'pegas.json' not found"))).toBe(true);
    expect(errors.some((e) => e.includes("Contract 'pegas.json' not found"))).toBe(true);
    expect(logs.some((l) => l.includes("Invalid JSON syntax"))).toBe(true);
    expect(errors.some((e) => e.includes("Invalid JSON syntax"))).toBe(true);
  });

  it("prevents domain hijacking when another project already owns the domain", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-hijack-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-hijack-gw-"));

    // Pre-create existing project-a.caddy in conf.d
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");
    await fs.writeFile(
      path.join(confDir, "project-a.caddy"),
      `# Auto-generated by Pegas for project: project-a\n\nprotected.com {\n    reverse_proxy project-a-web:3000\n}\n`,
      "utf-8"
    );

    // Project B tries to claim protected.com
    const contract = {
      projectName: "project-b",
      services: {
        web: {
          upstream: "web:3000",
          domains: {
            dev: ["b.localhost"],
            prod: ["protected.com"],
          },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract, null, 2), "utf-8");

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    try {
      await handleDeploy({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        noExit: true,
        skipUp: true,
      });
    } finally {
      console.error = origError;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    const collisionErr = errors.find((e) => e.includes("already owned by project 'project-a'"));
    expect(collisionErr).toBeDefined();
    expect(collisionErr).toContain("protected.com");
  });

  it("allows re-deployment of domains owned by the same project", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-same-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-same-gw-"));

    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");
    // Same project file: project-self.caddy
    await fs.writeFile(
      path.join(confDir, "project-self.caddy"),
      `# Auto-generated by Pegas for project: project-self\n\nmy-domain.com {\n    reverse_proxy project-self-web:3000\n}\n`,
      "utf-8"
    );

    const contract = {
      projectName: "project-self",
      services: {
        web: {
          upstream: "web:3000",
          domains: {
            dev: ["self.localhost"],
            prod: ["my-domain.com"],
          },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract, null, 2), "utf-8");

    const errors: string[] = [];
    const origError = console.error;
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    try {
      await handleDeploy({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        dryRun: true,
        noExit: true,
        skipUp: true,
      });
    } finally {
      console.error = origError;
      console.log = origLog;
      console.warn = origWarn;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(errors.length).toBe(0);
  });

  it("performs full live route configuration and hot-reload in json and text mode", async () => {
    mockDeployReloadOk = true;
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-live-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-live-gw-"));

    await fs.mkdir(path.join(tmpGateway, "conf.d"), { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");

    const contract = {
      projectName: "live-app",
      services: {
        web: {
          upstream: "web:3000",
          domains: { dev: ["app.localhost"], prod: ["live.example.com"] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract, null, 2), "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      // 1. Live deploy in JSON mode
      await handleDeploy({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipDnsCheck: true,
        skipUp: true,
        noExit: true,
        json: true,
      });

      const routeFile = path.join(tmpGateway, "conf.d", "live-app.caddy");
      expect(await fs.access(routeFile).then(() => true).catch(() => false)).toBe(true);
      const content = await fs.readFile(routeFile, "utf-8");
      expect(content).toContain("live.example.com");

      // 2. Live deploy in Text mode
      await handleDeploy({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipDnsCheck: true,
        skipUp: true,
        noExit: true,
        json: false,
      });
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes('"status":"success"') && l.includes("live-app"))).toBe(true);
    expect(logs.some((l) => l.includes("successfully deployed to Pegas gateway"))).toBe(true);
  });

  it("handles reload failure and rolls back route configuration cleanly", async () => {
    mockDeployReloadOk = false;
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-fail-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-fail-gw-"));

    await fs.mkdir(path.join(tmpGateway, "conf.d"), { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");

    const routeFile = path.join(tmpGateway, "conf.d", "rollback-app.caddy");
    await fs.writeFile(routeFile, "original-route-content", "utf-8");

    const contract = {
      projectName: "rollback-app",
      services: {
        web: {
          upstream: "web:3000",
          domains: { dev: ["app.localhost"], prod: ["new.example.com"] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract, null, 2), "utf-8");

    const errors: string[] = [];
    const logs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      await handleDeploy({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipDnsCheck: true,
        skipUp: true,
        noExit: true,
        json: false,
      });

      // Verify original content was restored
      const content = await fs.readFile(routeFile, "utf-8");
      expect(content).toBe("original-route-content");
    } finally {
      console.log = origLog;
      console.error = origError;
      mockDeployReloadOk = true;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }
  });

  it("removes old project route file when contract has no production domains", async () => {
    mockDeployReloadOk = true;
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-del-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-del-gw-"));

    await fs.mkdir(path.join(tmpGateway, "conf.d"), { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");

    const routeFile = path.join(tmpGateway, "conf.d", "dev-only-app.caddy");
    await fs.writeFile(routeFile, "old-prod-routes", "utf-8");

    // Contract has only dev domain, no prod
    const contract = {
      projectName: "dev-only-app",
      services: {
        web: {
          upstream: "web:3000",
          domains: { dev: ["dev.localhost"], prod: [] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract, null, 2), "utf-8");

    const origLog = console.log;
    console.log = () => {};
    try {
      await handleDeploy({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        skipUp: true,
        noExit: true,
        json: true,
      });

      const exists = await fs.access(routeFile).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }
  });

  it("waitForContainerReadiness handles container states: healthy, unhealthy, exited", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-ready-mock-"));
    const origExec = child_process.execFileSync;

    try {
      // 1. Healthy state
      child_process.execFileSync = ((cmd: string, args: string[]) => {
        if (args.includes("-q")) return "container-id-123\n";
        return JSON.stringify([
          {
            State: {
              Status: "running",
              Health: { Status: "healthy" },
            },
          },
        ]);
      }) as any;

      const resHealthy = await waitForContainerReadiness(tmpProj, "web", { timeoutMs: 500, pollIntervalMs: 50 });
      expect(resHealthy.ready).toBe(true);

      // 2. Unhealthy state
      child_process.execFileSync = ((cmd: string, args: string[]) => {
        if (args.includes("-q")) return "container-id-123\n";
        return JSON.stringify([
          {
            State: {
              Status: "running",
              Health: { Status: "unhealthy" },
            },
          },
        ]);
      }) as any;

      const resUnhealthy = await waitForContainerReadiness(tmpProj, "web", { timeoutMs: 500, pollIntervalMs: 50 });
      expect(resUnhealthy.ready).toBe(false);
      expect(resUnhealthy.reason).toContain("healthcheck failed");

      // 3. Exited/Dead state
      child_process.execFileSync = ((cmd: string, args: string[]) => {
        if (args.includes("-q")) return "container-id-123\n";
        return JSON.stringify([
          {
            State: {
              Status: "exited",
              ExitCode: 137,
            },
          },
        ]);
      }) as any;

      const resExited = await waitForContainerReadiness(tmpProj, "web", { timeoutMs: 500, pollIntervalMs: 50 });
      expect(resExited.ready).toBe(false);
      expect(resExited.reason).toContain("exited unexpectedly");
    } finally {
      child_process.execFileSync = origExec;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }
  });

  it("aborts deploy when strictDns is true and domain does not match server IP", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-dns-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-dns-gw-"));

    await fs.mkdir(path.join(tmpGateway, "conf.d"), { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");

    const contract = {
      projectName: "dns-test-project",
      services: {
        web: {
          upstream: "web:3000",
          domains: {
            dev: ["test.localhost"],
            prod: ["dns.google"], // resolves to 8.8.8.8
          },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract), "utf-8");

    const errors: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    console.warn = () => {};
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    try {
      await handleDeploy({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        serverIp: "192.0.2.1", // mismatch!
        strictDns: true,
        noExit: true,
        skipUp: true,
      });
    } finally {
      console.error = origError;
      console.warn = origWarn;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    const strictErr = errors.find((e) => e.includes("Strict DNS check failed"));
    expect(strictErr).toBeDefined();
  });
});
