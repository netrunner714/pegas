import { describe, it, expect } from "bun:test";
import os from "node:os";
import { validatePegasContract } from "./contract.js";
import { createRuntimeCompose } from "./runtime-compose.js";
import {
  backupTarget,
  buildBackupHealthcheck,
  buildBackupScript,
  parseBackupInterval,
} from "./backup.js";
import type { PegasContract } from "./types.js";

const projectRoot = os.tmpdir();
const projectId = "0a1b0e24d9";

function contract(): PegasContract {
  return {
    projectName: "backup-app",
    scenarios: ["development", "production"],
    gateway: {
      development: { httpPort: 80, httpsPort: 443 },
      production: { httpPort: 80, httpsPort: 443, acmeEmail: "a@b.co" },
    },
    services: {
      db: {
        runtime: { development: { driver: "docker" }, production: { driver: "docker" } },
        image: { development: "postgres:18-alpine", production: "postgres:18-alpine" },
        port: { development: 5432, production: 5432 },
        volumes: {
          development: ["pgdata:/var/lib/postgresql"],
          production: ["pgdata:/var/lib/postgresql"],
        },
        healthcheck: {
          development: { test: ["CMD-SHELL", "pg_isready -U postgres"] },
          production: { test: ["CMD-SHELL", "pg_isready -U postgres"] },
        },
        env: {
          POSTGRES_USER: { development: "exogram", production: "exogram" },
          POSTGRES_DB: { development: "exogram", production: "exogram" },
        },
        secrets: ["POSTGRES_PASSWORD"],
        backup: {
          development: null,
          production: { every: "1h", keep: 24 },
        },
      },
    },
  } as unknown as PegasContract;
}

describe("backup: разбор интервала и целей", () => {
  it("every: минуты/часы/дни", () => {
    expect(parseBackupInterval("30m")).toBe(1800);
    expect(parseBackupInterval("1h")).toBe(3600);
    expect(parseBackupInterval("7d")).toBe(604800);
  });

  it("невалидные интервалы — null", () => {
    for (const value of ["", "0h", "1s", "hourly", "1.5h", "-1h"]) {
      expect({ value, parsed: parseBackupInterval(value) }).toEqual({ value, parsed: null });
    }
  });

  it("цель по умолчанию — env сервиса, явные поля важнее", () => {
    expect(backupTarget({ every: "1h", keep: 24 }, { POSTGRES_USER: "u", POSTGRES_DB: "d" })).toEqual({ user: "u", database: "d" });
    expect(backupTarget({ every: "1h", keep: 24, user: "x", database: "y" }, { POSTGRES_USER: "u", POSTGRES_DB: "d" })).toEqual({ user: "x", database: "y" });
  });

  it("скрипт и healthcheck содержат безопасные compose-экранирования", () => {
    const script = buildBackupScript();
    expect(script).toContain("pg_dump -Fc");
    expect(script).toContain("$$(date");
    expect(script).toContain("sort -r");
    expect(script).toContain("BACKUP_KEEP");
    const healthcheck = buildBackupHealthcheck(3600);
    expect(healthcheck.test[1]).toContain(".last-success");
    expect(healthcheck.test[1]).toContain("-mmin -120");
    expect(healthcheck.start_period).toBe("10m");
    expect(buildBackupHealthcheck(7 * 24 * 3600).test[1]).toContain("-mmin -20160");
  });
});

