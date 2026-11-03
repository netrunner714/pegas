import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import type { PegasContract } from "./types.js";

export interface SecretsCheckResult {
  valid: boolean;
  envFile: string;
  envExists: boolean;
  isGitIgnored: boolean;
  expectedSecrets: string[];
  source: "contract" | "example" | "none";
  missingKeys: string[];
  emptyKeys: string[];
  extraKeys: string[];
  loadedKeys: string[];
  exampleExists: boolean;
  missingInExample: string[];
  extraInExample: string[];
  extraEnvFiles: string[];
  warnings: string[];
  errors: string[];
}

/**
 * Parses raw .env file content into a key-value Map.
 * Strips comments, empty lines, 'export ' prefix, and surrounding quotes.
 */
export function parseEnvContent(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sanitized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIdx = sanitized.indexOf("=");
    if (equalsIdx === -1) {
      const key = sanitized.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        map.set(key, "");
      }
      continue;
    }

    const key = sanitized.slice(0, equalsIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = sanitized.slice(equalsIdx + 1).trim();

    // Strip inline comments if value is not quoted
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const commentIdx = value.indexOf(" #");
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim();
      }
    }

    map.set(key, value);
  }

  return map;
}

/**
 * Retrieves the list of expected secret keys for a project.
 * Priority:
 * 1. contract.secrets (authoritative declaration in pegas.json)
 * 2. .env.example (fallback schema file in project root)
 * 3. none (no secrets declared)
 */
export async function getExpectedSecrets(
  projectRoot: string,
  contract?: PegasContract
): Promise<{ secrets: string[]; source: "contract" | "example" | "none" }> {
  if (contract?.secrets && Array.isArray(contract.secrets) && contract.secrets.length > 0) {
    const valid = contract.secrets
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
    return { secrets: Array.from(new Set(valid)), source: "contract" };
  }

  const examplePath = path.join(projectRoot, ".env.example");
  try {
    const content = await fs.readFile(examplePath, "utf-8");
    const parsed = parseEnvContent(content);
    const keys = Array.from(parsed.keys());
    if (keys.length > 0) {
      return { secrets: keys, source: "example" };
    }
  } catch {
    // .env.example does not exist or cannot be read
  }

  return { secrets: [], source: "none" };
}

/**
 * Checks whether a given path or filename is ignored by git in projectRoot.
 * Uses `git check-ignore` first; if not in git repository, checks `.gitignore` manually.
 */
export function isIgnoredByGit(projectRoot: string, relativePath: string): boolean {
  try {
    childProcess.execFileSync("git", ["check-ignore", "-q", "--", relativePath], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    return true;
  } catch (error: any) {
    if (error?.status === 0) return true;
    if (error?.status === 1) return false;
    // Status 128: not a git repo, git command not found, or directory outside repo.
    // Fall back to reading .gitignore manually.
    const gitignorePath = path.join(projectRoot, ".gitignore");
    try {
      const content = fsSync.readFileSync(gitignorePath, "utf-8");
      const baseName = path.basename(relativePath);
      const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      return lines.some((pattern) => {
        const cleanPattern = pattern.replace(/^\//, "").replace(/\/$/, "");
        return cleanPattern === baseName || cleanPattern === relativePath || baseName.startsWith(cleanPattern.replace(/\*$/, ""));
      });
    } catch {
      return false;
    }
  }
}

const IGNORED_SCAN_DIRS = new Set([
  "node_modules",
  ".git",
  ".pegas",
  ".turbo",
  ".next",
  "dist",
  "build",
  ".cache",
  "vendor",
]);

/**
 * Recursively scans project directory for rogue env files.
 * Pegas strictly permits ONLY a single root .env and root .env.example.
 */
export async function findExtraneousEnvFiles(projectRoot: string): Promise<string[]> {
  const extraFiles: string[] = [];

  async function walk(dir: string) {
    let entries: fsSync.Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_SCAN_DIRS.has(entry.name)) {
          await walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(projectRoot, fullPath).replace(/\\/g, "/");

        const isRootEnv = relPath === ".env";
        const isRootExample = relPath === ".env.example";
        const isEnvName = entry.name.startsWith(".env") || entry.name.endsWith(".env") || /\.env\./.test(entry.name);

        if (isEnvName && !isRootEnv && !isRootExample) {
          extraFiles.push(relPath);
        }
      }
    }
  }

  await walk(projectRoot);
  return extraFiles;
}

