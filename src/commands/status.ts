import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import net from "node:net";
import { findGatewayDir, findProjectRoot, getConfDir } from "../gateway.js";
import { CONTRACT_FILENAME } from "../contract.js";
import {
  checkDocker,
  checkDockerCompose,
  getGatewayContainerStatus,
  runCommand,
} from "../docker.js";
import { renderTable } from "../table.js";
import { parseRouteMeta, type RouteMeta } from "../route-meta.js";

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  networks: string[];
  ports?: string;
  composeProject?: string;
  composeService?: string;
  pegasProject?: string;
  pegasProjectName?: string;
  pegasScenario?: string;
  pegasService?: string;
  pegasRole?: string;
  pegasDomains?: string;
  pegasEndpoint?: string;
  /** Память контейнера (`docker stats`, формат "12.3MiB / 7.7GiB"). */
  memUsage?: string;
  /** Время с запуска (`docker ps` RunningFor), например "2 hours ago". */
  runningFor?: string;
}

/** Строка единого дашборда (issue #30): один сервис — одна строка. */
export interface ServiceRow {
  project: string;
  service: string;
  env: string;
  driver: "docker" | "bun" | "unknown";
  /** Как сервис доступен снаружи: домен, localhost:<port>, publicHost или (internal). */
  endpoint: string;
  /** Куда шлюз проксирует: container-alias:port или 127.0.0.1:port. */
  target: string;
  /** Состояние маршрута в шлюзе. */
  gateway: "linked" | "routed" | "direct" | "none";
  /** Реальное состояние процесса/контейнера. */
  health: string;
  state: string;
  /** Ресурсы и аптайм: "48 MB (2h)" для контейнера, "host" для host-процесса. */
  resources: string;
  /** Домены маршрута (для JSON-потребителей). */
  domains: string[];
  container?: string;
  containerId?: string;
  image?: string;
  /** Логический порт сервиса (из метаданных маршрута или метки контейнера). */
  port?: number;
  /** Строка принадлежит проекту, из каталога которого запущен status. */
  current: boolean;
  /** Проблема, из-за которой сервис не отвечает (для блока подсказок). */
  issue?: string;
}

/** Совместимость: строка прежнего дашборда маршрутов (поле `projects` в JSON). */
export interface ProjectDashboardItem {
  project: string;
  domains: string[];
  upstream: string;
  status: string;
  state: string;
  displayStatus: string;
  container?: string;
  containerId?: string;
}

export interface CaddyTopLevelBlock {
  header: string;
  body: string;
  /**
   * Комментарии, идущие подряд непосредственно перед заголовком блока.
   * Pegas записывает туда метаданные маршрута (`# pegas:service=... | env=... | driver=...`),
   * поэтому они обязаны переживать merge/strip (issue #30).
   */
  leadingComments: string[];
}

export function parseCaddyTopLevelBlocks(content: string): CaddyTopLevelBlock[] {
  const blocks: CaddyTopLevelBlock[] = [];
  let i = 0;
  const n = content.length;

  while (i < n) {
    const openBrace = content.indexOf("{", i);
    if (openBrace === -1) break;

    const beforeText = content.slice(i, openBrace).trim();
    const lines = beforeText.split("\n").map((l) => l.trim()).filter((l) => Boolean(l));
    const nonComment = lines.filter((l) => !l.startsWith("#"));
    const header = nonComment[nonComment.length - 1] || "";

    // Комментарии, стоящие подряд прямо перед заголовком блока, — его метаданные.
    // Всё, что выше (шапка файла, комментарии предыдущих блоков), к блоку не относится.
    const headerIdx = header ? lines.lastIndexOf(header) : -1;
    const leadingComments: string[] = [];
    if (headerIdx > 0) {
      for (let k = headerIdx - 1; k >= 0 && lines[k].startsWith("#"); k--) {
        leadingComments.unshift(lines[k]);
      }
    }

    let depth = 1;
    let j = openBrace + 1;
    let inQuote = false;
    let quoteChar = "";

    while (j < n && depth > 0) {
      const char = content[j];
      if (inQuote) {
        if (char === quoteChar && content[j - 1] !== "\\") {
          inQuote = false;
        }
      } else if (char === '"' || char === "'") {
        inQuote = true;
        quoteChar = char;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
      }
      j++;
    }

    if (depth === 0) {
      const body = content.slice(openBrace + 1, j - 1);
      if (header && !header.startsWith("#")) {
        blocks.push({ header, body, leadingComments });
      }
      i = j;
    } else {
      break;
    }
  }

  return blocks;
}

/**
 * Имена сценариев, которыми Pegas суффиксирует route-файл
 * (`getProjectRouteFilePath`: `<project>-<env>.caddy`). Белый список нужен,
 * чтобы не отрезать часть настоящего имени проекта (`my-app-tools`).
 */
