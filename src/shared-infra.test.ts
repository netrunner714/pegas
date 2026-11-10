import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifySharedImage,
  sharedPoolKey,
  sharedPoolName,
  sharedVolumeName,
  sharedPoolPort,
  loadSharedState,
  saveSharedState,
  registerTenant,
  releaseTenant,
  releaseProjectTenants,
  countTenants,
  ensureSharedPool,
  ensureSuperuserSecret,
  buildPostgresProvisionSql,
  quoteSqlIdentifier,
  quoteSqlLiteral,
  provisionSharedTenant,
  stopSharedPoolIfUnused,
  releaseProjectSharedPools,
  SHARED_POOL_LABEL,
  SHARED_SCOPE_LABEL,
  type SharedInfraDeps,
  type SharedPoolProfile,
  type TenantRef,
} from "./shared-infra.js";

/**
 * Issue #29: разделяемые инфраструктурные пулы.
 * Все тесты работают на фейковом исполнителе команд: логика пулов не должна
 * требовать реального Docker, чтобы быть покрытой.
 */

type Call = { command: string; args: string[]; stdin?: string };

/** Фейковый Docker: записывает вызовы, отвечает по правилам сценария. */
function fakeDocker(
  handlers: Partial<{
    inspect: (args: string[]) => { success: boolean; stdout: string; stderr: string };
    run: (args: string[]) => { success: boolean; stdout: string; stderr: string };
    start: (args: string[]) => { success: boolean; stdout: string; stderr: string };
    exec: (args: string[], stdin: string | undefined) => { success: boolean; stdout: string; stderr: string };
    stop: (args: string[]) => { success: boolean; stdout: string; stderr: string };
  }> = {}
): { deps: SharedInfraDeps; calls: Call[] } {
  const calls: Call[] = [];
  const ok = { success: true, stdout: "", stderr: "" };
  const deps: SharedInfraDeps = {
    async run(command, args, stdin) {
      calls.push({ command, args, stdin });
      const sub = args[0];
      const handler = sub === "inspect" ? handlers.inspect
        : sub === "run" ? handlers.run
        : sub === "start" ? handlers.start
        : sub === "exec" ? () => handlers.exec?.(args, stdin) ?? ok
        : sub === "stop" ? handlers.stop
        : undefined;
      return handler?.(args) ?? ok;
    },
  };
  return { deps, calls };
}

let stateDir: string;
function withState(): SharedInfraDeps {
  const { deps } = fakeDocker();
  return { ...deps, stateDir };
}

function tenant(over: Partial<TenantRef> = {}): TenantRef {
  return {
    project: "aaa111",
    projectName: "alpha",
    scenario: "development",
    service: "db",
    name: "alpha_db",
    ...over,
  };
}

const pgProfile: SharedPoolProfile = { kind: "postgres", version: "18", image: "postgres:18-alpine" };
const redisProfile: SharedPoolProfile = { kind: "redis", version: "7", image: "redis:7-alpine" };

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pegas-shared-"));
});

describe("issue #29: классификация образов в пулы", () => {
  it("postgres и его производные — пул postgres", () => {
    expect(classifySharedImage("postgres:18-alpine")).toEqual({ kind: "postgres", version: "18", image: "postgres:18-alpine" });
    expect(classifySharedImage("postgres:16")?.version).toBe("16");
    expect(classifySharedImage("pgvector/pgvector:pg17")?.kind).toBe("postgres");
    expect(classifySharedImage("timescale/timescaledb:2.14-pg16")?.kind).toBe("postgres");
  });

  it("redis и valkey — пул redis", () => {
    expect(classifySharedImage("redis:7-alpine")).toEqual({ kind: "redis", version: "7", image: "redis:7-alpine" });
    expect(classifySharedImage("valkey/valkey:8")?.kind).toBe("redis");
  });

  it("реестр и namespace в имени образа не мешают классификации", () => {
    const p = classifySharedImage("registry.example.com:5000/team/postgres:18.2-alpine");
    expect(p).toEqual({ kind: "postgres", version: "18.2", image: "registry.example.com:5000/team/postgres:18.2-alpine" });
  });

  it("digest не влияет на версию", () => {
    expect(classifySharedImage("postgres:18@sha256:abcd")?.version).toBe("18");
  });

  it("образ без тега считается latest: разные версии в один пул не смешиваются", () => {
    expect(classifySharedImage("postgres")?.version).toBe("latest");
    expect(sharedPoolKey(classifySharedImage("postgres")!, "development"))
      .not.toBe(sharedPoolKey(classifySharedImage("postgres:18")!, "development"));
  });

  it("образы приложений и собранные pegas-образы не разделяемы", () => {
    expect(classifySharedImage("pegas/abc123/web:hash123")).toBeNull();
    expect(classifySharedImage("node:22-alpine")).toBeNull();
    expect(classifySharedImage("nginx:1.27")).toBeNull();
    expect(classifySharedImage(undefined)).toBeNull();
    expect(classifySharedImage("")).toBeNull();
    expect(classifySharedImage("   ")).toBeNull();
  });
});

