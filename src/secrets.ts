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

/**
 * Ensures that `.env.example` mirrors `contract.secrets`.
 * Creates or appends missing keys to `.env.example`.
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
  let existingKeys = new Set<string>();

  try {
    existingContent = await fs.readFile(examplePath, "utf-8");
    const parsed = parseEnvContent(existingContent);
    existingKeys = new Set(parsed.keys());
  } catch {
    // file does not exist yet
  }

  const missingFromExample = contract.secrets.filter((key) => !existingKeys.has(key));
  if (missingFromExample.length === 0) {
    return { updated: false, added: [] };
  }

  let newContent = existingContent;
  if (!newContent) {
    newContent = "# Pegas Contract Required Secrets\n";
  } else if (!newContent.endsWith("\n")) {
    newContent += "\n";
  }

  for (const key of missingFromExample) {
    newContent += `${key}=\n`;
  }

  await fs.writeFile(examplePath, newContent, "utf-8");
  return { updated: true, added: missingFromExample };
}

/**
 * Verifies that secrets in .env adhere to the contract or .env.example schema.
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
    warnings.push(`Undocumented secrets in ${envFileName} (not listed in ${source === "contract" ? "pegas.json" : ".env.example"}): ${extraKeys.join(", ")}`);
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

  if (result.missingKeys.length > 0) {
    lines.push(`   ❌ Missing (${result.missingKeys.length}): ${result.missingKeys.join(", ")}`);
  }
  if (result.emptyKeys.length > 0) {
    lines.push(`   ❌ Empty (${result.emptyKeys.length}): ${result.emptyKeys.join(", ")}`);
  }
  if (result.extraKeys.length > 0) {
    lines.push(`   ⚠️  Undocumented (${result.extraKeys.length}): ${result.extraKeys.join(", ")}`);
  }

  if (result.valid) {
    lines.push(`   ✨ All required secrets are verified and present.`);
  }

  return lines.join("\n");
}
