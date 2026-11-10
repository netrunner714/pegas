import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import child_process from "node:child_process";
import { randomBytes } from "node:crypto";
import type { SharedTenantConfig } from "./types.js";

/**
 * Разделяемые инфраструктурные пулы (issue #29).
 *
 * Один инстанс PostgreSQL/Redis обслуживает несколько проектов-арендаторов:
 * вместо N процессов СУБД — один, а изоляция обеспечивается отдельной базой и
 * ролью (postgres) либо префиксом ключей (redis).
 *
 * Проектировочные решения, отличающиеся от черновика issue:
 *
 * 1. **Пул привязан к сценарию.** `pegas-shared-postgres-18-development` и
 *    `pegas-shared-postgres-18-production` — разные инстансы. Общая база для dev
 *    и production означала бы, что dev-арендатор видит production-данные.
 *
 * 2. **Пулы не несут метку `pegas.project`.** `removeProjectContainers` удаляет
 *    контейнеры по этой метке, поэтому `pegas down` одного проекта снёс бы общую
 *    базу. Вместо неё — `pegas.shared-pool`.
 *
 * 3. **Пароль не попадает в argv.** SQL передаётся через stdin `docker exec -i`:
 *    значение не видно в `ps` и не оседает в истории команд.
 *
 * 4. **Данные арендатора никогда не удаляются.** `down` только уменьшает счётчик
 *    ссылок и останавливает пустой инстанс; том с данными сохраняется.
 *
 * 5. **Имя арендатора обязано быть объявлено в контракте** (`shared.name`).
 *    Угадывание имени из `projectName` привело бы к тому, что переименование
 *    проекта создало бы вторую базу и «потеряло» данные.
 */

export type SharedPoolKind = "postgres" | "redis";

/** Профиль пула: какой образ и какую мажорную версию он представляет. */
export interface SharedPoolProfile {
  kind: SharedPoolKind;
  /** Мажорная версия образа: пулы разных версий не смешиваются. */
  version: string;
  /** Исходное значение image из контракта. */
  image: string;
}

/** Результат команды Docker. Совместим с CommandResult из docker.ts. */
export interface SharedCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Зависимости модуля: инжектируемый исполнитель команд и каталог состояния. */
export interface SharedInfraDeps {
  /** Выполняет команду и возвращает результат (не бросает исключение при ненулевом коде). */
  run: (command: string, args: string[], stdin?: string) => Promise<SharedCommandResult>;
  /** Каталог состояния пулов (по умолчанию ~/.pegas/shared). */
  stateDir?: string;
  /** Порт по умолчанию для профиля. */
  defaultPort?: (kind: SharedPoolKind) => number;
}

/**
 * Реальный исполнитель команд Docker со stdin (issue #29).
 *
 * `runCommand` из docker.ts stdin не поддерживает, а он нужен принципиально:
 * SQL подготовки арендатора содержит пароль и обязан идти через stdin
 * `docker exec -i`, а не через argv, где его видно в `ps`. Поэтому у пулов —
 * свой исполнитель на spawn с тремя pipe-потоками; при ненулевом коде не
 * бросает, а возвращает { success: false, stderr } — как SharedCommandResult.
 */
