import path from "node:path";
import { createHash } from "node:crypto";
import { PegasContract, ServiceContract } from "./types.js";
import { validatePegasContract } from "./contract.js";

export interface RuntimeComposeOptions {
  projectRoot: string;
  projectId: string;
}

export interface RuntimeComposeResult {
  manifest: Record<string, unknown>;
  content: string;
  serviceHashes: Record<string, string>;
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

function isAppService(service: ServiceContract): boolean {
  if (service.role) return service.role === "app";
  return Boolean(service.build || service.command);
}

function getVolumeTarget(spec: string): string | undefined {
  const parts = spec.split(":");
  // Compose short syntax is source:target[:mode]. On Windows, the host drive
  // letter adds one extra colon before the target.
  if (/^[A-Za-z]:\\\\/.test(spec)) return parts[2]?.split(":")[0];
  return parts.length >= 2 ? parts[1] : undefined;
}

/**
 * Builds an ephemeral Compose document from the declarative contract.
 * JSON is valid YAML, which lets us avoid a runtime YAML dependency and safely
 * pass the document to `docker compose -f -` through stdin.
 */
export function createRuntimeCompose(
  contract: PegasContract,
  options: RuntimeComposeOptions
): RuntimeComposeResult {
  const issues = validatePegasContract(contract);
  if (issues.length > 0) {
    throw new Error(
      `Invalid Pegas Docker contract: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`
    );
  }
  if (contract.runtime !== "docker") {
    throw new Error('The generated Compose manifest requires runtime: "docker".');
  }

  const services: Record<string, unknown> = {};
  const namedVolumes = new Set<string>();
  const serviceHashes: Record<string, string> = {};

  for (const [serviceName, service] of Object.entries(contract.services)) {
    const app = isAppService(service);
    if (!service.build && !service.image) {
      throw new Error(
        `Service "${serviceName}" has no build or image. Stack-based default images are not available in this runtime stage.`
      );
    }

    const serviceHash = hashValue(service);
    serviceHashes[serviceName] = serviceHash;

    const generated: Record<string, unknown> = {
      restart: "unless-stopped",
      labels: {
        "pegas.project": options.projectId,
        "pegas.project-name": contract.projectName || options.projectId,
        "pegas.service": serviceName,
        "pegas.manifest-hash": serviceHash,
        "pegas.role": service.role || (app ? "app" : "infra"),
      },
      networks: {
        "pegas-network": {
          aliases: [`${options.projectId}-${serviceName}`],
        },
      },
    };

    if (service.build) {
      generated.build = {
        context: path.resolve(options.projectRoot, service.build.context),
        ...(service.build.dockerfile ? { dockerfile: service.build.dockerfile } : {}),
      };
    }
    if (service.image) generated.image = service.image;
    if (service.command) generated.command = service.command;
    const environment: Record<string, string> = { ...(service.env || {}) };
    if (service.hmr?.fileWatch === "polling") {
      environment.CHOKIDAR_USEPOLLING ??= "true";
      environment.WATCHPACK_POLLING ??= "true";
    } else if (service.hmr?.fileWatch === "events") {
      environment.CHOKIDAR_USEPOLLING ??= "false";
      environment.WATCHPACK_POLLING ??= "false";
    }
    if (Object.keys(environment).length > 0) generated.environment = environment;
    if (service.envFile) generated.env_file = [path.resolve(options.projectRoot, service.envFile)];
    if (service.port !== undefined) generated.expose = [String(service.port)];

    const volumes = [...(service.volumes || [])];
    if (app) {
      const source = path.resolve(options.projectRoot, service.bindMount || ".");
      volumes.unshift(`${source}:/workspace`);
      generated.working_dir = "/workspace";

      if (!volumes.some((volume) => getVolumeTarget(volume) === "/workspace/node_modules")) {
        const volumeName = `pegas-${options.projectId}-${serviceName}-node-modules`;
        volumes.push(`${volumeName}:/workspace/node_modules`);
        namedVolumes.add(volumeName);
      }
    }
    if (volumes.length > 0) generated.volumes = volumes;

    services[serviceName] = generated;
  }

  const manifest: Record<string, unknown> = {
    services,
    networks: {
      "pegas-network": { external: true, name: "pegas-network" },
    },
    ...(namedVolumes.size > 0
      ? { volumes: Object.fromEntries([...namedVolumes].sort().map((name) => [name, {}])) }
      : {}),
  };

  return {
    manifest,
    content: JSON.stringify(manifest, null, 2) + "\n",
    serviceHashes,
  };
}
