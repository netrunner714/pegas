import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { PegasContract, ServiceContract } from "./types.js";
import { validatePegasContract } from "./contract.js";

export interface RuntimeComposeOptions {
  projectRoot: string;
  projectId: string;
  environment?: string;
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

const INFRA_IMAGES: Record<string, string> = {
  postgres: "postgres:17",
  postgresql: "postgres:17",
  redis: "redis:8-alpine",
  mongo: "mongo:8",
  mongodb: "mongo:8",
  mysql: "mysql:9",
  mariadb: "mariadb:11",
  rabbitmq: "rabbitmq:4-management",
  memcached: "memcached:1.6-alpine",
};

interface AppDefaults {
  image: string;
  command: string[];
  dependencyTarget: string;
  lockHash: string;
  runtimeVersion: string;
  packageManager: string;
  packageManagerVersion: string;
  dockerfileInline: string;
  imageHash: string;
}

function readJson(file: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function firstVersion(value: string, fallback: string): string {
  const match = value.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [match[1], match[2], match[3]].filter(Boolean).join(".") : fallback;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function resolveAppDefaults(
  serviceName: string,
  service: ServiceContract,
  projectRoot: string,
  environment: string
): AppDefaults {
  const sourceDir = path.resolve(projectRoot, service.bindMount || service.build?.context || ".");
  const pkg = readJson(path.join(sourceDir, "package.json"));
  const packageManagerField = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  const hasBunLock = ["bun.lock", "bun.lockb"].some((file) => fs.existsSync(path.join(sourceDir, file)));
  const hasPnpmLock = fs.existsSync(path.join(sourceDir, "pnpm-lock.yaml"));
  const hasYarnLock = fs.existsSync(path.join(sourceDir, "yarn.lock"));
  const hasNpmLock = fs.existsSync(path.join(sourceDir, "package-lock.json"));
  const pythonProject =
    fs.existsSync(path.join(sourceDir, "pyproject.toml")) ||
    fs.existsSync(path.join(sourceDir, "requirements.txt"));

  let stack: "node" | "bun" | "python";
  let runtimeVersion: string;
  let packageManager: string;
  let packageManagerVersion: string;
  let image: string;
  let dependencyTarget: string;
  let installCommand: string;
  let defaultCommand: string[];

  if (pkg.name || fs.existsSync(path.join(sourceDir, "package.json"))) {
    stack = packageManagerField.startsWith("bun@") || hasBunLock ? "bun" : "node";
    if (stack === "bun") {
      runtimeVersion = firstVersion(
        packageManagerField.startsWith("bun@") ? packageManagerField : readText(path.join(sourceDir, ".bun-version")),
        "1"
      );
      packageManager = "bun";
      packageManagerVersion = packageManagerField || `bun@${runtimeVersion}`;
      image = `oven/bun:${runtimeVersion}`;
      installCommand = hasBunLock ? "bun install --frozen-lockfile" : "bun install";
    } else {
      const engines = typeof pkg.engines?.node === "string" ? pkg.engines.node : "";
      runtimeVersion = firstVersion(readText(path.join(sourceDir, ".nvmrc")) || engines, "24");
      if (packageManagerField.startsWith("pnpm@") || hasPnpmLock) packageManager = "pnpm";
      else if (packageManagerField.startsWith("yarn@") || hasYarnLock) packageManager = "yarn";
      else packageManager = "npm";
      packageManagerVersion = packageManagerField || `${packageManager}-bundled`;
      image = `node:${runtimeVersion}-bookworm`;
      const yarnLock = readText(path.join(sourceDir, "yarn.lock"));
      const yarnMajor = packageManagerField.startsWith("yarn@")
        ? firstVersion(packageManagerField, "4").split(".")[0]
        : yarnLock.includes("# yarn lockfile v1") ? "1" : "4";
      installCommand = packageManager === "pnpm"
        ? "pnpm install --frozen-lockfile"
        : packageManager === "yarn"
          ? "yarn install " + (Number(yarnMajor) < 2 ? "--frozen-lockfile" : "--immutable")
          : hasNpmLock ? "npm ci" : "npm install";
    }
    dependencyTarget = "/workspace/node_modules";
    const scripts = pkg.scripts || {};
    const preferredScript = environment === "development" ? "dev" : "start";
    const fallbackScript = environment === "development" ? "start" : "dev";
    defaultCommand = service.command || (
      scripts[preferredScript] ? [packageManager, "run", preferredScript] :
      scripts[fallbackScript] ? [packageManager, "run", fallbackScript] : []
    );
    if (defaultCommand.length === 0) {
      throw new Error(`Service "${serviceName}" was detected as ${stack}, but package.json has no "${preferredScript}" or "${fallbackScript}" script. Set services.${serviceName}.command explicitly.`);
    }
  } else if (pythonProject) {
    stack = "python";
    const pyproject = readText(path.join(sourceDir, "pyproject.toml"));
    const pythonRequirement = pyproject.match(/requires-python\s*=\s*["']([^"']+)["']/)?.[1] || "";
    runtimeVersion = firstVersion(
      readText(path.join(sourceDir, ".python-version")) || pythonRequirement,
      "3.13"
    );
    packageManager = fs.existsSync(path.join(sourceDir, "uv.lock")) ? "uv" : "pip";
    packageManagerVersion = packageManager === "uv" ? "uv-lock" : "pip";
    image = `python:${runtimeVersion}-slim`;
    dependencyTarget = "/workspace/.venv";
    installCommand = packageManager === "uv"
      ? "python -m venv /workspace/.venv && /workspace/.venv/bin/pip install uv && /workspace/.venv/bin/uv sync --frozen"
      : "python -m venv /workspace/.venv && . /workspace/.venv/bin/activate && " +
        (fs.existsSync(path.join(sourceDir, "requirements.txt"))
          ? "pip install -r requirements.txt"
          : "pip install -e .");
    defaultCommand = service.command || [];
    if (defaultCommand.length === 0) {
      throw new Error(`Python service "${serviceName}" needs an explicit services.${serviceName}.command in pegas.json.`);
    }
  } else {
    throw new Error(
      `Cannot detect the stack for app service "${serviceName}". Add a package.json, pyproject.toml or requirements.txt, or specify image/build in pegas.json.`
    );
  }

  const lockFiles = [
    "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
    "uv.lock", "poetry.lock", "requirements.txt", "pyproject.toml",
  ];
  const lockContent = lockFiles
    .map((file) => {
      const fullPath = path.join(sourceDir, file);
      return fs.existsSync(fullPath) ? `${file}\0${fs.readFileSync(fullPath)}` : "";
    })
    .filter(Boolean)
    .join("\0");
  const lockHash = createHash("sha256")
    .update([lockContent, packageManager, packageManagerVersion, runtimeVersion].join("\0"))
    .digest("hex");

  const marker = `${dependencyTarget}/.pegas-deps-hash`;
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const dockerfileInline = [
    `FROM ${image}`,
    "USER root",
    ...(stack === "node" ? ["RUN corepack enable"] : []),
    `RUN mkdir -p ${dependencyTarget} /tmp/pegas-home && chown -R ${uid}:${gid} /workspace /tmp/pegas-home`,
    "ENV HOME=/tmp/pegas-home",
    "WORKDIR /workspace",
    `USER ${uid}:${gid}`,
  ].join("\n");
  const imageHash = hashValue({ image, dockerfileInline });
  const wrapper = [
    `mkdir -p ${shellQuote(dependencyTarget)}` ,
    `if [ ! -f ${shellQuote(marker)} ] || [ "$(cat ${shellQuote(marker)})" != ${shellQuote(lockHash)} ]; then`,
    `  ${installCommand}` ,
    `  printf %s ${shellQuote(lockHash)} > ${shellQuote(marker)}` ,
    "fi",
    ...(stack === "python" ? [". /workspace/.venv/bin/activate"] : []),
    `exec ${defaultCommand.map(shellQuote).join(" ")}` ,
  ].join("\n");

  return {
    image,
    command: ["sh", "-lc", wrapper],
    dependencyTarget,
    lockHash,
    runtimeVersion,
    packageManager,
    packageManagerVersion,
    dockerfileInline,
    imageHash,
  };
}

function isInfraService(serviceName: string, service: ServiceContract): boolean {
  if (service.role) return service.role === "infra";
  return Boolean(INFRA_IMAGES[serviceName.toLowerCase()]);
}

function isAppService(serviceName: string, service: ServiceContract): boolean {
  if (service.role) return service.role === "app";
  if (INFRA_IMAGES[serviceName.toLowerCase()]) return false;
  return Boolean(service.build || service.command || service.port || service.domains?.development?.length || service.domains?.dev?.length);
}

function getVolumeTarget(spec: string | { target?: string }): string | undefined {
  if (typeof spec !== "string") return spec.target;
  const parts = spec.split(":");
  // Compose short syntax is source:target[:mode]. On Windows, the host drive
  // letter adds one extra colon before the target.
  if (/^[A-Za-z]:\\/.test(spec)) return parts[2]?.split(":")[0];
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
    const app = isAppService(serviceName, service);
    const infra = isInfraService(serviceName, service);
    let appDefaults: AppDefaults | undefined;
    let effectiveImage = service.image;
    if (!service.build && !service.image) {
      if (infra) {
        effectiveImage = INFRA_IMAGES[serviceName.toLowerCase()];
        if (!effectiveImage) {
          throw new Error(`Infrastructure service "${serviceName}" needs an explicit image in pegas.json; no built-in profile exists for this service.`);
        }
      } else if (app && (options.environment || "development") === "development") {
        appDefaults = resolveAppDefaults(serviceName, service, options.projectRoot, "development");
        effectiveImage = appDefaults.image;
      } else if (app) {
        throw new Error(`Production service "${serviceName}" must declare build or image in pegas.json. Automatic stack images are for development only.`);
      } else {
        throw new Error(`Service "${serviceName}" needs an image, build configuration, or a recognized app/infra profile.`);
      }
    }

    const dockerfilePath = service.build?.dockerfile
      ? path.resolve(options.projectRoot, service.build.context, service.build.dockerfile)
      : service.build
        ? path.resolve(options.projectRoot, service.build.context, "Dockerfile")
        : "";
    const dockerIgnorePath = path.resolve(options.projectRoot, service.build?.context || ".", ".dockerignore");
    const dockerfileHash = createHash("sha256")
      .update(dockerfilePath && fs.existsSync(dockerfilePath) ? fs.readFileSync(dockerfilePath) : "")
      .update(fs.existsSync(dockerIgnorePath) ? fs.readFileSync(dockerIgnorePath) : "")
      .digest("hex");
    const environmentName = options.environment || "development";
    const configuredWatchMode = service.hmr?.fileWatch;
    const watchMode = environmentName !== "development"
      ? "events"
      : !configuredWatchMode || configuredWatchMode === "auto"
        ? (process.platform === "linux" ? "events" : "polling")
        : configuredWatchMode;
    const serviceHash = hashValue({
      service,
      environment: environmentName,
      effectiveImage,
      dockerfileHash,
      watchMode,
      defaults: appDefaults ? {
        image: appDefaults.image,
        runtimeVersion: appDefaults.runtimeVersion,
        packageManager: appDefaults.packageManager,
        packageManagerVersion: appDefaults.packageManagerVersion,
        lockHash: appDefaults.lockHash,
        dockerfileInline: appDefaults.dockerfileInline,
        imageHash: appDefaults.imageHash,
        command: appDefaults.command,
        environment: options.environment || "development",
      } : undefined,
    });
    serviceHashes[serviceName] = serviceHash;

    const generated: Record<string, unknown> = {
      restart: "unless-stopped",
      labels: {
        "pegas.project": options.projectId,
        "pegas.project-name": contract.projectName || options.projectId,
        "pegas.service": serviceName,
        "pegas.manifest-hash": serviceHash,
        "pegas.role": service.role || (app ? "app" : "infra"),
        ...(appDefaults ? { "pegas.dependencies-hash": appDefaults.lockHash } : {}),
        ...(service.envFile ? {
          "pegas.env-hash": createHash("sha256")
            .update(fs.readFileSync(path.resolve(options.projectRoot, service.envFile)))
            .digest("hex"),
        } : {}),
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
      generated.image = `pegas/${options.projectId}/${serviceName.toLowerCase()}:${serviceHash.slice(0, 12)}`;
    } else if (appDefaults) {
      generated.build = {
        context: options.projectRoot,
        dockerfile_inline: appDefaults.dockerfileInline,
      };
      generated.image = `pegas/${options.projectId}/${serviceName.toLowerCase()}:${appDefaults.imageHash.slice(0, 12)}`;
    } else if (effectiveImage) {
      generated.image = effectiveImage;
    }
    if (appDefaults) generated.command = appDefaults.command;
    else if (service.command) generated.command = service.command;
    const environment: Record<string, string> = { ...(service.env || {}) };
    if (app) {
      environment.NODE_ENV ??= environmentName === "development" ? "development" : "production";
      environment.PEGAS_ENV ??= environmentName;
    }
    if (environmentName === "development" && watchMode === "polling") {
      environment.CHOKIDAR_USEPOLLING ??= "true";
      environment.WATCHPACK_POLLING ??= "true";
    } else if (environmentName === "development" && watchMode === "events") {
      environment.CHOKIDAR_USEPOLLING ??= "false";
      environment.WATCHPACK_POLLING ??= "false";
    }
    if (Object.keys(environment).length > 0) generated.environment = environment;
    if (service.envFile) generated.env_file = [path.resolve(options.projectRoot, service.envFile)];
    if (service.dependsOn) generated.depends_on = service.dependsOn;
    if (service.healthcheck) {
      generated.healthcheck = {
        test: service.healthcheck.test,
        ...(service.healthcheck.interval ? { interval: service.healthcheck.interval } : {}),
        ...(service.healthcheck.timeout ? { timeout: service.healthcheck.timeout } : {}),
        ...(service.healthcheck.retries ? { retries: service.healthcheck.retries } : {}),
        ...(service.healthcheck.startPeriod ? { start_period: service.healthcheck.startPeriod } : {}),
      };
    }
    if (service.port !== undefined) generated.expose = [String(service.port)];

    const volumes: unknown[] = [...(service.volumes || [])];
    if (app && (options.environment || "development") === "development") {
      const source = path.resolve(options.projectRoot, service.bindMount || ".");
      volumes.unshift({
        type: "bind",
        source,
        target: "/workspace",
        bind: { create_host_path: true },
      });
      generated.working_dir = "/workspace";

      const dependencyTarget = appDefaults?.dependencyTarget || "/workspace/node_modules";
      if (!volumes.some((volume) => getVolumeTarget(volume) === dependencyTarget)) {
        const volumeName = `pegas-${options.projectId}-${serviceName}-dependencies`;
        volumes.push(`${volumeName}:${dependencyTarget}`);
        namedVolumes.add(volumeName);
      }
    }
    if (volumes.length > 0) generated.volumes = volumes;

    services[serviceName] = generated;
  }

  const manifest: Record<string, unknown> = {
    name: "pegas-" + options.projectId,
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