const FILE_ENV_SUFFIXES = new Set(["development", "dev", "production", "prod", "stage", "staging"]);

export interface ParsedProjectRoute {
  projectName: string;
  domains: string[];
  upstream: string;
  filePath: string;
  /** Метаданные маршрута из комментария `# pegas:...` (null — файл записан до 3.3.0). */
  meta: RouteMeta | null;
  /** Источник имени сервиса: метаданные точны, вывод из домена — приближение. */
  serviceSource: "meta" | "inferred";
  /** Имя сервиса: из метаданных или выведено из домена маршрута. */
  service: string;
  /** Сценарий маршрута. */
  env: string;
}

/**
 * Вывод имени сервиса из домена маршрута (issue #30).
 *
 * Dev-домены Pegas формируются как `<service>.<project>.localhost`, поэтому для
 * них имя сервиса извлекается точно. Для произвольного домена берётся первая
 * метка — это приближение, и вызывающий код помечает источник как `inferred`.
 *
 * Используется только для route-файлов, записанных до появления строки
 * метаданных `# pegas:...`: при её наличии имя сервиса берётся из метаданных.
 */
export function inferServiceFromDomain(domain: string, projectName: string): string {
  if (!domain) return "";
  const labels = domain.toLowerCase().split(".");
  // Точный случай: <service>.<project>.localhost
  const localIdx = labels.lastIndexOf("localhost");
  if (localIdx >= 2 && labels.slice(1, localIdx).join(".") === projectName.toLowerCase()) {
    return labels[0];
  }
  // Приближение: первая метка домена (www отбрасывается — это алиас, не сервис)
  const first = labels[0] === "www" ? labels[1] ?? "" : labels[0];
  return first ?? "";
}

/**
 * Вывод имени сервиса из scoped-upstream `<runtimeId>-<scenario>-<service>`.
 * Имя сервиса — последняя часть после дефиса; разбор неоднозначен, поэтому
 * применяется только когда домен имени не дал (например, publicHost TCP-маршрут).
 */
export function inferServiceFromUpstream(upstream: string): string {
  const host = upstream.split(":")[0];
  if (!host || host.includes(".")) return "";
  const lastDash = host.lastIndexOf("-");
  if (lastDash <= 0 || lastDash === host.length - 1) return "";
  return host.slice(lastDash + 1);
}

