export interface GatewayContext {
  gatewayDir: string;
  networkName: string;
}

export interface AddOptions {
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

export interface InitOptions {
  cwd?: string;
  gatewayDir?: string;
  dryRun?: boolean;
  json?: boolean;
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

export interface ServiceContract {
  port?: number | string;
  upstream?: string;
  domains: {
    development?: string[];
    stage?: string[];
    production?: string[];
    dev?: string[];
    prod?: string[];
    [environment: string]: string[] | undefined;
  };
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
}

export interface PegasContract {
  projectName?: string;
  bootInfra?: boolean;
  devGateway?: DevGatewayConfig;
  services: Record<string, ServiceContract>;
}
