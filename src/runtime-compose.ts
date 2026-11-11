import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PegasContract, ScenarioMap, ServiceDriver } from "./types.js";
import { validatePegasContract, getEnvironmentDomains, getProjectRuntimeId } from "./contract.js";
import { composeProjectName, containerName, projectNetworkName, runtimeVolumeName } from "./naming.js";
import { classifySharedImage, sharedPoolName } from "./shared-infra.js";

/**
 * Генерация эфемерного compose-манифеста из v3-контракта (docs/internal/rfc/RFC_CONTRACT_V3.md, столп 3):
 * deploy -s <scenario> поднимает ТОЛЬКО сервисы с driver: "docker"; host-сервисы
 * (driver: "bun") в манифест не попадают — их запускает пользователь сам.
 * JSON — валидный YAML: манифест передаётся в docker compose -f - по stdin,
 * на диск не пишется.
 */

export interface RuntimeComposeOptions {
  projectRoot: string;
  projectId: string;
  environment?: string;
  /** Значения из .env: инжектятся в environment и раскрывают ${PLACEHOLDER}. */
  secretValues?: Record<string, string>;
}

export interface RuntimeComposeResult {
  manifest: Record<string, unknown>;
  content: string;
  serviceHashes: Record<string, string>;
  /** Фактически использованный сценарий (после фолбэка на scenarios[0]). */
  scenario: string;
  /** Имя compose-проекта — `name:` манифеста, единственный источник истины. */
  composeProject: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

/** Named-volume source из короткого синтаксиса ("pgdata:/path" → "pgdata"). */
function getNamedVolumeSource(volume: string): string | null {
  if (!volume || volume.startsWith("/") || volume.startsWith(".")) return null;
  const idx = volume.indexOf(":");
  if (idx <= 0) return null;
  const source = volume.slice(0, idx);
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source) ? source : null;
}

/** Значение сценарной карты (валидатор гарантировал полноту и точность ключей). */
function at<T>(map: ScenarioMap<T> | undefined, scenario: string): T | undefined {
  return map?.[scenario];
}

/**
 * Docker-сервисы сценария — единственные, кто попадает в манифест.
 * (Реэкспорт имени из contract.js для обратной совместимости импортов.)
 */
export { getDockerServices } from "./contract.js";

/**
 * Builds an ephemeral Compose document from the declarative v3 contract.
 * JSON is valid YAML: passed to docker compose -f - via stdin.
 */
/**
 * Схема URL по образу docker-образа (как в v2 internalUrl): redis → redis://,
 * postgres → postgresql://, остальное — http://.
 */
function schemeForImage(image: string | undefined): string {
  const img = (image || "").toLowerCase();
  if (img.includes("redis")) return "redis";
  if (img.includes("postgres") || img.includes("pgvector")) return "postgresql";
  return "http";
}

/**
 * Service discovery: разворачивает "pegas://<имя-сервиса>" во внутренний адрес
 * сервиса в сети pegas-network для текущего сценария:
 *   <scheme>://<projectId>-<scenario>-<service>:<port>
 * Схема выбирается по образу цели (redis -> redis, postgres -> postgresql,
 * иначе http). Порт — из port-карты цели; host-драйвер (bun) или отсутствие
 * port — ошибка: внутренний адрес должен быть выражаем в контракте.
 */
export function resolveInternalUrl(
  contract: PegasContract,
  scenario: string,
  serviceName: string,
  projectId: string,
  errorPath: string
): string {
  const svc = contract.services[serviceName];
  if (!svc) {
    throw new Error(errorPath + ": pegas://" + serviceName + " — сервиса нет в контракте (опечатка?).");
  }
  const targetDriver = svc.runtime?.[scenario]?.driver;
  if (targetDriver === "bun") {
    throw new Error(errorPath + ": pegas://" + serviceName + ' — сервис в сценарии "' + scenario + '" запускается host-драйвером (bun); внутренний адрес контейнерам недоступен.');
  }
  const port = svc.port?.[scenario];
  if (typeof port !== "number") {
    throw new Error(errorPath + ": pegas://" + serviceName + ' — у сервиса нет port в сценарии "' + scenario + '" (internalUrl требует логический порт).');
  }
  const image = svc.image?.[scenario];
  const scheme = schemeForImage(image);
  // issue #29: shared-сервис живёт в общем пуле вне compose-проекта:
  // адрес — сетевой алиас пула, а не алиас сервиса проекта.
  if (svc.scope?.[scenario] === "shared") {
    const profile = classifySharedImage(image);
    if (!profile) {
      throw new Error(errorPath + ": pegas://" + serviceName + ' — сервис в сценарии "' + scenario + '" объявлен shared, но его образ не является поддерживаемой разделяемой инфраструктурой.');
    }
    return scheme + "://" + sharedPoolName(profile, scenario) + ":" + port;
  }
  return scheme + "://" + projectId + "-" + scenario + "-" + serviceName + ":" + port;
}