export function parseCaddyProjectFile(content: string, filename: string): ParsedProjectRoute[] {
  const base = path.basename(filename, ".caddy");
  let projectName = base;
  let fileEnv: string | undefined;

  // Шапка файла — точный источник: пишется connect/deploy вместе с маршрутами.
  const projectCommentMatch = content.match(/#\s*Auto-generated by Pegas for project:\s*([^\n\r\[]+)(?:\[([^\]]+)\])?/i);
  if (projectCommentMatch && projectCommentMatch[1]) {
    projectName = projectCommentMatch[1].trim();
    fileEnv = projectCommentMatch[2]?.trim() || fileEnv;
  }

  // Файлы, записанные до появления шапки (или рукописные): имя и сценарий берутся
  // из имени файла. Суффикс сценария отсекается только по белому списку.
  if (!fileEnv) {
    const lastDash = base.lastIndexOf("-");
    if (lastDash > 0) {
      const suffix = base.slice(lastDash + 1).toLowerCase();
      if (FILE_ENV_SUFFIXES.has(suffix)) {
        fileEnv = suffix;
        if (!projectCommentMatch) projectName = base.slice(0, lastDash);
      }
    }
  }

  const routes: ParsedProjectRoute[] = [];
  const topBlocks = parseCaddyTopLevelBlocks(content);

  const wwwRedirects = new Set<string>();
  for (const block of topBlocks) {
    if (block.body.includes("redir ") && block.header.startsWith("www.")) {
      wwwRedirects.add(block.header);
    }
  }

  for (const block of topBlocks) {
    const header = block.header;
    const body = block.body;

    if (body.includes("redir https://")) {
      continue;
    }

    const domainList = header
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter((d) => Boolean(d) && !d.startsWith("#"));

    const meta = parseRouteMeta(block.leadingComments);

    const proxyMatches = body.matchAll(/reverse_proxy\s+([^\s\n{}]+)/g);
    for (const pm of proxyMatches) {
      const upstream = pm[1].trim();
      const allDomains = [...domainList];
      for (const d of domainList) {
        const wwwVariant = `www.${d}`;
        if (wwwRedirects.has(wwwVariant) && !allDomains.includes(wwwVariant)) {
          allDomains.push(wwwVariant);
        }
      }

      // Метаданные маршрута приоритетны: имя проекта из них точнее, чем вывод
      // из имени файла (файл может содержать блоки нескольких владельцев).
      const project = meta?.project ?? projectName;
      // Имя сервиса: метаданные → домен → upstream. Первые два источника точны,
      // upstream-вывод неоднозначен, поэтому идёт последним.
      const service =
        meta?.service ||
        inferServiceFromDomain(allDomains[0] ?? "", project) ||
        inferServiceFromUpstream(upstream);
      const env = meta?.env || fileEnv || "";

      routes.push({
        projectName: project,
        domains: allDomains,
        upstream,
        filePath: filename,
        meta: meta ?? null,
        service,
        serviceSource: meta?.service ? "meta" : "inferred",
        env,
      });
      // Один блок — один маршрут: дальнейшие reverse_proxy (например, SPA api-prefix)
      // не должны порождать дубли строк дашборда.
      break;
    }
  }

  return routes;
}

/**
 * Сопоставление маршрута с контейнером по стабильным меткам Pegas (issue #9).
 *
 * Прежняя эвристика сравнивала `com.docker.compose.project` с именем проекта из
 * контракта и сопоставляла контейнер по подстроке имени. В v3 compose-проект
 * содержит runtimeId, а не projectName, поэтому статус всегда показывал
 * «Not started»; сопоставление по подстроке имени давало и обратную ошибку —
 * контейнер чужого проекта принимался за свой (критерий приёмки issue #9:
 * отсутствующий контейнер не должен сопоставляться с контейнером другого проекта).
 *
 * Порядок источников, все они основаны на метках, а не на схеме имён:
 * 1. метки Pegas + метаданные маршрута (`projectName` + `service` + `env`);
 * 2. сетевой алиас `<runtimeId>-<scenario>-<service>` — сверяется с тройкой
 *    меток контейнера посимвольно, поэтому разбор имени не неоднозначен
 *    (работает и для route-файлов, записанных до появления метаданных);
 * 3. метки compose (`com.docker.compose.project` + `...service`) — для
 *    контейнеров, поднятых не манифестом Pegas v3.
 */
export function matchContainerForRoute(
  upstream: string,
  projectName: string,
  containers: DockerContainerInfo[],
  meta?: { service?: string; env?: string } | null,
): DockerContainerInfo | undefined {
  const hostPart = upstream.split(":")[0];

  if (hostPart === "host.docker.internal" || hostPart === "127.0.0.1" || hostPart === "localhost") {
    return undefined;
  }

  const sameName = (a: string | undefined, b: string | undefined): boolean =>
    Boolean(a) && Boolean(b) && a!.toLowerCase() === b!.toLowerCase();

  // 1. Метки Pegas + метаданные маршрута — точное совпадение проекта, сервиса и сценария.
  if (meta?.service) {
    const labeled = containers.find((c) => {
      if (!sameName(c.pegasProjectName, projectName)) return false;
      if (!sameName(c.pegasService, meta.service)) return false;
      if (meta.env && !sameName(c.pegasScenario, meta.env)) return false;
      return true;
    });
    if (labeled) return labeled;
  }

  // 2. Сетевой алиас: сверяем upstream с тройкой меток, а не разбираем имя.
  //    Точное совпадение всей строки устраняет неоднозначность разделения
  //    «runtimeId / сценарий / сервис», когда сценарий или сервис содержат дефисы.
  //    Принадлежность к проекту подтверждается отдельно: runtimeId в алиасе —
  //    не projectName, поэтому без этой проверки контейнер чужого проекта
  //    с тем же именем сервиса матчился бы (критерий приёмки issue #9).
  const byAlias = containers.find(
    (c) => c.pegasProject && c.pegasScenario && c.pegasService &&
      `${c.pegasProject}-${c.pegasScenario}-${c.pegasService}` === hostPart &&
      (!projectName || sameName(c.pegasProjectName, projectName))
  );
  if (byAlias) return byAlias;

  // 3. Метки compose: имя сервиса внутри compose-проекта, совпадающего с проектом.
  const byCompose = containers.find((c) => {
    if (!c.composeService || !c.composeProject) return false;
    if (c.composeService.toLowerCase() !== hostPart.toLowerCase()) return false;
    return c.composeProject.toLowerCase() === projectName.toLowerCase();
  });
  if (byCompose) return byCompose;

  return undefined;
}

export function formatDockerStatus(container?: DockerContainerInfo, upstream?: string): {
  displayStatus: string;
  state: string;
  statusText: string;
} {
  if (!container) {
    if (
      upstream?.startsWith("host.docker.internal") ||
      upstream?.startsWith("127.0.0.1") ||
      upstream?.startsWith("localhost")
    ) {
      return {
        displayStatus: "\x1b[36m💻 Host (dev)\x1b[0m",
        state: "host",
        statusText: "Host (dev)",
      };
    }
    return {
      displayStatus: "\x1b[90m⚪ Not started\x1b[0m",
      state: "stopped",
      statusText: "Not started",
    };
  }

  const state = container.state?.toLowerCase();
  const rawStatus = container.status || "";

  if (state === "running") {
    const isHealthy = rawStatus.toLowerCase().includes("(healthy)");
    const isUnhealthy = rawStatus.toLowerCase().includes("(unhealthy)");
    const isStarting = rawStatus.toLowerCase().includes("(health: starting)");

    if (isHealthy) {
      return {
        displayStatus: "\x1b[32m🟢 Up (healthy)\x1b[0m",
        state: "running",
        statusText: "Up (healthy)",
      };
    }
    if (isUnhealthy) {
      return {
        displayStatus: "\x1b[31m🔴 Up (unhealthy)\x1b[0m",
        state: "running",
        statusText: "Up (unhealthy)",
      };
    }
    if (isStarting) {
      return {
        displayStatus: "\x1b[33m🟡 Up (starting)\x1b[0m",
        state: "running",
        statusText: "Up (starting)",
      };
    }

    const text = rawStatus ? `Up (${rawStatus.replace(/^Up\s+/i, "")})` : "Up";
    return {
      displayStatus: `\x1b[32m🟢 ${text}\x1b[0m`,
      state: "running",
      statusText: text,
    };
  }

  if (state === "restarting") {
    return {
      displayStatus: `\x1b[33m🟡 ${rawStatus}\x1b[0m`,
      state: "restarting",
      statusText: rawStatus,
    };
  }

  return {
    displayStatus: `\x1b[31m🔴 ${rawStatus || "Offline"}\x1b[0m`,
    state: state || "exited",
    statusText: rawStatus || "Offline",
  };
}

/** Разделитель полей в `--format`; не встречается в именах и метках Pegas. */
const PS_DELIMITER = "\x1f";

/**
 * Список контейнеров с метками Pegas.
 *
 * Метки читаются через `{{.Label "..."}}`, а не парсингом строки `{{.Labels}}`:
 * значение метки `pegas.domains` само содержит запятые, поэтому прежний regex
 * `([^,]+)` обрезал список доменов на первом же элементе.
 */
export async function getDockerContainers(): Promise<DockerContainerInfo[]> {
  const format = [
    "{{.ID}}",
    "{{.Names}}",
    "{{.Image}}",
    "{{.State}}",
    "{{.Status}}",
    "{{.Networks}}",
    "{{.Ports}}",
    "{{.RunningFor}}",
    '{{.Label "com.docker.compose.project"}}',
    '{{.Label "com.docker.compose.service"}}',
    '{{.Label "pegas.project"}}',
    '{{.Label "pegas.project-name"}}',
    '{{.Label "pegas.scenario"}}',
    '{{.Label "pegas.service"}}',
    '{{.Label "pegas.role"}}',
    '{{.Label "pegas.domains"}}',
    '{{.Label "pegas.endpoint"}}',
    '{{.Label "pegas.gateway"}}',
  ].join(PS_DELIMITER);

  try {
    const res = await runCommand("docker", ["ps", "-a", "--format", format]);
    if (!res.success || !res.stdout.trim()) {
      return [];
    }

    const containers: DockerContainerInfo[] = [];
    for (const line of res.stdout.trim().split("\n")) {
      const f = line.split(PS_DELIMITER);
      if (f.length < 17) continue;
      const pick = (v: string | undefined): string | undefined => {
        const t = (v ?? "").trim();
        return t ? t : undefined;
      };
      containers.push({
        id: (f[0] ?? "").trim(),
        name: (f[1] ?? "").trim(),
        image: (f[2] ?? "").trim(),
        state: (f[3] ?? "").trim().toLowerCase(),
        status: (f[4] ?? "").trim(),
        networks: (f[5] ?? "").split(",").map((n: string) => n.trim()).filter(Boolean),
        ports: (f[6] ?? "").trim(),
        runningFor: pick(f[7]),
        composeProject: pick(f[8]),
        composeService: pick(f[9]),
        pegasProject: pick(f[10]),
        pegasProjectName: pick(f[11]),
        pegasScenario: pick(f[12]),
        pegasService: pick(f[13]),
        pegasRole: pick(f[14]),
        pegasDomains: pick(f[15]),
        pegasEndpoint: pick(f[16]),
      });
    }
    return containers;
  } catch {
    return [];
  }
}

/** Память контейнеров одним вызовом: id → "12.3MiB / 7.7GiB". */
export async function getContainerMemory(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const res = await runCommand("docker", [
    "stats", "--no-stream", "--format", "{{.ID}}|{{.MemUsage}}", ...ids,
  ]);
  if (!res.success || !res.stdout.trim()) return {};
  const out: Record<string, string> = {};
  for (const line of res.stdout.trim().split("\n")) {
    const [id, mem] = line.split("|");
    if (id && mem) out[id.trim()] = mem.trim();
  }
  return out;
}

/**
 * Реальная проверка host-процесса (issue #30).
 *
 * Прежний статус `Host (dev)` печатался по факту записи маршрута в Caddyfile,
 * поэтому сервис выглядел работающим, даже если `bun run dev` не запущен и
 * шлюз отвечает 502. TCP-подключение к порту отражает действительность.
 * Таймаут короткий и проверки идут параллельно — status остаётся быстрым.
 */
export function probeTcpPort(port: number, host = "127.0.0.1", timeoutMs = 150): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function resolveInfraEndpoint(
  c: DockerContainerInfo,
  proj: string,
  svc: string,
  cleanPorts: string,
  startDir: string = process.cwd()
): string {
  if (c.pegasEndpoint) return c.pegasEndpoint;
  const hostPort = cleanPorts && cleanPorts !== "-" ? cleanPorts.split("->")[0].trim() : "";
  if (c.pegasDomains) {
    const firstDomain = c.pegasDomains.split(",")[0].trim();
    return hostPort ? `${firstDomain}:${hostPort}` : firstDomain;
  }
  const candidates = [
    path.join(startDir, "pegas.json"),
    path.join(startDir, proj, "pegas.json"),
    path.join(path.dirname(startDir), proj, "pegas.json"),
  ];
  for (const cPath of candidates) {
    try {
      if (fsSync.existsSync(cPath)) {
        const raw = fsSync.readFileSync(cPath, "utf-8");
        const contract = JSON.parse(raw);
        if (contract.projectName === proj) {
          const svcConf = contract.services?.[svc];
          const dList = svcConf?.domains?.development || svcConf?.domains;
          if (Array.isArray(dList) && dList[0]) {
            return hostPort ? `${dList[0]}:${hostPort}` : dList[0];
          }
          const pubHost = typeof svcConf?.publicHost === "object" ? svcConf.publicHost.development : undefined;
          if (pubHost) {
            return hostPort ? `${pubHost}:${hostPort}` : pubHost;
          }
        }
      }
    } catch {}
  }
  // issue #30: синтетический домен больше не выдумывается. Порт проброшен на хост —
  // показываем фактический адрес; не проброшен — сервис доступен только внутри сети.
  if (hostPort) {
    return `localhost:${hostPort}`;
  }
  return "(internal)";
}

/** "12.3MiB / 7.7GiB" → "12.3 MB". */
export function formatMemUsage(memUsage?: string): string {
  if (!memUsage) return "-";
  const used = memUsage.split("/")[0]?.trim();
  if (!used) return "-";
  return used.replace(/\s+/g, " ");
}

/** "2 hours ago" → "2h"; "3 days ago" → "3d". */
export function formatUptime(runningFor?: string): string {
  if (!runningFor) return "-";
  const m = runningFor.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?/i);
  if (!m) return "-";
  const unit = m[2].toLowerCase()[0];
  return `${m[1]}${unit}`;
}

