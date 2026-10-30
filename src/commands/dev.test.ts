import { describe, it, expect, spyOn } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import net from "node:net";
import * as child_process from "node:child_process";
import { generateDevCaddyfile, handleDev } from "./dev.js";
import { findOrDownloadCaddy } from "../binary.js";
import { findAvailablePort, isPortAvailable } from "../ports.js";
import { detectInfraServices } from "../compose.js";
import { PegasContract } from "../types.js";
import { CONTRACT_FILENAME } from "../contract.js";

describe("pegas dev", () => {
  it("generates local dev Caddyfile from pegas.json contract with custom ports", () => {
    const contract: PegasContract = {
      services: {
        web: {
          upstream: "app:3000",
          domains: {
            dev: ["app.localhost"],
            prod: ["mysite.ru"],
          },
        },
      },
    };

    const caddyfile = generateDevCaddyfile(contract, { httpsPort: 8444, httpPort: 8081 });
    expect(caddyfile).toContain("admin off");
    expect(caddyfile).toContain("https_port 8444");
    expect(caddyfile).toContain("http_port 8081");
    expect(caddyfile).not.toContain("skip_install_trust");
    expect(caddyfile).toContain("app.localhost {");
    expect(caddyfile).toContain("reverse_proxy localhost:3000");
  });

  it("respects devGateway admin and skipInstallTrust options in generateDevCaddyfile", () => {
    // 1. admin: true, skipInstallTrust: false
    const contractWithOverrides: PegasContract = {
      devGateway: {
        httpPort: 8080,
        httpsPort: 8443,
        skipInstallTrust: false,
        admin: true,
      },
      services: {
        web: {
          port: 3000,
          domains: { development: ["test.localhost"] },
        },
      },
    };

    const caddyfile = generateDevCaddyfile(contractWithOverrides);
    expect(caddyfile).not.toContain("admin off");
    expect(caddyfile).not.toContain("skip_install_trust");

    // 2. admin: false, skipInstallTrust: true
    const contractDefault: PegasContract = {
      devGateway: {
        httpPort: 8080,
        httpsPort: 8443,
        skipInstallTrust: true,
        admin: false,
      },
      services: {
        web: {
          port: 3000,
          domains: { development: ["test.localhost"] },
        },
      },
    };

    const caddyfileDefault = generateDevCaddyfile(contractDefault);
    expect(caddyfileDefault).toContain("admin off");
    expect(caddyfileDefault).toContain("skip_install_trust");
  });

  it("handles multiple services and multiple dev domains with correct local ports", () => {
    const contract: PegasContract = {
      services: {
        frontend: {
          upstream: "client:3000",
          domains: {
            dev: ["app.localhost", "client.localhost"],
            prod: ["app.com"],
          },
        },
        backend: {
          upstream: "api:8080",
          domains: {
            dev: ["api.localhost"],
            prod: ["api.com"],
          },
        },
        worker: {
          upstream: "worker:9000",
          domains: {
            dev: [],
            prod: ["worker.com"],
          },
        },
      },
    };

    const caddyfile = generateDevCaddyfile(contract);
    expect(caddyfile).toContain("app.localhost, client.localhost {");
    expect(caddyfile).toContain("reverse_proxy localhost:3000");
    expect(caddyfile).toContain("api.localhost {");
    expect(caddyfile).toContain("reverse_proxy localhost:8080");
    expect(caddyfile).not.toContain("worker.localhost");
  });

  it("dynamically finds available port and skips occupied port", async () => {
    // Occupy a temporary port
    const server = net.createServer();
    const occupiedPort = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as net.AddressInfo;
        resolve(address.port);
      });
    });

    const isOccupiedFree = await isPortAvailable(occupiedPort);
    expect(isOccupiedFree).toBe(false);

    const nextPort = await findAvailablePort(occupiedPort);
    expect(nextPort).toBeGreaterThan(occupiedPort);

    await new Promise((resolve) => server.close(resolve));
  });

  it("finds cached caddy binary or binary from system PATH", async () => {
    const caddyPath = await findOrDownloadCaddy({ silent: true });
    expect(caddyPath).toBeDefined();
    expect(caddyPath.length).toBeGreaterThan(0);

    const exists = await fs.access(caddyPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("finds Caddy from custom cacheDir or repository .cache/bin", async () => {
    const repoCacheBin = path.join(process.cwd(), ".cache", "bin");
    const binaryName = process.platform === "win32" ? "caddy.exe" : "caddy";
    const cachedFile = path.join(repoCacheBin, binaryName);

    if (await fs.access(cachedFile).then(() => true).catch(() => false)) {
      const found = await findOrDownloadCaddy({ cacheDir: repoCacheBin, silent: true });
      expect(found).toBe(cachedFile);
    }
  });

  it("detects infrastructure services and their host ports from compose YAML", () => {
    const yaml = `
services:
  web:
    build: .
    expose:
      - "3000"
  postgres:
    image: postgres:15-alpine
    ports:
      - "5432:5432"
  cache:
    image: redis:7-alpine
    ports:
      - 6379:6379
  message-broker:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"
  worker:
    build: .
    command: npm run worker
`;
    const infra = detectInfraServices(yaml);
    expect(infra.length).toBe(3);

    const pg = infra.find((s) => s.name === "postgres");
    expect(pg).toBeDefined();
    expect(pg?.hostPort).toBe("5432");

    const redis = infra.find((s) => s.name === "cache");
    expect(redis).toBeDefined();
    expect(redis?.hostPort).toBe("6379");

    const rabbit = infra.find((s) => s.name === "message-broker");
    expect(rabbit).toBeDefined();
    expect(rabbit?.hostPort).toBe("5672");
  });

  it("gracefully runs handleDev when no docker-compose.yml exists", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-dev-test-"));
    const contract: PegasContract = {
      services: {
        web: {
          upstream: "web:3000",
          domains: { dev: ["no-infra.localhost"], prod: ["no-infra.com"] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract, null, 2), "utf-8");

    const staleCaddyfile = path.join(tmpProj, ".pegas", "Caddyfile.dev");
    await fs.mkdir(path.join(tmpProj, ".pegas"), { recursive: true });
    await fs.writeFile(staleCaddyfile, "old", "utf-8");

    // Execute handleDev with a fast-terminating command
    const origLog = console.log;
    console.log = () => {};
    try {
      await handleDev({
        cwd: tmpProj,
        noExit: true,
        command: ["node", "-e", "process.exit(0)"],
      });

      // Verify Caddyfile.dev was cleaned up and not left on disk
      expect(await fs.access(staleCaddyfile).then(() => true).catch(() => false)).toBe(false);
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }
  });

  it("respects skipInfra option in handleDev", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-dev-test-"));
    const contract: PegasContract = {
      services: {
        web: {
          upstream: "web:3000",
          domains: { dev: ["skip-infra.localhost"], prod: ["skip-infra.com"] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract, null, 2), "utf-8");
    // Add compose with mock infra
    await fs.writeFile(
      path.join(tmpProj, "docker-compose.yml"),
      `services:\n  db:\n    image: postgres:15\n    ports:\n      - "5432:5432"\n`,
      "utf-8"
    );

    const origLog = console.log;
    console.log = () => {};
    try {
      await handleDev({
        cwd: tmpProj,
        skipInfra: true,
        noExit: true,
        command: ["node", "-e", "process.exit(0)"],
      });
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }
  });

  it("outputs smart hint by default when infra services exist without bootInfra", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-dev-test-"));
    const contract: PegasContract = {
      services: {
        web: {
          upstream: "web:3000",
          domains: { dev: ["hint.localhost"], prod: ["hint.com"] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract, null, 2), "utf-8");
    await fs.writeFile(
      path.join(tmpProj, "docker-compose.yml"),
      `services:\n  db:\n    image: postgres:15\n    ports:\n      - "5432:5432"\n  redis:\n    image: redis:7\n    ports:\n      - "6379:6379"\n`,
      "utf-8"
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    try {
      await handleDev({
        cwd: tmpProj,
        noExit: true,
        command: ["node", "-e", "process.exit(0)"],
      });
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }

    const hint = logs.find((l) => l.includes("💡 Tip: Detected infra services"));
    expect(hint).toBeDefined();
    expect(hint).toContain("db, redis");
    expect(hint).toContain('"bootInfra": true');
  });

  it("boots infra services when bootInfra is true in contract", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-dev-test-"));
    const contract: PegasContract = {
      bootInfra: true,
      services: {
        web: {
          upstream: "web:3000",
          domains: { dev: ["override.localhost"], prod: ["override.com"] },
        },
      },
    };
    await fs.writeFile(path.join(tmpProj, CONTRACT_FILENAME), JSON.stringify(contract, null, 2), "utf-8");
    await fs.writeFile(
      path.join(tmpProj, "docker-compose.yml"),
      `services:\n  db:\n    image: postgres:15\n    ports:\n      - "5432:5432"\n`,
      "utf-8"
    );

    const executedCalls: { cmd: string; args: string[] }[] = [];
    const spy = spyOn(child_process, "execFileSync").mockImplementation(((cmd: string, args: string[]) => {
      executedCalls.push({ cmd, args });
      return Buffer.from("");
    }) as any);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    try {
      await handleDev({
        cwd: tmpProj,
        noExit: true,
        command: ["node", "-e", "process.exit(0)"],
      });
    } finally {
      spy.mockRestore();
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }

    const booted = logs.find((l) => l.includes("Booting project infrastructure with Docker Compose"));
    expect(booted).toBeDefined();
    expect(executedCalls.length).toBe(2);
    expect(executedCalls[0].cmd).toBe("docker");
    expect(executedCalls[0].args).toContain("up");
    expect(executedCalls[0].args).toContain("db");
    expect(executedCalls[1].args).toContain("stop");
    expect(executedCalls[1].args).toContain("db");
  });
});
