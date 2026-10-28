import { describe, it, expect, mock } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

let mockDockerOk = true;
let mockComposeOk = true;
let mockStartSuccess = true;
let mockNetworkOk = true;

mock.module("../docker.js", () => ({
  checkDocker: async () => mockDockerOk,
  checkDockerCompose: async () => mockComposeOk,
  ensureDockerNetwork: async () => mockNetworkOk,
  startGatewayContainer: async () => ({
    success: mockStartSuccess,
    stderr: mockStartSuccess ? "" : "daemon start failed",
  }),
  validateCaddyConfig: async () => ({
    success: true,
  }),
}));

import { setupGitignore, handleProjectInit, handleServerInit, handleInit } from "./init.js";

describe("pegas init (unit)", () => {
  it("setupGitignore adds .pegas if missing and is idempotent", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-git-"));

    // 1. Missing file: creates .gitignore
    const res1 = await setupGitignore(tmpProj);
    expect(res1).toBe("Создан .gitignore с записью .pegas");
    const content1 = await fs.readFile(path.join(tmpProj, ".gitignore"), "utf-8");
    expect(content1).toContain(".pegas");

    // 2. Existing file with .pegas: returns null (no-op)
    const res2 = await setupGitignore(tmpProj);
    expect(res2).toBeNull();

    // 3. Existing file without .pegas: appends .pegas
    await fs.writeFile(path.join(tmpProj, ".gitignore"), "node_modules/\ndist/\n", "utf-8");
    const res3 = await setupGitignore(tmpProj);
    expect(res3).toBe("Добавлена запись .pegas в .gitignore");
    const content3 = await fs.readFile(path.join(tmpProj, ".gitignore"), "utf-8");
    expect(content3).toContain("node_modules/\ndist/\n.pegas");

    await fs.rm(tmpProj, { recursive: true, force: true });
  });

  it("handleProjectInit initializes project contract, package.json, docs, and compose", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-proj-"));
    await fs.writeFile(
      path.join(tmpProj, "package.json"),
      JSON.stringify({ name: "my-microservice", scripts: { dev: "vite" } }, null, 2)
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleProjectInit(tmpProj, true);
    } finally {
      console.log = origLog;
    }

    const res = JSON.parse(logs[0]);
    expect(res.status).toBe("success");
    expect(res.actions.length).toBeGreaterThan(0);

    // Verify created files
    expect(await fs.access(path.join(tmpProj, "pegas.json")).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(path.join(tmpProj, "docs", "pegas.md")).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(path.join(tmpProj, "docker-compose.yml")).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(path.join(tmpProj, ".gitignore")).then(() => true).catch(() => false)).toBe(true);

    const contract = JSON.parse(await fs.readFile(path.join(tmpProj, "pegas.json"), "utf-8"));
    expect(contract.projectName).toBe("my-microservice");

    await fs.rm(tmpProj, { recursive: true, force: true });
  });

  it("handleProjectInit handles pre-existing files and text output cleanly", async () => {
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-preexist-"));
    await fs.writeFile(
      path.join(tmpProj, "package.json"),
      JSON.stringify({ name: "pre-existing-app" }, null, 2)
    );
    await fs.writeFile(path.join(tmpProj, "pegas.json"), JSON.stringify({ projectName: "pre-existing-app" }), "utf-8");
    await fs.writeFile(path.join(tmpProj, "docker-compose.yml"), "services:\n  app:\n    image: node:20\n", "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleProjectInit(tmpProj, false);
    } finally {
      console.log = origLog;
      await fs.rm(tmpProj, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("Project initialized with Pegas"))).toBe(true);
    expect(logs.some((l) => l.includes("уже существует"))).toBe(true);
  });

  it("handleServerInit validates Docker and Docker Compose availability", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-srv-"));
    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // Docker missing (json and text)
      mockDockerOk = false;
      await handleServerInit({ gatewayDir: tmpGateway, noExit: true, json: true });
      await handleServerInit({ gatewayDir: tmpGateway, noExit: true, json: false });

      // Compose missing (json and text)
      mockDockerOk = true;
      mockComposeOk = false;
      await handleServerInit({ gatewayDir: tmpGateway, noExit: true, json: true });
      await handleServerInit({ gatewayDir: tmpGateway, noExit: true, json: false });
    } finally {
      console.log = origLog;
      console.error = origError;
      mockDockerOk = true;
      mockComposeOk = true;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("Docker daemon is not running"))).toBe(true);
    expect(errors.some((e) => e.includes("Docker daemon is not running"))).toBe(true);
    expect(logs.some((l) => l.includes("Docker Compose is not available"))).toBe(true);
    expect(errors.some((e) => e.includes("Docker Compose is not available"))).toBe(true);
  });

  it("handleServerInit bootstraps gateway directory, configs, network, and container", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-full-"));
    mockDockerOk = true;
    mockComposeOk = true;
    mockStartSuccess = true;

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      // Boot with custom email and custom network in JSON mode
      await handleServerInit({
        gatewayDir: tmpGateway,
        email: "admin@mycorp.com",
        networkName: "custom-pegas-net",
        noExit: true,
        json: true,
      });

      const caddyfile = await fs.readFile(path.join(tmpGateway, "Caddyfile"), "utf-8");
      expect(caddyfile).toContain("email admin@mycorp.com");
      expect(caddyfile).toContain("import /etc/caddy/conf.d/*.caddy");

      const compose = await fs.readFile(path.join(tmpGateway, "docker-compose.yml"), "utf-8");
      expect(compose).toContain("custom-pegas-net");

      // Boot in text mode
      await handleServerInit({
        gatewayDir: tmpGateway,
        noExit: true,
        json: false,
      });
    } finally {
      console.log = origLog;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes('"status":"success"') && l.includes("custom-pegas-net"))).toBe(true);
    expect(logs.some((l) => l.includes("Pegas server gateway initialized successfully"))).toBe(true);
  });

  it("handleServerInit handles container startup failure", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-fail-"));
    mockDockerOk = true;
    mockComposeOk = true;
    mockStartSuccess = false;

    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
      // JSON mode
      await handleServerInit({ gatewayDir: tmpGateway, noExit: true, json: true });

      // Text mode
      await handleServerInit({ gatewayDir: tmpGateway, noExit: true, json: false });
    } finally {
      console.log = origLog;
      console.error = origError;
      mockStartSuccess = true;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("Failed to start Caddy container"))).toBe(true);
    expect(errors.some((e) => e.includes("Failed to start Caddy container"))).toBe(true);
  });

  it("handleInit dispatches to server or project based on options", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-dispatch-gw-"));
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-init-dispatch-proj-"));

    await fs.writeFile(
      path.join(tmpProj, "package.json"),
      JSON.stringify({ name: "dispatch-app", scripts: { dev: "vite" } }, null, 2)
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      // 1. Explicit --server
      await handleInit({ server: true, gatewayDir: tmpGateway, noExit: true, json: true });

      // 2. Explicit --project (in isolated tmp directory)
      await handleInit({ project: true, cwd: tmpProj, json: true });

      // 3. Smart detection (pointing to tmpProj)
      await handleInit({ cwd: tmpProj, json: true });
    } finally {
      console.log = origLog;
      await fs.rm(tmpGateway, { recursive: true, force: true });
      await fs.rm(tmpProj, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes('"status":"success"'))).toBe(true);
  });
});