/** Сокращённое имя сценария для узкой колонки ENV. */
export function shortEnv(env: string): string {
  const lower = env.toLowerCase();
  if (lower === "development") return "dev";
  if (lower === "production") return "prod";
  if (lower === "staging") return "stage";
  return lower;
}

/**
 * Хост-порт из строки `{{.Ports}}` контейнера.
 *
 * Docker различает публикацию и expose:
 * - `0.0.0.0:5432->5432/tcp`, `[::]:5432->5432/tcp` — порт опубликован на хосте;
 * - `5432/tcp` — порт доступен только внутри сети `pegas-network` (expose).
 * Возвращается только опубликованный порт: иначе эндпоинт `localhost:<port>`
 * обещал бы доступ, которого на хосте нет (issue #30 — честные эндпоинты).
 */
export function firstHostPort(ports?: string): string {
  if (!ports || ports === "-") return "";
  for (const entry of ports.split(",")) {
    const part = entry.trim();
    // Признак публикации — стрелка маппинга «хост -> контейнер».
    if (!part.includes("->")) continue;
    const hostSide = part.split("->")[0].trim();
    const colon = hostSide.lastIndexOf(":");
    const port = colon >= 0 ? hostSide.slice(colon + 1) : hostSide;
    if (/^\d+$/.test(port)) return port;
  }
  return "";
}

