/**
 * Типы контракта Pegas v3 (breaking, major 3.0.0).
 * Спецификация — docs/internal/rfc/RFC_CONTRACT_V3.md; эталон — example.json (генерируемый
 * артефакт schemas/pegas.json). v2-типы удалены: обратной совместимости нет.
 */

/** Значение сценарной карты: ровно по одному значению на каждый ключ из scenarios. */
export type ScenarioMap<T> = Record<string, T>;

/** Драйвер запуска сервиса в сценарии. */
export type ServiceDriver = "docker" | "bun";

/** Рантайм сервиса в сценарии. Единственное поле — driver (см. столп 3). */
export interface ServiceRuntime {
  driver: ServiceDriver;
}

/**
 * Область жизненного цикла сервиса в сценарии (issue #29).
 *
 * - `isolated` (по умолчанию): собственный контейнер проекта — прежнее поведение;
 * - `shared`: разделяемый инфраструктурный пул Pegas. Один инстанс на профиль
 *   образа обслуживает арендаторов (отдельная база/ключи на проект), поэтому
 *   N проектов занимают память одного процесса, а не N процессов.
 *
 * Применяется только к docker-сервисам с публичным образом (инфраструктура):
 * приложение с `build` не разделяемо — его код принадлежит проекту.
 */
export type ServiceScope = "isolated" | "shared";

/** Профиль разделяемого пула: какие инстансы поддерживать. */
export type SharedPoolKind = "postgres" | "redis";

/**
 * Параметры аренды в разделяемом пуле (сценарная карта).
 *
 * Имя базы/пользователя или префикс ключей должно различать проекты внутри
 * одного инстанса. Значение берётся из контракта, поэтому аренда идемпотентна
 * между деплоями и не требует ручного SQL.
 */
export interface SharedTenantConfig {
  /** Имя базы данных и роли (postgres) либо префикс ключей (redis). */
  name: string;
  /**
   * Имя секрета из `.env` со значением пароля/токена арендатора. Значение
   * передаётся через stdin `docker exec` и не сохраняется на диск.
   */
  secret?: string;
}

/** Конфигурация шлюза для сценария (замещает v2 devGateway и статический gateway). */
export interface GatewayScenarioConfig {
  /** Хостовый HTTP-порт шлюза (обычно 80). */
  httpPort: number;
  /** Хостовый HTTPS-порт шлюза (обычно 443). */
  httpsPort: number;
  /** Включить admin-интерфейс Caddy (:2019) для сценария. */
  admin?: boolean;
  /** Email для ACME/Let's Encrypt; требуется для не-dev HTTPS-сценариев. */
  acmeEmail?: string;
}

/** Docker-healthcheck для контейнера (сценарная карта). */
export interface DockerHealthcheck {
  test: string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
}

/**
 * Healthcheck сервиса:
 * - docker-сервисы: объект compose-healthcheck;
 * - host-сервисы (bun): строка HTTP ping-URL — информативна для агента/доков,
 *   pegas её не опрашивает (супервизора нет);
 * - null — healthcheck отсутствует (воркеры без endpoint).
 */
export type ServiceHealthcheck = DockerHealthcheck | string | null;

/** Сборка docker-образа из репозитория (сценарная карта; null в сценариях host-драйвера). */
export interface ServiceBuild {
  context: string;
  dockerfile?: string;
  /** Stage multi-target Dockerfile; передаётся в compose как есть. */
  target?: string;
  /** Build-аргументы; передаются в compose как есть. */
  args?: Record<string, string>;
}

/** Условие готовности зависимости (как в compose). */
export type DependCondition = "service_started" | "service_healthy";

/** Зависимость от сервиса сценария. */
export interface ServiceDependency {
  condition: DependCondition;
}

/** dependsOn-карта сценария: имя сервиса → условие. Пустой объект допустим. */
export type ScenarioDependencies = Record<string, ServiceDependency>;

/**
 * Сервис v3. Все сценарные поля — строгие карты по scenarios (Zero Scalars):
 * отсутствие ключа или лишний ключ — ошибка валидации, не дефолт.
 */