/**
 * Контекст Runtime SDK (столп 6): то, что инжектится в PEGAS_CONTEXT каждого контейнера.
 * Сериализуется в JSON; обёртка — @netrunner714/pegas/runtime.
 */
export interface SdkServiceContext {
  driver: ServiceDriver;
  /** Логический порт сервиса в сценарии (undefined — не задан). */
  port?: number;
  /** Docker-алиас в сети pegas-network (только docker-драйвер). */
  alias?: string;
  /** Схема URL по образу (redis/postgresql/http). */
  scheme: string;
  /** Внутренний URL: scheme://alias:port (docker-драйвер с port). */
  internalUrl?: string;
  /** Публичные HTTP-домены через шлюз (без схемы). */
  domains?: string[];
  /** Первый домен с https:// — удобная ссылка для fetch/CORS. */
  url?: string;
}

export interface SdkContext {
  project: string;
  projectId: string;
  scenario: string;
  /** Имя текущего сервиса (в контейнере которого исполняется SDK). */
  service: string;
  services: Record<string, SdkServiceContext>;
  /** Несекретный конфиг текущего сервиса из services.<name>.env, развёрнутый по сценарию. */
  env?: Record<string, string>;
}

/**
 * Сборка PEGAS_CONTEXT для контейнера serviceName: все сервисы сценария
 * с их адресами. Scheme и internalUrl — та же семантика, что pegas:// в env.
 */
