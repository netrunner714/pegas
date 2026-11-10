/**
 * Контракт Pegas v3: загрузка и валидация (docs/internal/rfc/RFC_CONTRACT_V3.md).
 * v2-парсер и харвесты удалены: обратной совместимости нет (major 3.0.0).
 * «Умного» чтения репозитория нет: переход v2→v3 — ручная правка контракта
 * по подсказкам pegas check (docs/internal/rfc/RFC_UX_V3.md, решение №2).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { PegasContract, ServiceContract, ScenarioMap } from "./types.js";
import { classifySharedImage } from "./shared-infra.js";

export const CONTRACT_FILENAME = "pegas.json";

/** Публичный URL JSON Schema контракта: включает IDE-подсказки в pegas.json. */
export const CONTRACT_SCHEMA_URL = "https://netrunner714.ru/schemas/pegas.json";

/** Паттерн имени сценария (столп 2, правило 4). */
const SCENARIO_NAME_REGEX = /^[a-z0-9-]+$/;

/** Паттерн имени сервиса (как compose service name). */
const SERVICE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Паттерн имени арендатора разделяемого пула (issue #29).
 * Ограничен алфавитом SQL-идентификаторов: значение становится именем базы и
 * роли PostgreSQL, а также частью имени compose-сервиса, поэтому только нижний
 * регистр, цифры и подчёркивание.
 */
const SHARED_TENANT_NAME_REGEX = /^[a-z_][a-z0-9_]*$/;

/** Сценарные поля сервиса: каждое обязано быть картой по scenarios. */
const SCENARIO_FIELDS = [
  "runtime", "image", "build", "command", "port", "ports", "domains",
  "publicHost", "volumes", "dependsOn", "healthcheck", "cors",
  "scope", "shared",
] as const;

export interface ContractValidationIssue {
  path: string;
  message: string;
}

/**
 * v2-канонизация имён сред удалена: в v3 имена сценариев обязаны совпадать
 * байт-в-байт с корневым списком scenarios (RFC, столп 2, правило 3).
 * Функция оставлена для вызовов интерфейсов команд, но НЕ канонизирует:
 * неизвестное имя — ошибка валидации.
 */
export function normalizeEnvironment(env: string | undefined, scenarios?: string[]): string {
  const value = (env || "").trim();
  if (!value) {
    if (scenarios && scenarios.length > 0) return scenarios[0];
    return "development";
  }
  return value;
}

/** Убирает протокол, креды, путь, порт и точки из домена (v2-хелпер, семантика сохранена). */
export function normalizeDomain(raw: string): string {
  let domain = raw.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.replace(/^.*@/, "");
  domain = domain.replace(/[/?#].*$/, "");
  domain = domain.replace(/:\d+$/, "");
  domain = domain.replace(/\.+$/, "");
  return domain;
}

/** Punycode-совместимое ASCII-имя домена (для файлов маршрутов; v2-хелпер). */
export function toAsciiDomain(domain: string): string {
  // WHATWG URL делает IDNA→punycode (президент.рф → xn--d1abbgf6aiiy.xn--p1ai)
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return domain;
  }
}

/** Слаг проекта из каталога или имени пакета (v2-хелпер для init/update). */
export function detectProjectSlug(projectDir: string): string {
  const base = path.basename(path.resolve(projectDir));
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

/** Идентификатор рантайм-инсталляции проекта (для алиасов и compose-проекта). */
export function getProjectRuntimeId(projectRoot: string, projectName: string): string {
  const content = JSON.stringify({ projectRoot, projectName });
  return createHash("sha256").update(content).digest("hex").slice(0, 10);
}

/** Домены сервиса для сценария (без канонизации: ключ обязан существовать точно). */
export function getEnvironmentDomains(serviceConfig: ServiceContract, scenario: string): string[] {
  const domains = serviceConfig.domains?.[scenario];
  return Array.isArray(domains) ? domains : [];
}

/** Список сценариев контракта. */
export function listAvailableEnvironments(contract: PegasContract): string[] {
  return contract.scenarios || [];
}

/** Docker-сервисы сценария: единственные, кого поднимает deploy -s <scenario>. */
export function getDockerServices(contract: PegasContract, scenario: string): Record<string, ServiceContract> {
  const out: Record<string, ServiceContract> = {};
  for (const [name, svc] of Object.entries(contract.services || {})) {
    if (svc.runtime?.[scenario]?.driver === "docker") out[name] = svc;
  }
  return out;
}

/** Host-сервисы сценария (driver: "bun") — pegas их не касается. */
export function getHostServices(contract: PegasContract, scenario: string): Record<string, ServiceContract> {
  const out: Record<string, ServiceContract> = {};
  for (const [name, svc] of Object.entries(contract.services || {})) {
    if (svc.runtime?.[scenario]?.driver === "bun") out[name] = svc;
  }
  return out;
}

/**
 * Роль сервиса — производная (столп 4a): domains → web; image без build → infra;
 * build → app. Поля role в контракте нет.
 */
export type ServiceRole = "web" | "infra" | "app";

export function getServiceRole(svc: ServiceContract): ServiceRole {
  if (svc.domains) return "web";
  if (svc.build) return "app";
  if (svc.image) return "infra";
  return "app";
}

/** Статус наружности сервиса в сценарии (столп 4a). */
export type ServiceExposure = "web" | "public-tcp" | "closed";

export function getServiceExposure(contract: PegasContract, name: string, scenario: string): ServiceExposure {
  const svc = contract.services[name];
  if (!svc) return "closed";
  if (svc.domains?.[scenario]?.length) return "web";
  const ports = svc.ports?.[scenario];
  if (ports && ports.length > 0 && (svc.publicHost?.[scenario] || scenario === "development")) return "public-tcp";
  return "closed";
}

/**
 * Валидация v3-контракта: все правила docs/internal/rfc/RFC_CONTRACT_V3.md (столпы 2, 3, 4, 4a, 4b, 5).
 * Рид-онли: ничего не чинит и не дописывает.
 */
export function validatePegasContract(value: unknown): ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  const add = (p: string, message: string) => issues.push({ path: p, message });

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ path: "$", message: "Contract must be a JSON object." }];
  }
  const contract = value as unknown as PegasContract & Record<string, unknown>;

  // --- Корень ---
  if (typeof contract.projectName !== "string" || !contract.projectName.trim()) {
    add("projectName", "Обязательное строковое поле (основа алиасов и dev-доменов).");
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(contract.projectName)) {
    add("projectName", "Имя проекта: [a-z0-9-]+, начинается с буквы/цифры.");
  }

  if (!Array.isArray(contract.scenarios) || contract.scenarios.length === 0) {
    add("scenarios", "Обязательный непустой список сценариев (источник истины для всех сценарных карт).");
  } else {
    const scenarios = contract.scenarios as string[];
    for (const [i, s] of scenarios.entries()) {
      if (typeof s !== "string" || !SCENARIO_NAME_REGEX.test(s)) {
        add(`scenarios[${i}]`, "Имя сценария: [a-z0-9-]+ (lowercase, без канонизации).");
      }
    }
    if (new Set(scenarios).size !== scenarios.length) {
      add("scenarios", "Имена сценариев не должны повторяться.");
    }
  }

  const scenarios: string[] = Array.isArray(contract.scenarios) ? contract.scenarios : [];
  const knownRootKeys = new Set(["$schema", "projectName", "scenarios", "gateway", "services"]);
  for (const key of Object.keys(contract)) {
    if (!knownRootKeys.has(key)) {
      add(key, `Неизвестное корневое поле v3. Удалено в v3: env (→ services.<name>.env), runtime (→ services.<name>.runtime), secrets (→ services.<name>.secrets), devGateway (→ gateway), envFile, role, replicas, bootInfra, deploy, hmr, upstream, routes, bindMount.`);
    }
  }

  // --- gateway ---
  if (!contract.gateway || typeof contract.gateway !== "object" || Array.isArray(contract.gateway)) {
    add("gateway", "Обязательная карта конфигурации шлюза по сценариям.");
  } else {
    validateScenarioKeys(contract.gateway as Record<string, unknown>, "gateway", scenarios, add);
    for (const [scenario, gw] of Object.entries(contract.gateway as Record<string, any>)) {
      if (!gw || typeof gw !== "object") {
        add(`gateway.${scenario}`, "Ожидался объект { httpPort, httpsPort, admin?, acmeEmail? }.");
        continue;
      }
      if (typeof gw.httpPort !== "number" || gw.httpPort < 1 || gw.httpPort > 65535) {
        add(`gateway.${scenario}.httpPort`, "Обязательное число 1–65535.");
      }
      if (typeof gw.httpsPort !== "number" || gw.httpsPort < 1 || gw.httpsPort > 65535) {
        add(`gateway.${scenario}.httpsPort`, "Обязательное число 1–65535.");
      }
    }
  }

  // --- services ---
  if (!contract.services || typeof contract.services !== "object" || Array.isArray(contract.services)) {
    add("services", "Обязательная карта сервисов.");
    return issues;
  }
  const services = contract.services as Record<string, ServiceContract & Record<string, unknown>>;
  if (Object.keys(services).length === 0) {
    add("services", "Контракт без сервисов бессмыслен: минимум один сервис.");
  }

  const knownServiceKeys = new Set([...SCENARIO_FIELDS, "env", "secrets"]);
  const conditions = new Set(["service_started", "service_healthy"]);

  for (const [name, svc] of Object.entries(services)) {
    if (!SERVICE_NAME_REGEX.test(name)) {
      add(`services.${name}`, "Имя сервиса: [a-z0-9][a-z0-9_-]*.");
    }
    const base = `services.${name}`;

    if (!svc || typeof svc !== "object" || Array.isArray(svc)) {
      add(base, "Сервис обязан быть объектом.");
      continue;
    }

    for (const key of Object.keys(svc)) {
      if (!knownServiceKeys.has(key)) {
        add(`${base}.${key}`, "Неизвестное поле сервиса v3 (в v3 удалены: role, envFile, upstream, routes, bindMount, hmr и т.д.).");
      }
    }

    // runtime — обязательная карта по сценариям
    if (!svc.runtime || typeof svc.runtime !== "object" || Array.isArray(svc.runtime)) {
      add(`${base}.runtime`, "Обязательная карта рантайма по сценариям: { <scenario>: { driver } }.");
    } else {
      validateScenarioKeys(svc.runtime as Record<string, unknown>, `${base}.runtime`, scenarios, add);
      for (const [scenario, rt] of Object.entries(svc.runtime as Record<string, any>)) {
        if (!rt || typeof rt !== "object") {
          add(`${base}.runtime.${scenario}`, "Ожидался объект { driver }.");
          continue;
        }
        if (rt.driver !== "docker" && rt.driver !== "bun") {
          add(`${base}.runtime.${scenario}.driver`, 'driver: "docker" | "bun" — других значений нет.');
        }
        for (const k of Object.keys(rt)) {
          if (k !== "driver") {
            add(`${base}.runtime.${scenario}.${k}`, "В runtime допустимо только поле driver (up-поля нет — RFC, столп 3).");
          }
        }
      }
    }

    // Сценарные поля: полнота матрицы + типы
    for (const field of SCENARIO_FIELDS) {
      if (field === "runtime") continue; // разобран выше
      if ((svc as any)[field] === undefined) continue;
      const raw = (svc as any)[field] as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        add(`${base}.${field}`, "Сценарное поле обязано быть картой { <scenario>: значение } (Zero Scalars, без исключений).");
        continue;
      }
      validateScenarioKeys(raw, `${base}.${field}`, scenarios, add);
    }

    // env: каждый ключ — карта сценариев
    if (svc.env !== undefined) {
      if (!svc.env || typeof svc.env !== "object" || Array.isArray(svc.env)) {
        add(`${base}.env`, "env — объект { KEY: { <scenario>: значение } }.");
      } else {
        for (const [key, val] of Object.entries(svc.env)) {
          if (val === null || typeof val !== "object" || Array.isArray(val)) {
            add(`${base}.env.${key}`, "Значение env-ключа обязано быть картой по сценариям (скаляры запрещены — Zero Scalars).");
            continue;
          }
          validateScenarioKeys(val as Record<string, unknown>, `${base}.env.${key}`, scenarios, add);
          for (const [sc, v] of Object.entries(val as Record<string, unknown>)) {
            if (typeof v !== "string") {
              add(`${base}.env.${key}.${sc}`, "Значение env-переменной — строка.");
              continue;
            }
            // Service discovery: "pegas://<имя-сервиса>" — ссылка на внутренний адрес.
            if (v.startsWith("pegas://")) {
              const target = v.slice("pegas://".length);
              const targetSvc = contract.services[target];
              if (!targetSvc) {
                add(`${base}.env.${key}.${sc}`, `pegas://${target} — сервиса нет в контракте (опечатка?).`);
              } else if (targetSvc.runtime?.[sc]?.driver === "bun") {
                add(`${base}.env.${key}.${sc}`, `pegas://${target} — цель в сценарии "${sc}" на host-драйвере (bun): внутренний адрес контейнерам недоступен.`);
              } else if (typeof targetSvc.port?.[sc] !== "number") {
                add(`${base}.env.${key}.${sc}`, `pegas://${target} — у цели нет port в сценарии "${sc}" (internalUrl требует логический порт).`);
              }
            }
          }
        }
      }
    }

    // secrets: плоский массив имён
    if (svc.secrets !== undefined) {
      if (!Array.isArray(svc.secrets) || svc.secrets.some((s) => typeof s !== "string" || !/^[A-Z0-9_]+$/.test(s))) {
        add(`${base}.secrets`, "Массив имён секретных ключей [A-Z0-9_]+ (интерфейс зависимостей; значения — в .env/CI).");
      }
    }

    // Правила по сценариям (столпы 4, 4a, 4b)
    for (const scenario of scenarios) {
      const sc = scenario;
      const rt = svc.runtime?.[sc];
      const isHost = rt?.driver === "bun";
      const isDocker = rt?.driver === "docker";
      const prefix = `${base}${scenarios.length > 1 ? `.${sc}` : ""}`;

      // domains: только HTTP + только с портом + не при host-драйвере
      const domains = (svc.domains as ScenarioMap<string[]> | undefined)?.[sc];
      if (domains !== undefined && Array.isArray(domains) && domains.length > 0) {
        if (isHost && sc !== "development") {
          add(`${prefix} domains`, "Домены при driver: \"bun\" разрешены только в development (dev-маршруты connect); в не-dev сценариях host-сервис не маршрутизируется.");
        }
        if (isDocker && domains.some((d) => d.endsWith(".localhost"))) {
          // dev-домен в docker-сценарии не запрещён жёстко (docker-dev возможен), но в не-dev — ошибка
        }
        const port = (svc.port as ScenarioMap<number> | undefined)?.[sc];
        if (port === undefined) {
          add(`${prefix} domains`, "Домены требуют port (логический порт upstream-а).");
        }
        for (const d of domains) {
          if (typeof d !== "string" || d.trim() !== normalizeDomain(d) || !d.includes(".")) {
            add(`${prefix} domains`, `Некорректный домен \"${d}\": только голый домен, без схемы/порта/пути.`);
          }
        }
      }

      // publicHost/ports — статус public-tcp
      const ports = (svc.ports as ScenarioMap<string[]> | undefined)?.[sc];
      const publicHost = (svc.publicHost as ScenarioMap<string> | undefined)?.[sc];
      const portsNonEmpty = Array.isArray(ports) && ports.length > 0;
      if (portsNonEmpty && sc !== "development" && !publicHost) {
        add(`${prefix} ports`, "Непустой ports вне development требует publicHost (статус public-tcp; осознанная публикация).");
      }
      if (publicHost && !portsNonEmpty) {
        add(`${prefix} publicHost`, "publicHost без непустых ports — бесполезное имя (столп 4a).");
      }
      if (publicHost !== undefined && typeof publicHost !== "string") {
        add(`${prefix} publicHost.${sc}`, "publicHost — DNS-имя (строка), порт публикации задаётся в ports.");
      }
      if (isHost && portsNonEmpty) {
        // host-процесс и так на хосте: проброс портов Docker не применим
        add(`${prefix} ports`, "ports несовместим с driver: \"bun\" (host-процесс уже на хосте).");
      }

      // dependsOn: при host-драйвере только {}
      const depends = (svc.dependsOn as ScenarioMap<Record<string, { condition: string }>> | undefined)?.[sc];
      if (depends != null && isHost && Object.keys(depends).length > 0) {
        add(`${prefix} dependsOn`, "Зависимости при host-драйвере запрещены (супервизора нет): используйте {}.");
      }
      if (depends != null) {
        for (const [depName, dep] of Object.entries(depends)) {
          if (!services[depName]) {
            add(`${prefix} dependsOn.${depName}`, "Зависимость ссылается на несуществующий сервис.");
          }
          if (!dep || typeof dep !== "object" || !conditions.has(dep.condition)) {
            add(`${prefix} dependsOn.${depName}.condition`, 'condition обязателен: "service_started" | "service_healthy".');
          }
          const depDocker = services[depName]?.runtime?.[sc]?.driver === "docker";
          if (depName in services && !depDocker) {
            add(`${prefix} dependsOn.${depName}`, "Зависимость возможна только от docker-сервиса этого же сценария.");
          }
        }
      }

      // docker-сервису нужен image или build; host-сервису — ни image, ни build в этом сценарии
      if (isDocker) {
        const image = (svc.image as ScenarioMap<string> | undefined)?.[sc];
        const build = (svc.build as ScenarioMap<unknown> | undefined)?.[sc];
        if (!image && !build) {
          add(`${prefix}`, "docker-сервису нужен image или build в этом сценарии.");
        }
      }
      if (isHost) {
        const image = (svc.image as ScenarioMap<string> | undefined)?.[sc];
        const build = (svc.build as ScenarioMap<unknown> | undefined)?.[sc];
        const command = (svc.command as ScenarioMap<string[]> | undefined)?.[sc];
        const volumes = (svc.volumes as ScenarioMap<string[]> | undefined)?.[sc];
        if (image) add(`${prefix} image`, "image несовместим с driver: \"bun\" (host-сервис не имеет образа).");
        if (build) add(`${prefix} build`, "build несовместим с driver: \"bun\" (host-сервис не собирается).");
        if (command) add(`${prefix} command`, "command — команда контейнера; при driver: \"bun\" неприменима.");
        if (volumes) add(`${prefix} volumes`, "volumes — тома контейнера; при driver: \"bun\" неприменимы.");
      }

      // healthcheck: строка-URL для host, объект/null для docker
      const hc = (svc.healthcheck as ScenarioMap<unknown> | undefined)?.[sc];
      if (hc !== undefined && hc !== null) {
        if (isHost && typeof hc !== "string") {
          add(`${prefix} healthcheck`, "Для host-сервиса healthcheck — строка HTTP ping-URL (или null).");
        }
        if (isDocker && (typeof hc === "string" || !Array.isArray((hc as any)?.test))) {
          add(`${prefix} healthcheck`, 'Для docker-сервиса healthcheck — объект { test: [...] } (compose-формат) или null.');
        }
      }

      // scope / shared (issue #29): разделяемый инфраструктурный пул
      const scope = (svc.scope as ScenarioMap<unknown> | undefined)?.[sc];
      const shared = (svc.shared as ScenarioMap<unknown> | undefined)?.[sc];

      if (scope !== undefined && scope !== "isolated" && scope !== "shared") {
        add(`${prefix} scope`, 'scope: "isolated" | "shared" — других значений нет.');
      }

      if (scope === "shared") {
        if (isHost) {
          add(`${prefix} scope`, 'scope: "shared" несовместим с driver: "bun" — пул это контейнер, host-процесс разделить нельзя.');
        }
        const image = (svc.image as ScenarioMap<string> | undefined)?.[sc];
        const build = (svc.build as ScenarioMap<unknown> | undefined)?.[sc];
        if (build) {
          add(`${prefix} build`, 'build несовместим с scope: "shared" — содержимое собранного образа принадлежит проекту, разделять его нельзя.');
        }
        if (!image) {
          add(`${prefix} image`, 'scope: "shared" требует публичный образ инфраструктуры (postgres:18-alpine, redis:7-alpine).');
        } else if (!classifySharedImage(image)) {
          add(`${prefix} image`, `Образ "${image}" не является поддерживаемой разделяемой инфраструктурой. Поддерживаются postgres, pgvector, timescaledb, postgis, redis, valkey; для прочего используйте scope: "isolated".`);
        }
        if (typeof (svc.port as ScenarioMap<number> | undefined)?.[sc] !== "number") {
          add(`${prefix} port`, 'scope: "shared" требует port: по нему формируется адрес пула в сети pegas-network.');
        }

        if (shared === undefined || shared === null) {
          add(`${prefix} shared`, 'scope: "shared" требует объект { name } — имя базы/роли (postgres) или префикса ключей (redis).');
        } else if (typeof shared !== "object" || Array.isArray(shared)) {
          add(`${prefix} shared`, "shared — объект { name, secret? } (или null для изолированного сценария).");
        } else {
          const tenantName = (shared as { name?: unknown }).name;
          if (typeof tenantName !== "string" || !SHARED_TENANT_NAME_REGEX.test(tenantName)) {
            add(`${prefix} shared.name`, "Имя арендатора: [a-z_][a-z0-9_]* — оно становится именем базы и роли PostgreSQL, поэтому другие символы недопустимы.");
          }
          const secretName = (shared as { secret?: unknown }).secret;
          if (secretName !== undefined) {
            if (typeof secretName !== "string" || !/^[A-Z0-9_]+$/.test(secretName)) {
              add(`${prefix} shared.secret`, "secret — имя секретного ключа [A-Z0-9_]+ (значение берётся из .env).");
            } else if (!Array.isArray(svc.secrets) || !svc.secrets.includes(secretName)) {
              add(`${prefix} shared.secret`, `Секрет "${secretName}" не объявлен в services.${name}.secrets: значение не будет доступно при подготовке арендатора.`);
            }
          }
        }

        // Пул поднимается с готовым томом: собственные тома сервиса привели бы к
        // двум источникам данных, поэтому в разделяемом сценарии они запрещены.
        const volumes = (svc.volumes as ScenarioMap<string[]> | undefined)?.[sc];
        if (Array.isArray(volumes) && volumes.length > 0) {
          add(`${prefix} volumes`, 'volumes несовместимы с scope: "shared" — данные хранятся в томе пула, который pegas создаёт и сохраняет сам.');
        }
        // Пул живёт вне compose-проекта: dependsOn от него не сработает.
        const depends = (svc.dependsOn as ScenarioMap<Record<string, unknown>> | undefined)?.[sc];
        if (depends && Object.keys(depends).length > 0) {
          add(`${prefix} dependsOn`, 'dependsOn несовместим с scope: "shared" — pegas поднимает пул до compose-проекта и ожидает его готовности.');
        }
      } else if (shared !== undefined && shared !== null) {
        add(`${prefix} shared`, `shared без scope: "shared" в этом сценарии — уберите поле или объявите scope: "shared".`);
      }
    }
  }

  return issues;
}

