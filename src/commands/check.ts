import fs from "node:fs/promises";
import path from "node:path";
import { validatePegasContract, type ContractValidationIssue } from "../contract.js";
import { verifySecrets, formatSecretsDiagnostic, isIgnoredByGit } from "../secrets.js";
import type { CheckOptions, PegasContract } from "../types.js";

/**
 * pegas check v3 — рид-онли валидатор (RFC_UX_V3.md, решение №4):
 * контракт + secrets-паритет + git-гигиена. Ничего не пишет на диск.
 */
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
  /** Свежесть AGENTS.md-блока и docs/pegas.md против канона установленного пегаса (детектор, не мутатор). */
  artifactIssues: string[];
  errors: string[];
  warnings: string[];
}

export async function auditRepository(
  cwd = process.cwd(),
  options?: { envFile?: string }
): Promise<RepoAuditResult> {
  const projectRoot = path.resolve(cwd);
  const errors: string[] = [];
  const warnings: string[] = [];
  const gitignoreIssues: string[] = [];

  // 1. Контракт: существование + валидация v3
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
        errors.push(`Контракт, "${issue.path}": ${issue.message}`);
      }
    } catch (parseErr: any) {
      errors.push(`Не удалось разобрать pegas.json: ${parseErr.message}`);
    }
  } catch {
    contractExists = false;
    errors.push(
      "pegas.json не найден. Напишите контракт v3 по схеме https://netrunner714.ru/schemas/pegas.json (контекст для агента: pegas llms)."
    );
  }

  // 2. Secrets-паритет: services.*.secrets ↔ .env (если существует)
  const secretsCheck = await verifySecrets(projectRoot, contract, { envFile: options?.envFile });
  if (!secretsCheck.valid) {
    errors.push(...secretsCheck.errors);
  }
  warnings.push(...secretsCheck.warnings);

  // 3. Git-гигиена: .pegas и env-маска в .gitignore (.env* + !.env.example)
  if (!isIgnoredByGit(projectRoot, ".pegas")) {
    gitignoreIssues.push("Каталог .pegas должен быть в .gitignore (рантайм-каталог проекта).");
    warnings.push(".pegas отсутствует в .gitignore.");
  }
  if (!isIgnoredByGit(projectRoot, ".env")) {
    gitignoreIssues.push("Файл .env должен быть в .gitignore (секреты не коммитятся).");
    warnings.push(".env отсутствует в .gitignore.");
  }
  // Шаблон секретов обязан коммититься: маска .env* без !.env.example прячет его — баг.
  try {
    await fs.access(path.join(projectRoot, ".env.example"));
    if (isIgnoredByGit(projectRoot, ".env.example")) {
      gitignoreIssues.push("Файл .env.example игнорируется git (шаблон секретов обязан быть в git): добавьте !.env.example после .env*.");
      warnings.push(".env.example исключён из git (!.env.example отсутствует).");
    }
  } catch {}
  // Легаси-конфиги шлюза в репо: Caddyfile/Caddyfile.* — маршруты обязан описывать
  // контракт (domains), файлы обратного прокси в репо — рассинхрон с pegas.json.
  // НО: Caddyfile, который Dockerfile копирует внутрь образа (COPY/ADD), — контейнерная
  // статика (file_server), а не конфиг шлюза: не алертим.
  {
    const dockerReferenced = new Set<string>();
    const skip = new Set(["node_modules", ".pegas", ".git", "dist", "build", ".next", ".cache"]);
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!skip.has(e.name)) await walk(path.join(dir, e.name), depth + 1);
        } else if (/^Caddyfile(\..+)?$/i.test(e.name) || e.name === "caddy.json") {
          const rel = path.relative(projectRoot, path.join(dir, e.name)).replace(/\\/g, "/");
          foundCaddy.push(rel);
        } else if (/^Dockerfile(\..+)?$/i.test(e.name)) {
          // COPY/ADD <src>, ссылающийся на Caddyfile: файл уходит внутрь образа
          try {
            const text = await fs.readFile(path.join(dir, e.name), "utf-8");
            for (const line of text.split("\n")) {
              const m = line.match(/^\s*(COPY|ADD)\s+(\S+)/i);
              if (m && /Caddyfile/i.test(m[2])) {
                dockerReferenced.add(path.join(path.relative(projectRoot, dir), m[2]).replace(/\\/g, "/"));
              }
            }
          } catch {}
        }
      }
    };
    const foundCaddy: string[] = [];
    await walk(projectRoot, 0);
    const legacy = foundCaddy.filter((f) => {
      if (dockerReferenced.has(f)) return false;
      const base = f.split("/").pop() ?? f;
      for (const ref of dockerReferenced) {
        const refBase = ref.split("/").pop() ?? ref;
        if (refBase === base) return false;
      }
      return true;
    });
    if (legacy.length > 0) {
      const list = legacy.join(", ");
      gitignoreIssues.push(
        "Caddyfile в репо: " + list + " — маршруты объявляются в pegas.json (services.<name>.domains); конфиг обратного прокси в репо рассинхронизируется с контрактом. Удалите файл или перенесите правила в контракт."
      );
      warnings.push("Легаси-конфиг шлюза в репо: " + list + " (объявите домены через pegas.json).");
    }
  }
  // 4. Свежесть артефактов: AGENTS.md-блок + docs/pegas.md против канона установленного CLI
  let artifactIssues: string[] = [];
  if (contract && typeof contract.projectName === "string") {
    try {
      const { auditProjectArtifacts } = await import("./init.js");
      artifactIssues = await auditProjectArtifacts(projectRoot, contract.projectName);
      warnings.push(...artifactIssues);
    } catch {
      // init.js недоступен — аудит артефактов пропускается тихо (не блокирует чек)
    }
  }

  const hasErrors = errors.length > 0;
  const hasWarnings = warnings.length > 0;
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
    artifactIssues,
    errors,
    warnings,
  };
}

