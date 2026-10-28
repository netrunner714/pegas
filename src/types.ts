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
  gatewayDir?: string;
  email?: string;
  networkName?: string;
  server?: boolean;
  project?: boolean;
  json?: boolean;
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
  upstream: string;
  domains: {
    dev: string[];
    prod: string[];
  };
}

export interface PegasContract {
  projectName?: string;
  bootInfra?: boolean;
  services: Record<string, ServiceContract>;
}