describe("issue #29: идентичность пула", () => {
  it("пул привязан к сценарию: dev и production не делят инстанс", () => {
    // Общий инстанс для dev и production означал бы доступ dev-арендатора
    // к production-данным.
    const dev = sharedPoolName(pgProfile, "development");
    const prod = sharedPoolName(pgProfile, "production");
    expect(dev).toBe("pegas-shared-postgres-18-development");
    expect(prod).toBe("pegas-shared-postgres-18-production");
    expect(dev).not.toBe(prod);
    expect(sharedPoolKey(pgProfile, "development")).toBe("postgres-18-development");
  });

  it("имя тома стабильно и не зависит от compose-проекта", () => {
    expect(sharedVolumeName(pgProfile, "development")).toBe("pegas-shared-postgres-18-development-data");
    expect(sharedVolumeName(redisProfile, "production")).toBe("pegas-shared-redis-7-production-data");
  });

  it("порты по умолчанию соответствуют сервису", () => {
    expect(sharedPoolPort("postgres")).toBe(5432);
    expect(sharedPoolPort("redis")).toBe(6379);
    expect(sharedPoolPort("postgres", { defaultPort: () => 15432 })).toBe(15432);
  });
});

describe("issue #29: реестр арендаторов", () => {
  it("пустой реестр при отсутствии файла", () => {
    expect(loadSharedState({ stateDir })).toEqual({ pools: {} });
  });

  it("сохранение и чтение round-trip", () => {
    const deps = { stateDir };
    let state = loadSharedState(deps);
    const key = sharedPoolKey(pgProfile, "development");
    state = registerTenant(state, key, tenant());
    saveSharedState(state, deps);

    const reloaded = loadSharedState(deps);
    expect(countTenants(reloaded, key)).toBe(1);
    expect(reloaded.pools[key][0].name).toBe("alpha_db");
  });

  it("файл реестра закрыт от других пользователей (0600): там имена арендаторов", () => {
    const deps = { stateDir };
    saveSharedState(registerTenant(loadSharedState(deps), "postgres-18-development", tenant()), deps);
    const file = path.join(stateDir, "state.json");
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("повторная регистрация того же арендатора не дублирует запись", () => {
    const key = sharedPoolKey(pgProfile, "development");
    let state = loadSharedState({ stateDir });
    state = registerTenant(state, key, tenant());
    state = registerTenant(state, key, tenant());
    expect(countTenants(state, key)).toBe(1);
  });

  it("один и тот же сервис в двух checkout'ах — два разных арендатора", () => {
    const key = sharedPoolKey(pgProfile, "development");
    let state = loadSharedState({ stateDir });
    state = registerTenant(state, key, tenant({ project: "aaa111", name: "alpha_db" }));
    state = registerTenant(state, key, tenant({ project: "bbb222", projectName: "beta", name: "beta_db" }));
    expect(countTenants(state, key)).toBe(2);
  });

  it("release убирает только свою запись, чужие арендаторы остаются", () => {
    const key = sharedPoolKey(pgProfile, "development");
    let state = loadSharedState({ stateDir });
    state = registerTenant(state, key, tenant({ project: "aaa111" }));
    state = registerTenant(state, key, tenant({ project: "bbb222", projectName: "beta" }));
    state = releaseTenant(state, key, tenant({ project: "aaa111" }));
    expect(countTenants(state, key)).toBe(1);
    expect(state.pools[key][0].project).toBe("bbb222");
  });

  it("опустевший пул исчезает из реестра", () => {
    const key = sharedPoolKey(pgProfile, "development");
    let state = loadSharedState({ stateDir });
    state = registerTenant(state, key, tenant());
    state = releaseTenant(state, key, tenant());
    expect(state.pools[key]).toBeUndefined();
  });

  it("releaseProjectTenants снимает все записи проекта, включая несколько сервисов", () => {
    const key = sharedPoolKey(pgProfile, "development");
    let state = loadSharedState({ stateDir });
    state = registerTenant(state, key, tenant({ project: "aaa111", service: "db" }));
    state = registerTenant(state, key, tenant({ project: "aaa111", service: "analytics", name: "alpha_analytics" }));
    state = registerTenant(state, key, tenant({ project: "bbb222", projectName: "beta", name: "beta_db" }));
    state = releaseProjectTenants(state, "aaa111");
    expect(countTenants(state, key)).toBe(1);
    expect(state.pools[key][0].project).toBe("bbb222");
  });

  it("фильтр по сценарию не трогает записи других сценариев", () => {
    const devKey = sharedPoolKey(pgProfile, "development");
    const prodKey = sharedPoolKey(pgProfile, "production");
    let state = loadSharedState({ stateDir });
    state = registerTenant(state, devKey, tenant({ scenario: "development" }));
    state = registerTenant(state, prodKey, tenant({ scenario: "production" }));
    state = releaseProjectTenants(state, "aaa111", "development");
    expect(countTenants(state, devKey)).toBe(0);
    expect(countTenants(state, prodKey)).toBe(1);
  });

  it("повреждённый файл реестра не роняет загрузку", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "state.json"), "{ не json", "utf-8");
    expect(loadSharedState({ stateDir })).toEqual({ pools: {} });
  });

  it("записи без обязательных полей отбрасываются при загрузке", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({ pools: { "postgres-18-development": [{ project: "a" }, tenant()] } }),
      "utf-8"
    );
    const state = loadSharedState({ stateDir });
    expect(state.pools["postgres-18-development"].length).toBe(1);
    expect(state.pools["postgres-18-development"][0].service).toBe("db");
  });
});

