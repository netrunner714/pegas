import fs from "node:fs/promises";
import path from "node:path";
import { validatePegasContract, type ContractValidationIssue } from "../contract.js";
import { verifySecrets, formatSecretsDiagnostic, syncEnvExample, isIgnoredByGit } from "../secrets.js";
import { setupGitignore } from "./init.js";
import type { CheckOptions, PegasContract } from "../types.js";

export interface RepoAuditResult {
  valid: boolean;
  hasErrors: boolean;
  hasWarnings: boolean;
  projectRoot: string;
  contractExists: boolean;
  contractIssues: ContractValidationIssue[];
  contract?: PegasContract;
  secretsCheck?: import("../secrets.js").SecretsCheckResult;
  gitignoreIssues: string[];
  legacyFiles: { path: string; reason: string; severity: "warn" | "info" }[];
  fixesApplied: string[];
  errors: string[];
  warnings: string[];
}

const LEGACY_PATTERNS: { pattern: RegExp; reason: string; severity: "warn" | "info" }[] = [
  {
    pattern: /^(docker-compose(\.[a-zA-Z0-9_-]+)?\.ya?ml|compose(\.[a-zA-Z0-9_-]+)?\.ya?ml)$/,
    reason: "Redundant Compose file. Pegas Docker runtime orchestrates containers directly from pegas.json.",
    severity: "warn",
  },
  {
    pattern: /^Caddyfile(\.[a-zA-Z0-9_-]+)?$/,
    reason: "Redundant in-project Caddyfile. Pegas Gateway routes domains and path prefixes (routes) automatically.",
    severity: "warn",
  },
  {
    pattern: /^nginx(\.[a-zA-Z0-9_-]+)?\.conf$/,
    reason: "Redundant in-project Nginx config. Pegas Gateway handles reverse proxying and SSL at L7.",
    severity: "warn",
  },
  {
    pattern: /^\.env\.(production|prod|stage|staging|development|dev|test|local)$/,
    reason: "Multi-environment .env proliferation. Put non-secret configs into pegas.json env profiles, keep secrets in a single root .env.",
    severity: "warn",
  },
];

export async function auditRepository(
  cwd = process.cwd(),
  options?: { envFile?: string; fix?: boolean }
): Promise<RepoAuditResult> {
  const projectRoot = path.resolve(cwd);
  const errors: string[] = [];
  const warnings: string[] = [];
  const gitignoreIssues: string[] = [];
  const legacyFiles: { path: string; reason: string; severity: "warn" | "info" }[] = [];
  const fixesApplied: string[] = [];

  // Automated repair mode (--fix)
  if (options?.fix) {
    if (!isIgnoredByGit(projectRoot, ".pegas") || !isIgnoredByGit(projectRoot, ".env")) {
      const gitignoreFix = await setupGitignore(projectRoot);
      if (gitignoreFix) {
        fixesApplied.push(gitignoreFix);
      }
    }
  }

  // 1. Contract existence and validation
  const contractPath = path.join(projectRoot, "pegas.json");
  let contractExists = false;
  let contract: PegasContract | undefined;
  let contractIssues: ContractValidationIssue[] = [];

  try {
    const raw = await fs.readFile(contractPath, "utf-8");
    contractExists = true;
    try {
      const parsed = JSON.parse(raw);
      contract = parsed;
      contractIssues = validatePegasContract(parsed);
      for (const issue of contractIssues) {
        errors.push(`Contract issue at "${issue.path}": ${issue.message}`);
      }
    } catch (parseErr: any) {
      errors.push(`Failed to parse pegas.json: ${parseErr.message}`);
    }
  } catch {
    contractExists = false;
    errors.push("pegas.json contract file does not exist. Run 'pegas init' to create one.");
  }

  // If fix is requested and contract exists, sync .env.example and create starter .env if missing
  if (options?.fix && contract) {
    if (contract.secrets && Array.isArray(contract.secrets) && contract.secrets.length > 0) {
      const syncRes = await syncEnvExample(projectRoot, contract);
      if (syncRes.updated) {
        fixesApplied.push(`Синхронизирован .env.example с contract.secrets (${syncRes.added.join(", ")})`);
      }
    }

    const envFileName = options?.envFile || ".env";
    const envPath = path.join(projectRoot, envFileName);
    const examplePath = path.join(projectRoot, ".env.example");
    let hasEnv = false;
    try {
      await fs.access(envPath);
      hasEnv = true;
    } catch {}

    if (!hasEnv) {
      let hasExample = false;
      try {
        await fs.access(examplePath);
        hasExample = true;
      } catch {}

      if (hasExample) {
        await fs.copyFile(examplePath, envPath);
        fixesApplied.push(`Создан стартовый ${envFileName} из .env.example`);
      } else if (contract.secrets && Array.isArray(contract.secrets) && contract.secrets.length > 0) {
        const starter = "# Local environment secrets (not committed to git)\n" +
          contract.secrets.map((s) => `${s}=\n`).join("");
        await fs.writeFile(envPath, starter, "utf-8");
        fixesApplied.push(`Создан стартовый ${envFileName}`);
      }
    }

    if (contract.secrets && Array.isArray(contract.secrets) && contract.secrets.length > 0) {
      const syncRes = await syncEnvExample(projectRoot, contract);
      if (syncRes.updated) {
        fixesApplied.push("Синхронизирован .env.example с contract.secrets");
      }
    }
  }

  // 2. Secrets parity and gitignore protection
  const secretsCheck = await verifySecrets(projectRoot, contract, { envFile: options?.envFile });
  if (!secretsCheck.valid) {
    errors.push(...secretsCheck.errors);
  }
  warnings.push(...secretsCheck.warnings);

  // Check if .pegas is gitignored
  if (!isIgnoredByGit(projectRoot, ".pegas")) {
    gitignoreIssues.push(".pegas directory should be added to .gitignore (internal runtime cache).");
    warnings.push(".pegas directory is not in .gitignore.");
  }

  // Check if contract.secrets has sync with .env.example
  if (contract?.secrets && Array.isArray(contract.secrets) && contract.secrets.length > 0) {
    const examplePath = path.join(projectRoot, ".env.example");
    try {
      await fs.access(examplePath);
    } catch {
      warnings.push("Missing .env.example schema file mirroring contract.secrets. Run 'pegas check --fix' or create it.");
    }
  }

  // 3. Scan root and immediate subdirs for legacy clutter
  try {
    const rootEntries = await fs.readdir(projectRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile()) {
        for (const rule of LEGACY_PATTERNS) {
          if (rule.pattern.test(entry.name)) {
            legacyFiles.push({
              path: entry.name,
              reason: rule.reason,
              severity: rule.severity,
            });
            break;
          }
        }
      } else if (entry.isDirectory() && (entry.name === "apps" || entry.name === "packages")) {
        // Monorepo subproject scan for rogue .env files
        const subDirPath = path.join(projectRoot, entry.name);
        try {
          const subDirs = await fs.readdir(subDirPath, { withFileTypes: true });
          for (const sub of subDirs) {
            if (sub.isDirectory()) {
              const subEnv = path.join(entry.name, sub.name, ".env");
              try {
                await fs.access(path.join(projectRoot, subEnv));
                legacyFiles.push({
                  path: subEnv,
                  reason: "Subproject .env file violates single-root .env doctrine. Move secrets to root .env.",
                  severity: "warn",
                });
              } catch {}
            }
          }
        } catch {}
      }
    }
  } catch {}

  const hasErrors = errors.length > 0;
  const hasWarnings = warnings.length > 0 || legacyFiles.length > 0;
  const valid = !hasErrors;

  return {
    valid,
    hasErrors,
    hasWarnings,
    projectRoot,
    contractExists,
    contractIssues,
    contract,
    secretsCheck,
    gitignoreIssues,
    legacyFiles,
    fixesApplied,
    errors,
    warnings,
  };
}