export function runDockerWithStdin(command: string, args: string[], stdin?: string): Promise<SharedCommandResult> {
  return new Promise((resolve) => {
    const child = child_process.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      resolve({ success: false, stdout: stdout.trim(), stderr: (stderr.trim() || err.message).trim() });
    });
    child.on("close", (code) => {
      resolve({ success: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/** Зависимости пулов по умолчанию: реальный Docker, состояние в ~/.pegas/shared. */
export function createSharedInfraDeps(overrides: Partial<SharedInfraDeps> = {}): SharedInfraDeps {
  return { run: runDockerWithStdin, ...overrides };
}

/**
 * Ожидание готовности свежесозданного пула (issue #29).
 *
 * `docker run -d` возвращается до инициализации СУБД: postgres на пустом томе
 * несколько секунд разворачивает кластер, и немедленный `docker exec psql`
 * упал бы. Опрашиваем родной readiness-инструмент образа внутри контейнера
 * (pg_isready / redis-cli ping) до успеха или таймаута.
 */
export async function waitForSharedPoolReady(
  deps: SharedInfraDeps,
  profile: SharedPoolProfile,
  scenario: string,
  timeoutMs = 30_000
): Promise<void> {
  const containerName = sharedPoolName(profile, scenario);
  const probe = profile.kind === "postgres"
    ? ["exec", containerName, "pg_isready", "-U", "postgres", "-q"]
    : ["exec", containerName, "redis-cli", "ping"];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await deps.run("docker", probe);
    if (res.success) return;
    if (Date.now() >= deadline) {
      throw new Error(`Разделяемый пул ${containerName} не стал готов за ${Math.round(timeoutMs / 1000)}с: ${res.stderr || res.stdout}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Ссылка на арендатора пула — запись в реестре состояния. */
export interface TenantRef {
  /** runtimeId проекта (уникальность checkout'а). */
  project: string;
  /** Имя проекта из контракта. */
  projectName: string;
  scenario: string;
  /** Имя сервиса в контракте проекта-арендатора. */
  service: string;
  /** Имя арендатора (база/роль или префикс ключей). */
  name: string;
}

export interface SharedPoolState {
  /** Ключ пула → список арендаторов. */
  pools: Record<string, TenantRef[]>;
}

/** Метка контейнера разделяемого пула. */
export const SHARED_POOL_LABEL = "pegas.shared-pool";

/** Метка роли контейнера в экосистеме Pegas. */
export const SHARED_SCOPE_LABEL = "pegas.scope";

/**
 * Определяет профиль разделяемого пула по образу.
 * Возвращает null, если образ не является поддерживаемой инфраструктурой:
 * разделять можно только общеизвестные stateful-сервисы.
 */
export function classifySharedImage(image: string | undefined): SharedPoolProfile | null {
  if (!image) return null;
  const raw = image.trim();
  if (!raw) return null;
  // Локальные и собранные образы не разделяемы: их содержимое принадлежит проекту.
  if (raw.startsWith("pegas/")) return null;

  // Образ вида [registry/][namespace/]name[:tag][@digest]
  const withoutDigest = raw.split("@")[0];
  const withoutTag = withoutDigest.replace(/:[^/]*$/, "");
  const name = withoutTag.split("/").pop() ?? "";
  const tagMatch = withoutDigest.match(/:([^/]+)$/);
  const tag = tagMatch ? tagMatch[1] : "latest";

  // Мажорная версия: "18-alpine" → "18", "7.4" → "7.4", "latest" → "latest"
  const majorMatch = tag.match(/^(\d+(?:\.\d+)?)/);
  const version = majorMatch ? majorMatch[1] : tag;

  if (/^(postgres|pgvector|timescale.*|postgis.*)$/i.test(name)) {
    return { kind: "postgres", version, image: raw };
  }
  if (/^(redis|valkey)$/i.test(name)) {
    return { kind: "redis", version, image: raw };
  }
  return null;
}

/** Ключ пула: идентичность инстанса (вид, версия, сценарий). */
export function sharedPoolKey(profile: SharedPoolProfile, scenario: string): string {
  return `${profile.kind}-${profile.version}-${scenario}`;
}

/** Имя контейнера и сетевого алиаса пула. */
export function sharedPoolName(profile: SharedPoolProfile, scenario: string): string {
  return `pegas-shared-${sharedPoolKey(profile, scenario)}`;
}

/** Имя тома данных пула. Том не привязан к compose-проекту и переживает переименования. */
export function sharedVolumeName(profile: SharedPoolProfile, scenario: string): string {
  return `pegas-shared-${sharedPoolKey(profile, scenario)}-data`;
}

/** Логический порт сервиса внутри пула. */
export function sharedPoolPort(kind: SharedPoolKind, deps?: Pick<SharedInfraDeps, "defaultPort">): number {
  if (deps?.defaultPort) return deps.defaultPort(kind);
  return kind === "postgres" ? 5432 : 6379;
}

/** Каталог состояния пулов. */
export function getSharedStateDir(deps?: Pick<SharedInfraDeps, "stateDir">): string {
  if (deps?.stateDir) return deps.stateDir;
  return path.join(os.homedir(), ".pegas", "shared");
}

/** Путь файла реестра арендаторов. */
export function getSharedStatePath(deps?: Pick<SharedInfraDeps, "stateDir">): string {
  return path.join(getSharedStateDir(deps), "state.json");
}

/** Читает реестр арендаторов. Отсутствующий или повреждённый файл — пустой реестр. */
export function loadSharedState(deps?: Pick<SharedInfraDeps, "stateDir">): SharedPoolState {
  const file = getSharedStatePath(deps);
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.pools && typeof parsed.pools === "object") {
      const pools: Record<string, TenantRef[]> = {};
      for (const [key, list] of Object.entries(parsed.pools as Record<string, unknown>)) {
        if (Array.isArray(list)) pools[key] = list.filter(isTenantRef);
      }
      return { pools };
    }
  } catch {
    // Файл отсутствует или повреждён: считаем реестр пустым. Потеря реестра
    // не удаляет данные — пул просто продолжит работать, а count ссылок
    // восстановится при следующих деплоях.
  }
  return { pools: {} };
}

function isTenantRef(value: unknown): value is TenantRef {
  return (
    typeof value === "object" && value !== null &&
    typeof (value as TenantRef).project === "string" &&
    typeof (value as TenantRef).scenario === "string" &&
    typeof (value as TenantRef).service === "string" &&
    typeof (value as TenantRef).name === "string"
  );
}

/** Атомарно пишет реестр арендаторов. */
export function saveSharedState(state: SharedPoolState, deps?: Pick<SharedInfraDeps, "stateDir">): void {
  const file = getSharedStatePath(deps);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Ключ записи арендатора: проект + сценарий + сервис. */
function tenantKey(ref: TenantRef): string {
  return `${ref.project}::${ref.scenario}::${ref.service}`;
}

/** Добавляет арендатора в реестр (идемпотентно). */
export function registerTenant(state: SharedPoolState, poolKey: string, ref: TenantRef): SharedPoolState {
  const existing = state.pools[poolKey] ?? [];
  const key = tenantKey(ref);
  const withoutSelf = existing.filter((t) => tenantKey(t) !== key);
  return { pools: { ...state.pools, [poolKey]: [...withoutSelf, ref] } };
}

/**
 * Удаляет арендатора из реестра. Возвращает новый реестр.
 *
 * Удаляется только запись ссылки: данные арендатора (база, роль, ключи) остаются
 * в томе пула, поэтому повторный deploy поднимает проект на прежних данных.
 */
export function releaseTenant(state: SharedPoolState, poolKey: string, ref: TenantRef): SharedPoolState {
  const existing = state.pools[poolKey] ?? [];
  const key = tenantKey(ref);
  const remaining = existing.filter((t) => tenantKey(t) !== key);
  const pools = { ...state.pools };
  if (remaining.length === 0) delete pools[poolKey];
  else pools[poolKey] = remaining;
  return { pools };
}

/** Удаляет все записи проекта (используется `pegas down`). */
export function releaseProjectTenants(state: SharedPoolState, project: string, scenario?: string): SharedPoolState {
  const pools: Record<string, TenantRef[]> = {};
  for (const [key, list] of Object.entries(state.pools)) {
    const remaining = list.filter((t) => {
      if (t.project !== project) return true;
      if (scenario && t.scenario !== scenario) return true;
      return false;
    });
    if (remaining.length > 0) pools[key] = remaining;
  }
  return { pools };
}

/** Количество арендаторов пула. */
export function countTenants(state: SharedPoolState, poolKey: string): number {
  return (state.pools[poolKey] ?? []).length;
}

export interface EnsureSharedPoolOptions {
  profile: SharedPoolProfile;
  scenario: string;
  /** Публиковать порт на хост (development: host-приложения ходят в 127.0.0.1:port). */
  publishHostPort: boolean;
  /** Хостовый порт публикации. */
  hostPort?: number;
  /** Логический порт сервиса внутри пула. */
  port?: number;
}

export interface EnsureSharedPoolResult {
  /** Сетевой алиас пула в pegas-network. */
  host: string;
  /** Логический порт сервиса. */
  port: number;
  /** Был ли контейнер создан в этом вызове. */
  created: boolean;
  /** Имя контейнера. */
  containerName: string;
}

/** Каталог файлов-секретов, монтируемых в контейнеры пулов. */
function getSecretsDir(deps: Pick<SharedInfraDeps, "stateDir">): string {
  return path.join(getSharedStateDir(deps), "secrets");
}

/**
 * Генерирует (однократно) пароль суперпользователя пула PostgreSQL.
 *
 * Значение пишется в файл с режимом 0600 и монтируется в контейнер как
 * `POSTGRES_PASSWORD_FILE`. Передавать пароль через `--env` нельзя: argv
 * `docker run` виден другим локальным пользователям в `ps`, а образ PostgreSQL
 * без пароля вообще не запускается (проверено: контейнер падает с «superuser
 * password is not specified»).
 *
 * Файл сохраняется между запусками, поэтому пересоздание пула на том же томе
 * не расходится с уже инициализированной базой: пароль меняется только вместе
 * с удалением каталога данных.
 */
export function ensureSuperuserSecret(
  deps: Pick<SharedInfraDeps, "stateDir">,
  profile: SharedPoolProfile,
  scenario: string
): string {
  const dir = getSecretsDir(deps);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sharedPoolKey(profile, scenario)}-superuser`);
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing) return file;
  } catch {
    // Файла нет или он не читается — создаём заново.
  }
  const password = randomBytes(24).toString("base64url");
  // mode игнорируется, если файл уже существует, поэтому выставляем права явно.
  fs.writeFileSync(file, `${password}\n`, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * Гарантирует, что инстанс пула запущен и доступен в сети pegas-network.
 * Идемпотентно: повторный вызов не пересоздаёт контейнер и не трогает данные.
 */
export async function ensureSharedPool(
  deps: SharedInfraDeps,
  options: EnsureSharedPoolOptions
): Promise<EnsureSharedPoolResult> {
  const { profile, scenario } = options;
  const containerName = sharedPoolName(profile, scenario);
  const port = options.port ?? sharedPoolPort(profile.kind, deps);

  const inspect = await deps.run("docker", ["inspect", containerName, "--format", "{{.State.Running}}"]);
  if (inspect.success && inspect.stdout.trim() === "true") {
    return { host: containerName, port, created: false, containerName };
  }
  if (inspect.success) {
    // Контейнер существует, но остановлен: запускаем (данные в томе сохранены).
    const started = await deps.run("docker", ["start", containerName]);
    if (started.success) {
      return { host: containerName, port, created: false, containerName };
    }
    throw new Error(
      `Не удалось запустить разделяемый пул ${containerName}: ${started.stderr || started.stdout}`
    );
  }

  const volume = sharedVolumeName(profile, scenario);
  const dataPath = profile.kind === "postgres" ? "/var/lib/postgresql" : "/data";
  const args = [
    "run", "-d",
    "--name", containerName,
    "--network", "pegas-network",
    "--network-alias", containerName,
    "--restart", "unless-stopped",
    "--label", `${SHARED_POOL_LABEL}=${sharedPoolKey(profile, scenario)}`,
    "--label", `${SHARED_SCOPE_LABEL}=shared`,
    "--label", `pegas.shared-kind=${profile.kind}`,
    "--label", `pegas.shared-version=${profile.version}`,
    "--label", `pegas.scenario=${scenario}`,
    // Том с явным именем: данные пула не привязаны ни к одному compose-проекту.
    "--volume", `${volume}:${dataPath}`,
  ];

  if (options.publishHostPort) {
    // Публикация только на loopback: пул не должен быть доступен извне.
    const hostPort = options.hostPort ?? port;
    args.push("--publish", `127.0.0.1:${hostPort}:${port}`);
  }

  if (profile.kind === "postgres") {
    const secretFile = ensureSuperuserSecret(deps, profile, scenario);
    const mountPath = "/run/secrets/pegas-superuser";
    // Пароль суперпользователя — из файла, а не из argv: `docker run --env` виден
    // другим локальным пользователям в `ps`. Сеть требует scram-sha-256
    // (проверено на postgres:18-alpine: `host all all all scram-sha-256`),
    // поэтому снаружи инстанс без пароля не пускает; подготовка арендаторов идёт
    // через unix-сокет внутри контейнера (`local all all trust`).
    args.push("--volume", `${secretFile}:${mountPath}:ro`);
    args.push("--env", `POSTGRES_PASSWORD_FILE=${mountPath}`);
  }

  args.push(profile.image);

  const created = await deps.run("docker", args);
  if (!created.success) {
    throw new Error(
      `Не удалось создать разделяемый пул ${containerName}: ${created.stderr || created.stdout}`
    );
  }

  return { host: containerName, port, created: true, containerName };
}

/** SQL-идентификатор: допускаются только безопасные символы, иначе quoting невозможен. */
const SQL_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/i;

/** Кавычит SQL-идентификатор после проверки алфавита. */
export function quoteSqlIdentifier(name: string): string {
  if (!SQL_IDENTIFIER_RE.test(name)) {
    throw new Error(
      `Имя арендатора "${name}" недопустимо для SQL: разрешены буквы, цифры и "_" (первый символ — буква или "_").`
    );
  }
  return `"${name}"`;
}

/** Строит SQL-литерал строки с экранированием одинарных кавычек. */
export function quoteSqlLiteral(value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("Значение секрета не должно содержать переводов строк.");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * SQL подготовки арендатора PostgreSQL: идемпотентное создание роли и базы.
 * Пароль подставляется в текст, который передаётся через stdin — не через argv.
 */
export function buildPostgresProvisionSql(tenantName: string, password: string | undefined): string {
  const quoted = quoteSqlIdentifier(tenantName);
  const passwordLiteral = password !== undefined ? quoteSqlLiteral(password) : null;
  const lines: string[] = ["\\set ON_ERROR_STOP on"];

  if (passwordLiteral !== null) {
    // Роль создаётся с паролем; если роль уже существует, пароль не меняется —
    // смена пароля существующего арендатора могла бы сломать уже работающие приложения.
    lines.push(
      `DO $$ BEGIN`,
      `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${tenantName}') THEN`,
      `    EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', '${tenantName}', ${passwordLiteral});`,
      `  END IF;`,
      `END $$;`
    );
  } else {
    lines.push(
      `DO $$ BEGIN`,
      `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${tenantName}') THEN`,
      `    EXECUTE format('CREATE ROLE %I WITH LOGIN', '${tenantName}');`,
      `  END IF;`,
      `END $$;`
    );
  }

  lines.push(
    `SELECT 'CREATE DATABASE ${quoted} OWNER ${quoted}'`,
    `WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${tenantName}')\\gexec`,
    // Арендатор управляет только своей базой: расширяем права внутри неё.
    `GRANT ALL PRIVILEGES ON DATABASE ${quoted} TO ${quoted};`
  );
  return lines.join("\n") + "\n";
}

/** Результат подготовки арендатора. */
export interface ProvisionTenantResult {
  /** Был ли арендатор создан в этом вызове (false — уже существовал). */
  created: boolean;
  /** Префикс ключей (redis) или имя базы (postgres). */
  name: string;
  /** Пояснение, если подготовка пропущена. */
  skipped?: string;
}

/**
 * Готовит арендатора в пуле и регистрирует ссылку в реестре.
 *
 * Идемпотентно: повторный вызов не пересоздаёт базу и не меняет пароль.
 * Значение секрета передаётся вызывающим кодом из `.env` в памяти процесса и
 * не сохраняется ни в реестре, ни на диск.
 */
export async function provisionSharedTenant(
  deps: SharedInfraDeps,
  poolKey: string,
  profile: SharedPoolProfile,
  scenario: string,
  ref: TenantRef,
  tenant: SharedTenantConfig,
  secretValue: string | undefined
): Promise<ProvisionTenantResult> {
  const containerName = sharedPoolName(profile, scenario);

  if (profile.kind === "redis") {
    // Redis не имеет изоляции по базам с отдельными правами: арендаторы
    // разделяют инстанс, а изоляция достигается префиксом ключей. Префикс
    // инжектится в приложения через PEGAS_SHARED_KEY_PREFIX.
    const state = loadSharedState(deps);
    saveSharedState(registerTenant(state, poolKey, ref), deps);
    return { created: false, name: tenant.name, skipped: "redis: изоляция префиксом ключей, подготовка не требуется" };
  }

  if (!SQL_IDENTIFIER_RE.test(tenant.name)) {
    throw new Error(
      `services.${ref.service}: shared.name "${tenant.name}" недопустимо для имени базы PostgreSQL ` +
      `(разрешены буквы, цифры и "_", первый символ — буква или "_").`
    );
  }

  const sql = buildPostgresProvisionSql(tenant.name, secretValue);
  // `-i` без `-t`: SQL уходит в stdin, значение пароля не появляется в argv.
  const res = await deps.run(
    "docker",
    ["exec", "-i", containerName, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-q"],
    sql
  );
  if (!res.success) {
    throw new Error(
      `Подготовка арендатора "${tenant.name}" в пуле ${containerName} не удалась: ${res.stderr || res.stdout}`
    );
  }

  const state = loadSharedState(deps);
  const existed = (state.pools[poolKey] ?? []).some((t) => tenantKey(t) === tenantKey(ref));
  saveSharedState(registerTenant(state, poolKey, ref), deps);
  return { created: !existed, name: tenant.name };
}

/**
 * Останавливает пул, если арендаторов не осталось (issue #29, раздел 4).
 *
 * Данные не удаляются: останавливается только процесс. Следующий деплой любого
 * проекта-арендатора запустит инстанс заново на прежнем томе.
 */
export async function stopSharedPoolIfUnused(
  deps: SharedInfraDeps,
  poolKey: string,
  containerName: string
): Promise<{ stopped: boolean; reason: string }> {
  const state = loadSharedState(deps);
  const remaining = countTenants(state, poolKey);
  if (remaining > 0) {
    return { stopped: false, reason: `пул удержан: активных арендаторов ${remaining}` };
  }

  const inspect = await deps.run("docker", ["inspect", containerName, "--format", "{{.State.Running}}"]);
  if (!inspect.success || inspect.stdout.trim() !== "true") {
    return { stopped: false, reason: "пул уже остановлен" };
  }
  const stopped = await deps.run("docker", ["stop", containerName]);
  if (!stopped.success) {
    throw new Error(`Не удалось остановить разделяемый пул ${containerName}: ${stopped.stderr || stopped.stdout}`);
  }
  return { stopped: true, reason: "пул остановлен: арендаторов не осталось" };
}

/**
 * Освобождает ссылки проекта и останавливает опустевшие пулы.
 * Вызывается из `pegas down` после снятия контейнеров проекта.
 */
export async function releaseProjectSharedPools(
  deps: SharedInfraDeps,
  project: string,
  scenario?: string
): Promise<{ released: number; stoppedPools: string[] }> {
  const state = loadSharedState(deps);
  const affected: Array<{ poolKey: string; tenants: TenantRef[] }> = [];
  for (const [poolKey, tenants] of Object.entries(state.pools)) {
    const mine = tenants.filter((t) => t.project === project && (!scenario || t.scenario === scenario));
    if (mine.length > 0) affected.push({ poolKey, tenants: mine });
  }
  if (affected.length === 0) return { released: 0, stoppedPools: [] };

  // Сначала освобождаем арендаторов и фиксируем состояние, затем по одному
  // останавливаем опустевшие пулы. stopSharedPoolIfUnused перечитывает
  // состояние с диска, поэтому видит уже уменьшенный список арендаторов.
  saveSharedState(releaseProjectTenants(state, project, scenario), deps);

  const stoppedPools: string[] = [];
  for (const { poolKey } of affected) {
    const containerName = `pegas-shared-${poolKey}`;
    const result = await stopSharedPoolIfUnused(deps, poolKey, containerName);
    if (result.stopped) stoppedPools.push(containerName);
  }

  return { released: affected.reduce((sum, a) => sum + a.tenants.length, 0), stoppedPools };
}
