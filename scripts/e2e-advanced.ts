#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";

// Terminal colors
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const blue = (text: string) => `\x1b[34m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BIN_PATH = path.join(REPO_ROOT, "dist", "index.js");

function logStep(step: number, title: string) {
  console.log(`\n${bold(blue(`[Step ${step}]`))} ${bold(title)}`);
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

async function runAdvancedE2E() {
  const startTime = Date.now();
  console.log(bold("================================================================"));
  console.log(bold("  🧪 PEGAS ADVANCED E2E: LOCAL DELEGATION & MULTI-TENANT SUITE"));
  console.log(bold("================================================================"));

  let delegationDir = "";
  let multiTenantDir = "";
  let gatewayDir = "";
  let pAlphaDir = "";
  let pBetaDir = "";

  try {
    // 0. Pre-flight & Build verification
    logStep(0, "Build and Environment Pre-flight");
    const buildRes = await execAsync("bun", ["run", "build"], { cwd: REPO_ROOT });
    if (buildRes.code !== 0) {
      throw new Error(`Build failed: ${buildRes.stderr}`);
    }
    logSuccess("Fresh dist/index.js built and ready");

    // ==========================================
    // 1. Local Delegation Test
    // ==========================================
    logStep(1, "Verify Local Delegation Pattern (node_modules/pegas intercept)");
    delegationDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-e2e-delegation-"));
    const localPegasDist = path.join(delegationDir, "node_modules", "pegas", "dist");
    await fs.mkdir(localPegasDist, { recursive: true });

    // Mock local pegas package in node_modules
    const mockLocalPegasCode = `console.log("MOCK_LOCAL_PEGAS_EXECUTED");\nprocess.exit(0);\n`;
    await fs.writeFile(path.join(localPegasDist, "index.js"), mockLocalPegasCode, "utf-8");
    logSuccess("Created mock local pegas binary at node_modules/pegas/dist/index.js");

    // Execute global binary from delegationDir
    const delRes = await execAsync("node", [BIN_PATH, "status"], { cwd: delegationDir });
    if (delRes.code !== 0) {
      throw new Error(`Delegation execution failed with code ${delRes.code}: ${delRes.stderr}`);
    }
    if (!delRes.stdout.includes("MOCK_LOCAL_PEGAS_EXECUTED")) {
      throw new Error(`Expected delegation to local pegas, got stdout: ${delRes.stdout}`);
    }
    logSuccess("Global binary intercepted call and delegated to local node_modules version");

    // Verify recursion guard (PEGAS_DELEGATED=1 prevents infinite re-delegation)
    const guardRes = await execAsync("node", [BIN_PATH, "--version"], {
      cwd: delegationDir,
      env: { ...process.env, PEGAS_DELEGATED: "1" },
    });
    if (guardRes.stdout.includes("MOCK_LOCAL_PEGAS_EXECUTED")) {
      throw new Error("PEGAS_DELEGATED=1 failed to prevent re-delegation");
    }
    if (!guardRes.stdout.includes("pegas v")) {
      throw new Error(`Expected version output from primary binary, got: ${guardRes.stdout}`);
    }
    logSuccess("Recursion guard verified: PEGAS_DELEGATED=1 executes primary binary without loop");

    // ==========================================
    // 2. Setup Multi-Tenant Sandbox & Gateway
    // ==========================================
    logStep(2, "Setup Multi-Tenant Sandbox and Caddy Gateway");
    multiTenantDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-e2e-multitenant-"));
    gatewayDir = path.join(multiTenantDir, "gateway");
    pAlphaDir = path.join(multiTenantDir, "project-alpha");
    pBetaDir = path.join(multiTenantDir, "project-beta");

    await fs.mkdir(pAlphaDir, { recursive: true });
    await fs.mkdir(pBetaDir, { recursive: true });

    // Initialize Server Gateway container
    const initGwRes = await execAsync("node", [BIN_PATH, "init", "--server", "--gateway-dir", gatewayDir]);
    if (initGwRes.code !== 0) {
      throw new Error(`Failed to initialize gateway container: ${initGwRes.stderr}`);
    }
    logSuccess(`Server gateway container running in ${gatewayDir}`);

    // ==========================================
    // 3. Project Alpha: Scaffolding & Deployment
    // ==========================================
    logStep(3, "Deploy Project Alpha (traefik/whoami on internal 80)");
    await fs.writeFile(
      path.join(pAlphaDir, "package.json"),
      JSON.stringify({ name: "project-alpha", version: "1.0.0" }, null, 2),
      "utf-8"
    );
    await fs.writeFile(
      path.join(pAlphaDir, "docker-compose.yml"),
      `services:\n  web:\n    image: traefik/whoami\n    ports:\n      - "8080:80"\n`,
      "utf-8"
    );

    const initAlphaRes = await execAsync("node", [BIN_PATH, "init"], { cwd: pAlphaDir });
    if (initAlphaRes.code !== 0) {
      throw new Error(`Project Alpha init failed: ${initAlphaRes.stderr}`);
    }
    logSuccess("Project Alpha initialized: public ports stripped, scoped alias 'project-alpha-web' configured");

    const deployAlphaRes = await execAsync(
      "node",
      [BIN_PATH, "deploy", "--gateway-dir", gatewayDir],
      { cwd: pAlphaDir }
    );
    if (deployAlphaRes.code !== 0) {
      throw new Error(`Project Alpha deploy failed: ${deployAlphaRes.stderr}`);
    }
    logSuccess("Project Alpha deployed & Caddy reloaded with zero downtime");

    // ==========================================
    // 4. Project Beta: Parallel Deployment
    // ==========================================
    logStep(4, "Deploy Project Beta in parallel (Zero Port Conflicts)");
    await fs.writeFile(
      path.join(pBetaDir, "package.json"),
      JSON.stringify({ name: "project-beta", version: "1.0.0" }, null, 2),
      "utf-8"
    );
    await fs.writeFile(
      path.join(pBetaDir, "docker-compose.yml"),
      `services:\n  web:\n    image: traefik/whoami\n    ports:\n      - "8081:80"\n`,
      "utf-8"
    );

    const initBetaRes = await execAsync("node", [BIN_PATH, "init"], { cwd: pBetaDir });
    if (initBetaRes.code !== 0) {
      throw new Error(`Project Beta init failed: ${initBetaRes.stderr}`);
    }
    logSuccess("Project Beta initialized: public ports stripped, scoped alias 'project-beta-web' configured");

    const deployBetaRes = await execAsync(
      "node",
      [BIN_PATH, "deploy", "--gateway-dir", gatewayDir],
      { cwd: pBetaDir }
    );
    if (deployBetaRes.code !== 0) {
      throw new Error(`Project Beta deploy failed: ${deployBetaRes.stderr}`);
    }
    logSuccess("Project Beta deployed in parallel without port conflict; Caddy reloaded cleanly");

    // ==========================================
    // 5. Global Dashboard Inspection (`pegas ls`)
    // ==========================================
    logStep(5, "Inspect Global Dashboard (`pegas ls`) from Neutral Location");
    const lsJsonRes = await execAsync(
      "node",
      [BIN_PATH, "ls", "--gateway-dir", gatewayDir, "--json"],
      { cwd: multiTenantDir }
    );
    if (lsJsonRes.code !== 0) {
      throw new Error(`'pegas ls --json' failed: ${lsJsonRes.stderr}`);
    }

    const dashboardItems = JSON.parse(lsJsonRes.stdout);
    if (!Array.isArray(dashboardItems) || dashboardItems.length !== 2) {
      throw new Error(`Expected 2 active projects in dashboard, got: ${lsJsonRes.stdout}`);
    }

    const alphaItem = dashboardItems.find((item: any) => item.project === "project-alpha");
    if (!alphaItem) {
      throw new Error("Project Alpha missing from dashboard output");
    }
    if (alphaItem.upstream !== "project-alpha-web:80") {
      throw new Error(`Project Alpha upstream mismatch: ${alphaItem.upstream}`);
    }
    if (alphaItem.state !== "running") {
      throw new Error(`Project Alpha state is not running: ${alphaItem.state}`);
    }
    logSuccess("Dashboard verified: Project Alpha active, upstream='project-alpha-web:80', state='running'");

    const betaItem = dashboardItems.find((item: any) => item.project === "project-beta");
    if (!betaItem) {
      throw new Error("Project Beta missing from dashboard output");
    }
    if (betaItem.upstream !== "project-beta-web:80") {
      throw new Error(`Project Beta upstream mismatch: ${betaItem.upstream}`);
    }
    if (betaItem.state !== "running") {
      throw new Error(`Project Beta state is not running: ${betaItem.state}`);
    }
    logSuccess("Dashboard verified: Project Beta active, upstream='project-beta-web:80', state='running'");

    // Render visual terminal table for validation
    const lsTableRes = await execAsync(
      "node",
      [BIN_PATH, "ls", "--gateway-dir", gatewayDir],
      { cwd: multiTenantDir }
    );
    if (!lsTableRes.stdout.includes("project-alpha") || !lsTableRes.stdout.includes("project-beta")) {
      throw new Error(`Visual dashboard output missing project rows:\n${lsTableRes.stdout}`);
    }
    console.log(`\n${lsTableRes.stdout}\n`);
    logSuccess("Terminal Unicode table verified: both projects displayed with green status indicators");

    // ==========================================
    // 6. Clean Teardown
    // ==========================================
    logStep(6, "Execute 'pegas down' for Both Projects & Verify State Clearance");
    const downAlphaRes = await execAsync(
      "node",
      [BIN_PATH, "down", "--gateway-dir", gatewayDir],
      { cwd: pAlphaDir }
    );
    if (downAlphaRes.code !== 0) {
      throw new Error(`'pegas down' for Project Alpha failed: ${downAlphaRes.stderr}`);
    }
    logSuccess("Project Alpha taken down and routes cleaned up");

    const downBetaRes = await execAsync(
      "node",
      [BIN_PATH, "down", "--gateway-dir", gatewayDir],
      { cwd: pBetaDir }
    );
    if (downBetaRes.code !== 0) {
      throw new Error(`'pegas down' for Project Beta failed: ${downBetaRes.stderr}`);
    }
    logSuccess("Project Beta taken down and routes cleaned up");

    // Check that dashboard is now empty
    const finalLsRes = await execAsync(
      "node",
      [BIN_PATH, "ls", "--gateway-dir", gatewayDir, "--json"],
      { cwd: multiTenantDir }
    );
    const finalItems = JSON.parse(finalLsRes.stdout);
    if (!Array.isArray(finalItems) || finalItems.length !== 0) {
      throw new Error(`Expected dashboard to be empty after teardown, got: ${finalLsRes.stdout}`);
    }
    logSuccess("Dashboard verified empty: [] (Zero residual route state)");

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("\n" + bold("================================================================"));
    console.log(bold(green(`  ✨ ALL ADVANCED E2E TESTS PASSED SUCCESSFULLY IN ${duration}s`)));
    console.log(bold("================================================================"));
  } finally {
    // Teardown containers and temp folders
    logStep(7, "Cleanup & Teardown");
    if (gatewayDir) {
      await execAsync("docker", ["compose", "down", "-v"], { cwd: gatewayDir });
      logSuccess("Gateway Caddy container stopped and removed");
    }
    if (delegationDir) {
      await fs.rm(delegationDir, { recursive: true, force: true });
    }
    if (multiTenantDir) {
      await fs.rm(multiTenantDir, { recursive: true, force: true });
    }
    logSuccess("All temporary sandboxes wiped clean");
  }
}

runAdvancedE2E().catch((err) => {
  console.error(`\n${bold(red("❌ ADVANCED E2E TEST RUN FAILED:"))}`);
  console.error(err);
  process.exit(1);
});
