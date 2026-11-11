#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";
import { createHash } from "node:crypto";
import { createHash } from "node:crypto";

// Colors for terminal output
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const blue = (text: string) => `\x1b[34m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BIN_PATH = path.join(REPO_ROOT, "dist", "index.js");

function logPhase(step: number, title: string) {
  console.log(`\n${bold(blue(`[Phase ${step}]`))} ${bold(title)}`);
}

function logSuccess(message: string) {
  console.log(`  ${green("✔")} ${message}`);
}

function logFail(message: string) {
  console.error(`  ${red("✖")} ${message}`);
}

function execAsync(
  cmd: string,
  args: string[],
  options: child_process.SpawnOptionsWithoutStdio = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = child_process.spawn(cmd, args, options);
    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 });
    });

    proc.on("error", (err) => {
      stderr += err.message;
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: 1 });
    });
  });
}

/**
 * Perform a physical HTTP request to the local Gateway with a custom Host header
 */
async function httpGet(
  hostHeader: string,
  urlPath: string = "/",
  port: number = 80,
  timeoutMs: number = 4000
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const curlRes = await execAsync("curl", [
    "-s",
    "--noproxy",
    "*",
    "-m",
    (timeoutMs / 1000).toString(),
    "-i",
    "-H",
    `Host: ${hostHeader}`,
    `http://127.0.0.1:${port}${urlPath}`,
  ]);

  if (curlRes.code !== 0 && !curlRes.stdout) {
    throw new Error(`HTTP request failed for Host '${hostHeader}': ${curlRes.stderr}`);
  }

  const raw = curlRes.stdout;
  const headerEndIndex = raw.indexOf("\r\n\r\n") !== -1 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  const headerPart = headerEndIndex !== -1 ? raw.slice(0, headerEndIndex) : raw;
  const body = headerEndIndex !== -1 ? raw.slice(headerEndIndex).trim() : "";

  const statusMatch = headerPart.match(/HTTP\/[12]\.?\d?\s+(\d{3})/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  const headers: Record<string, string> = {};
  for (const line of headerPart.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const k = line.slice(0, colon).trim().toLowerCase();
      const v = line.slice(colon + 1).trim();
      headers[k] = v;
    }
  }

  return { status, body, headers };
}

async function ensureDockerImage(imageName: string) {
  // Pull via Docker itself: if the image is already in the local daemon
  // storage, docker reuses it without downloading; otherwise it fetches it.
  const pullRes = await execAsync("docker", ["pull", imageName]);
  if (pullRes.code !== 0) {
    throw new Error(`Failed to pull '${imageName}': ${pullRes.stderr}`);
  }
  logSuccess(`Image '${imageName}' available in local Docker storage`);
}

/**
 * v3: контракт pegas.json пишет сам e2e (init в v3 контракт не создаёт).
 * Форма — как в v3-валидаторе: scenarios, gateway-карта, runtime-карты,
 * image-карты, сценарные domains (производственные тест-домены).
 */
function writeV3Contract(projectDir: string, projectName: string, webDomain: string, extraServices: Record<string, { domain: string; port: number }> = {}) {
  const scenarios = ["development", "stage", "production"];
  const contract = {
    projectName,
    scenarios,
    gateway: Object.fromEntries(
      scenarios.map((s) => [s, { httpPort: 80, httpsPort: 443 }])
    ),
    services: {
      web: {
        runtime: Object.fromEntries(scenarios.map((s) => [s, { driver: "docker" }])),
        image: Object.fromEntries(scenarios.map((s) => [s, "traefik/whoami"])),
        port: Object.fromEntries(scenarios.map((s) => [s, 80])),
        domains: {
          development: [`${projectName}.localhost`],
          stage: [`${projectName}-stage.test`],
          production: [webDomain],
        },
      },
      ...Object.fromEntries(
        Object.entries(extraServices).map(([name, { domain, port }]) => [
          name,
          {
            runtime: Object.fromEntries(scenarios.map((s) => [s, { driver: "docker" }])),
            image: Object.fromEntries(scenarios.map((s) => [s, "traefik/whoami"])),
            port: Object.fromEntries(scenarios.map((s) => [s, port])),
            domains: {
              development: [`${name}.${projectName}.localhost`],
              stage: [`${name}-${projectName}-stage.test`],
              production: [domain],
            },
          },
        ])
      ),
    },
  };
  return fs.writeFile(path.join(projectDir, "pegas.json"), JSON.stringify(contract, null, 2) + "\n", "utf-8");
}