/**
 * Ensures that `.env.example` strictly mirrors `contract.secrets` 1:1.
 */
export async function syncEnvExample(
  projectRoot: string,
  contract: PegasContract
): Promise<{ updated: boolean; added: string[] }> {
  if (!contract.secrets || !Array.isArray(contract.secrets) || contract.secrets.length === 0) {
    return { updated: false, added: [] };
  }

  const examplePath = path.join(projectRoot, ".env.example");
  let existingContent = "";

  try {
    existingContent = await fs.readFile(examplePath, "utf-8");
  } catch {
    // file does not exist yet
  }

  const parsed = parseEnvContent(existingContent);
  const existingKeys = new Set(parsed.keys());
  const contractSet = new Set(contract.secrets);

  const missingFromExample = contract.secrets.filter((key) => !existingKeys.has(key));
  const extraInExample = Array.from(existingKeys).filter((key) => !contractSet.has(key));

  if (missingFromExample.length === 0 && extraInExample.length === 0) {
    return { updated: false, added: [] };
  }

  const lines = [
    "# Pegas Required Secrets (strictly mirrors pegas.json secrets)",
    ...contract.secrets.map((sec) => `${sec}=`),
    "",
  ];

  await fs.writeFile(examplePath, lines.join("\n"), "utf-8");
  return { updated: true, added: missingFromExample };
}

/**
 * Verifies that secrets in .env adhere to the contract or .env.example schema with strict 1:1 parity.
 */
export async function verifySecrets(
  projectRoot: string,
  contract?: PegasContract,
  options?: { envFile?: string }
): Promise<SecretsCheckResult> {
  const envFileName = options?.envFile || ".env";
  const resolvedEnv = path.resolve(projectRoot, envFileName);
  const relativeEnv = path.relative(projectRoot, resolvedEnv);

  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Detect extraneous env files across the repository tree
  const extraEnvFiles = await findExtraneousEnvFiles(projectRoot);
  if (extraEnvFiles.length > 0) {
    errors.push(
      `Extraneous env file(s) detected: ${extraEnvFiles.join(", ")}. Pegas strictly permits ONLY a single root .env and root .env.example. Multiple env files or environment-suffixed variants (.env.development, etc.) are prohibited.`
    );
  }

  let envExists = false;
  let parsedEnv = new Map<string, string>();

  try {
    const rawContent = await fs.readFile(resolvedEnv, "utf-8");
    envExists = true;
    parsedEnv = parseEnvContent(rawContent);
  } catch {
    envExists = false;
  }

  const isGitIgnored = isIgnoredByGit(projectRoot, relativeEnv || envFileName);
  const { secrets: expectedSecrets, source } = await getExpectedSecrets(projectRoot, contract);

  const loadedKeys = Array.from(parsedEnv.keys());
  const missingKeys: string[] = [];
  const emptyKeys: string[] = [];
  const extraKeys: string[] = [];

  let exampleExists = false;
  const missingInExample: string[] = [];
  const extraInExample: string[] = [];

  // 2. Validate .env.example parity if contract declares secrets
  if (contract?.secrets && Array.isArray(contract.secrets) && contract.secrets.length > 0) {
    const examplePath = path.join(projectRoot, ".env.example");
    try {
      const exampleContent = await fs.readFile(examplePath, "utf-8");
      exampleExists = true;
      const exampleParsed = parseEnvContent(exampleContent);
      const exampleKeySet = new Set(exampleParsed.keys());
      const contractSet = new Set(expectedSecrets);

      for (const sec of expectedSecrets) {
        if (!exampleKeySet.has(sec)) missingInExample.push(sec);
      }
      for (const eKey of exampleKeySet) {
        if (!contractSet.has(eKey)) extraInExample.push(eKey);
      }
    } catch {
      exampleExists = false;
    }

    if (!exampleExists) {
      errors.push("Missing root .env.example file. Root .env.example is required and must strictly mirror pegas.json secrets.");
    }
    if (missingInExample.length > 0) {
      errors.push(`Missing secrets in .env.example: ${missingInExample.join(", ")}`);
    }
    if (extraInExample.length > 0) {
      errors.push(`Undocumented variables in .env.example (not in pegas.json secrets): ${extraInExample.join(", ")}`);
    }
  }

  // 3. Validate .env parity with expectedSecrets
  if (expectedSecrets.length > 0) {
    for (const key of expectedSecrets) {
      if (!parsedEnv.has(key)) {
        missingKeys.push(key);
      } else {
        const val = parsedEnv.get(key) ?? "";
        if (val.trim() === "") {
          emptyKeys.push(key);
        }
      }
    }
  }

  if (source !== "none") {
    const expectedSet = new Set(expectedSecrets);
    for (const key of loadedKeys) {
      if (!expectedSet.has(key)) {
        extraKeys.push(key);
      }
    }
  }

  if (!envExists && expectedSecrets.length > 0) {
    errors.push(`Secret file "${envFileName}" not found. Required by ${source === "contract" ? "pegas.json (secrets)" : ".env.example"}.`);
  }

  if (envExists && !isGitIgnored) {
    errors.push(`Security risk: "${envFileName}" is NOT gitignored! Secrets must never be committed to Git.`);
  }

  if (missingKeys.length > 0) {
    errors.push(`Missing required secrets in ${envFileName}: ${missingKeys.join(", ")}`);
  }

  if (emptyKeys.length > 0) {
    errors.push(`Empty secret values in ${envFileName}: ${emptyKeys.join(", ")}`);
  }

  if (extraKeys.length > 0) {
    errors.push(`Undocumented secrets in ${envFileName} (not listed in ${source === "contract" ? "pegas.json secrets" : ".env.example"}): ${extraKeys.join(", ")}. Strict 1:1 match with secrets is required.`);
  }

  const valid = errors.length === 0;

  return {
    valid,
    envFile: envFileName,
    envExists,
    isGitIgnored,
    expectedSecrets,
    source,
    missingKeys,
    emptyKeys,
    extraKeys,
    loadedKeys,
    exampleExists,
    missingInExample,
    extraInExample,
    extraEnvFiles,
    warnings,
    errors,
  };
}

