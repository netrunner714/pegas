import { describe, expect, it } from "bun:test";
import {
  validatePegasContract,
  interpolateServiceReferences,
  resolveServiceProperty,
  extractServiceReferences,
} from "./contract.js";
import { createRuntimeCompose } from "./runtime-compose.js";
import { PegasContract } from "./types.js";

describe("service self-references (${services.<name>.<prop>})", () => {
  const baseContract: PegasContract = {
    projectName: "my-app",
    runtime: "docker",
    services: {
      api: {
        image: "node:20-alpine",
        port: 4000,
        domains: {
          development: ["api.my-app.localhost"],
          stage: ["api-stage.example.com"],
          production: ["api.example.com"],
        },
      },
      web: {
        image: "node:20-alpine",
        port: 3000,
        domains: {
          development: ["web.my-app.localhost"],
          stage: ["stage.example.com"],
          production: ["example.com"],
        },
      },
      db: {
        image: "postgres:18-alpine",
        role: "infra",
        port: 5432,
        domains: {
          development: ["pg18.my-app.localhost"],
          stage: ["pg18.example.com"],
          production: ["pg18.example.com"],
        },
      },
    },
  };

  it("extracts service references correctly from strings", () => {
    const refs = extractServiceReferences("${services.web.url}/auth,${services.api.internalUrl}");
    expect(refs).toEqual([
      { raw: "${services.web.url}", service: "web", property: "url" },
      { raw: "${services.api.internalUrl}", service: "api", property: "internalUrl" },
    ]);
  });

  it("resolves url/origin with correct scheme (http for dev, https for prod)", () => {
    const devUrl = resolveServiceProperty("web", "url", baseContract, "development");
    const prodUrl = resolveServiceProperty("web", "url", baseContract, "production");
    expect(devUrl).toBe("http://web.my-app.localhost");
    expect(prodUrl).toBe("https://example.com");

    const devOrigin = resolveServiceProperty("api", "origin", baseContract, "development");
    const prodOrigin = resolveServiceProperty("api", "origin", baseContract, "production");
    expect(devOrigin).toBe("http://api.my-app.localhost");
    expect(prodOrigin).toBe("https://api.example.com");
  });

  it("resolves wsUrl with correct scheme (ws for dev, wss for prod)", () => {
    const devWs = resolveServiceProperty("api", "wsUrl", baseContract, "development");
    const prodWs = resolveServiceProperty("api", "wsUrl", baseContract, "production");
    expect(devWs).toBe("ws://api.my-app.localhost");
    expect(prodWs).toBe("wss://api.example.com");
  });

  it("resolves host and domain without scheme", () => {
    const devHost = resolveServiceProperty("web", "host", baseContract, "development");
    const prodDomain = resolveServiceProperty("web", "domain", baseContract, "production");
    expect(devHost).toBe("web.my-app.localhost");
    expect(prodDomain).toBe("example.com");
  });

  it("resolves port and internalUrl", () => {
    const apiPort = resolveServiceProperty("api", "port", baseContract, "development");
    const apiInternal = resolveServiceProperty("api", "internalUrl", baseContract, "production");
    expect(apiPort).toBe("4000");
    expect(apiInternal).toBe("http://api:4000");

    const dbInternal = resolveServiceProperty("db", "internalUrl", baseContract, "development");
    expect(dbInternal).toBe("postgresql://db:5432");
  });

  it("interpolates multiple and composed references within templates", () => {
    const template = "${services.web.url}/callback,${services.api.url}/v1";
    const resolvedDev = interpolateServiceReferences(template, baseContract, "development");
    const resolvedProd = interpolateServiceReferences(template, baseContract, "production");
    expect(resolvedDev).toBe("http://web.my-app.localhost/callback,http://api.my-app.localhost/v1");
    expect(resolvedProd).toBe("https://example.com/callback,https://api.example.com/v1");
  });

  it("allows top-level scalar service reference shorthand in global env", () => {
    const contract: PegasContract = {
      ...baseContract,
      env: {
        WEB_URL: "${services.web.url}",
        API_INTERNAL_URL: "${services.api.internalUrl}",
      },
    };
    const issues = validatePegasContract(contract);
    expect(issues).toEqual([]);
  });

  it("allows service references inside profile maps and service.env", () => {
    const contract: PegasContract = {
      ...baseContract,
      env: {
        CORS_ORIGIN: {
          development: "${services.web.url},http://localhost:5173",
          stage: "${services.web.url}",
          production: "${services.web.url}",
        },
      },
      services: {
        ...baseContract.services,
        web: {
          ...baseContract.services.web,
          env: {
            API_URL: "${services.api.url}",
            API_INTERNAL_URL: "${services.api.internalUrl}",
          },
        },
      },
    };
    const issues = validatePegasContract(contract);
    expect(issues).toEqual([]);
  });

  it("rejects unknown service in service reference", () => {
    const contract: PegasContract = {
      ...baseContract,
      env: {
        WEB_URL: "${services.ghost_service.url}",
      },
    };
    const issues = validatePegasContract(contract);
    expect(issues.some((i) => i.message.includes('Unknown service "ghost_service"'))).toBe(true);
  });

  it("rejects unknown property in service reference", () => {
    const contract: PegasContract = {
      ...baseContract,
      env: {
        WEB_URL: "${services.web.nonexistent_property}",
      },
    };
    const issues = validatePegasContract(contract);
    expect(issues.some((i) => i.message.includes('Unknown property "nonexistent_property"'))).toBe(true);
  });

  it("rejects service reference when referenced service lacks domains for a profile", () => {
    const contract: PegasContract = {
      ...baseContract,
      services: {
        ...baseContract.services,
        worker: {
          role: "worker",
          // worker has no domains!
        },
      },
      env: {
        WORKER_URL: "${services.worker.url}",
      },
    };
    const issues = validatePegasContract(contract);
    expect(issues.some((i) => i.message.includes('Service "worker" referenced in "${services.worker.url}" has no domains defined'))).toBe(true);
  });

  it("resolves service references end-to-end in createRuntimeCompose", () => {
    const contract: PegasContract = {
      ...baseContract,
      env: {
        WEB_URL: "${services.web.url}",
        VITE_WS_URL: "${services.api.wsUrl}",
      },
      services: {
        ...baseContract.services,
        api: {
          ...baseContract.services.api,
          env: {
            INTERNAL_CLIENT_URL: "${services.web.internalUrl}",
          },
        },
      },
    };

    const devCompose = createRuntimeCompose(contract, {
      projectRoot: "/tmp",
      projectId: "test",
      environment: "development",
    });
    const devApiEnv = (devCompose.manifest.services as any).api.environment;
    expect(devApiEnv.WEB_URL).toBe("http://web.my-app.localhost");
    expect(devApiEnv.VITE_WS_URL).toBe("ws://api.my-app.localhost");
    expect(devApiEnv.INTERNAL_CLIENT_URL).toBe("http://web:3000");

    const prodCompose = createRuntimeCompose(contract, {
      projectRoot: "/tmp",
      projectId: "test",
      environment: "production",
    });
    const prodApiEnv = (prodCompose.manifest.services as any).api.environment;
    expect(prodApiEnv.WEB_URL).toBe("https://example.com");
    expect(prodApiEnv.VITE_WS_URL).toBe("wss://api.example.com");
    expect(prodApiEnv.INTERNAL_CLIENT_URL).toBe("http://web:3000");
  });
});
