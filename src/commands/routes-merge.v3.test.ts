import { describe, it, expect, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as actualDocker from "../docker.js";

// Герметичность: reload шлюза замокан — реального Caddy в юнит-тестах нет.
mock.module("../docker.js", () => ({
  ...actualDocker,
  validateCaddyConfig: async () => ({ success: true, stderr: "" }),
  reloadCaddyConfig: async () => ({ success: true, stderr: "" }),
  ensureGatewayContainer: async () => ({ success: true, stdout: "", stderr: "" }),
  ensureDockerNetwork: async () => true,
  stopGatewayIfUnused: async () => ({ success: true, stdout: "", stderr: "" }),
}));

import { handleConnect } from "./connect.js";
import { handleDeploy } from "./deploy.js";
import { handleDisconnect } from "./disconnect.js";
import { handleDown } from "./down.js";
import { CONTRACT_FILENAME } from "../contract.js";

/** Контракт из воспроизведения issue #24: web (bun) + worker (docker), оба с доменами. */
function mixedContract(projectName: string): any {
  return {
    projectName,
    scenarios: ["development"],
    gateway: { development: { httpPort: 80, httpsPort: 443 } },
    services: {
      web: {
        runtime: { development: { driver: "bun" } },
        port: { development: 3100 },
        domains: { development: [`${projectName === "mixed-app" ? "web.mixed-app" : "web.x"}.localhost`] },
      },
      worker: {
        runtime: { development: { driver: "docker" } },
        image: { development: "node:24" },
        port: { development: 3200 },
        domains: { development: [`${projectName === "mixed-app" ? "worker.mixed-app" : "worker.x"}.localhost`] },
      },
    },
  };
}

async function setup(projectName: string): Promise<{ proj: string; gw: string; routeFile: string }> {
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-merge24-proj-"));
  const gw = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-merge24-gw-"));
  await fs.mkdir(path.join(gw, "conf.d"), { recursive: true });
  await fs.writeFile(path.join(gw, "Caddyfile"), "import conf.d/*.caddy\n", "utf-8");
  await fs.writeFile(path.join(proj, CONTRACT_FILENAME), JSON.stringify(mixedContract(projectName)), "utf-8");
  const routeFile = path.join(gw, "conf.d", `${projectName}-development.caddy`);
  return { proj, gw, routeFile };
}

const silence = () => {
  const orig = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = orig;
    console.error = origErr;
  };
};