describe("issue #29: запуск инстанса пула", () => {
  it("создаёт контейнер с томом, метками и loopback-публикацией", async () => {
    const { deps, calls } = fakeDocker({
      inspect: () => ({ success: false, stdout: "", stderr: "No such object" }),
    });
    const full: SharedInfraDeps = { ...deps, stateDir };

    const res = await ensureSharedPool(full, {
      profile: pgProfile, scenario: "development", publishHostPort: true, hostPort: 5432,
    });

    expect(res.created).toBe(true);
    expect(res.host).toBe("pegas-shared-postgres-18-development");
    expect(res.port).toBe(5432);

    const run = calls.find((c) => c.args[0] === "run")!;
    const joined = run.args.join(" ");
    // Метка пула вместо pegas.project: removeProjectContainers удаляет по
    // pegas.project, поэтому `pegas down` одного проекта не должен снести пул.
    expect(joined).toContain(`${SHARED_POOL_LABEL}=postgres-18-development`);
    expect(joined).toContain(`${SHARED_SCOPE_LABEL}=shared`);
    expect(joined).not.toContain("label pegas.project=");
    expect(run.args).not.toContain("pegas.project");
    // Том с явным именем: данные не привязаны к compose-проекту.
    expect(joined).toContain("--volume pegas-shared-postgres-18-development-data:/var/lib/postgresql");
    // Точка монтирования postgres:18+ (issue #26), не legacy .../data
    expect(joined).not.toContain("/var/lib/postgresql/data");
    // Публикация только на loopback
    expect(joined).toContain("--publish 127.0.0.1:5432:5432");
    expect(joined).not.toContain("--publish 0.0.0.0");
    expect(run.args[run.args.length - 1]).toBe("postgres:18-alpine");
  });

  it("пароль суперпользователя передаётся файлом, а не через argv", async () => {
    const { deps, calls } = fakeDocker({
      inspect: () => ({ success: false, stdout: "", stderr: "No such object" }),
    });
    const full: SharedInfraDeps = { ...deps, stateDir };
    await ensureSharedPool(full, { profile: pgProfile, scenario: "development", publishHostPort: false });

    const run = calls.find((c) => c.args[0] === "run")!;
    const joined = run.args.join(" ");
    expect(joined).toContain("POSTGRES_PASSWORD_FILE=/run/secrets/pegas-superuser");
    expect(joined).toContain(":ro");
    // Значение секрета не должно появляться в argv docker run
    const secretPath = path.join(stateDir, "secrets", "postgres-18-development-superuser");
    const secret = fs.readFileSync(secretPath, "utf-8").trim();
    expect(secret.length).toBeGreaterThan(20);
    expect(joined).not.toContain(secret);
    expect(joined).not.toContain("POSTGRES_PASSWORD=");
  });

  it("файл секрета имеет режим 0600 и переиспользуется между запусками", async () => {
    const { deps } = fakeDocker({ inspect: () => ({ success: false, stdout: "", stderr: "" }) });
    const full: SharedInfraDeps = { ...deps, stateDir };
    const first = ensureSuperuserSecret(full, pgProfile, "development");
    const secret1 = fs.readFileSync(first, "utf-8").trim();
    expect(fs.statSync(first).mode & 0o777).toBe(0o600);

    const second = ensureSuperuserSecret(full, pgProfile, "development");
    expect(second).toBe(first);
    // Тот же пароль: иначе пересозданный пул не сошёлся бы с инициализированной базой
    expect(fs.readFileSync(second, "utf-8").trim()).toBe(secret1);
  });

  it("redis-пул монтирует /data и не требует пароля суперпользователя", async () => {
    const { deps, calls } = fakeDocker({ inspect: () => ({ success: false, stdout: "", stderr: "" }) });
    const full: SharedInfraDeps = { ...deps, stateDir };
    const res = await ensureSharedPool(full, { profile: redisProfile, scenario: "production", publishHostPort: false });
    expect(res.host).toBe("pegas-shared-redis-7-production");
    const joined = calls.find((c) => c.args[0] === "run")!.args.join(" ");
    expect(joined).toContain("--volume pegas-shared-redis-7-production-data:/data");
    expect(joined).not.toContain("POSTGRES_PASSWORD_FILE");
    expect(joined).not.toContain("--publish");
  });

  it("уже запущенный пул не пересоздаётся: docker run не вызывается", async () => {
    const { deps, calls } = fakeDocker({ inspect: () => ({ success: true, stdout: "true", stderr: "" }) });
    const res = await ensureSharedPool({ ...deps, stateDir }, {
      profile: pgProfile, scenario: "development", publishHostPort: true,
    });
    expect(res.created).toBe(false);
    expect(calls.some((c) => c.args[0] === "run")).toBe(false);
    expect(calls.some((c) => c.args[0] === "start")).toBe(false);
  });

  it("остановленный пул запускается, данные сохраняются", async () => {
    const { deps, calls } = fakeDocker({ inspect: () => ({ success: true, stdout: "false", stderr: "" }) });
    const res = await ensureSharedPool({ ...deps, stateDir }, {
      profile: pgProfile, scenario: "development", publishHostPort: false,
    });
    expect(res.created).toBe(false);
    const started = calls.find((c) => c.args[0] === "start");
    expect(started?.args).toContain("pegas-shared-postgres-18-development");
    // Пересоздание удалило бы том: docker run обязан отсутствовать
    expect(calls.some((c) => c.args[0] === "run")).toBe(false);
  });

  it("ошибка создания пула — явное исключение с причиной", async () => {
    const { deps } = fakeDocker({
      inspect: () => ({ success: false, stdout: "", stderr: "" }),
      run: () => ({ success: false, stdout: "", stderr: "port is already allocated" }),
    });
    await expect(
      ensureSharedPool({ ...deps, stateDir }, { profile: pgProfile, scenario: "development", publishHostPort: true })
    ).rejects.toThrow(/port is already allocated/);
  });

  it("ошибка запуска остановленного пула — явное исключение", async () => {
    const { deps } = fakeDocker({
      inspect: () => ({ success: true, stdout: "false", stderr: "" }),
      start: () => ({ success: false, stdout: "", stderr: "device or resource busy" }),
    });
    await expect(
      ensureSharedPool({ ...deps, stateDir }, { profile: pgProfile, scenario: "development", publishHostPort: false })
    ).rejects.toThrow(/device or resource busy/);
  });
});