export interface ServiceContract {
  /** Драйвер запуска по сценариям. Единственное поле рантайма; "up"-поля нет. */
  runtime: ScenarioMap<ServiceRuntime>;
  /** Docker-образ (сценарная карта); для docker-сервисов обязателен, если нет build. */
  image?: ScenarioMap<string>;
  /** Сборка образа (сценарная карта; null — сценарий не собирается, host-драйвер). */
  build?: ScenarioMap<ServiceBuild | null>;
  /** Команда процесса внутри контейнера (сценарная карта). */
  command?: ScenarioMap<string[]>;
  /** Логический TCP-порт сервиса (сценарная карта); обязателен при domains. */
  port?: ScenarioMap<number>;
  /** Физический проброс портов на хост (сценарная карта; [] вне dev — норма). */
  ports?: ScenarioMap<string[]>;
  /** HTTP-домены через шлюз (сценарная карта; только для web-сервисов). */
  domains?: ScenarioMap<string[]>;
  /** Публичное DNS-имя TCP-сервиса (сценарная карта; требует непустого ports вне dev). */
  publicHost?: ScenarioMap<string>;
  /** Named-тома (сценарная карта). */
  volumes?: ScenarioMap<string[]>;
  /** Зависимости запуска (сценарная карта; при host-драйвере сценария — {}). */
  dependsOn?: ScenarioMap<ScenarioDependencies>;
  /** Healthcheck (сценарная карта). */
  healthcheck?: ScenarioMap<ServiceHealthcheck>;
  /** Несекретные значения конфигурации (Zero Scalars: карта сценариев на каждый ключ). */
  env?: Record<string, ScenarioMap<string>>;
  /** CORS-сервисов; false/undefined — без заголовков. */
  cors?: ScenarioMap<boolean>;
  /**
   * Имена секретных ключей, требуемых сервисом (интерфейс зависимостей).
   * Значения — из .env (dev) / CI-хранилища (prod). Замещает v2 envFile/root secrets.
   */
  secrets?: string[];
  /**
   * Область жизненного цикла сервиса по сценариям (issue #29).
   * Отсутствие поля — `isolated` (прежнее поведение: собственный контейнер).
   */
  scope?: ScenarioMap<ServiceScope>;
  /**
   * Параметры аренды в разделяемом пуле по сценариям (issue #29).
   * Обязательно для сценариев с `scope: "shared"`; null — сценарий изолирован.
   */
  shared?: ScenarioMap<SharedTenantConfig | null>;
}

/** Корневой контракт v3. */
export interface PegasContract {
  /** URL JSON Schema; включает IDE-подсказки. */
  $schema?: string;
  /** Имя проекта; основа алиасов, имён compose-проектов и dev-доменов. */
  projectName: string;
  /**
   * Явный список сценариев проекта — источник истины для всех сценарных карт.
   * Минимум один; имена [a-z0-9-]+; карты обязаны совпадать байт-в-байт.
   */
  scenarios: string[];
  /** Конфигурация шлюза по сценариям. */
  gateway: ScenarioMap<GatewayScenarioConfig>;
  services: Record<string, ServiceContract>;
}

/** Опции команд (без v2-полей). */
export interface InitOptions {
  cwd?: string;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  noExit?: boolean;
}

export interface CheckOptions {
  cwd?: string;
  json?: boolean;
  noExit?: boolean;
}

export interface CaOptions {
  action?: string;
  json?: boolean;
  dryRun?: boolean;
  noExit?: boolean;
}

export interface UpdateOptions {
  latest?: boolean;
  json?: boolean;
  cwd?: string;
  noExit?: boolean;
}

/** Информация о маршруте из route-файла шлюза (модуль gateway). */
export interface RouteInfo {
  domain: string;
  upstream: string;
  filePath: string;
  hasWwwRedirect: boolean;
  isSpa: boolean;
  apiUpstream?: string;
}

/** Опции генерации Caddy-сниппета (модуль generator). */
export interface RouteSnippetOptions {
  domain: string;
  upstream?: string;
  spa?: boolean;
  apiUpstream?: string;
  apiPrefix?: string;
  noWww?: boolean;
  security?: boolean;
  routes?: Record<string, string | { to: string; websocket?: boolean }>;
  cors?: boolean | string[] | import("./types.js").CorsConfig;
  corsOrigins?: string[];
  /**
   * Метаданные маршрута (issue #30): записываются комментарием `# pegas:...`
   * перед блоком домена. По ним `pegas status` определяет сервис, сценарий и
   * драйвер маршрута без эвристики по имени файла.
   */
  meta?: import("./route-meta.js").RouteMeta;
  force?: boolean;
  dryRun?: boolean;
  gatewayDir?: string;
  json?: boolean;
  noExit?: boolean;
}

export interface CorsConfig {
  origins?: string[];
  methods?: string[];
  headers?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