export function buildSdkContext(
  contract: PegasContract,
  scenario: string,
  projectId: string,
  serviceName: string
): string {
  const services: Record<string, SdkServiceContext> = {};
  for (const [name, svc] of Object.entries(contract.services)) {
    const driver = svc.runtime?.[scenario]?.driver ?? "docker";
    const port = svc.port?.[scenario];
    const image = svc.image?.[scenario];
    const scheme = schemeForImage(image);
    const sharedProfile = svc.scope?.[scenario] === "shared" ? classifySharedImage(image) : null;
    const alias = sharedProfile
      ? sharedPoolName(sharedProfile, scenario)
      : driver === "docker"
        ? projectId + "-" + scenario + "-" + name
        : undefined;
    const domains = svc.domains?.[scenario];
    const entry: SdkServiceContext = { driver, scheme };
    if (typeof port === "number") entry.port = port;
    if (alias) entry.alias = alias;
    if (alias && typeof port === "number") {
      entry.internalUrl = scheme + "://" + alias + ":" + port;
    }
    if (domains && domains.length > 0) {
      entry.domains = domains;
      entry.url = "https://" + domains[0];
    }
    services[name] = entry;
  }
  // Несекретный конфиг текущего сервиса из services.<name>.env, развёрнутый
  // по сценарию (pegas:// — во внутренний адрес). Тот же резолвинг, что
  // в манифесте, чтобы config() читал контракт, а не process.env.
  const env: Record<string, string> = {};
  const currentSvc = contract.services[serviceName];
  if (currentSvc?.env) {
    for (const [key, valueMap] of Object.entries(currentSvc.env)) {
      const v = valueMap[scenario];
      if (v === undefined) continue;
      if (typeof v === "string" && v.startsWith("pegas://")) {
        env[key] = resolveInternalUrl(contract, scenario, v.slice("pegas://".length), projectId, "services." + serviceName + ".env." + key);
      } else {
        env[key] = v;
      }
    }
  }
  const context: SdkContext = {
    project: contract.projectName,
    projectId,
    scenario,
    service: serviceName,
    services,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
  return JSON.stringify(context);
}

export function createRuntimeCompose(
  contract: PegasContract,
  options: RuntimeComposeOptions
): RuntimeComposeResult {
  const issues = validatePegasContract(contract);
  if (issues.length > 0) {
    throw new Error(
      `Invalid Pegas v3 contract: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`
    );
  }

  const scenario = options.environment || contract.scenarios[0];
  if (!contract.scenarios.includes(scenario)) {
    throw new Error(
      `Сценарий "${scenario}" не объявлен в scenarios (${contract.scenarios.join(", ")}). Опечатка ловится до деплоя (RFC, столп 2, правило 5).`
    );
  }

  const services: Record<string, unknown> = {};
  const namedVolumes = new Set<string>();
  const serviceHashes: Record<string, string> = {};

  for (const [serviceName, service] of Object.entries(contract.services)) {
    // Фильтр по драйверу: host-сервисы pegas не поднимает (столп 3)
    if (at(service.runtime, scenario)?.driver !== "docker") continue;
    // issue #29: shared-сервисы живут в общем пуле вне compose-проекта —
    // их поднимает deploy до compose up, в манифест они не попадают.
    if (at(service.scope, scenario) === "shared") continue;

    const image = at(service.image, scenario);
    const build = at(service.build, scenario);
    const command = at(service.command, scenario);
    const port = at(service.port, scenario);
    const ports = at(service.ports, scenario) || [];
    const volumes = at(service.volumes, scenario) || [];
    const healthcheck = at(service.healthcheck, scenario);
    const dependsOn = at(service.dependsOn, scenario);

    // Хэш эффективной конфигурации сервиса для манифеста
    const serviceHash = hashValue({
      service: stableValue({ ...service, runtime: service.runtime }),
      scenario,
      image,
      build: build ? { ...build } : null,
      command,
      port,
      ports,
      volumes,
      healthcheck,
      dependsOn,
    });
    serviceHashes[serviceName] = serviceHash;

    const envDomains = getEnvironmentDomains(service, scenario);
    const domainStr = envDomains.length > 0 ? envDomains.join(",") : undefined;
    const publicHost = at(service.publicHost, scenario);

    const generated: Record<string, unknown> = {
      restart: "unless-stopped",
      // issue #27: имя контейнера задаётся явно — compose больше не склеивает
      // его из случайного хеша проекта. Порядок: pegas-<проект>-<сервис>-<сценарий>-<runtimeId>.
      container_name: containerName({
        projectName: contract.projectName,
        scenario,
        service: serviceName,
        runtimeId: options.projectId,
      }),
      labels: {
        "pegas.project": options.projectId,
        "pegas.scenario": scenario,
        "pegas.project-name": contract.projectName,
        "pegas.service": serviceName,
        "pegas.manifest-hash": serviceHash,
        ...(domainStr ? { "pegas.domains": domainStr } : {}),
        ...(publicHost ? { "pegas.public-host": publicHost } : {}),
      },
      networks: {
        "pegas-network": {
          aliases: [`${options.projectId}-${scenario}-${serviceName}`],
        },
        "project-network": {
          aliases: [serviceName],
        },
      },
    };

    if (build) {
      const contextDir = resolveProjectDirectory(options.projectRoot, build.context, `services.${serviceName}.build.context`);
      generated.build = {
        context: path.resolve(options.projectRoot, build.context),
        ...(build.dockerfile ? { dockerfile: build.dockerfile } : {}),
        ...(build.target ? { target: build.target } : {}),
        ...(build.args ? { args: build.args } : {}),
      };
      generated.image = `pegas/${options.projectId}/${serviceName.toLowerCase()}:${serviceHash.slice(0, 12)}`;
      // Контекст обязан существовать — валидация на этапе генерации, не docker build
      void contextDir;
    } else if (image) {
      generated.image = image;
    }

    if (command) generated.command = command;

    // env: посервисная карта, развёрнутая по текущему сценарию.
    // Значения вида "pegas://<имя-сервиса>" — service discovery: pegas подставляет
    // внутренний адрес этого сервиса в сети pegas-network (scheme по образу image).
    const environment: Record<string, string> = {};
    if (service.env) {
      for (const [key, valueMap] of Object.entries(service.env)) {
        const v = valueMap[scenario];
        if (v === undefined) continue;
        if (typeof v === "string" && v.startsWith("pegas://")) {
          const target = v.slice("pegas://".length);
          environment[key] = resolveInternalUrl(contract, scenario, target, options.projectId, "services." + serviceName + ".env." + key);
        } else {
          environment[key] = v;
        }
      }
    }
    // Порт сервиса — платформенная инъекция (как PEGAS_CONTEXT): манифест подставляет
    // значение из port-карты контракта. Ручной env-ключ PORT в контракте — дубль и
    // источник рассинхрона; порты читают из инъекции (любой рантайм: Node/Rust/Go).
    const servicePort = service.port?.[scenario];
    if (typeof servicePort === "number") {
      environment.PORT = String(servicePort);
    }
    environment.PEGAS_SCENARIO ??= scenario;
    // Runtime SDK (столп 6): контекст всех сервисов сценария — типизированный доступ
    // из кода приложения через @netrunner714/pegas/runtime.
    environment.PEGAS_CONTEXT = buildSdkContext(contract, scenario, options.projectId, serviceName);
    if (service.secrets && service.secrets.length > 0) {
      environment.PEGAS_SECRETS = service.secrets.join(",");
      // Значения секретов не должны теряться: Compose-интерполяция ${VAR}
      // и SDK secret() читают process.env контейнера.
      for (const name of service.secrets) {
        const value = options.secretValues?.[name];
        if (value !== undefined && value !== "") environment[name] = value;
      }
    }
    // Разворачиваем точные плейсхолдеры ${KEY} из .env (например POSTGRES_PASSWORD).
    for (const [key, value] of Object.entries(environment)) {
      const m = /^\$\{([A-Z0-9_]+)\}$/.exec(value);
      if (m && options.secretValues?.[m[1]] !== undefined) environment[key] = options.secretValues[m[1]];
    }
    if (Object.keys(environment).length > 0) generated.environment = environment;

    // dependsOn: карта → compose-формат
    if (dependsOn && Object.keys(dependsOn).length > 0) {
      generated.depends_on = Object.fromEntries(
        Object.entries(dependsOn).map(([depName, dep]) => [depName, { condition: dep.condition }])
      );
    }

    // healthcheck: compose-объект (валидатор уже проверил форму)
    if (healthcheck && typeof healthcheck === "object") {
      generated.healthcheck = {
        test: (healthcheck as any).test,
        ...((healthcheck as any).interval ? { interval: (healthcheck as any).interval } : {}),
        ...((healthcheck as any).timeout ? { timeout: (healthcheck as any).timeout } : {}),
        ...((healthcheck as any).retries ? { retries: (healthcheck as any).retries } : {}),
        ...((healthcheck as any).startPeriod ? { start_period: (healthcheck as any).startPeriod } : {}),
      };
    }

    // ports: публикация на хост (public-tcp в не-dev; dev — отладочный доступ)
    if (ports.length > 0) generated.ports = [...ports];

    // port: логический порт — expose внутри сети (шлюз/соседи)
    if (port !== undefined) generated.expose = [String(port)];

    // volumes: named-тома из короткого синтаксиса
    const volumeList: string[] = [...volumes];
    for (const volume of volumes) {
      const namedSource = getNamedVolumeSource(volume);
      if (namedSource) namedVolumes.add(namedSource);
    }
    if (volumeList.length > 0) generated.volumes = volumeList;

    services[serviceName] = generated;
  }

  const composeProject = composeProjectName({
    projectName: contract.projectName,
    scenario,
    runtimeId: options.projectId,
  });
  const manifest: Record<string, unknown> = {
    // issue #27: имя compose-проекта — `pegas-<проект>-<сценарий>-<runtimeId>`.
    // Возвращается и в result.composeProject: вызывающий код берёт имя отсюда,
    // а не вычисляет заново (отдельное вычисление раньше расходилось с манифестом).
    name: composeProject,
    services,
    networks: {
      "pegas-network": { external: true, name: "pegas-network" },
      // Канонические имена сервисов внутри проекта (`db:5432`), независимо от
      // того, сколько проектов и сценариев живёт на машине.
      "project-network": {
        external: true,
        name: projectNetworkName({ runtimeId: options.projectId, scenario }),
      },
    },
    // issue #27: имена томов закреплены явно. Без `name:` compose префиксует их
    // именем проекта, и переименование проекта осиротило бы существующие тома
    // с данными. Явное имя повторяет историческую схему `<runtimeId>-<scenario>_<том>`:
    // плоскость данных не меняется вместе с cosmetic-неймингом.
    ...(namedVolumes.size > 0
      ? {
          volumes: Object.fromEntries(
            [...namedVolumes].sort().map((name) => [
              name,
              { name: runtimeVolumeName({ runtimeId: options.projectId, scenario, volume: name }) },
            ])
          ),
        }
      : {}),
  };

  return {
    manifest,
    content: JSON.stringify(manifest, null, 2) + "\n",
    serviceHashes,
    scenario,
    composeProject,
  };
}

/** Resolve an existing project directory without allowing symlink escapes. */
function resolveProjectDirectory(projectRoot: string, relativePath: string, field: string): string {
  const resolved = path.resolve(projectRoot, relativePath);
  if (isPathOutside(path.resolve(projectRoot), resolved)) {
    throw new Error(`${field} must resolve to a directory inside the project root.`);
  }
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    throw new Error(`${field} directory does not exist: ${relativePath}`);
  }
  if (isPathOutside(fs.realpathSync(projectRoot), realPath) || !fs.statSync(realPath).isDirectory()) {
    throw new Error(`${field} must resolve to a directory inside the project root.`);
  }
  return realPath;
}

function isPathOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export { getProjectRuntimeId };