export async function handleCheck(options: CheckOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const isJson = options.json ?? false;

  const result = await auditRepository(cwd);

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid && !options.noExit) {
      process.exit(1);
    }
    return;
  }

  console.log(`\n🔍 Pegas v3 Audit — ${result.projectRoot}\n`);

  // 1. Контракт
  if (result.contractExists && result.contractIssues.length === 0) {
    const svcCount = Object.keys(result.contract?.services || {}).length;
    console.log(`  ✔ Контракт: pegas.json валиден (${svcCount} сервис(ов), сценарии: ${result.contract?.scenarios.join(", ")})`);
  } else if (!result.contractExists) {
    console.log(`  ❌ Контракт: pegas.json отсутствует`);
  } else {
    console.log(`  ❌ Контракт: ${result.contractIssues.length} проблем(ы):`);
    for (const issue of result.contractIssues) {
      console.log(`     - [${issue.path}] ${issue.message}`);
    }
  }

  // 2. Секреты
  if (result.secretsCheck) {
    const diag = formatSecretsDiagnostic(result.secretsCheck);
    console.log(`\n  ${diag.split("\n").join("\n  ")}`);
  }

  // 3. Git-гигиена
  if (result.gitignoreIssues.length > 0) {
    console.log(`\n  ⚠️  Git-гигиена:`);
    for (const gi of result.gitignoreIssues) {
      console.log(`     - ${gi}`);
    }
  }
  // 4. Свежесть артефактов (AGENTS.md / docs/pegas.md)
  if (result.artifactIssues.length > 0) {
    console.log(`\n  ⚠️  Артефакты Pegas (pegas init обновит идемпотентно):`);
    for (const ai of result.artifactIssues) {
      console.log(`     - ${ai}`);
    }
  }

  console.log("");
  if (result.valid && !result.hasWarnings) {
    console.log(`✨ Репозиторий полностью соответствует стандарту Pegas v3!\n`);
  } else if (result.valid) {
    console.log(`✅ Контракт и секреты валидны; предложений по гигиене: ${result.warnings.length}.\n`);
  } else {
    console.error(`❌ Аудит не пройден: ${result.errors.length} ошибок(и). Исправьте перед деплоем.\n`);
    if (!options.noExit) {
      process.exit(1);
    }
  }
}
