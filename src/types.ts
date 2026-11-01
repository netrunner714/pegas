export interface GatewayContext {
  gatewayDir: string;
  networkName: string;
}

export interface RouteSnippetOptions {
  domain: string;
  upstream?: string;
  spa?: boolean;
  apiUpstream?: string;
  apiPrefix?: string;
  noWww?: boolean;
  security?: boolean;
  force?: boolean;
  dryRun?: boolean;
  gatewayDir?: string;
  json?: boolean;
  noExit?: boolean;
}

export type AddOptions = RouteSnippetOptions;

export interface InitOptions {
  cwd?: string;
  gatewayDir?: string;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  noExit?: boolean;
}

export interface UpdateOptions {
  latest?: boolean;
  json?: boolean;
  cwd?: string;
  noExit?: boolean;
}

export interface RouteInfo {
  domain: string;
  upstream: string;
  filePath: string;
  hasWwwRedirect: boolean;
  isSpa: boolean;
  apiUpstream?: string;
}

export interface ServiceBuildContract {
  context: string;
  dockerfile?: string;
  /** Build stage (multi-target Dockerfile); forwarded to compose as-is. */
  target?: string;
}

export type ServiceRole = "app" | "infra";
export type FileWatchMode = "auto" | "events" | "polling";

export interface ServiceHmrContract {
  fileWatch?: FileWatchMode;
}

export interface ServiceContract {
  port?: number | string;
  upstream?: string;
  /** Build an image from a project-relative context. Mutually exclusive with image. */
  build?: ServiceBuildContract;
  /** Use a prebuilt image instead of building one. */
  image?: string;
  /** Container command; when omitted, the image default is used. */
  command?: string[];
  /** Non-secret environment variables. */
  env?: Record<string, string>;
  /** Path to a gitignored env file; values are passed to Docker without logging. */
  envFile?: string;
  /** Additional named or bind volumes in Docker Compose short syntax. */
  volumes?: string[];
  /** Host source path mounted into the app container; defaults to project root. */
  bindMount?: string;
  /** Explicitly classify the service instead of relying on stack detection. */
  role?: ServiceRole;
  hmr?: ServiceHmrContract;
  /** Services that must be started before this service. */
  dependsOn?: string[] | Record<string, { condition?: "service_started" | "service_healthy" | "service_completed_successfully" }>;
  /** Docker healthcheck configuration. */
  healthcheck?: { test: string[]; interval?: string; timeout?: string; retries?: number; startPeriod?: string };
  domains: {
    development?: string[];
    stage?: string[];
    production?: string[];
    dev?: string[];
    prod?: string[];
    [environment: string]: string[] | undefined;
  };
}

export interface UninstallOptions {
  cwd?: string;
  json?: boolean;
  dryRun?: boolean;
  noExit?: boolean;
}

export interface CaOptions {
  action?: string;
  json?: boolean;
  dryRun?: boolean;
  noExit?: boolean;
}

export interface UpOptions {
  env?: string;
  cwd?: string;
  gatewayDir?: string;
  dryRun?: boolean;
  json?: boolean;
  noExit?: boolean;
  skipReadiness?: boolean;
  readinessTimeoutMs?: number;
  gracePeriodMs?: number;
  strictDns?: boolean;
  skipDnsCheck?: boolean;
  serverIp?: string;
  skipUp?: boolean;
  command?: string[];
  systemCaddy?: boolean;
  caddyPath?: string;
}

export interface DevGatewayConfig {
  httpPort?: number;
  httpsPort?: number;
  skipInstallTrust?: boolean;
  admin?: boolean;
  systemCaddy?: boolean;
  caddyPath?: string;
}

export interface DeployConfig {
  strictDns?: boolean;
  skipDnsCheck?: boolean;
  skipReadiness?: boolean;
}

/** Допустимые профили контракта. */
export type EnvironmentProfile = "development" | "stage" | "production";
/**
 * Значение глобального env-ключа: либо одинаковое для всех профилей
 * (строка), либо явная карта — в ней обязаны быть ВСЕ три профиля.
 * Секреты сюда не пишутся: им место в envFile (не переносится между
 * окружениями и не коммитится).
 */
export type EnvProfileValue = string | Record<EnvironmentProfile, string>;

export interface PegasContract {
  /** JSON Schema URL; enables editor hints for pegas.json. */
  $schema?: string;
  projectName?: string;
  /** Opt in to the declarative Docker runtime; absent/"host" preserves legacy behavior. */
  runtime?: "host" | "docker";
  bootInfra?: boolean;
  deploy?: DeployConfig;
  devGateway?: DevGatewayConfig;
  /**
   * Глобальный конфиг проекта (env-профили): переносится между
   * окружениями и коммитится. Значение — либо строка (одинаково для всех
   * профилей), либо карта development/stage/production со ВСЕМИ тремя
   * ключами. Инъектируется каждому сервису при deploy/dev; сервисный env
   * перекрывает глобальный. Секреты — только в envFile.
   */
  env?: Record<string, EnvProfileValue>;
  services: Record<string, ServiceContract>;
}
