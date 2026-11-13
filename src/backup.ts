/**
 * Автоматические бэкапы PostgreSQL (issue: backup в контракте).
 *
 * Контракт описывает только политику: как часто и сколько копий хранить.
 * Pegas сам добавляет в compose сайдкар, который делает `pg_dump -Fc`
 * в named-volume. Ни cron, ни systemd на хосте не нужны.
 *
 * Схитрить с сортировкой по mtime нельзя: BusyBox `ls -t` внутри образа
 * postgres:alpine различает только секунды, а дампы могут появиться в одну
 * секунду. Имена файлов содержат UTC-время `YYYYmmddTHHMMSSZ`, поэтому
 * лексикографический порядок совпадает с хронологическим.
 */

import type { ServiceBackup } from "./types.js";

export const BACKUP_DIR = "/backups";
export const BACKUP_DEFAULT_PASSWORD_SECRET = "POSTGRES_PASSWORD";
export const BACKUP_MIN_INTERVAL_SECONDS = 60;
export const BACKUP_MAX_KEEP = 1000;

/** Разбор `1h`, `30m`, `7d` в секунды. Невалидное/слишком частое — null. */
export function parseBackupInterval(value: string): number | null {
  const match = /^([1-9]\d*)([mhd])$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60 : match[2] === "h" ? 3600 : 86400;
  const seconds = amount * multiplier;
  return seconds >= BACKUP_MIN_INTERVAL_SECONDS ? seconds : null;
}

export function backupServiceName(serviceName: string): string {
  return `${serviceName}-backup`;
}

export function backupVolumeName(serviceName: string): string {
  return `backup-${serviceName}`;
}

export function backupPasswordSecret(backup: ServiceBackup): string {
  return backup.passwordSecret ?? BACKUP_DEFAULT_PASSWORD_SECRET;
}

/**
 * Shell-цикл сайдкара. `$$` — экранирование для compose: в контейнер
 * попадает обычный `$`, и переменные раскрывает shell, а не compose.
 */
export function buildBackupScript(): string {
  return [
    "set -eu",
    `mkdir -p ${BACKUP_DIR}`,
    "while true; do",
    "  now=$$(date +%s)",
    `  last=$$(cat ${BACKUP_DIR}/.last-success 2>/dev/null || echo 0)`,
    '  if [ $$((now - last)) -ge "$$BACKUP_EVERY_SECONDS" ]; then',
    "    ts=$$(date -u +%Y%m%dT%H%M%SZ)",
    `    tmp="${BACKUP_DIR}/.tmp-$$ts.dump"`,
    '    if pg_dump -Fc -f "$$tmp"; then',
    `      mv "$$tmp" "${BACKUP_DIR}/$$PGDATABASE-$$ts.dump"`,
    `      date +%s > ${BACKUP_DIR}/.last-success`,
    `      ls -1 ${BACKUP_DIR}/*.dump 2>/dev/null | sort -r | tail -n +$$((BACKUP_KEEP + 1)) | while read -r f; do rm -f "$$f"; done`,
    '      echo "backup: $$PGDATABASE-$$ts.dump"',
    "    else",
    '      rm -f "$$tmp"',
    '      echo "backup failed"',
    "    fi",
    "  fi",
    "  sleep 60",
    "done",
  ].join("\n");
}

/**
 * Healthcheck сайдкара: последний успешный дамп не старше двух интервалов
 * (но не меньше двух часов). При первом старте дампа ещё нет —
 * start_period даёт время на инициализацию.
 */
export function buildBackupHealthcheck(intervalSeconds: number): {
  test: string[];
  interval: string;
  timeout: string;
  retries: number;
  start_period: string;
} {
  const minutes = Math.max(120, Math.ceil(intervalSeconds / 60) * 2);
  return {
    test: [
      "CMD-SHELL",
      `test -f ${BACKUP_DIR}/.last-success && find ${BACKUP_DIR} -maxdepth 1 -name .last-success -mmin -${minutes} | grep -q .`,
    ],
    interval: "5m",
    timeout: "5s",
    retries: 3,
    start_period: "10m",
  };
}

/** Развёрнутое имя БД/пользователя: из env сервиса или явное поле backup. */
export function backupTarget(
  backup: ServiceBackup,
  env: Record<string, string> | undefined
): { user: string; database: string } {
  return {
    user: backup.user ?? env?.POSTGRES_USER ?? "postgres",
    database: backup.database ?? env?.POSTGRES_DB ?? "postgres",
  };
}
