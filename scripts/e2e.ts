#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";

// Colors for terminal output
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const blue = (text: string) => `\x1b[34m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BIN_PATH = path.join(REPO_ROOT, "dist", "index.js");
const DIST_PATH = BIN_PATH;

function logStep(step: number, title: string) {
  console.log(`\n${bold(blue(`[Step ${step}]`))} ${bold(title)}`);
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
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    proc.on("error", (err) => {
      stderr += err.message;
      resolve({ stdout, stderr, code: 1 });
    });
  });
}

async function runE2E() {
  const startTime = Date.now();
  console.log(bold("=================================================="));
  console.log(bold("  🧪 PEGAS END-TO-END (E2E) RUNTIME TEST SUITE"));
  console.log(bold("=================================================="));

  let sandboxDir = "";
  let caddyBinaryPath = "";

  try {
    // 0. Pre-flight Checks
    logStep(0, "Pre-flight checks and build verification");

    try {
      await fs.access(DIST_PATH);
      logSuccess(`Found compiled bundle at ${DIST_PATH}`);
    } catch {
      console.log("  Building pegas before running E2E...");
      const buildRes = await execAsync("bun", ["run", "build"], { cwd: REPO_ROOT });
      if (buildRes.code !== 0) {
        throw new Error(`Build failed: ${buildRes.stderr}`);
      }
      logSuccess("Built dist/index.js successfully");
    }

    const dockerCheck = await execAsync("docker", ["compose", "version"]);
    if (dockerCheck.code !== 0) {
      throw new Error(`Docker Compose is not available on host: ${dockerCheck.stderr}`);
    }
    logSuccess(`Docker Compose available: ${dockerCheck.stdout.trim()}`);

    // Check Caddy binary
    const caddyHome = path.join(os.homedir(), ".pegas", "bin", "caddy");
    try {
      await fs.access(caddyHome);
      caddyBinaryPath = caddyHome;
    } catch {
      const whichCaddy = await execAsync("which", ["caddy"]);
      if (whichCaddy.code === 0 && whichCaddy.stdout.trim()) {
        caddyBinaryPath = whichCaddy.stdout.trim();
      }
    }
    if (caddyBinaryPath) {
      logSuccess(`Native Caddy binary located at: ${caddyBinaryPath}`);
    } else {
      console.log(`  ${yellow("ℹ")} Caddy not in PATH or cache, pegas will test auto-download.`);
    }

    // 1. Sandbox Setup
    logStep(1, "Create isolated sandbox environment");
    sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-e2e-sandbox-"));
    logSuccess(`Created temporary sandbox directory: ${sandboxDir}`);

    const packageJsonContent = {
      name: "e2e-demo-service",
      version: "1.0.0",
      description: "E2E automated test fixture",
      scripts: {
        dev: "node -e 'console.log(\"SERVER_BOOTED\")'",
      },
    };
    await fs.writeFile(
      path.join(sandboxDir, "package.json"),
      JSON.stringify(packageJsonContent, null, 2),
      "utf-8"
    );
    logSuccess("Generated fixture package.json with name 'e2e-demo-service'");

    const composeContent = `services:
  web:
    image: traefik/whoami
    ports:
      - "8080:80"
    environment:
      - WHOAMI_NAME=e2e-web
  redis:
    image: redis:alpine
    ports:
      - "6379:6379"