describe("issue #29: SQL подготовки арендатора", () => {
  it("создаёт роль и базу идемпотентно (IF NOT EXISTS + WHERE NOT EXISTS)", () => {
    const sql = buildPostgresProvisionSql("alpha_db", "secret-pw");
    expect(sql).toContain("IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'alpha_db')");
    expect(sql).toContain("WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'alpha_db')");
    expect(sql).toContain("\\gexec");
    expect(sql).toContain('GRANT ALL PRIVILEGES ON DATABASE "alpha_db" TO "alpha_db"');
  });

  it("пароль экранируется как SQL-литерал, а не подставляется сырым", () => {
    const sql = buildPostgresProvisionSql("t", "pw'with\"quote");
    expect(sql).toContain("'pw''with\"quote'");
    // Сырое значение с одиночной кавычкой разорвало бы SQL и позволило инъекцию
    expect(sql).not.toContain("'pw'with");
  });

  it("format('%I'/'%L') используется вместо склейки идентификаторов", () => {
    const sql = buildPostgresProvisionSql("t", "pw");
    expect(sql).toContain("EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L'");
  });

  it("без секрета роль создаётся без PASSWORD", () => {
    const sql = buildPostgresProvisionSql("t", undefined);
    expect(sql).toContain("CREATE ROLE %I WITH LOGIN");
    expect(sql).not.toContain("PASSWORD");
  });

  it("перевод строки в пароле отклоняется: он разорвал бы SQL-поток", () => {
    expect(() => buildPostgresProvisionSql("t", "a\nb")).toThrow(/перевод/);
  });

  it("опасные идентификаторы отклоняются до построения SQL", () => {
    for (const bad of ["1abc", "a-b", "a b", "a;b", 'a"b', "a'b", "", "drop database x--"]) {
      expect(() => quoteSqlIdentifier(bad)).toThrow();
      expect(() => buildPostgresProvisionSql(bad, "pw")).toThrow();
    }
  });

  it("допустимые идентификаторы проходят", () => {
    expect(quoteSqlIdentifier("alpha_db")).toBe('"alpha_db"');
    expect(quoteSqlIdentifier("_x1")).toBe('"_x1"');
    expect(quoteSqlIdentifier("Alpha")).toBe('"Alpha"');
  });

  it("quoteSqlLiteral удваивает кавычки", () => {
    expect(quoteSqlLiteral("a'b")).toBe("'a''b'");
    expect(quoteSqlLiteral("plain")).toBe("'plain'");
  });
});