/**
 * Formats check diagnostics for user-facing terminal logs.
 */
export function formatSecretsDiagnostic(result: SecretsCheckResult): string {
  const lines: string[] = [];

  if (result.source === "none") {
    lines.push(`ℹ️  No secrets contract declared (neither "secrets" in pegas.json nor .env.example found).`);
    return lines.join("\n");
  }

  lines.push(`🔑 Secrets Schema (${result.source === "contract" ? "pegas.json contract" : ".env.example"}):`);
  lines.push(`   Expected: ${result.expectedSecrets.length} variable(s)`);

  if (!result.envExists) {
    lines.push(`   ❌ ${result.envFile} is missing`);
  } else {
    lines.push(`   ✔ ${result.envFile} exists`);
    if (result.isGitIgnored) {
      lines.push(`   ✔ ${result.envFile} is protected by .gitignore`);
    } else {
      lines.push(`   ❌ ${result.envFile} is NOT gitignored!`);
    }
  }

  if (result.extraEnvFiles && result.extraEnvFiles.length > 0) {
    lines.push(`   ❌ Extraneous env file(s) (${result.extraEnvFiles.length}): ${result.extraEnvFiles.join(", ")}`);
  }

  if (result.missingKeys.length > 0) {
    lines.push(`   ❌ Missing in ${result.envFile} (${result.missingKeys.length}): ${result.missingKeys.join(", ")}`);
  }
  if (result.emptyKeys.length > 0) {
    lines.push(`   ❌ Empty in ${result.envFile} (${result.emptyKeys.length}): ${result.emptyKeys.join(", ")}`);
  }
  if (result.extraKeys.length > 0) {
    lines.push(`   ❌ Extra in ${result.envFile} (${result.extraKeys.length}): ${result.extraKeys.join(", ")}`);
  }

  if (result.missingInExample && result.missingInExample.length > 0) {
    lines.push(`   ❌ Missing in .env.example (${result.missingInExample.length}): ${result.missingInExample.join(", ")}`);
  }
  if (result.extraInExample && result.extraInExample.length > 0) {
    lines.push(`   ❌ Extra in .env.example (${result.extraInExample.length}): ${result.extraInExample.join(", ")}`);
  }

  if (result.valid) {
    lines.push(`   ✨ Strict 1:1 secrets parity verified across contract, .env, and .env.example.`);
  }

  return lines.join("\n");
}