describe("issue #24: merge маршрутов в общем development-файле", () => {
  it("connect не сносит docker-блоки, записанные deploy", async () => {
    const { proj, gw, routeFile } = await setup("mixed-app");
    const restore = silence();
    try {
      await handleDeploy({ cwd: proj, scenario: "development", gatewayDir: gw, skipUp: true, skipDnsCheck: true, noExit: true, json: true });
      const afterDeploy = await fs.readFile(routeFile, "utf-8");
      expect(afterDeploy).toContain("worker.mixed-app.localhost");
      expect(afterDeploy).toMatch(/-development-worker:3200/);

      await handleConnect({ cwd: proj, gatewayDir: gw, skipGatewayEnsure: true, skipReload: true, noExit: true, json: true });

      const content = await fs.readFile(routeFile, "utf-8");
      expect(content).toContain("web.mixed-app.localhost");
      expect(content).toContain("host.docker.internal:3100");
      // Блок deploy пережил connect:
      expect(content).toContain("worker.mixed-app.localhost");
      expect(content).toMatch(/-development-worker:3200/);
    } finally {
      restore();
      await fs.rm(proj, { recursive: true, force: true });
      await fs.rm(gw, { recursive: true, force: true });
    }
  });

  it("deploy не сносит connect-блоки (host-маршруты)", async () => {
    const { proj, gw, routeFile } = await setup("mixed-app");
    const restore = silence();
    try {
      await handleConnect({ cwd: proj, gatewayDir: gw, skipGatewayEnsure: true, skipReload: true, noExit: true, json: true });
      const afterConnect = await fs.readFile(routeFile, "utf-8");
      expect(afterConnect).toContain("host.docker.internal:3100");

      await handleDeploy({ cwd: proj, scenario: "development", gatewayDir: gw, skipUp: true, skipDnsCheck: true, noExit: true, json: true });

      const content = await fs.readFile(routeFile, "utf-8");
      expect(content).toContain("worker.mixed-app.localhost");
      expect(content).toMatch(/-development-worker:3200/);
      // Блок connect пережил deploy:
      expect(content).toContain("web.mixed-app.localhost");
      expect(content).toContain("host.docker.internal:3100");
    } finally {
      restore();
      await fs.rm(proj, { recursive: true, force: true });
      await fs.rm(gw, { recursive: true, force: true });
    }
  });

  it("повторный connect не дублирует свои блоки", async () => {
    const { proj, gw, routeFile } = await setup("mixed-app");
    const restore = silence();
    try {
      await handleConnect({ cwd: proj, gatewayDir: gw, skipGatewayEnsure: true, skipReload: true, noExit: true, json: true });
      await handleDeploy({ cwd: proj, scenario: "development", gatewayDir: gw, skipUp: true, skipDnsCheck: true, noExit: true, json: true });
      await handleConnect({ cwd: proj, gatewayDir: gw, skipGatewayEnsure: true, skipReload: true, noExit: true, json: true });

      const content = await fs.readFile(routeFile, "utf-8");
      expect(content.split("web.mixed-app.localhost {").length - 1).toBe(1);
      expect(content.split("worker.mixed-app.localhost {").length - 1).toBe(1);
    } finally {
      restore();
      await fs.rm(proj, { recursive: true, force: true });
      await fs.rm(gw, { recursive: true, force: true });
    }
  });

  it("disconnect снимает только connect-блоки; deploy-блоки остаются", async () => {
    const { proj, gw, routeFile } = await setup("mixed-app");
    const restore = silence();
    try {
      await handleDeploy({ cwd: proj, scenario: "development", gatewayDir: gw, skipUp: true, skipDnsCheck: true, noExit: true, json: true });
      await handleConnect({ cwd: proj, gatewayDir: gw, skipGatewayEnsure: true, skipReload: true, noExit: true, json: true });

      await handleDisconnect({ cwd: proj, gatewayDir: gw, noExit: true, json: true });

      const content = await fs.readFile(routeFile, "utf-8");
      expect(content).not.toContain("host.docker.internal");
      expect(content).toContain("worker.mixed-app.localhost");
      expect(content).toMatch(/-development-worker:3200/);
    } finally {
      restore();
      await fs.rm(proj, { recursive: true, force: true });
      await fs.rm(gw, { recursive: true, force: true });
    }
  });

  it("down снимает только deploy-блоки; connect-блоки остаются", async () => {
    const { proj, gw, routeFile } = await setup("mixed-app");
    const restore = silence();
    try {
      await handleConnect({ cwd: proj, gatewayDir: gw, skipGatewayEnsure: true, skipReload: true, noExit: true, json: true });
      await handleDeploy({ cwd: proj, scenario: "development", gatewayDir: gw, skipUp: true, skipDnsCheck: true, noExit: true, json: true });

      await handleDown({ cwd: proj, gatewayDir: gw, skipComposeDown: true, noExit: true, json: true, env: "development" });

      const content = await fs.readFile(routeFile, "utf-8");
      expect(content).toContain("web.mixed-app.localhost");
      expect(content).toContain("host.docker.internal:3100");
      expect(content).not.toContain("worker.mixed-app.localhost");
    } finally {
      restore();
      await fs.rm(proj, { recursive: true, force: true });
      await fs.rm(gw, { recursive: true, force: true });
    }
  });

  it("disconnect при чистом connect-файле удаляет файл целиком", async () => {
    const { proj, gw, routeFile } = await setup("mixed-app");
    const restore = silence();
    try {
      await handleConnect({ cwd: proj, gatewayDir: gw, skipGatewayEnsure: true, skipReload: true, noExit: true, json: true });
      await handleDisconnect({ cwd: proj, gatewayDir: gw, noExit: true, json: true });
      expect(await fs.access(routeFile).then(() => true, () => false)).toBe(false);
    } finally {
      restore();
      await fs.rm(proj, { recursive: true, force: true });
      await fs.rm(gw, { recursive: true, force: true });
    }
  });
});