describe("issue #29: подготовка арендатора и подсчёт ссылок", () => {
  it("postgres: SQL уходит в stdin docker exec -i, пароль не попадает в argv", async () => {
    const { deps, calls } = fakeDocker({ exec: () => ({ success: true, stdout: "", stderr: "" }) });
    const full: SharedInfraDeps = { ...deps, stateDir };
    const key = sharedPoolKey(pgProfile, "development");

    const res = await provisionSharedTenant(
      full, key, pgProfile, "development", tenant(), { name: "alpha_db", secret: "DB_PASSWORD" }, "s3cret"
    );

    expect(res.created).toBe(true);
    const exec = calls.find((c) => c.args[0] === "exec")!;
    expect(exec.args).toContain("-i");
    expect(exec.args).not.toContain("-t");
    expect(exec.args).toContain("pegas-shared-postgres-18-development");
    expect(exec.args.join(" ")).toContain("psql");
    // Секрет только в stdin
    expect(exec.stdin).toContain("'s3cret'");
    expect(exec.args.join(" ")).not.toContain("s3cret");
  });

  it("повторная подготовка помечает арендатора как существующего", async () => {
    const { deps } = fakeDocker({ exec: () => ({ success: true, stdout: "", stderr: "" }) });
    const full: SharedInfraDeps = { ...deps, stateDir };
    const key = sharedPoolKey(pgProfile, "development");
    const first = await provisionSharedTenant(full, key, pgProfile, "development", tenant(), { name: "alpha_db" }, undefined);
    const second = await provisionSharedTenant(full, key, pgProfile, "development", tenant(), { name: "alpha_db" }, undefined);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(countTenants(loadSharedState(full), key)).toBe(1);
  });

  it("redis: изоляция префиксом ключей, SQL не выполняется", async () => {
    const { deps, calls } = fakeDocker();
    const full: SharedInfraDeps = { ...deps, stateDir };
    const key = sharedPoolKey(redisProfile, "development");

    const res = await provisionSharedTenant(
      full, key, redisProfile, "development",
      tenant({ service: "cache", name: "alpha" }), { name: "alpha" }, undefined
    );

    expect(res.name).toBe("alpha");
    expect(res.skipped).toContain("префикс");
    expect(calls.some((c) => c.args[0] === "exec")).toBe(false);
    expect(countTenants(loadSharedState(full), key)).toBe(1);
  });

  it("ошибка psql пробрасывается с именем пула и арендатора", async () => {
    const { deps } = fakeDocker({
      exec: () => ({ success: false, stdout: "", stderr: 'ERROR: role "alpha_db" already exists' }),
    });
    await expect(
      provisionSharedTenant({ ...deps, stateDir }, "postgres-18-development", pgProfile, "development", tenant(), { name: "alpha_db" }, undefined)
    ).rejects.toThrow(/pegas-shared-postgres-18-development/);
  });

  it("недопустимое имя арендатора отклоняется с путём до поля контракта", async () => {
    const { deps } = fakeDocker();
    await expect(
      provisionSharedTenant(
        { ...deps, stateDir }, "postgres-18-development", pgProfile, "development",
        tenant({ service: "db" }), { name: "bad-name" }, undefined
      )
    ).rejects.toThrow(/services\.db/);
  });

  it("пустой пул останавливается, данные не удаляются", async () => {
    const { deps, calls } = fakeDocker({
      inspect: () => ({ success: true, stdout: "true", stderr: "" }),
    });
    const res = await stopSharedPoolIfUnused({ ...deps, stateDir }, "postgres-18-development", "pegas-shared-postgres-18-development");
    expect(res.stopped).toBe(true);
    expect(calls.some((c) => c.args[0] === "stop")).toBe(true);
    // rm -v уничтожил бы данные арендаторов: только stop
    expect(calls.some((c) => c.args[0] === "rm")).toBe(false);
  });

  it("пул с оставшимися арендаторами удерживается", async () => {
    const { deps, calls } = fakeDocker({ inspect: () => ({ success: true, stdout: "true", stderr: "" }) });
    const full: SharedInfraDeps = { ...deps, stateDir };
    const key = "postgres-18-development";
    let state = loadSharedState(full);
    state = registerTenant(state, key, tenant({ project: "aaa111" }));
    state = registerTenant(state, key, tenant({ project: "bbb222", projectName: "beta", name: "beta_db" }));
    // Один проект ушёл, второй остался: пул обязан продолжить работу.
    state = releaseTenant(state, key, tenant({ project: "aaa111" }));
    saveSharedState(state, full);

    const res = await stopSharedPoolIfUnused(full, key, "pegas-shared-postgres-18-development");
    expect(res.stopped).toBe(false);
    expect(res.reason).toContain("1");
    expect(calls.some((c) => c.args[0] === "stop")).toBe(false);
  });

  it("уже остановленный пул не останавливается повторно", async () => {
    const { deps, calls } = fakeDocker({ inspect: () => ({ success: true, stdout: "false", stderr: "" }) });
    const res = await stopSharedPoolIfUnused({ ...deps, stateDir }, "postgres-18-development", "pegas-shared-postgres-18-development");
    expect(res.stopped).toBe(false);
    expect(res.reason).toContain("уже остановлен");
    expect(calls.some((c) => c.args[0] === "stop")).toBe(false);
  });

  it("down проекта: ссылки сняты, опустевший пул остановлен", async () => {
    const { deps, calls } = fakeDocker({ inspect: () => ({ success: true, stdout: "true", stderr: "" }) });
    const full: SharedInfraDeps = { ...deps, stateDir };
    const key = sharedPoolKey(pgProfile, "development");
    saveSharedState(registerTenant(loadSharedState(full), key, tenant()), full);

    const res = await releaseProjectSharedPools(full, "aaa111", "development");
    expect(res.released).toBe(1);
    expect(res.stoppedPools).toEqual(["pegas-shared-postgres-18-development"]);
    expect(countTenants(loadSharedState(full), key)).toBe(0);
    expect(calls.some((c) => c.args[0] === "stop")).toBe(true);
  });

  it("down проекта не останавливает пул, которым пользуется другой проект", async () => {
    const { deps, calls } = fakeDocker({ inspect: () => ({ success: true, stdout: "true", stderr: "" }) });
    const full: SharedInfraDeps = { ...deps, stateDir };
    const key = sharedPoolKey(pgProfile, "development");
    let state = loadSharedState(full);
    state = registerTenant(state, key, tenant({ project: "aaa111" }));
    state = registerTenant(state, key, tenant({ project: "bbb222", projectName: "beta", name: "beta_db" }));
    saveSharedState(state, full);

    const res = await releaseProjectSharedPools(full, "aaa111", "development");
    expect(res.released).toBe(1);
    expect(res.stoppedPools).toEqual([]);
    expect(countTenants(loadSharedState(full), key)).toBe(1);
    expect(calls.some((c) => c.args[0] === "stop")).toBe(false);
  });

  it("проект без арендаторов: реестр и docker не трогаются", async () => {
    const { deps, calls } = fakeDocker({ inspect: () => ({ success: true, stdout: "true", stderr: "" }) });
    const res = await releaseProjectSharedPools({ ...deps, stateDir }, "nobody");
    expect(res).toEqual({ released: 0, stoppedPools: [] });
    expect(calls.length).toBe(0);
  });
});
