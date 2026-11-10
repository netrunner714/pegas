/**
 * Метаданные маршрута в route-файле шлюза (issue #30).
 *
 * `pegas status` должен показывать имя сервиса, сценарий и драйвер для каждого
 * маршрута. До появления метаданных это восстанавливалось эвристикой по имени
 * файла и upstream, что давало неверные результаты: веб-сервисы одного проекта
 * не различались, а инфраструктурные сервисы получали выдуманные эндпоинты.
 *
 * Формат — однострочный комментарий непосредственно перед блоком домена:
 *
 *   # pegas:project=815records | service=booking-api | env=development | driver=bun
 *   api.815records.localhost {
 *       reverse_proxy host.docker.internal:3002
 *   }
 *
 * Комментарий — данные для Pegas, Caddy его игнорирует. Значения ограничены
 * алфавитом имён (`[a-z0-9._-]`), поэтому разделители ` | ` и `=` однозначны,
 * а экранирование не требуется.
 */

/** Маркер строки метаданных. */
export const ROUTE_META_PREFIX = "# pegas:";

/** Владельцы маршрута (правило «владелец маршрута = владелец процесса», issue #23). */
export type RouteMetaOwner = "connect" | "deploy";

/** Драйвер сервиса в сценарии маршрута. */
export type RouteMetaDriver = "docker" | "bun";

export interface RouteMeta {
  /** Имя проекта из контракта (`projectName`). */
  project: string;
  /** Имя сервиса из контракта. */
  service: string;
  /** Сценарий маршрута. */
  env: string;
  /** Драйвер сервиса в этом сценарии. */
  driver: RouteMetaDriver;
  /** Владелец блока маршрута. */
  owner?: RouteMetaOwner;
  /** Логический порт сервиса (если объявлен в контракте). */
  port?: number;
}

/** Ключи, порядок которых фиксирует сериализация (стабильный diff route-файлов). */
const META_KEYS = ["project", "service", "env", "driver", "owner", "port"] as const;

/** Допустимый алфавит значения метаданных: имена проекта/сервиса/сценария и драйвер. */
const META_VALUE_RE = /^[a-z0-9._-]+$/i;

/**
 * Сериализует метаданные в однострочный комментарий.
 * Возвращает null, если обязательные поля отсутствуют или содержат значение вне
 * алфавита имён: маршруту лучше остаться без строки метаданных, чем получить
 * комментарий, по которому сервис нельзя однозначно определить.
 */
export function serializeRouteMeta(meta: RouteMeta): string | null {
  const required: Array<keyof RouteMeta> = ["project", "service", "env", "driver"];
  for (const key of required) {
    const value = meta[key];
    if (value === undefined || value === null || value === "") return null;
    if (!META_VALUE_RE.test(String(value))) return null;
  }

  const parts: string[] = [];
  for (const key of META_KEYS) {
    const value = meta[key];
    if (value === undefined || value === null || value === "") continue;
    const text = String(value);
    // Необязательный ключ со значением вне алфавита имён пропускается: он не
    // влияет на сопоставление маршрута, а строку сделал бы неоднозначной.
    if (!META_VALUE_RE.test(text)) continue;
    parts.push(`${key}=${text}`);
  }
  if (parts.length === 0) return null;
  return `${ROUTE_META_PREFIX}${parts.join(" | ")}`;
}

/**
 * Разбирает строку комментариев в метаданные.
 * Принимает как одну строку, так и массив комментариев блока (берётся последняя
 * строка с маркером `# pegas:`). Неизвестные ключи игнорируются: старые файлы
 * и файлы, дописанные вручную, не должны ломать разбор.
 */
export function parseRouteMeta(comments: string | string[] | null | undefined): RouteMeta | null {
  const lines = Array.isArray(comments) ? comments : comments ? [comments] : [];
  let line: string | undefined;
  for (const candidate of lines) {
    const trimmed = candidate.trim();
    if (trimmed.startsWith(ROUTE_META_PREFIX)) line = trimmed;
  }
  if (!line) return null;

  const payload = line.slice(ROUTE_META_PREFIX.length);
  const meta: Record<string, string> = {};
  for (const chunk of payload.split("|")) {
    const eq = chunk.indexOf("=");
    if (eq <= 0) continue;
    const key = chunk.slice(0, eq).trim().toLowerCase();
    const value = chunk.slice(eq + 1).trim();
    if (key && value) meta[key] = value;
  }

  if (!meta.project || !meta.service || !meta.env) return null;
  const driver: RouteMetaDriver = meta.driver === "bun" ? "bun" : "docker";
  const owner: RouteMetaOwner | undefined =
    meta.owner === "connect" || meta.owner === "deploy" ? meta.owner : undefined;
  const portNum = meta.port ? Number(meta.port) : NaN;

  return {
    project: meta.project,
    service: meta.service,
    env: meta.env,
    driver,
    ...(owner ? { owner } : {}),
    ...(Number.isFinite(portNum) && portNum > 0 ? { port: portNum } : {}),
  };
}

/**
 * Метаданные из upstream-а и сценария — для маршрутов, записанных до появления
 * строки метаданных (обратная совместимость). Драйвер выводится из upstream:
 * `host.docker.internal:<port>` принадлежит host-процессу (issue #23).
 */
export function inferRouteMeta(input: {
  projectName: string;
  upstream: string | null;
  env?: string;
  service?: string;
}): RouteMeta | null {
  if (!input.projectName || !input.upstream) return null;
  const host = input.upstream.split(":")[0];
  const portRaw = input.upstream.split(":")[1];
  const portNum = portRaw ? Number(portRaw) : NaN;
  const isHost = host === "host.docker.internal" || host === "127.0.0.1" || host === "localhost";
  return {
    project: input.projectName,
    service: input.service ?? "",
    env: input.env ?? "",
    driver: isHost ? "bun" : "docker",
    owner: isHost ? "connect" : "deploy",
    ...(Number.isFinite(portNum) && portNum > 0 ? { port: portNum } : {}),
  };
}