/** Полнота и точность ключей сценарной карты (столп 2, правило 2). */
function validateScenarioKeys(
  map: Record<string, unknown>,
  path: string,
  scenarios: string[],
  add: (p: string, message: string) => void
): void {
  const keys = Object.keys(map);
  for (const s of scenarios) {
    if (!keys.includes(s)) {
      add(path, `Сценарная карта неполна: нет ключа \"${s}\" (список scenarios — источник истины).`);
    }
  }
  for (const k of keys) {
    if (!scenarios.includes(k)) {
      add(path, `Лишний ключ \"${k}\": не объявлен в scenarios (включая опечатки — это ошибка, не игнор).`);
    }
  }
}

/** Читает и валидирует контракт с диска; выбрасывает ошибку с описанием issues. */
export async function loadContract(projectRoot: string): Promise<PegasContract> {
  const contractPath = path.join(projectRoot, CONTRACT_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(contractPath, "utf-8");
  } catch {
    throw new Error(`Контракт ${CONTRACT_FILENAME} не найден в ${projectRoot}. Напишите контракт v3 по схеме ${CONTRACT_SCHEMA_URL} (см. llms-контекст: pegas llms).`);
  }
  let contract: PegasContract;
  try {
    contract = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Некорректный JSON в ${contractPath}: ${err?.message || err}`);
  }
  const issues = validatePegasContract(contract);
  if (issues.length > 0) {
    const details = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(`Контракт ${CONTRACT_FILENAME} невалиден (${issues.length}): ${details}`);
  }
  return contract;
}
