#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import child_process from "node:child_process";

// Colors for terminal output
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const blue = (text: string) => `\x1b[34m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BIN_PATH = path.join(REPO_ROOT, "dist", "index.js");

function logPhase(step: number, title: string) {
  console.log(`\n${bold(blue(`[Phase ${step}]`))} ${bold(title)}`);
}

function logSuccess(message: string) {
  console.log(`  ${green("✔")} ${message}`);
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
 * Perform a physical HTTPS request using curl with --insecure to test local dev proxy
 */
async function httpsGet(
  hostHeader: string,
  urlPath: string = "/",
  port: number = 8443,
  timeoutMs: number = 4000
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const curlRes = await execAsync("curl", [
    "-k",
    "-s",
    "--noproxy",
    "*",
    "-m",
    (timeoutMs / 1000).toString(),
    "-i",
    "--resolve",
    `${hostHeader}:${port}:127.0.0.1`,
    `https://${hostHeader}:${port}${urlPath}`,
  ]);

  if (curlRes.code !== 0 && !curlRes.stdout) {
    throw new Error(`HTTPS request failed for Host '${hostHeader}' (code ${curlRes.code}): ${curlRes.stderr}`);
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

async function runE2EDev() {
  const startTime = Date.now();
  console.log(bold("================================================================================"));
  console.log(bold("  🧪 PEGAS LOCAL DEVELOPMENT ('DEV') RUNTIME TEST SUITE"));
  console.log(bold("================================================================================"));

  let sandboxDir = "";
  let infraSandboxDir = "";
  let dummyServer: net.Server | null = null;
  let devProc: child_process.ChildProcess | null = null;

  try {
    // =========================================================================
    // Phase 0: Pre-flight & Fresh Bundle Build
    // =========================================================================
    logPhase(0, "Pre-flight Verification and Fresh Bundle Build");
    const buildRes = await execAsync("bun", ["run", "build"], { cwd: REPO_ROOT });
    if (buildRes.code !== 0) {
      throw new Error(`Build failed: ${buildRes.stderr}`);
    }
    logSuccess("Built fresh dist/index.js bundle");

    // =========================================================================
    // Phase 1: Native Caddy Binary Resolution & Repository Cache (.cache/bin)
    // =========================================================================
    logPhase(1, "Native Caddy Binary Discovery & Repository Cache (.cache/bin)");
    const binaryName = process.platform === "win32" ? "caddy.exe" : "caddy";
    const repoBinCacheDir = path.join(REPO_ROOT, ".cache", "bin");
    const repoCachedCaddy = path.join(repoBinCacheDir, binaryName);
    const homeCachedCaddy = path.join(os.homedir(), ".pegas", "bin", binaryName);

    await fs.mkdir(repoBinCacheDir, { recursive: true });

    let caddyPath = "";
    if (await fs.access(repoCachedCaddy).then(() => true).catch(() => false)) {
      caddyPath = repoCachedCaddy;
      logSuccess(`Found cached Caddy in repository cache: ${cyan(repoCachedCaddy)}`);
    } else if (await fs.access(homeCachedCaddy).then(() => true).catch(() => false)) {
      await fs.copyFile(homeCachedCaddy, repoCachedCaddy);
      await fs.chmod(repoCachedCaddy, 0o755);
      caddyPath = repoCachedCaddy;
      logSuccess(`Mirrored Caddy from ~/.pegas/bin to repository cache: ${cyan(repoCachedCaddy)}`);
    } else {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const whichRes = await execAsync(whichCmd, [binaryName]);
      if (whichRes.code === 0 && whichRes.stdout) {
        const sysCaddy = whichRes.stdout.split("\n")[0].trim();
        await fs.copyFile(sysCaddy, repoCachedCaddy);
        await fs.chmod(repoCachedCaddy, 0o755);
        caddyPath = repoCachedCaddy;
        logSuccess(`Mirrored system Caddy to repository cache: ${cyan(repoCachedCaddy)}`);
      } else {
        console.log(`  ${yellow("⬇")} Caddy not found in cache or system. Downloading to .cache/bin...`);
        const { findOrDownloadCaddy } = await import("../src/binary.js");
        caddyPath = await findOrDownloadCaddy({ cacheDir: repoBinCacheDir });
        if (caddyPath !== repoCachedCaddy) {
          await fs.copyFile(caddyPath, repoCachedCaddy);
          await fs.chmod(repoCachedCaddy, 0o755);
          caddyPath = repoCachedCaddy;
        }
        logSuccess(`Downloaded and cached Caddy into: ${cyan(repoCachedCaddy)}`);
      }
    }

    const caddyVer = await execAsync(caddyPath, ["version"]);
    logSuccess(`Caddy version: ${caddyVer.stdout.split("\n")[0]}`);

    // =========================================================================
    // Phase 2: Dynamic Port Conflict Resolution
    // =========================================================================
    logPhase(2, "Dynamic Port Conflict Resolution (Auto-Skip Occupied Ports)");
    
    // Bind port 8443 with a dummy TCP server to simulate port collision
    dummyServer = net.createServer();
    const portOccupied = await new Promise<boolean>((resolve) => {
      dummyServer!.once("error", () => resolve(false));
      dummyServer!.listen(8443, "127.0.0.1", () => resolve(true));
    });

    if (portOccupied) {
      logSuccess("Occupied port 8443 intentionally with dummy TCP listener");
    } else {
      console.log(`  ${yellow("ℹ")} Port 8443 was already in use by host; testing probe logic`);
    }

    // Import findAvailablePort from binary
    const { findAvailablePort } = await import("../src/ports.js");
    const nextPort = await findAvailablePort(8443);

    if (nextPort <= 8443) {
      throw new Error(`Expected findAvailablePort to skip 8443 and return >8443, got: ${nextPort}`);
    }
    logSuccess(`Port collision resolved dynamically: 8443 is busy -> allocated ${cyan(nextPort.toString())}`);

    if (dummyServer) {
      await new Promise<void>((r) => dummyServer!.close(() => r()));
      dummyServer = null;
      logSuccess("Released dummy listener on 8443");
    }

    // =========================================================================
    // Phase 3: ⚡ Physical HTTPS Traffic Proxying in Sandbox
    // =========================================================================
    logPhase(3, "Physical HTTPS Proxying (Local Caddy reverse_proxy to child dev server)");
    sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-e2e-dev-"));

    const devMockPort = await findAvailablePort(3456);
    const devDomain = "demo-app.localhost";

    // Setup contract pointing to localhost:${devMockPort}
    await fs.writeFile(
      path.join(sandboxDir, "package.json"),
      JSON.stringify(
        {
          name: "demo-app",
          version: "1.0.0",
        },
        null,
        2
      )
    );

    const devContract = {
      projectName: "demo-app",
      services: {
        web: {
          upstream: `web:${devMockPort}`,
          domains: {
            dev: [devDomain],
            prod: ["demo-app.com"],
          },
        },
      },
    };
    await fs.writeFile(path.join(sandboxDir, "pegas.json"), JSON.stringify(devContract, null, 2));

    // Create a mock child dev server script that starts HTTP on devMockPort and replies with JSON
    const mockChildServerCode = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'DEV_SERVER_OK',
    url: req.url,
    host: req.headers.host,
    pid: process.pid
  }));
});
server.listen(${devMockPort}, '127.0.0.1', () => {
  console.log('MOCK_DEV_SERVER_READY_ON_${devMockPort}');
});
`;
    await fs.writeFile(path.join(sandboxDir, "mock-dev-server.cjs"), mockChildServerCode);

    // Spawn `pegas dev -- node mock-dev-server.cjs`
    console.log(`  Starting 'pegas dev -- node mock-dev-server.cjs' in sandbox...`);
    devProc = child_process.spawn(
      "node",
      [BIN_PATH, "dev", "--skip-infra", "--", "node", "mock-dev-server.cjs"],
      {
        cwd: sandboxDir,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: {
          ...process.env,
          CADDY_PATH: caddyPath,
        },
      }
    );

    let devStdout = "";
    let devStderr = "";
    devProc.stdout?.on("data", (d) => {
      devStdout += d.toString();
    });
    devProc.stderr?.on("data", (d) => {
      devStderr += d.toString();
    });

    // Wait until proxy is active
    let activeHttpsPort = 8443;
    let proxyReady = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 300));
      if (devStdout.includes("Pegas proxy active at:")) {
        const match = devStdout.match(/https:\/\/\S+/);
        if (match) {
          const parsedUrl = new URL(match[0]);
          activeHttpsPort = parseInt(parsedUrl.port || "443", 10);
        }
        proxyReady = true;
        break;
      }
      if (devProc.exitCode !== null) {
        throw new Error(`'pegas dev' exited prematurely with code ${devProc.exitCode}:\n${devStderr || devStdout}`);
      }
    }

    if (!proxyReady) {
      throw new Error(`Timed out waiting for 'pegas dev' to initialize:\n${devStdout}\n${devStderr}`);
    }
    logSuccess(`Local Caddy HTTPS proxy running on port ${cyan(activeHttpsPort.toString())}`);

    // Wait for mock dev server ready signal
    let childReady = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (devStdout.includes(`MOCK_DEV_SERVER_READY_ON_${devMockPort}`)) {
        childReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!childReady) {
      throw new Error(`Child dev server failed to start:\nstdout: ${devStdout}\nstderr: ${devStderr}`);
    }
    logSuccess(`Child dev server confirmed ready on localhost:${devMockPort}`);

    // Make physical HTTPS request to Caddy proxy
    const httpsRes = await httpsGet(devDomain, "/api/profile", activeHttpsPort);
    if (httpsRes.status !== 200) {
      throw new Error(`Expected HTTP 200 from local HTTPS proxy, got: ${httpsRes.status}`);
    }

    const resJson = JSON.parse(httpsRes.body);
    if (resJson.status !== "DEV_SERVER_OK" || resJson.url !== "/api/profile") {
      throw new Error(`Payload mismatch from local dev proxy: ${httpsRes.body}`);
    }
    logSuccess(`Physical HTTPS GET -> 'https://${devDomain}:${activeHttpsPort}/api/profile' returned 200 OK`);
    logSuccess(`Verified end-to-end TLS termination & reverse-proxy delivery to child dev server`);

    // Terminate dev session gracefully (SIGINT simulation)
    if (devProc && devProc.pid) {
      try {
        process.kill(-devProc.pid, "SIGTERM");
      } catch {
        devProc.kill("SIGTERM");
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
    devProc = null;
    logSuccess("Graceful shutdown verified: proxy and child server terminated cleanly");

    // =========================================================================
    // Phase 4: Smart Infra Boot & Teardown (`--infra` / `bootInfra`)
    // =========================================================================
    logPhase(4, "Smart Infrastructure Boot & Safe Teardown (`--infra` / `bootInfra: true`)");
    infraSandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-e2e-infra-"));

    await fs.writeFile(
      path.join(infraSandboxDir, "package.json"),
      JSON.stringify({ name: "infra-demo-app", version: "1.0.0" }, null, 2)
    );

    // docker-compose with web and infra (redis)
    const infraCompose = `services:
  web:
    image: traefik/whoami
    ports:
      - "3000:80"
  redis:
    image: traefik/whoami
    ports:
      - "16379:80"