export interface StatusOptions {
  gatewayDir?: string;
  json?: boolean;
  /** Каталог запуска: его проект помечается ★ в дашборде. */
  cwd?: string;
  /** Не опрашивать host-порты и docker stats (быстрый вывод, например в тестах). */
  skipProbes?: boolean;
}

export async function handleStatus(options: StatusOptions = {}): Promise<void> {
  const isJson = options.json ?? false;

  const dockerOk = await checkDocker();
  const composeOk = await checkDockerCompose();
  const gatewayDir = await findGatewayDir(options.gatewayDir);

  const netInspect = await runCommand("docker", ["network", "inspect", "pegas-network"]);
  const networkOk = netInspect.success;

  const containerStatus = await getGatewayContainerStatus(gatewayDir);
  const isRunning = containerStatus.success && containerStatus.stdout.includes("caddy");

  const confDir = getConfDir(gatewayDir);
  const routes: ParsedProjectRoute[] = [];
  try {
    const files = await fs.readdir(confDir);
    for (const file of files) {
      if (!file.endsWith(".caddy")) continue;
      const filePath = path.join(confDir, file);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const parsed = parseCaddyProjectFile(content, file);
        routes.push(...parsed);
      } catch {}
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  // Текущий проект: status, запущенный из каталога проекта, помечает его строки ★.
  // pegas.json ищется сначала в каталоге запуска: findProjectRoot опирается на
  // .git/package.json, которых в минимальном каталоге проекта может не быть.
  let currentProject: string | undefined;
  const startDir = options.cwd ?? process.cwd();
  try {
    const direct = await fs.readFile(path.join(startDir, CONTRACT_FILENAME), "utf-8")
      .then((raw) => JSON.parse(raw)?.projectName as string | undefined)
      .catch(() => undefined);
    if (direct) {
      currentProject = direct;
    } else {
      const projectRoot = await findProjectRoot(startDir);
      if (projectRoot) {
        const raw = await fs.readFile(path.join(projectRoot, CONTRACT_FILENAME), "utf-8");
        currentProject = JSON.parse(raw)?.projectName;
      }
    }
  } catch {}

  const containers = await getDockerContainers();
  const appContainers = containers.filter((c) => c.name !== "pegas-gateway" && c.name !== "/pegas-gateway");

  // Один сервис (project + service + env) — одна строка: домены объединяются,
  // несколько route-файлов одного сервиса не дублируют строку.
  const rowsByKey = new Map<string, ServiceRow>();
  const usedContainerIds = new Set<string>();

  for (const route of routes) {
    const meta = route.meta;
    // service/env уже вычислены в parseCaddyProjectFile: метаданные маршрута,
    // затем вывод из домена, затем из upstream. Upstream-хост как имя сервиса
    // больше не показывается (issue #30: host.docker.internal не имя сервиса).
    const serviceName = route.service || route.upstream.split(":")[0];
    const env = route.env;
    const driver: ServiceRow["driver"] = meta?.driver ?? "unknown";
    const isHostRoute =
      driver === "bun" ||
      route.upstream.startsWith("host.docker.internal") ||
      route.upstream.startsWith("127.0.0.1") ||
      route.upstream.startsWith("localhost");

    const key = `${route.projectName}::${serviceName}::${env}`;
    let row = rowsByKey.get(key);
    if (!row) {
      row = {
        project: route.projectName,
        service: serviceName,
        env,
        driver: isHostRoute ? "bun" : driver === "unknown" ? "unknown" : "docker",
        endpoint: "",
        target: route.upstream,
        gateway: isHostRoute ? "linked" : "routed",
        health: "",
        state: "unknown",
        resources: isHostRoute ? "host" : "-",
        domains: [],
        port: meta?.port,
        current: currentProject === route.projectName,
      };
      rowsByKey.set(key, row);
    }
    for (const d of route.domains) {
      if (!row.domains.includes(d)) row.domains.push(d);
    }
    if (row.port === undefined && meta?.port) row.port = meta.port;

    const matched = isHostRoute
      ? undefined
      : matchContainerForRoute(route.upstream, route.projectName, appContainers, {
          // Выведенное имя сервиса безопасно передавать в сопоставление: при
          // ошибке вывода метки просто не совпадут, и ложного сопоставления
          // с контейнером другого проекта не возникнет (критерий приёмки #9).
          service: route.service || meta?.service,
          env,
        });
    if (matched) {
      row.container = matched.name.replace(/^\//, "");
      row.containerId = matched.id;
      row.image = matched.image;
      usedContainerIds.add(matched.id);
    }
  }

  // Инфраструктурные и фоновые сервисы: контейнеры есть, маршрута в шлюзе нет.
  for (const c of appContainers) {
    if (usedContainerIds.has(c.id)) continue;
    if (!c.pegasProjectName && !c.composeProject) continue;
    const proj = c.pegasProjectName || c.composeProject || "unknown";
    const svc = c.pegasService || c.composeService || c.name.replace(/^\//, "");
    const env = c.pegasScenario || "";
    const key = `${proj}::${svc}::${env}`;
    if (rowsByKey.has(key)) continue;
    rowsByKey.set(key, {
      project: proj,
      service: svc,
      env,
      driver: "docker",
      endpoint: "",
      target: c.image,
      gateway: "direct",
      health: "",
      state: c.state || "unknown",
      resources: "-",
      domains: c.pegasDomains ? c.pegasDomains.split(",").map((d) => d.trim()).filter(Boolean) : [],
      container: c.name.replace(/^\//, ""),
      containerId: c.id,
      image: c.image,
      current: currentProject === proj,
    });
  }

  const rows = [...rowsByKey.values()];

  // Память контейнеров — одним вызовом на все строки.
  const containerIds = rows.map((r) => r.containerId).filter(Boolean) as string[];
  const memById = options.skipProbes ? {} : await getContainerMemory(containerIds);

  // Реальное состояние: host-порты опрашиваются параллельно.
  const probes = rows.map(async (row) => {
    const container = row.containerId
      ? appContainers.find((c) => c.id === row.containerId)
      : undefined;

    if (row.driver === "bun" || !container) {
      const probePort = row.port ?? (Number(row.target.split(":")[1]) || undefined);
      if (row.driver === "bun" && probePort && !options.skipProbes) {
        const listening = await probeTcpPort(probePort);
        // «Маршрут объявлен, процесс не запущен» — штатное состояние connect,
        // а не проблема: разработчик поднимает host-сервис сам.
        row.state = listening ? "listening" : "not_started";
        row.health = listening ? "🟢 Listening" : "⚪ Not started";
      } else if (row.driver === "bun") {
        row.state = "unknown";
        row.health = "⚪ Unknown";
      } else {
        const { state, statusText } = formatDockerStatus(undefined, row.target);
        // Контейнер ещё не создан (connect без deploy) — тоже штатное состояние.
        row.state = container ? state : "not_started";
        row.health = container ? statusText : state === "host" ? "💻 Host" : "⚪ Not started";
      }
      return;
    }

    const { state, statusText } = formatDockerStatus(container, row.target);
    row.state = state;
    row.health = state === "running"
      ? (statusText.includes("healthy") ? "🟢 Running (healthy)"
        : statusText.includes("unhealthy") ? "🔴 Running (unhealthy)"
        : statusText.includes("starting") ? "🟡 Starting"
        : `🟢 Running (${formatUptime(container.runningFor)})`)
      : `🔴 ${statusText}`;
    row.resources = `${formatMemUsage(memById[container.id])} (${formatUptime(container.runningFor)})`;
    if (state === "running" && statusText.includes("unhealthy")) {
      row.issue = "healthcheck контейнера не проходит";
    } else if (state !== "running") {
      // Остановленный контейнер — не ошибка: это может быть осознанный down.
      row.health = `⚪ Not running (${statusText})`;
    }
  });
  await Promise.all(probes);

  // Эндпоинты: фактические адреса, а не выдуманные домены (issue #30).
  for (const row of rows) {
    const container = row.containerId ? appContainers.find((c) => c.id === row.containerId) : undefined;
    if (row.domains.length > 0) {
      // Веб-маршрут: домен шлюза. Локальные dev-домены — без замка Let's Encrypt.
      const isLocal = row.domains[0].endsWith(".localhost") || row.domains[0] === "localhost";
      row.endpoint = `${isLocal ? "🔧" : "🔒"} ${row.domains[0]}${row.domains.length > 1 ? ` +${row.domains.length - 1}` : ""}`;
    } else if (container) {
      row.endpoint = resolveInfraEndpoint(container, row.project, row.service, firstHostPort(container.ports), startDir);
    } else if (row.driver === "bun") {
      const port = row.port ?? Number(row.target.split(":")[1]);
      row.endpoint = port > 0 ? `localhost:${port}` : "(host)";
    } else {
      row.endpoint = "(internal)";
    }
  }

  rows.sort((a, b) =>
    a.project.localeCompare(b.project) || a.env.localeCompare(b.env) || a.service.localeCompare(b.service)
  );

  if (isJson) {
    const cleanProjects: ProjectDashboardItem[] = routes.map((route) => {
      const matched = matchContainerForRoute(route.upstream, route.projectName, appContainers, {
        service: route.meta?.service,
        env: route.meta?.env,
      });
      const { displayStatus, state, statusText } = formatDockerStatus(matched, route.upstream);
      return {
        project: route.projectName,
        domains: route.domains,
        upstream: route.upstream,
        status: statusText,
        state,
        displayStatus,
        container: matched ? matched.name.replace(/^\//, "") : undefined,
        containerId: matched?.id,
      };
    });

    console.log(
      JSON.stringify(
        {
          docker: dockerOk,
          compose: composeOk,
          network: { name: "pegas-network", exists: networkOk },
          gatewayDir,
          activeRoutesCount: routes.length,
          gateway: {
            docker: dockerOk,
            compose: composeOk,
            network: { name: "pegas-network", exists: networkOk },
            container: { running: isRunning, details: containerStatus.stdout },
            gatewayDir,
            activeRoutesCount: routes.length,
          },
          // Единый дашборд (issue #30): сервис — единица вывода, не домен.
          services: rows.map((r) => ({
            project: r.project,
            service: r.service,
            env: r.env,
            driver: r.driver,
            endpoint: r.endpoint,
            target: r.target,
            gateway: r.gateway,
            health: r.health.replace(/\x1b\[[0-9;]*m/g, ""),
            state: r.state,
            resources: r.resources,
            domains: r.domains,
            current: r.current,
            container: r.container,
            containerId: r.containerId,
            image: r.image,
            ...(r.issue ? { issue: r.issue } : {}),
          })),
          // Обратная совместимость: прежняя форма списка маршрутов.
          projects: cleanProjects,
          issues: rows.filter((r) => r.issue).map((r) => ({
            project: r.project,
            service: r.service,
            env: r.env,
            message: r.issue,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log("\n📡 \x1b[1mPegas Gateway Status:\x1b[0m\n");
  console.log(`  Docker Engine:      ${dockerOk ? "✓ Active" : "✗ Offline"}`);
  console.log(`  Docker Compose:     ${composeOk ? "✓ Available" : "✗ Missing"}`);
  console.log(`  Docker Network:     ${networkOk ? "✓ 'pegas-network' exists" : "✗ 'pegas-network' missing"}`);
  console.log(`  Caddy Container:    ${isRunning ? "✓ Running" : "✗ Stopped or not found"}`);
  console.log(`  Gateway Location:   ${gatewayDir}`);
  // Локальный CA нужен только для *.localhost. Публичные домены обслуживает
  // Let's Encrypt через Caddy — на проде ручной ca install не требуется.
  const hasLocalRoutes = routes.some((r) =>
    r.domains.some((d) => d === "localhost" || d.endsWith(".localhost"))
  );
  let tlsLine = hasLocalRoutes
    ? "  Local CA Trust:     ⚠ unknown (gateway PKI not reachable)"
    : "  Local CA Trust:     — public ACME (Let's Encrypt)";
  if (hasLocalRoutes) {
    try {
      const { readGatewayRootCert, isCaTrusted } = await import("../ca.js");
      const gwRoot = await readGatewayRootCert();
      if (gwRoot !== null) {
        const trusted = await isCaTrusted(process.platform, undefined, { gatewayRoot: gwRoot });
        tlsLine = trusted
          ? "  Local CA Trust:     ✓ trusted (https — зелёный замок)"
          : "  Local CA Trust:     ✗ NOT trusted — браузер покажет красный замок; лечение: pegas ca install";
      }
    } catch {}
  }
  console.log(tlsLine);
  console.log(`  Active Routes:      ${routes.length} domain(s)\n`);

  if (rows.length > 0) {
    console.log(`🚀 \x1b[1mPegas Services Dashboard\x1b[0m\n`);
    const headers = ["PROJECT", "SERVICE", "ENV", "DRIVER", "ENDPOINT", "TARGET", "GATEWAY", "HEALTH", "MEM / UP"];
    const gatewayLabel: Record<ServiceRow["gateway"], string> = {
      linked: "🔗 Linked",
      routed: "📦 Routed",
      direct: "➖ Direct",
      none: "—",
    };
    const tableRows = rows.map((r) => [
      r.project,
      r.service,
      shortEnv(r.env),
      r.driver,
      r.endpoint,
      r.target,
      gatewayLabel[r.gateway],
      r.health,
      r.resources,
    ]);
    console.log(renderTable({ headers, rows: tableRows }));
    console.log(`\nTotal: ${rows.length} service(s)\n`);

    const issues = rows.filter((r) => r.issue);
    if (issues.length > 0) {
      console.log(`⚠️  Обнаружено проблем: ${issues.length}`);
      for (const r of issues) {
        console.log(`   • ${r.project} [${r.service}] (${shortEnv(r.env)}): ${r.issue}`);
        if (r.driver === "bun") {
          console.log(`     ➔ Запустите процесс сервиса в каталоге проекта (host-драйвер не супервизируется Pegas).`);
        } else {
          console.log(`     ➔ Проверьте логи: pegas logs ${shortEnv(r.env) === "dev" ? "development" : r.env} ${r.service}`);
        }
      }
      console.log("");
    }
  } else {
    console.log("ℹ️  Активных сервисов Pegas не найдено.\n");
  }
}