async function runUnifiedE2E() {
  const startTime = Date.now();
  console.log(bold("================================================================================"));
  console.log(bold("  🧪 PEGAS BATTLE-TESTED UNIFIED END-TO-END (E2E) RUNTIME SUITE"));
  console.log(bold("================================================================================"));

  let mainSandboxDir = "";
  let delegationDir = "";
  let gatewayDir = "";
  let pAlphaDir = "";
  let pBetaDir = "";
  let pMultiDir = "";
  let pHijackDir = "";
  let pBrokenDir = "";
  // Момент старта: страховочный sweep чистит только pegas-контейнеры ЭТОГО прогона,
  // не задевая чужие pegas-развёртывания на хосте (created >= runStartedAt).
  const runStartedAt = Date.now();

  try {
    // =========================================================================
    // Phase 0: Pre-flight & Fresh Build
    // =========================================================================
    logPhase(0, "Pre-flight Verification and Fresh Bundle Build");
    const buildRes = await execAsync("bun", ["run", "build"], { cwd: REPO_ROOT });
    if (buildRes.code !== 0) {
      throw new Error(`Build failed: ${buildRes.stderr}`);
    }
    logSuccess("Built fresh dist/index.js bundle");

    const dockerCheck = await execAsync("docker", ["compose", "version"]);
    if (dockerCheck.code !== 0) {
      throw new Error(`Docker Compose is not available on host: ${dockerCheck.stderr}`);
    }
    logSuccess(`Docker Compose verified: ${dockerCheck.stdout.split("\n")[0]}`);

    await ensureDockerImage("caddy:2-alpine");
    await ensureDockerImage("traefik/whoami");
    logSuccess("Test container images verified in local Docker storage");

    // =========================================================================
    // Phase 1: Local CLI Mechanics (thin init, no compose surgery)
    // =========================================================================
    logPhase(1, "Local CLI Mechanics (init writes documentation artifacts, no manifest surgery)");
    mainSandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-e2e-unified-"));
    const surgeryDir = path.join(mainSandboxDir, "surgery-project");
    await fs.mkdir(surgeryDir, { recursive: true });

    await fs.writeFile(
      path.join(surgeryDir, "package.json"),
      JSON.stringify(
        {
          name: "surgery-demo-app",
          version: "1.0.0",
          scripts: { dev: "node -e 'console.log(\"OK\")'" },
        },
        null,
        2
      )
    );
    await fs.writeFile(
      path.join(surgeryDir, "pegas.json"),
      JSON.stringify({ runtime: "host", services: {} }, null, 2)
    );

    const rawCompose = `services:
  web:
    image: traefik/whoami
    ports:
      - "8080:80"
  redis:
    image: redis:alpine
    ports:
      - "6379:6379"
`;
    await fs.writeFile(path.join(surgeryDir, "docker-compose.yml"), rawCompose);

    const initRes = await execAsync("node", [BIN_PATH, "init"], { cwd: surgeryDir });
    if (initRes.code !== 0) {
      throw new Error(`'pegas init' failed: ${initRes.stderr || initRes.stdout}`);
    }
    logSuccess("'pegas init' executed with code 0");

    // v3: init НЕ должен переписывать контракт — только писать docs/pegas.md и .gitignore-гигиену
    const contractRaw = await fs.readFile(path.join(surgeryDir, "pegas.json"), "utf-8");
    if (JSON.parse(contractRaw).projectName === "surgery-demo-app") {
      throw new Error("v3 violation: pegas init mutated pegas.json (projectName was injected)");
    }
    logSuccess("Contract preserved: init did not rewrite pegas.json (thin init semantics)");

    // docs/pegas.md: каноничный шаблон docsPegasMd() — суть Pegas, контракт, dev-цикл; без compose-surgery
    const docsMd = await fs.readFile(path.join(surgeryDir, "docs", "pegas.md"), "utf-8");
    if (!docsMd.includes("# Pegas")) throw new Error("docs/pegas.md: title missing");
    if (!docsMd.includes("## Контракт pegas.json")) throw new Error("docs/pegas.md: contract section missing");
    if (!docsMd.includes("## Dev-цикл")) throw new Error("docs/pegas.md: dev cycle section missing");
    // Имя в docs — из package.json проекта (pegas.json имени не содержит)
    if (!docsMd.includes("Проект: `surgery-demo-app`")) throw new Error("docs/pegas.md: project name missing");
    if (docsMd.includes("expose:")) {
      throw new Error("docs/pegas.md still documents compose surgery (removed in v3)");
    }
    logSuccess("docs/pegas.md written: canonical contract documentation, no compose-surgery references");

    // .gitignore-гигиена: манифесты эфемерны и не коммитятся
    const gitignoreContent = await fs.readFile(path.join(surgeryDir, ".gitignore"), "utf-8");
    if (!gitignoreContent.includes(".pegas")) {
      throw new Error(".gitignore is missing '.pegas'");
    }
    logSuccess(".gitignore protection verified (ephemeral manifests stay out of git)");

    // Phase 2: No Delegation (v3 — бинарник выполняется напрямую, перехвата node_modules/pegas нет)
    // =========================================================================
    logPhase(2, "Direct Execution (v3: no node_modules/pegas interception, no recursion guard)");
    delegationDir = path.join(mainSandboxDir, "delegation-sandbox");
    const localPegasDist = path.join(delegationDir, "node_modules", "pegas", "dist");
    await fs.mkdir(localPegasDist, { recursive: true });

    const mockLocalCode = `console.log("MOCK_LOCAL_PEGAS_EXECUTED");\nprocess.exit(0);\n`;
    await fs.writeFile(path.join(localPegasDist, "index.js"), mockLocalCode);

    const delRes = await execAsync("node", [BIN_PATH, "--version"], { cwd: delegationDir });
    if (delRes.stdout.includes("MOCK_LOCAL_PEGAS_EXECUTED")) {
      throw new Error("v3 violation: primary binary delegated to local node_modules/pegas (delegation removed in v3)");
    }
    if (!delRes.stdout.includes("pegas v")) {
      throw new Error(`Expected primary binary version, got: ${delRes.stdout}`);
    }
    logSuccess("Primary binary executes directly despite local node_modules/pegas (v3 semantics)");

    // =========================================================================
    // Phase 3: Multi-Tenant Gateway Setup (with auto_https off for hermetic HTTP)
    // =========================================================================
    logPhase(3, "Server Gateway Setup (Caddy on 'pegas-network' with auto_https off)");
    gatewayDir = path.join(mainSandboxDir, "gateway");
    pAlphaDir = path.join(mainSandboxDir, "project-alpha");
    pBetaDir = path.join(mainSandboxDir, "project-beta");
    pMultiDir = path.join(mainSandboxDir, "project-multi");
    pHijackDir = path.join(mainSandboxDir, "project-hijack");
    pBrokenDir = path.join(mainSandboxDir, "project-broken");

    await fs.mkdir(gatewayDir, { recursive: true });
    await fs.mkdir(pAlphaDir, { recursive: true });
    await fs.mkdir(pBetaDir, { recursive: true });
    await fs.mkdir(pMultiDir, { recursive: true });
    await fs.mkdir(pHijackDir, { recursive: true });
    await fs.mkdir(pBrokenDir, { recursive: true });

    // Configure gateway Caddyfile with auto_https off to allow physical HTTP testing without Let's Encrypt
    const testCaddyfile = `{\n    auto_https off\n    http_port 80\n    https_port 80\n}\n\nimport /etc/caddy/conf.d/*.caddy\n`;
    await fs.writeFile(path.join(gatewayDir, "Caddyfile"), testCaddyfile, "utf-8");
    await fs.mkdir(path.join(gatewayDir, "conf.d"), { recursive: true });

    const testCompose = `services:
  caddy:
    image: caddy:2-alpine
    container_name: gateway-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./conf.d:/etc/caddy/conf.d:ro
    networks:
      - pegas-network

networks:
  pegas-network:
    external: true
`;
    await fs.writeFile(path.join(gatewayDir, "docker-compose.yml"), testCompose, "utf-8");
    await execAsync("docker", ["network", "create", "pegas-network"]).catch(() => {});
    await execAsync("docker", ["rm", "-f", "gateway-caddy"]).catch(() => {});
    const startGwRes = await execAsync("docker", ["compose", "up", "-d"], { cwd: gatewayDir });
    if (startGwRes.code !== 0) {
      throw new Error(`Failed to initialize test gateway container: ${startGwRes.stderr}`);
    }
    logSuccess(`Server gateway container running in ${gatewayDir} on network 'pegas-network'`);

    // =========================================================================
    // Phase 4: Parallel Multi-Tenant Deployment (Alpha & Beta)
    // =========================================================================
    logPhase(4, "Parallel Multi-Tenant Deployment (Alpha & Beta)");

    // Project Alpha
    await fs.writeFile(
      path.join(pAlphaDir, "package.json"),
      JSON.stringify({ name: "project-alpha", version: "1.0.0" }, null, 2)
    );
    await fs.writeFile(
      path.join(pAlphaDir, "docker-compose.yml"),
      `services:\n  web:\n    image: traefik/whoami\n    ports:\n      - "8081:80"\n    environment:\n      - WHOAMI_NAME=project-alpha\n`
    );
    await execAsync("node", [BIN_PATH, "init"], { cwd: pAlphaDir });
    // v3: контракт пишет e2e (thin init контракт не создаёт); домены уникальны per-tenant
    await writeV3Contract(pAlphaDir, "project-alpha", "project-alpha.com");
    const deployAlphaRes = await execAsync("node", [BIN_PATH, "deploy", "-s", "production", "--skip-dns-check", "--gateway-dir", gatewayDir], {
      cwd: pAlphaDir,
    });
    if (deployAlphaRes.code !== 0) {
      throw new Error(`Project Alpha deploy failed: ${deployAlphaRes.stderr}`);
    }
    const connectAlphaRes = await execAsync("node", [BIN_PATH, "connect", "-s", "production", "--gateway-dir", gatewayDir], { cwd: pAlphaDir });
    if (connectAlphaRes.code !== 0) {
      throw new Error(`Project Alpha connect failed: ${connectAlphaRes.stderr}`);
    }
    logSuccess("Project Alpha deployed & Caddy reloaded cleanly");

    // Project Beta
    await fs.writeFile(
      path.join(pBetaDir, "package.json"),
      JSON.stringify({ name: "project-beta", version: "1.0.0" }, null, 2)
    );
    await fs.writeFile(
      path.join(pBetaDir, "docker-compose.yml"),
      `services:\n  web:\n    image: traefik/whoami\n    ports:\n      - "8082:80"\n    environment:\n      - WHOAMI_NAME=project-beta\n`
    );
    await execAsync("node", [BIN_PATH, "init"], { cwd: pBetaDir });
    await writeV3Contract(pBetaDir, "project-beta", "project-beta.com");
    const deployBetaRes = await execAsync("node", [BIN_PATH, "deploy", "-s", "production", "--skip-dns-check", "--gateway-dir", gatewayDir], {
      cwd: pBetaDir,
    });
    if (deployBetaRes.code !== 0) {
      throw new Error(`Project Beta deploy failed: ${deployBetaRes.stderr}`);
    }
    const connectBetaRes = await execAsync("node", [BIN_PATH, "connect", "-s", "production", "--gateway-dir", gatewayDir], { cwd: pBetaDir });
    if (connectBetaRes.code !== 0) {
      throw new Error(`Project Beta connect failed: ${connectBetaRes.stderr}`);
    }
    logSuccess("Project Beta deployed in parallel without port conflict");

    // =========================================================================
    // Phase 5: ⚡ Physical HTTP Traffic & Isolation Assertions
    // =========================================================================
    logPhase(5, "Physical HTTP Traffic & Tenant Isolation (Real L7 Proxy Delivery)");

    // Wait a brief moment for Caddy routing table to stabilize
    await new Promise((r) => setTimeout(r, 1000));

    // Request Alpha
    const resAlpha = await httpGet("project-alpha.com", "/", 80);
    if (resAlpha.status !== 200) {
      throw new Error(`Expected HTTP 200 for project-alpha.com, got: ${resAlpha.status}`);
    }
    if (!resAlpha.body.includes("project-alpha") && !resAlpha.body.includes("Hostname:")) {
      throw new Error(`Project Alpha response payload mismatch: ${resAlpha.body}`);
    }
    logSuccess("Physical HTTP GET -> 'project-alpha.com' returned 200 OK with Alpha payload");

    // Request Beta
    const resBeta = await httpGet("project-beta.com", "/", 80);
    if (resBeta.status !== 200) {
      throw new Error(`Expected HTTP 200 for project-beta.com, got: ${resBeta.status}`);
    }
    if (!resBeta.body.includes("project-beta") && !resBeta.body.includes("Hostname:")) {
      throw new Error(`Project Beta response payload mismatch: ${resBeta.body}`);
    }
    logSuccess("Physical HTTP GET -> 'project-beta.com' returned 200 OK with Beta payload");

    // Test Isolation (Alpha must not serve Beta payload)
    if (resAlpha.body.includes("project-beta")) {
      throw new Error("Tenant cross-talk detected: Alpha returned Beta payload!");
    }
    if (resBeta.body.includes("project-alpha")) {
      throw new Error("Tenant cross-talk detected: Beta returned Alpha payload!");
    }
    logSuccess("Verified zero tenant cross-talk: upstream routing is strictly isolated");

    // Request Unknown Host
    const resUnknown = await httpGet("completely-unregistered-domain.com", "/", 80);
    if (resUnknown.status !== 0 && resUnknown.status !== 404 && resUnknown.status !== 502) {
      console.log(`  ${cyan("ℹ")} Unknown domain returned HTTP status: ${resUnknown.status}`);
    }
    logSuccess("Unregistered host safely isolated without wildcard leakage");

    // =========================================================================
    // Phase 6: Multi-Service Path Routing (SPA + API)
    // =========================================================================
    logPhase(6, "Multi-Service Path Routing (/api/* vs /)");

    await fs.writeFile(
      path.join(pMultiDir, "package.json"),
      JSON.stringify({ name: "project-multi", version: "1.0.0" }, null, 2)
    );
    await fs.writeFile(
      path.join(pMultiDir, "docker-compose.yml"),
      `services:
  web:
    image: traefik/whoami
    ports:
      - "8083:80"
    environment:
      - WHOAMI_NAME=multi-web-frontend
  api:
    image: traefik/whoami
    ports:
      - "8084:80"
    environment:
      - WHOAMI_NAME=multi-backend-api
`
    );
    await execAsync("node", [BIN_PATH, "init"], { cwd: pMultiDir });

    // v3: контракт с двумя сервисами (web + api), сценарные карты
    await writeV3Contract(pMultiDir, "project-multi", "multi-app.com", {
      api: { domain: "api-multi-app.com", port: 80 },
    });

    const deployMultiRes = await execAsync("node", [BIN_PATH, "deploy", "-s", "production", "--skip-dns-check", "--gateway-dir", gatewayDir], {
      cwd: pMultiDir,
    });
    if (deployMultiRes.code !== 0) {
      throw new Error(`Project Multi deploy failed: ${deployMultiRes.stderr}`);
    }
    const connectMultiRes = await execAsync("node", [BIN_PATH, "connect", "-s", "production", "--gateway-dir", gatewayDir], { cwd: pMultiDir });
    if (connectMultiRes.code !== 0) {
      throw new Error(`Project Multi connect failed: ${connectMultiRes.stderr}`);
    }
    logSuccess("Multi-service project deployed with web and api upstreams");

    await new Promise((r) => setTimeout(r, 1000));

    const resMultiWeb = await httpGet("multi-app.com", "/", 80);
    if (resMultiWeb.status !== 200) {
      throw new Error(`Expected 200 for multi-app.com, got: ${resMultiWeb.status}`);
    }
    logSuccess("HTTP GET multi-app.com routed to multi-web-frontend (200 OK)");

    const resMultiApi = await httpGet("api-multi-app.com", "/", 80);
    if (resMultiApi.status !== 200) {
      throw new Error(`Expected 200 for api-multi-app.com, got: ${resMultiApi.status}`);
    }
    logSuccess("HTTP GET api-multi-app.com routed to multi-backend-api (200 OK)");

    // =========================================================================
    // Phase 7: Domain Anti-Hijacking Security Protection
    // =========================================================================
    logPhase(7, "Security Test: Domain Anti-Hijacking Protection");

    await fs.writeFile(
      path.join(pHijackDir, "package.json"),
      JSON.stringify({ name: "project-hijack", version: "1.0.0" }, null, 2)
    );
    await fs.writeFile(
      path.join(pHijackDir, "docker-compose.yml"),
      `services:\n  web:\n    image: traefik/whoami\n    ports:\n      - "8085:80"\n`
    );
    await execAsync("node", [BIN_PATH, "init"], { cwd: pHijackDir });

    // v3: намеренно захватываем домен Alpha (VIOLATION: owned by Alpha)
    await writeV3Contract(pHijackDir, "project-hijack", "project-alpha.com");

    const hijackDeployRes = await execAsync(
      "node",
      [BIN_PATH, "deploy", "-s", "production", "--skip-dns-check", "--gateway-dir", gatewayDir],
      { cwd: pHijackDir }
    );

    if (hijackDeployRes.code === 0) {
      throw new Error("Anti-hijacking failed! Malicious deploy succeeded when it should have failed.");
    }
    if (!hijackDeployRes.stderr.includes("already owned by project") && !hijackDeployRes.stdout.includes("already owned by project")) {
      throw new Error(`Expected hijack rejection error message, got: ${hijackDeployRes.stderr || hijackDeployRes.stdout}`);
    }
    logSuccess("Anti-hijacking verified: illegal domain claim was rejected before touching Caddy routes");

    // Verify Project Alpha is STILL alive and untouched
    const resAlphaAfterAttack = await httpGet("project-alpha.com", "/", 80);
    if (resAlphaAfterAttack.status !== 200) {
      throw new Error(`Project Alpha was broken by hijacked deployment attempt! Status: ${resAlphaAfterAttack.status}`);
    }
    logSuccess("Project Alpha continues serving traffic normally (zero impact from rejected attack)");

    // =========================================================================
    // Phase 8: Broken Container Readiness Probe & Rollback Protection
    // =========================================================================
    logPhase(8, "Reliability Test: Broken Container Readiness Probe & Zero-Crash Rollback");

    await fs.writeFile(
      path.join(pBrokenDir, "package.json"),
      JSON.stringify({ name: "project-broken", version: "1.0.0" }, null, 2)
    );
    // Container that immediately exits with code 1
    await fs.writeFile(
      path.join(pBrokenDir, "docker-compose.yml"),
      `services:
  web:
    image: traefik/whoami
    command: ["--invalid-flag-force-exit"]
`
    );
    await execAsync("node", [BIN_PATH, "init"], { cwd: pBrokenDir });

    // v3: контракт с падающим healthcheck — readiness-проба обязана отклонить деплой
    const brokenScenarios = ["development", "stage", "production"];
    const brokenContract = {
      projectName: "project-broken",
      scenarios: brokenScenarios,
      gateway: Object.fromEntries(brokenScenarios.map((s) => [s, { httpPort: 80, httpsPort: 443 }])),
      services: {
        web: {
          runtime: Object.fromEntries(brokenScenarios.map((s) => [s, { driver: "docker" }])),
          image: Object.fromEntries(brokenScenarios.map((s) => [s, "caddy:2-alpine"])),
          port: Object.fromEntries(brokenScenarios.map((s) => [s, 80])),
          healthcheck: Object.fromEntries(brokenScenarios.map((s) => [s, { test: ["CMD-SHELL", "exit 1"], interval: "1s", timeout: "1s", retries: 1 }])),
          domains: {
            development: ["broken-site.localhost"],
            stage: ["broken-site-stage.test"],
            production: ["broken-site.com"],
          },
        },
      },
    };
    await fs.writeFile(path.join(pBrokenDir, "pegas.json"), JSON.stringify(brokenContract, null, 2));

    const brokenDeployRes = await execAsync(
      "node",
      [BIN_PATH, "deploy", "-s", "production", "--skip-dns-check", "--gateway-dir", gatewayDir],
      { cwd: pBrokenDir }
    );

    if (brokenDeployRes.code === 0) {
      throw new Error("Broken container deployment should have failed readiness check!");
    }
    logSuccess("Readiness probe caught crashing container and aborted deployment before Caddy reload");

    // Verify existing projects are still 100% operational
    const resAlphaHealth = await httpGet("project-alpha.com", "/", 80);
    const resBetaHealth = await httpGet("project-beta.com", "/", 80);
    if (resAlphaHealth.status !== 200 || resBetaHealth.status !== 200) {
      throw new Error("Neighboring projects degraded after broken deployment failure!");
    }
    logSuccess("Neighboring projects remain 100% healthy: failure was cleanly isolated");

    // =========================================================================
    // Phase 9: Legacy Unmanaged Route Coexistence
    // =========================================================================
    logPhase(9, "Legacy Route Coexistence (Unmanaged Manual .caddy Files)");

    const manualLegacyPath = path.join(gatewayDir, "conf.d", "manual-legacy.caddy");
    const manualLegacyContent = `manual-legacy.test {\n    respond "MANUAL_LEGACY_PAYLOAD_OK" 200\n}\n`;
    await fs.writeFile(manualLegacyPath, manualLegacyContent, "utf-8");

    // Reload gateway Caddy
    await execAsync("docker", ["compose", "exec", "-T", "caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], { cwd: gatewayDir });

    await new Promise((r) => setTimeout(r, 500));

    const resLegacy = await httpGet("manual-legacy.test", "/", 80);
    if (resLegacy.status !== 200 || !resLegacy.body.includes("MANUAL_LEGACY_PAYLOAD_OK")) {
      throw new Error(`Legacy manual route failed to serve: status=${resLegacy.status}, body=${resLegacy.body}`);
    }
    logSuccess("Manual unmanaged route 'manual-legacy.caddy' coexists and serves traffic cleanly");

    // =========================================================================
    // Phase 10: Global Dashboard (`pegas status`) & Clean Teardown (`pegas down`)
    // =========================================================================
    logPhase(10, "Global Dashboard (`pegas status`) and Clean Teardown (`pegas down`)");

    const statusJsonRes = await execAsync("node", [BIN_PATH, "status", "--gateway-dir", gatewayDir, "--json"], {
      cwd: mainSandboxDir,
    });
    if (statusJsonRes.code !== 0) {
      throw new Error(`'pegas status --json' failed: ${statusJsonRes.stderr}`);
    }
    const statusData = JSON.parse(statusJsonRes.stdout);
    const dashboardItems = statusData.projects || (Array.isArray(statusData) ? statusData : []);
    if (!Array.isArray(dashboardItems) || dashboardItems.length < 3) {
      throw new Error(`Expected at least 3 active projects in dashboard, got: ${statusJsonRes.stdout}`);
    }
    logSuccess(`Dashboard reported ${dashboardItems.length} active projects with real-time health`);

    // Render terminal Unicode table
    const statusTableRes = await execAsync("node", [BIN_PATH, "status", "--gateway-dir", gatewayDir], {
      cwd: mainSandboxDir,
    });
    console.log(`\n${statusTableRes.stdout}\n`);
    logSuccess("Visual Unicode dashboard table verified");

    // Teardown projects
    await execAsync("node", [BIN_PATH, "down", "--gateway-dir", gatewayDir], { cwd: pAlphaDir });
    await execAsync("node", [BIN_PATH, "down", "--gateway-dir", gatewayDir], { cwd: pBetaDir });
    await execAsync("node", [BIN_PATH, "down", "--gateway-dir", gatewayDir], { cwd: pMultiDir });
    logSuccess("Executed 'pegas down' for all active projects");

    // Verify manual-legacy.caddy was NOT deleted
    try {
      await fs.access(manualLegacyPath);
      logSuccess("Verified manual legacy config was preserved after project teardowns");
    } catch {
      throw new Error("Manual legacy config was mistakenly deleted during teardown!");
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("\n" + bold("================================================================================"));
    console.log(bold(green(`  ✨ ALL UNIFIED E2E TEST PHASES PASSED SUCCESSFULLY IN ${duration}s`)));
    console.log(bold("================================================================================"));
  } finally {
    // Teardown containers and wipe sandboxes
    logPhase(11, "Cleanup and Environment Restoration");
    // v3: манифест compose эфемерный (stdin), `docker compose down` из каталога проекта —
    // no-op. Контейнеры чистятся по labels pegas.*; кэтч: deploy мог упасть на readiness
    // ДО записи маршрутов — `pegas down` для такого проекта уже не вызовешь. Гарантия:
    // удаляем по label=pegas.project=<runtimeId> для каждой песочницы прогона.
    const sandboxProjects: Array<[string, string]> = [
      [pAlphaDir, "project-alpha"],
      [pBetaDir, "project-beta"],
      [pMultiDir, "project-multi"],
      [pHijackDir, "project-hijack"],
      [pBrokenDir, "project-broken"],
    ];
    for (const [dir, name] of sandboxProjects) {
      if (!dir) continue;
      const runtimeId = createHash("sha256")
        .update(JSON.stringify({ projectRoot: path.resolve(dir), projectName: name }))
        .digest("hex")
        .slice(0, 10);
      const listed = (await execAsync("docker", [
        "ps", "-aq", "--filter", `label=pegas.project=${runtimeId}`,
      ])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (listed.length === 0) continue;
      const rmRes = await execAsync("docker", ["rm", "-f", ...listed]);
      if (rmRes.code !== 0 && rmRes.stderr) {
        logFail(`Cleanup warning (${name}): ${rmRes.stderr}`);
      }
    }
    // Страховка: не осталось ли pegas-контейнеров, созданных после старта прогона
    // (например, при изменении схемы имени/label). Чистим только свои — по времени создания.
    {
      const leftovers = (await execAsync("docker", [
        "ps", "-aq", "--filter", "label=pegas.project",
        "--format", "{{.ID}} {{.CreatedAt}}",
      ])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      const stale = leftovers
        .filter((line) => {
          const created = new Date(line.split(" ").slice(1).join(" "));
          return !Number.isNaN(created.getTime()) && created.getTime() >= runStartedAt;
        })
        .map((line) => line.split(" ")[0])
        .filter(Boolean);
      if (stale.length > 0) {
        await execAsync("docker", ["rm", "-f", ...stale]);
        logSuccess(`Swept ${stale.length} leftover pegas container(s) from this run`);
      }
    }
    if (gatewayDir) {
      await execAsync("docker", ["compose", "down", "-v"], { cwd: gatewayDir });
      logSuccess("Gateway Caddy container stopped and removed");
    }
    if (mainSandboxDir) {
      await fs.rm(mainSandboxDir, { recursive: true, force: true });
      logSuccess("All temporary sandboxes wiped clean from /tmp");
    }
  }
}

runUnifiedE2E().catch((err) => {
  console.error(`\n${bold(red("❌ UNIFIED E2E TEST RUN FAILED:"))}`);
  console.error(err);
  process.exit(1);
});