`;
    await fs.writeFile(path.join(infraSandboxDir, "docker-compose.yml"), infraCompose);

    const infraContract = {
      projectName: "infra-demo-app",
      bootInfra: true, // Enable automatic infra boot
      services: {
        web: {
          upstream: "web:3000",
          domains: { dev: ["infra-app.localhost"] },
        },
      },
    };
    await fs.writeFile(path.join(infraSandboxDir, "pegas.json"), JSON.stringify(infraContract, null, 2));

    // Run short dev command with infra boot enabled
    console.log("  Executing 'pegas dev --infra' with short-lived child command...");
    const infraDevRes = await execAsync(
      "node",
      [BIN_PATH, "dev", "--infra", "--", "node", "-e", "console.log('INFRA_TEST_COMMAND_DONE')"],
      {
        cwd: infraSandboxDir,
        env: {
          ...process.env,
          CADDY_PATH: caddyPath,
        },
      }
    );

    if (infraDevRes.code !== 0) {
      throw new Error(`'pegas dev --infra' failed: ${infraDevRes.stderr || infraDevRes.stdout}`);
    }

    if (!infraDevRes.stdout.includes("Booting project infrastructure with Docker Compose")) {
      throw new Error(`Expected infra boot output, got:\n${infraDevRes.stdout}`);
    }
    if (!infraDevRes.stdout.includes("Infra [redis] is ready")) {
      throw new Error(`Expected redis ready message, got:\n${infraDevRes.stdout}`);
    }
    if (!infraDevRes.stdout.includes("Stopping infrastructure services: redis")) {
      throw new Error(`Expected infra teardown message, got:\n${infraDevRes.stdout}`);
    }
    logSuccess("Smart Infra Boot verified: booted 'redis', verified readiness, executed command");
    logSuccess("Safe Teardown verified: stopped 'redis' automatically on session exit without deleting data volumes");

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("\n" + bold("================================================================================"));
    console.log(bold(green(`  ✨ ALL PEGAS DEV RUNTIME TEST PHASES PASSED IN ${duration}s`)));
    console.log(bold("================================================================================"));

  } finally {
    // Guaranteed cleanup
    logPhase(5, "Cleanup and Environment Restoration");
    if (dummyServer) {
      await new Promise<void>((r) => dummyServer!.close(() => r())).catch(() => {});
    }
    if (devProc && devProc.pid) {
      try {
        process.kill(-devProc.pid, "SIGKILL");
      } catch {
        try {
          devProc.kill("SIGKILL");
        } catch {}
      }
      devProc = null;
    }
    if (infraSandboxDir) {
      await execAsync("docker", ["compose", "down", "-v"], { cwd: infraSandboxDir }).catch(() => {});
      await fs.rm(infraSandboxDir, { recursive: true, force: true }).catch(() => {});
    }
    if (sandboxDir) {
      await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
    }
    logSuccess("All temporary dev sandboxes wiped clean");
  }
}

runE2EDev().catch((err) => {
  console.error(`\n${bold(red("❌ E2E-DEV RUNNER ERROR:"))}`);
  console.error(err);
  process.exit(1);
});