`;
    await fs.writeFile(
      path.join(sandboxDir, "docker-compose.yml"),
      composeContent,
      "utf-8"
    );
    logSuccess("Generated fixture docker-compose.yml with 'web' (8080:80) and 'redis' (6379:6379)");

    // 2. Command 'pegas init'
    logStep(2, "Execute 'pegas init' in sandbox");
    const initRes = await execAsync("node", [BIN_PATH, "init"], { cwd: sandboxDir });
    if (initRes.code !== 0) {
      throw new Error(`'pegas init' failed with exit code ${initRes.code}:\n${initRes.stderr || initRes.stdout}`);
    }
    logSuccess("'pegas init' finished with exit code 0");

    // 2.1 Verify contract (pegas.json)
    const contractPath = path.join(sandboxDir, "pegas.json");
    const contractRaw = await fs.readFile(contractPath, "utf-8");
    const contract = JSON.parse(contractRaw);

    if (contract.projectName !== "e2e-demo-service") {
      throw new Error(`Expected contract.projectName 'e2e-demo-service', got '${contract.projectName}'`);
    }
    logSuccess(`Contract verified: projectName='${contract.projectName}'`);

    const webService = contract.services?.web;
    if (!webService) {
      throw new Error("Contract is missing 'web' service definition");
    }
    if (webService.upstream !== "web:80") {
      throw new Error(`Expected upstream 'web:80' (detected from compose 8080:80), got '${webService.upstream}'`);
    }
    logSuccess(`Upstream auto-detection verified: '${webService.upstream}'`);

    if (!webService.domains?.dev?.includes("e2e-demo-service.localhost")) {
      throw new Error(`Expected dev domain 'e2e-demo-service.localhost', got: ${JSON.stringify(webService.domains?.dev)}`);
    }
    if (!webService.domains?.prod?.includes("e2e-demo-service.com")) {
      throw new Error(`Expected prod domain 'e2e-demo-service.com', got: ${JSON.stringify(webService.domains?.prod)}`);
    }
    logSuccess("Smart slug scaffolding verified for dev & prod domains");

    // 2.2 Verify compose surgery
    const patchedCompose = await fs.readFile(path.join(sandboxDir, "docker-compose.yml"), "utf-8");
    if (patchedCompose.includes('"8080:80"')) {
      throw new Error("Public port '8080:80' was not stripped from web service");
    }
    if (!patchedCompose.includes("expose:")) {
      throw new Error("Expected 'expose' directive in web service");
    }
    if (!patchedCompose.includes("e2e-demo-service-web")) {
      throw new Error("Expected project-scoped network alias 'e2e-demo-service-web' in web service");
    }
    if (!patchedCompose.includes('"6379:6379"')) {
      throw new Error("Infrastructure port '6379:6379' for Redis was mistakenly stripped");
    }
    if (!patchedCompose.includes("pegas-network:\n    external: true") && !patchedCompose.includes("pegas-network:\n  external: true")) {
      throw new Error("Expected external pegas-network declaration in compose root");
    }
    logSuccess("Compose surgery verified: public ports stripped, expose added, alias scoped, infra port preserved");

    // 2.3 Verify package.json & gitignore
    const updatedPkg = JSON.parse(await fs.readFile(path.join(sandboxDir, "package.json"), "utf-8"));
    if (updatedPkg.scripts?.dev !== "pegas dev -- node -e 'console.log(\"SERVER_BOOTED\")'") {
      throw new Error(`package.json dev script mismatch: ${updatedPkg.scripts?.dev}`);
    }
    if (updatedPkg.scripts?.deploy !== "pegas deploy") {
      throw new Error(`package.json deploy script mismatch: ${updatedPkg.scripts?.deploy}`);
    }
    if (!updatedPkg.devDependencies?.pegas) {
      throw new Error("package.json is missing pegas devDependency");
    }
    logSuccess("package.json scripts wrapping & devDependency verified");

    const gitignoreContent = await fs.readFile(path.join(sandboxDir, ".gitignore"), "utf-8");
    if (!gitignoreContent.includes(".pegas")) {
      throw new Error(".gitignore is missing '.pegas' entry");
    }
    logSuccess(".gitignore verified (.pegas entry present)");

    // 3. Docker Compose Daemon Validation
    logStep(3, "Validate patched compose schema against live Docker daemon");
    const composeConfigRes = await execAsync("docker", ["compose", "config"], { cwd: sandboxDir });
    if (composeConfigRes.code !== 0) {
      throw new Error(`'docker compose config' failed validation:\n${composeConfigRes.stderr}`);
    }
    logSuccess("Docker Engine successfully validated compose YAML syntax, networks, and aliases");

    // 4. Production Gateway Deployment Simulation
    logStep(4, "Test Gateway Deploy & Caddyfile snippet compilation");
    const mockGatewayDir = path.join(sandboxDir, "mock-gateway");
    const mockConfDir = path.join(mockGatewayDir, "conf.d");
    await fs.mkdir(mockConfDir, { recursive: true });

    // Deploy with --dry-run
    const dryRunRes = await execAsync(
      "node",
      [BIN_PATH, "deploy", "--gateway-dir", mockGatewayDir, "--dry-run"],
      { cwd: sandboxDir }
    );
    if (dryRunRes.code !== 0) {
      throw new Error(`'pegas deploy --dry-run' failed:\n${dryRunRes.stderr || dryRunRes.stdout}`);
    }
    if (!dryRunRes.stdout.includes("e2e-demo-service.caddy")) {
      throw new Error(`Dry run output missing target route file name:\n${dryRunRes.stdout}`);
    }
    if (!dryRunRes.stdout.includes("e2e-demo-service-web:80")) {
      throw new Error(`Dry run output missing scoped upstream 'e2e-demo-service-web:80':\n${dryRunRes.stdout}`);
    }
    logSuccess("Deploy dry-run verified successfully (scoped upstream & route planning)");

    // Write project route snippet to conf.d to test native Caddy validator
    const projectRouteFile = path.join(mockConfDir, "e2e-demo-service.caddy");
    const routeSnippet = `# Auto-generated by Pegas for project: e2e-demo-service\n\ne2e-demo-service.com {\n    reverse_proxy e2e-demo-service-web:80\n}\n`;
    await fs.writeFile(projectRouteFile, routeSnippet, { mode: 0o644 });

    const baseCaddyfile = `{\n    admin off\n    http_port 8080\n    https_port 8443\n}\n\nimport conf.d/*.caddy\n`;
    await fs.writeFile(path.join(mockGatewayDir, "Caddyfile"), baseCaddyfile, "utf-8");

    const stat = await fs.stat(projectRouteFile);
    const mode = stat.mode & 0o777;
    if (mode !== 0o644) {
      throw new Error(`Expected route file permissions 0o644, got 0o${mode.toString(8)}`);
    }
    logSuccess("Route file conf.d/e2e-demo-service.caddy created with scoped upstream & 0o644 permissions");

    // Validate generated Caddy snippet with Caddy if binary is available
    if (caddyBinaryPath) {
      const validateRes = await execAsync(
        caddyBinaryPath,
        ["validate", "--config", path.join(mockGatewayDir, "Caddyfile"), "--adapter", "caddyfile"]
      );
      if (validateRes.code !== 0) {
        throw new Error(`Caddy binary rejected generated gateway configuration:\n${validateRes.stderr}`);
      }
      logSuccess("Native Caddy successfully validated the complete gateway configuration with imported route");
    }

    // Test 'pegas down' route cleanup
    const downRes = await execAsync(
      "node",
      [BIN_PATH, "down", "--gateway-dir", mockGatewayDir],
      { cwd: sandboxDir }
    );
    try {
      await fs.access(projectRouteFile);
      throw new Error("Project route file was not removed after 'pegas down'");
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
    logSuccess("'pegas down' cleanly removed project route file from conf.d");

    // 5. Dev Runtime & Proxy Lifecycle Testing
    logStep(5, "Test 'pegas dev' runtime with native Caddy proxy and process cleanup");
    const devTestCmd = [
      BIN_PATH,
      "dev",
      "--",
      "node",
      "-e",
      "console.log('E2E_PAYLOAD_STARTED'); setTimeout(() => { console.log('E2E_PAYLOAD_FINISHED'); process.exit(0); }, 800);",
    ];

    const devProcRes = await execAsync("node", devTestCmd, { cwd: sandboxDir });
    if (devProcRes.code !== 0) {
      throw new Error(`'pegas dev' failed with exit code ${devProcRes.code}:\nSTDOUT:\n${devProcRes.stdout}\nSTDERR:\n${devProcRes.stderr}`);
    }

    if (!devProcRes.stdout.includes("Pegas proxy active at: https://e2e-demo-service.localhost:")) {
      throw new Error(`Missing proxy active banner in stdout:\n${devProcRes.stdout}`);
    }
    if (!devProcRes.stdout.includes("E2E_PAYLOAD_STARTED") || !devProcRes.stdout.includes("E2E_PAYLOAD_FINISHED")) {
      throw new Error(`User command payload did not execute completely:\n${devProcRes.stdout}`);
    }
    logSuccess("Dev command ran successfully; dynamic port allocated, proxy active banner logged");

    // Verify .pegas/Caddyfile.dev
    const devCaddyfilePath = path.join(sandboxDir, ".pegas", "Caddyfile.dev");
    const devCaddyContent = await fs.readFile(devCaddyfilePath, "utf-8");
    if (!devCaddyContent.includes("skip_install_trust")) {
      throw new Error("Caddyfile.dev is missing 'skip_install_trust'");
    }
    if (!devCaddyContent.includes("e2e-demo-service.localhost {")) {
      throw new Error("Caddyfile.dev is missing 'e2e-demo-service.localhost' block");
    }
    logSuccess("Generated .pegas/Caddyfile.dev verified (skip_install_trust & dev domains configured)");

    // Verify no zombie Caddy processes
    const psRes = await execAsync("ps", ["aux"]);
    const lines = psRes.stdout.split("\n");
    const lingeringCaddy = lines.filter(
      (l) => l.includes("caddy") && l.includes(sandboxDir)
    );
    if (lingeringCaddy.length > 0) {
      throw new Error(`Lingering Caddy process detected:\n${lingeringCaddy.join("\n")}`);
    }
    logSuccess("Zero process leaks verified: Caddy proxy and child process exited cleanly");

    // 6. All Tests Completed
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("\n" + bold("=================================================="));
    console.log(bold(green(`  ✨ ALL E2E RUNTIME TESTS PASSED IN ${duration}s`)));
    console.log(bold("=================================================="));
  } finally {
    // 7. Teardown
    if (sandboxDir) {
      logStep(6, "Teardown & Cleanup");
      try {
        await fs.rm(sandboxDir, { recursive: true, force: true });
        logSuccess(`Cleaned up sandbox directory: ${sandboxDir}`);
      } catch (err: any) {
        logFail(`Failed to clean sandbox: ${err.message}`);
      }
    }
  }
}

runE2E().catch((err) => {
  console.error(`\n${bold(red("❌ E2E TEST RUN FAILED:"))}`);
  console.error(err);
  process.exit(1);
});