export async function handleCheck(options: CheckOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const isJson = options.json ?? false;

  const result = await auditRepository(cwd, { fix: options.fix });

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid && !options.noExit) {
      process.exit(1);
    }
    return;
  }

  console.log(`\n🔍 Pegas Repository Audit — ${result.projectRoot}\n`);

  // Fixes section
  if (result.fixesApplied.length > 0) {
    console.log(`  🔧 Fixes Applied (${result.fixesApplied.length}):`);
    for (const fix of result.fixesApplied) {
      console.log(`     ✔ ${fix}`);
    }
    console.log("");
  }

  // 1. Contract section
  if (result.contractExists && result.contractIssues.length === 0) {
    console.log(`  ✔ Contract: pegas.json is valid (${Object.keys(result.contract?.services || {}).length} service(s) declared)`);
  } else if (!result.contractExists) {
    console.log(`  ❌ Contract: pegas.json is MISSING`);
  } else {
    console.log(`  ❌ Contract: pegas.json has ${result.contractIssues.length} issue(s):`);
    for (const issue of result.contractIssues) {
      console.log(`     - [${issue.path}] ${issue.message}`);
    }
  }

  // 2. Secrets section
  if (result.secretsCheck) {
    const diag = formatSecretsDiagnostic(result.secretsCheck);
    console.log(`\n  ${diag.split("\n").join("\n  ")}`);
  }

  // 3. Git protection section
  if (result.gitignoreIssues.length > 0) {
    console.log(`\n  ⚠️  Git Protection:`);
    for (const gi of result.gitignoreIssues) {
      console.log(`     - ${gi}`);
    }
  }

  // 4. Legacy Clutter section
  if (result.legacyFiles.length > 0) {
    console.log(`\n  🧹 Legacy Clutter / Migration Opportunities (${result.legacyFiles.length} file(s)):`);
    for (const file of result.legacyFiles) {
      const icon = file.severity === "warn" ? "⚠️ " : "ℹ️ ";
      console.log(`     ${icon} ${file.path}: ${file.reason}`);
    }
    console.log(`     💡 Pegas standard: repository root contains only pegas.json and a single .env`);
  }

  // 5. Final summary
  console.log("");
  if (result.valid && !result.hasWarnings) {
    console.log(`✨ Repository adheres perfectly to the Pegas 2-file standard!\n`);
  } else if (result.valid && result.hasWarnings) {
    console.log(`✅ Contract & secrets valid, with ${result.legacyFiles.length + result.warnings.length} cleanup suggestion(s).\n`);
  } else {
    console.error(`❌ Pegas audit failed with ${result.errors.length} error(s). Please fix before deploying.\n`);
    if (!options.noExit) {
      process.exit(1);
    }
  }
}