describe("backup: валидатор", () => {
  it("валидный контракт без замечаний", () => {
    expect(validatePegasContract(contract())).toEqual([]);
  });

  it("non-postgres образ — ошибка", () => {
    const c = contract();
    (c.services.db.image as any).production = "redis:7-alpine";
    expect(validatePegasContract(c).some((i) => i.message.includes("PostgreSQL"))).toBe(true);
  });

  it("плохой every — ошибка", () => {
    const c = contract();
    (c.services.db.backup as any).production.every = "0h";
    expect(validatePegasContract(c).some((i) => i.path.endsWith("backup.every"))).toBe(true);
  });

  it("плохой keep — ошибка", () => {
    const c = contract();
    (c.services.db.backup as any).production.keep = 0;
    expect(validatePegasContract(c).some((i) => i.path.endsWith("backup.keep"))).toBe(true);
  });

  it("секрет пароля обязан быть объявлен", () => {
    const c = contract();
    c.services.db.secrets = [];
    expect(validatePegasContract(c).some((i) => i.message.includes("POSTGRES_PASSWORD"))).toBe(true);
  });

  it("host-драйвер несовместим с backup", () => {
    const c = contract();
    (c.services.db.runtime as any).production = { driver: "bun" };
    expect(validatePegasContract(c).some((i) => i.message.includes('driver: "docker"'))).toBe(true);
  });

  it("shared-пул несовместим с backup", () => {
    const c = contract();
    (c.services.db as any).scope = { development: "isolated", production: "shared" };
    (c.services.db as any).shared = { development: null, production: { name: "tenant" } };
    (c.services.db as any).volumes = { development: [], production: [] };
    expect(validatePegasContract(c).some((i) => i.message.includes('scope: "shared"'))).toBe(true);
  });
});

describe("backup: сайдкар в compose", () => {
  it("production: к db добавляется db-backup с нужными env/volume/dependsOn", () => {
    const { manifest } = createRuntimeCompose(contract(), {
      projectRoot,
      projectId,
      environment: "production",
      secretValues: { POSTGRES_PASSWORD: "s3cret" },
    });
    const services = manifest.services as any;
    expect(Object.keys(services).sort()).toEqual(["db", "db-backup"]);
    const backup = services["db-backup"];
    expect(backup.image).toBe("postgres:18-alpine");
    expect(backup.environment.PGHOST).toBe("db");
    expect(backup.environment.PGPORT).toBe("5432");
    expect(backup.environment.PGUSER).toBe("exogram");
    expect(backup.environment.PGDATABASE).toBe("exogram");
    expect(backup.environment.PGPASSWORD).toBe("s3cret");
    expect(backup.environment.BACKUP_EVERY_SECONDS).toBe("3600");
    expect(backup.environment.BACKUP_KEEP).toBe("24");
    expect(backup.depends_on).toEqual({ db: { condition: "service_healthy" } });
    expect(backup.volumes).toEqual(["backup-db:/backups"]);
    expect(backup.labels["pegas.backup-for"]).toBe("db");
    expect(backup.command[0]).toBe("sh");
    expect(backup.command[2]).toContain("$$(date");
    expect((manifest.volumes as any)["backup-db"]).toEqual({
      name: `${projectId}-production_backup-db`,
    });
  });

  it("включение backup не меняет hash самой БД (контейнер не пересоздаётся)", () => {
    const withBackup = createRuntimeCompose(contract(), {
      projectRoot,
      projectId,
      environment: "production",
      secretValues: { POSTGRES_PASSWORD: "s3cret" },
    });
    const without = contract();
    delete (without.services.db as any).backup;
    const withoutBackup = createRuntimeCompose(without, {
      projectRoot,
      projectId,
      environment: "production",
      secretValues: { POSTGRES_PASSWORD: "s3cret" },
    });
    expect(withBackup.serviceHashes.db).toBe(withoutBackup.serviceHashes.db);
    expect(withBackup.serviceHashes["db-backup"]).not.toBe(withBackup.serviceHashes.db);
  });

  it("development: backup null — сайдкара нет", () => {
    const { manifest } = createRuntimeCompose(contract(), {
      projectRoot,
      projectId,
      environment: "development",
      secretValues: { POSTGRES_PASSWORD: "s3cret" },
    });
    expect(Object.keys(manifest.services as any)).toEqual(["db"]);
  });

  it("нет секрета в .env — генерация падает явно", () => {
    expect(() =>
      createRuntimeCompose(contract(), {
        projectRoot,
        projectId,
        environment: "production",
        secretValues: {},
      })
    ).toThrow(/POSTGRES_PASSWORD/);
  });
});
