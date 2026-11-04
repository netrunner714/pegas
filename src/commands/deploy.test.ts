import { describe, it, expect, mock } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import child_process from "node:child_process";
import * as actualDocker from "../docker.js";

let mockDeployReloadOk = true;

mock.module("../docker.js", () => ({
  ...actualDocker,
  validateCaddyConfig: async () => ({ success: mockDeployReloadOk, stderr: mockDeployReloadOk ? "" : "invalid" }),
  reloadCaddyConfig: async () => ({ success: mockDeployReloadOk, stderr: mockDeployReloadOk ? "" : "reload err" }),
}));

import { handleDeploy, resolveScopedUpstream, waitForContainerReadiness } from "./deploy.js";

/** Дописывает v3-обязательные поля контракта (scenarios/gateway/runtime-карты). */
function v3ify(contract: any): any {
  const scenarios = ["development", "production"];
  const out = {
    ...contract,
    projectName: contract.projectName ?? "fixture-project",
    scenarios,
    gateway: { development: { httpPort: 80, httpsPort: 443 }, production: { httpPort: 80, httpsPort: 443, acmeEmail: "a@b.co" } },
  };
  for (const [name, svc] of Object.entries<any>(contract.services || {})) {
    const driverOf = (sc: string) => svc.runtime?.[sc]?.driver ?? "docker";
    out.services[name] = {
      ...svc,
      runtime: { development: { driver: driverOf("development") }, production: { driver: driverOf("production") } },
      port: svc.port ?? { development: 3000, production: 3000 },
      // docker-сервисам нужен image: добавляем фиктивный, если своего нет
      ...(svc.image || svc.build ? {} : { image: { development: "node:24", production: "node:24" } }),
    };
  }
  return out;
}
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

  it("rejects dirty domains (scheme/port/path) as invalid v3 contract — no normalization", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-"));

    const contract = {
      projectName: "dirty-domains",
      services: {
        web: {
          port: { development: 3000, production: 3000 },
          domains: {
            development: ["app.localhost"],
            production: ["https://mysite.ru/", "web.mysite.ru:443"],
          },
        },
        api: {
          port: { development: 8000, production: 8000 },
          domains: {
            development: ["api.localhost"],
            production: ["http://api.mysite.ru/"],
          },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(v3ify(contract), null, 2), "utf-8");

    let errorOutput: any = null;
    const origLog = console.log;
    console.log = (msg: any) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.error && !errorOutput) errorOutput = parsed;
      } catch {}
    };

    try {
      await handleDeploy({
        cwd: tmpProj,
        scenario: "production",
        gatewayDir: tmpGateway,
        skipUp: true,
        json: true,
        noExit: true,
      });
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(errorOutput).not.toBeNull();
    expect(errorOutput.error).toContain("Invalid Pegas contract");
    const issueText = JSON.stringify(errorOutput.details || []);
    expect(issueText).toContain("https://mysite.ru/");
    expect(issueText).toContain("web.mysite.ru:443");
  });

  it("skips placeholder domain 'yourdomain.com' and services without prod domains", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-"));

    const contract = {
      services: {
        web: {
          domains: {
            development: ["app.localhost"],
            production: ["yourdomain.com", "mysite.ru"], // placeholder + valid
          },
        },
        app: {
          // missing domains.prod
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(v3ify(contract)), "utf-8");

    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      await handleDeploy({
        cwd: tmpProj,
        scenario: "production",
        gatewayDir: tmpGateway,
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
      await handleDeploy({ cwd: tmpProj, scenario: "production", noExit: true, json: true });

      // 2. Missing pegas.json (Text mode)
      await handleDeploy({ cwd: tmpProj, scenario: "production", noExit: true, json: false });

      // 3. Corrupted pegas.json (JSON mode)
      await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), "{ invalid-json", "utf-8");
      await handleDeploy({ cwd: tmpProj, scenario: "production", noExit: true, json: true });

      // 4. Corrupted pegas.json (Text mode)
      await handleDeploy({ cwd: tmpProj, scenario: "production", noExit: true, json: false });
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
          domains: { development: ["b.localhost"], production: ["protected.com"] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(v3ify(contract), null, 2), "utf-8");

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    try {
      await handleDeploy({
        cwd: tmpProj,
        scenario: "production",
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
          domains: { development: ["self.localhost"], production: ["my-domain.com"] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(v3ify(contract), null, 2), "utf-8");

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
        scenario: "production",
        gatewayDir: tmpGateway,
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
          domains: { development: ["app.localhost"], production: ["live.example.com"] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(v3ify(contract), null, 2), "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      // 1. Live deploy in JSON mode
      await handleDeploy({
        cwd: tmpProj,
        scenario: "production",
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
        scenario: "production",
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
          domains: { development: ["app.localhost"], production: ["new.example.com"] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(v3ify(contract), null, 2), "utf-8");

    const errors: string[] = [];
    const logs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      await handleDeploy({
        cwd: tmpProj,
        scenario: "production",
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

  it("rejects deployment when requested environment has no domains configured", async () => {
    mockDeployReloadOk = true;
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-del-proj-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-del-gw-"));

    // Contract has only dev domain, no prod
    const contract = {
      projectName: "dev-only-app",
      services: {
        web: {
          domains: { development: ["dev.localhost"], production: [] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(v3ify(contract), null, 2), "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await handleDeploy({
        cwd: tmpProj,
        gatewayDir: tmpGateway,
        scenario: "stage",
        skipUp: true,
        noExit: true,
        json: true,
      });

      const errLog = logs.find((l) => l.includes("has no domains defined"));
      expect(errLog).toBeDefined();
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
          domains: {
            development: ["test.localhost"],
            production: ["dns.google"], // resolves to 8.8.8.8
          },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(v3ify(contract)), "utf-8");

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
        scenario: "production",
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

  it("fails when no scenario is provided", async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));

    try {
      await handleDeploy({ noExit: true });
    } finally {
      console.error = origError;
    }

    expect(errors.some((e) => e.includes("Scenario is required for deploy"))).toBe(true);
  });

  it("route config uses port-map upstreams and skips host-driver services in the scenario", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-proj-routes-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-routes-"));

    await fs.mkdir(path.join(tmpGateway, "conf.d"), { recursive: true });
    await fs.writeFile(path.join(tmpGateway, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");

    const contract = {
      projectName: "route-test",
      services: {
        frontend: {
          port: { development: 3000, production: 3000 },
          domains: { development: ["app.localhost"], production: ["site.ru"] },
        },
        backend: {
          port: { development: 8000, production: 8000 },
          domains: { development: ["api.localhost"], production: ["api.site.ru"] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(v3ify(contract), null, 2), "utf-8");

    let successOutput: any = null;
    const origLog = console.log;
    console.log = (msg: any) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.status === "success") successOutput = parsed;
      } catch {}
    };

    try {
      await handleDeploy({
        cwd: tmpProj,
        scenario: "production",
        gatewayDir: tmpGateway,
        skipUp: true,
        json: true,
        noExit: true,
      });
      expect(successOutput).not.toBeNull();
      const upstreams = JSON.stringify(successOutput.routes || []);
      expect(upstreams).toContain("-production-frontend:3000");
      expect(upstreams).toContain("-production-backend:8000");
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }
  });

  it("aborts deploy when required secrets are missing", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-sec-deploy-"));
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-sec-"));

    const contract = {
      projectName: "sec-test",
      services: {
        web: {
          port: { development: 3000, production: 3000 },
          domains: { development: ["app.localhost"], production: ["sec.ru"] },
          secrets: ["REQUIRED_KEY"],
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(v3ify(contract)), "utf-8");

    let errorOutput: any = null;
    const origLog = console.log;
    console.log = (msg: any) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.error) errorOutput = parsed;
      } catch {}
    };

    try {
      await handleDeploy({
        cwd: tmpProj,
        scenario: "production",
        gatewayDir: tmpGateway,
        skipUp: true,
        noExit: true,
        json: true,
      });
      expect(errorOutput).not.toBeNull();
      expect(errorOutput.error).toBe("Secrets verification failed");
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }
  });
});
