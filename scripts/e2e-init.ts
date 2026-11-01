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
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BIN_PATH = path.join(REPO_ROOT, "dist", "index.js");
const REPORTS_DIR = path.join(REPO_ROOT, ".tmp", "reports");

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
 * Copies a local folder to a target directory, skipping heavy non-essential folders.
 */
async function copyDirClean(src: string, dest: string) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  const skipList = new Set([
    "node_modules",
    ".git",
    ".next",
    ".cache",
    ".tmp",
    ".turbo",
    "dist",
    "build",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
  ]);

  for (const entry of entries) {
    if (skipList.has(entry.name)) {
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirClean(srcPath, destPath);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function runE2EInit() {
  const args = process.argv.slice(2);
  let target = "";
  let branch = "";
  let keepSandbox = false;
  let showDiff = false;
  let useLocalBinary = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--branch" && i + 1 < args.length) {
      branch = args[++i];
    } else if (arg === "--keep") {
      keepSandbox = true;
    } else if (arg === "--diff") {
      showDiff = true;
    } else if (arg === "--local") {
      useLocalBinary = true;
    } else if (!arg.startsWith("-") && !target) {
      target = arg;
    }
  }

  if (!target) {
    console.error(`
${bold(red("Error: Target repository not specified."))}

${bold("USAGE:")}
  $ bun scripts/e2e-init.ts <local-path-or-git-url> [options]

${bold("OPTIONS:")}
  --branch <name>   Branch for remote Git repository
  --local           Execute local dist/index.js instead of pulling from NPM registry
  --diff            Show visual git diff of changes made by 'pegas init'
  --keep            Preserve the temporary sandbox directory after the test

${bold("EXAMPLES:")}
  $ bun scripts/e2e-init.ts /path/to/my-project
  $ bun scripts/e2e-init.ts /path/to/my-project --diff
  $ bun scripts/e2e-init.ts https://github.com/example/repo
`);
    process.exit(1);
  }

  const isRemote = target.startsWith("http://") || target.startsWith("https://") || target.startsWith("git@");
  const repoName = isRemote
    ? path.basename(target).replace(/\.git$/, "")
    : path.basename(path.resolve(target));

  console.log(bold("================================================================================"));
  console.log(bold(`  🧪 PEGAS REAL REPOSITORY 'INIT' COMPATIBILITY TEST: ${cyan(repoName)}`));
  console.log(bold("================================================================================"));
  console.log(`Target: ${target} ${isRemote ? `(Remote Git branch: ${branch || "default"})` : "(Local directory)"}`);
  console.log(`Execution Mode: ${useLocalBinary ? "Local Build (dist/index.js)" : "Public NPM Registry (npx @netrunner714/pegas)"}\n`);

  // Ensure fresh build of pegas if using local mode
  if (useLocalBinary) {
    try {
      await fs.access(BIN_PATH);
    } catch {
      console.log("Building pegas bundle before running test...");
      await execAsync("bun", ["run", "build"], { cwd: REPO_ROOT });
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const logFilePath = path.join(REPORTS_DIR, `e2e-init-${repoName}-${timestamp}.log`);
  const logEntries: string[] = [];

  const log = (msg: string) => {
    console.log(msg);
    logEntries.push(msg.replace(/\x1b\[[0-9;]*m/g, ""));
  };

  const logRaw = (msg: string) => {
    logEntries.push(msg);
  };

  logRaw(`--- PEGAS E2E-INIT RUN LOG ---`);
  logRaw(`Target: ${target}`);
  logRaw(`Date: ${new Date().toISOString()}`);
  logRaw(`Host: ${os.hostname()} (${os.platform()} ${os.arch()})`);
  logRaw(`Mode: ${useLocalBinary ? "Local Binary" : "NPM Registry (npx @netrunner714/pegas)"}\n`);

  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), `pegas-e2e-init-${repoName}-`));

  try {
    // =========================================================================
    // 1. Prepare Isolated Sandbox
    // =========================================================================
    if (isRemote) {
      log(`Cloning remote repository ${target}...`);
      const cloneArgs = ["clone", "--depth", "1"];
      if (branch) cloneArgs.push("--branch", branch);
      cloneArgs.push(target, sandboxDir);
      const cloneRes = await execAsync("git", cloneArgs);
      if (cloneRes.code !== 0) {
        throw new Error(`Git clone failed: ${cloneRes.stderr}`);
      }
      log(`  ${green("✔")} Repository cloned into sandbox`);
    } else {
      const resolvedSrc = path.resolve(target);
      log(`Mirroring local repository files from ${resolvedSrc}...`);
      await copyDirClean(resolvedSrc, sandboxDir);
      log(`  ${green("✔")} Local files mirrored to sandbox: ${cyan(sandboxDir)}`);
      log(`  ${dim("(Original repository is 100% untouched)")}`);

      // Initialize git inside sandbox so we can capture exact diff
      await execAsync("git", ["init"], { cwd: sandboxDir });
      await execAsync("git", ["config", "user.name", "Pegas Test Runner"], { cwd: sandboxDir });
      await execAsync("git", ["config", "user.email", "test@pegas.local"], { cwd: sandboxDir });
      await execAsync("git", ["add", "-A"], { cwd: sandboxDir });
      await execAsync("git", ["commit", "-m", "initial baseline", "--allow-empty"], { cwd: sandboxDir });
    }

    // =========================================================================
    // 2. Initial Repository Fingerprint
    // =========================================================================
    const initialFiles = await fs.readdir(sandboxDir);
    const initialHasPkg = initialFiles.includes("package.json");
    const initialComposeFile = initialFiles.find((f) => /^docker-compose\.ya?ml$/i.test(f) || /^compose\.ya?ml$/i.test(f));

    let initialPkgName = "";
    let initialScripts: string[] = [];
    if (initialHasPkg) {
      try {
        const rawPkg = JSON.parse(await fs.readFile(path.join(sandboxDir, "package.json"), "utf-8"));
        initialPkgName = rawPkg.name || "";
        initialScripts = Object.keys(rawPkg.scripts || {});
      } catch {}
    }

    logRaw(`\n--- INITIAL REPO FINGERPRINT ---`);
    logRaw(`Files in root: ${initialFiles.join(", ")}`);
    logRaw(`package.json present: ${initialHasPkg} (name: '${initialPkgName}')`);
    logRaw(`Initial scripts: ${initialScripts.join(", ")}`);
    logRaw(`Initial compose file: ${initialComposeFile || "none"}`);

    // =========================================================================
    // 3. Execute `pegas init`
    // =========================================================================
    log(`\n${bold(blue("Executing 'pegas init'..."))}`);

    let initRes: { stdout: string; stderr: string; code: number };
    if (useLocalBinary) {
      initRes = await execAsync("node", [BIN_PATH, "init"], { cwd: sandboxDir });
    } else {
      // Test real npm package pull: npx @netrunner714/pegas init
      log(`  ${cyan("ℹ")} Pulling and executing via: npx @netrunner714/pegas init...`);
      initRes = await execAsync("npx", ["--yes", "@netrunner714/pegas@latest", "init"], { cwd: sandboxDir });
    }

    logRaw(`\n--- PEGAS INIT STDOUT ---\n` + initRes.stdout);
    logRaw(`\n--- PEGAS INIT STDERR ---\n` + initRes.stderr);

    // =========================================================================
    // 4. Verification Checklist
    // =========================================================================
    log(`\n${bold("================================================================================")}`);
    log(bold("  📋 'INIT' VERIFICATION CHECKLIST"));
    log(bold("================================================================================"));

    let allChecksPassed = true;

    // Check 1: Command Execution / NPM pull
    if (initRes.code === 0) {
      log(`  ${green("✔")} 1. NPM Package Execution: Succeeded with exit code 0`);
    } else {
      log(`  ${red("✖")} 1. NPM Package Execution: Failed with exit code ${initRes.code}`);
      allChecksPassed = false;
    }

    // Check 2: docs/pegas.md
    let docsCreated = false;
    try {
      await fs.access(path.join(sandboxDir, "docs", "pegas.md"));
      docsCreated = true;
      log(`  ${green("✔")} 2. Agent Guidelines: Successfully generated 'docs/pegas.md'`);
    } catch {
      log(`  ${red("✖")} 2. Agent Guidelines: 'docs/pegas.md' was NOT created`);
      allChecksPassed = false;
    }

    // Check 3: pegas.json Contract
    let contractCreated = false;
    let contractDetails = "";
    try {
      const contractRaw = await fs.readFile(path.join(sandboxDir, "pegas.json"), "utf-8");
      const contract = JSON.parse(contractRaw);
      contractCreated = true;
      const sCount = Object.keys(contract.services || {}).length;
      contractDetails = `projectName='${contract.projectName}', ${sCount} service(s) configured`;
      log(`  ${green("✔")} 3. Declarative Contract: Scaffolded 'pegas.json' (${contractDetails})`);
    } catch (err: any) {
      log(`  ${red("✖")} 3. Declarative Contract: 'pegas.json' missing or invalid JSON: ${err.message}`);
      allChecksPassed = false;
    }

    // Check 4: package.json wrapping
    if (initialHasPkg) {
      try {
        const updatedPkg = JSON.parse(await fs.readFile(path.join(sandboxDir, "package.json"), "utf-8"));
        const hasDevDep = !!(updatedPkg.devDependencies?.["@netrunner714/pegas"] || updatedPkg.devDependencies?.pegas);
        const hasDeployScript =
          typeof updatedPkg.scripts?.deploy === "string" && updatedPkg.scripts.deploy.startsWith("pegas deploy");
        const hasDevWrapped = typeof updatedPkg.scripts?.dev === "string" && updatedPkg.scripts?.dev.startsWith("pegas dev");

        if (hasDevDep && hasDeployScript && hasDevWrapped) {
          log(`  ${green("✔")} 4. package.json Integration: dev script wrapped, deploy added, devDependency injected`);
        } else {
          const missingParts = [];
          if (!hasDevDep) missingParts.push("devDependencies");
          if (!hasDeployScript) missingParts.push("scripts.deploy");
          if (!hasDevWrapped) missingParts.push("scripts.dev wrapping");
          log(`  ${yellow("⚠️")}  4. package.json Integration: Incomplete (missing: ${missingParts.join(", ")})`);
          allChecksPassed = false;
        }
      } catch (err: any) {
        log(`  ${red("✖")} 4. package.json Integration: Error reading package.json: ${err.message}`);
        allChecksPassed = false;
      }
    } else {
      log(`  ${cyan("ℹ")} 4. package.json Integration: Skipped (no package.json in target repo)`);
    }

    // Check 5: .gitignore
    try {
      const gi = await fs.readFile(path.join(sandboxDir, ".gitignore"), "utf-8");
      if (gi.includes(".pegas")) {
        log(`  ${green("✔")} 5. VCS Protection: Added '.pegas' to .gitignore`);
      } else {
        log(`  ${yellow("⚠️")}  5. VCS Protection: '.pegas' missing from .gitignore`);
      }
    } catch {
      log(`  ${yellow("⚠️")}  5. VCS Protection: No .gitignore created`);
    }

    // Check 6: Docker Compose Surgery & Validation
    const afterFiles = await fs.readdir(sandboxDir);
    const afterCompose = afterFiles.find((f) => /^docker-compose\.ya?ml$/i.test(f) || /^compose\.ya?ml$/i.test(f));

    if (afterCompose) {
      const composeContent = await fs.readFile(path.join(sandboxDir, afterCompose), "utf-8");
      const hasPegasNet = composeContent.includes("pegas-network");
      const hasExpose = composeContent.includes("expose:");

      if (hasPegasNet) {
        log(`  ${green("✔")} 6. Compose Surgery: Configured network 'pegas-network' in ${afterCompose}`);
      } else {
        log(`  ${yellow("⚠️")}  6. Compose Surgery: 'pegas-network' not found in ${afterCompose}`);
        allChecksPassed = false;
      }

      // Live Docker daemon syntax validation (using --no-interpolate to tolerate required production env vars)
      let composeValRes = await execAsync("docker", ["compose", "config", "--no-interpolate"], { cwd: sandboxDir });
      if (composeValRes.code !== 0) {
        // Fallback without --no-interpolate in case of older compose versions
        composeValRes = await execAsync("docker", ["compose", "config"], { cwd: sandboxDir });
      }
      if (composeValRes.code === 0) {
        log(`  ${green("✔")} 7. Compose Syntax: 'docker compose config' validated 100% OK by Docker Engine`);
      } else {
        log(`  ${red("✖")} 7. Compose Syntax: 'docker compose config' failed validation: ${composeValRes.stderr}`);
        allChecksPassed = false;
      }
    } else {
      log(`  ${yellow("ℹ")} 6. Compose Surgery: No compose file created or present`);
    }

    // Git Diff
    const diffStat = await execAsync("git", ["diff", "--stat"], { cwd: sandboxDir });
    const fullDiff = await execAsync("git", ["diff"], { cwd: sandboxDir });
    logRaw(`\n--- GIT DIFF STAT ---\n` + diffStat.stdout);
    logRaw(`\n--- FULL GIT DIFF ---\n` + fullDiff.stdout);

    if (diffStat.stdout) {
      log(`\n${bold("Files Modified by Pegas:")}`);
      for (const line of diffStat.stdout.split("\n")) {
        log(`  ${dim(line)}`);
      }
    }

    if (showDiff && fullDiff.stdout) {
      console.log(`\n${bold("Visual Diff:")}\n${cyan(fullDiff.stdout)}`);
    }

    // Final Verdict
    log(`\n${bold("================================================================================")}`);
    if (allChecksPassed) {
      log(`  ${bold(green(`✨ VERDICT: PASSED (Pegas init is cleanly compatible with ${repoName})`))}`);
    } else {
      log(`  ${bold(yellow("⚠️  VERDICT: ISSUES FOUND (See details above and in diagnostic log)"))}`);
    }
    log(`================================================================================`);

    // Write full log file to .tmp/reports/
    await fs.writeFile(logFilePath, logEntries.join("\n"), "utf-8");
    log(`\n📄 Full diagnostic log saved to:\n   ${cyan(logFilePath)}\n`);
    if (!allChecksPassed) {
      process.exitCode = 1;
    }

  } finally {
    if (keepSandbox) {
      console.log(`ℹ️  Preserving sandbox directory as requested (--keep):\n   ${cyan(sandboxDir)}\n`);
    } else {
      await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

runE2EInit().catch((err) => {
  console.error(`\n${bold(red("❌ E2E-INIT RUNNER ERROR:"))}`);
  console.error(err);
  process.exit(1);
});
