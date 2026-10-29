import fs from "node:fs/promises";
import path from "node:path";
import { detectProjectSlug } from "./contract.js";

export function createDefaultCompose(projectName = "app"): string {
  return `services:
  web:
    build: .
    restart: unless-stopped
    expose:
      - "3000"
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "3"
    networks:
      pegas-network:
        aliases:
          - ${projectName}-web

networks:
  pegas-network:
    external: true
`;
}

export const DEFAULT_COMPOSE_CONTENT = createDefaultCompose("app");

export const INFRA_PORTS = new Set([
  22,     // SSH
  2222,   // SSH
  3306,   // MySQL / MariaDB
  4222,   // NATS
  5432,   // PostgreSQL
  5672,   // RabbitMQ AMQP
  6379,   // Redis
  6380,   // Redis SSL
  8123,   // ClickHouse HTTP
  9000,   // ClickHouse TCP / MinIO
  9092,   // Kafka
  9200,   // Elasticsearch
  9300,   // Elasticsearch
  11211,  // Memcached
  15672,  // RabbitMQ Management
  27017,  // MongoDB
  27018,  // MongoDB
]);

export const INFRA_SERVICE_NAMES = new Set([
  "db",
  "database",
  "postgres",
  "postgresql",
  "redis",
  "valkey",
  "mysql",
  "mariadb",
  "mongo",
  "mongodb",
  "rabbitmq",
  "queue",
  "broker",
  "elastic",
  "elasticsearch",
  "kafka",
  "memcached",
]);

export function parsePortEntry(raw: string): { host?: string; container: number; raw: string } | null {
  const clean = raw.trim().replace(/^-\s*/, "").replace(/^['"]|['"]$/g, "");
  const protoIndex = clean.indexOf("/");
  const noProto = protoIndex !== -1 ? clean.slice(0, protoIndex) : clean;
  const parts = noProto.split(":");
  const containerStr = parts[parts.length - 1];
  const containerPort = parseInt(containerStr, 10);
  if (isNaN(containerPort)) return null;

  const hostPort = parts.length > 1 ? parts[parts.length - 2] : undefined;
  return { host: hostPort, container: containerPort, raw };
}

export function isInfraService(serviceName: string, serviceLines: string[]): boolean {
  const lowerName = serviceName.toLowerCase();
  if (INFRA_SERVICE_NAMES.has(lowerName)) return true;
  for (const name of INFRA_SERVICE_NAMES) {
    if (lowerName.includes(name)) return true;
  }
  for (const line of serviceLines) {
    const match = line.match(/^\s*image:\s*([^\s]+)/);
    if (match) {
      const img = match[1].toLowerCase();
      for (const name of INFRA_SERVICE_NAMES) {
        if (img.includes(name)) return true;
      }
    }
  }
  return false;
}

export const PROXY_SERVICE_NAMES = new Set([
  "caddy",
  "nginx",
  "traefik",
  "envoy",
  "haproxy",
  "gateway",
  "reverse-proxy",
  "proxy",
]);

export function isProxyService(serviceName: string, serviceLines: string[]): boolean {
  const lowerName = serviceName.toLowerCase();
  if (PROXY_SERVICE_NAMES.has(lowerName)) return true;
  for (const name of PROXY_SERVICE_NAMES) {
    if (lowerName === name || lowerName.startsWith(`${name}-`) || lowerName.endsWith(`-${name}`)) return true;
  }
  for (const line of serviceLines) {
    const match = line.match(/^\s*image:\s*([^\s]+)/);
    if (match) {
      const img = match[1].toLowerCase();
      for (const name of PROXY_SERVICE_NAMES) {
        if (img.includes(name)) return true;
      }
    }
  }
  return false;
}

export interface InfraServiceInfo {
  name: string;
  hostPort?: string;
  containerPort?: number;
}

export function detectInfraServices(content: string): InfraServiceInfo[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const services: { name: string; lines: string[] }[] = [];
  let inServices = false;
  let serviceIndent: number | null = null;
  let currentService: { name: string; lines: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.search(/\S/);

    if (indent === 0) {
      if (trimmed.startsWith("services:")) {
        inServices = true;
        serviceIndent = null;
        currentService = null;
        continue;
      } else {
        inServices = false;
        if (currentService) {
          services.push(currentService);
          currentService = null;
        }
        continue;
      }
    }

    if (inServices) {
      if (serviceIndent === null) {
        serviceIndent = indent;
        const match = trimmed.match(/^([a-zA-Z0-9._-]+):/);
        if (match) {
          currentService = { name: match[1], lines: [] };
        }
      } else if (indent === serviceIndent) {
        if (currentService) {
          services.push(currentService);
        }
        const match = trimmed.match(/^([a-zA-Z0-9._-]+):/);
        if (match) {
          currentService = { name: match[1], lines: [] };
        } else {
          currentService = null;
        }
      } else if (indent > serviceIndent && currentService) {
        currentService.lines.push(line);
      }
    }
  }

  if (currentService) {
    services.push(currentService);
  }

  const infraServices: InfraServiceInfo[] = [];

  for (const s of services) {
    if (isInfraService(s.name, s.lines)) {
      let hostPort: string | undefined = undefined;
      let containerPort: number | undefined = undefined;

      let inPorts = false;
      let portsIndent: number | null = null;

      for (const line of s.lines) {
        const trimmed = line.trim();
        const indent = line.search(/\S/);

        if (trimmed.startsWith("ports:")) {
          inPorts = true;
          portsIndent = indent;
          continue;
        }

        if (inPorts) {
          if (indent > portsIndent! && trimmed.startsWith("-")) {
            const parsed = parsePortEntry(trimmed);
            if (parsed) {
              hostPort = parsed.host || String(parsed.container);
              containerPort = parsed.container;
              break;
            }
          } else if (indent <= portsIndent!) {
            inPorts = false;
          }
        }
      }

      infraServices.push({
        name: s.name,
        hostPort,
        containerPort,
      });
    }
  }

  return infraServices;
}

export function stripOmittedDependsOn(lines: string[], omittedServices: Set<string>): string[] {
  if (omittedServices.size === 0) return lines;

  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^(\s*)depends_on:\s*$/);
    if (!match) {
      result.push(line);
      i++;
      continue;
    }

    const depIndent = match[1].length;
    const depHeader = line;
    const keptDepLines: string[] = [];
    i++;

    while (i < lines.length) {
      const childLine = lines[i];
      const childTrimmed = childLine.trim();
      const childIndent = childLine.search(/\S/);

      if (childTrimmed === "" || childTrimmed.startsWith("#")) {
        i++;
        continue;
      }

      if (childIndent <= depIndent) {
        break; // Exited depends_on block
      }

      // Format 1: List item: "  - caddy"
      if (childTrimmed.startsWith("-")) {
        const depName = childTrimmed.replace(/^-\s*/, "").split(/[\s:#]/)[0].trim();
        if (omittedServices.has(depName)) {
          i++;
        } else {
          keptDepLines.push(childLine);
          i++;
        }
        continue;
      }

      // Format 2: Map item: "  caddy:" or "  caddy: { ... }"
      const mapMatch = childTrimmed.match(/^([a-zA-Z0-9._-]+):/);
      if (mapMatch) {
        const depName = mapMatch[1];
        const isOmitted = omittedServices.has(depName);
        const mapItemIndent = childIndent;

        if (isOmitted) {
          i++;
          // Skip sub-lines belonging to this map item
          while (i < lines.length) {
            const subLine = lines[i];
            const subIndent = subLine.search(/\S/);
            const subTrimmed = subLine.trim();
            if (subTrimmed === "" || subTrimmed.startsWith("#")) {
              i++;
              continue;
            }
            if (subIndent > mapItemIndent) {
              i++;
            } else {
              break;
            }
          }
        } else {
          keptDepLines.push(childLine);
          i++;
          while (i < lines.length) {
            const subLine = lines[i];
            const subIndent = subLine.search(/\S/);
            const subTrimmed = subLine.trim();
            if (subTrimmed === "" || subTrimmed.startsWith("#")) {
              keptDepLines.push(subLine);
              i++;
              continue;
            }
            if (subIndent > mapItemIndent) {
              keptDepLines.push(subLine);
              i++;
            } else {
              break;
            }
          }
        }
        continue;
      }

      keptDepLines.push(childLine);
      i++;
    }

    if (keptDepLines.length > 0) {
      result.push(depHeader);
      result.push(...keptDepLines);
    }
  }

  return result;
}

export function patchExistingCompose(content: string, projectName = "app"): string {
  // Normalize Windows CRLF line endings
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  // Step 1: Collect all services to detect proxy services
  interface ServiceEntry {
    name: string;
    header: string;
    lines: string[];
    indent: number;
  }

  const services: ServiceEntry[] = [];
  const otherLinesBeforeServices: string[] = [];
  const otherLinesAfterServices: string[] = [];

  let inServices = false;
  let pastServices = false;
  let serviceIndent: number | null = null;
  let currentSvc: ServiceEntry | null = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    const lineIndent = line.search(/\S/);

    if (lineIndent === 0 && /^[a-zA-Z0-9_-]+:\s*$/.test(line)) {
      if (trimmed === "services:") {
        inServices = true;
        pastServices = false;
        serviceIndent = null;
        if (currentSvc) {
          services.push(currentSvc);
          currentSvc = null;
        }
        continue;
      } else {
        if (inServices) {
          if (currentSvc) {
            services.push(currentSvc);
            currentSvc = null;
          }
          inServices = false;
          pastServices = true;
        }
      }
    }

    if (inServices) {
      if (serviceIndent === null && lineIndent > 0 && /^[a-zA-Z0-9._-]+:\s*$/.test(trimmed)) {
        serviceIndent = lineIndent;
      }

      if (serviceIndent !== null && lineIndent === serviceIndent && /^[a-zA-Z0-9._-]+:\s*$/.test(trimmed)) {
        if (currentSvc) {
          services.push(currentSvc);
        }
        currentSvc = {
          name: trimmed.replace(/:\s*$/, ""),
          header: line,
          lines: [],
          indent: lineIndent,
        };
        continue;
      }

      if (currentSvc) {
        currentSvc.lines.push(line);
        continue;
      }
    }

    if (!pastServices && !inServices) {
      otherLinesBeforeServices.push(line);
    } else {
      otherLinesAfterServices.push(line);
    }
  }

  if (currentSvc) {
    services.push(currentSvc);
  }

  // Step 2: Identify proxy services to omit
  const omittedServices = new Set<string>();
  for (const s of services) {
    if (isProxyService(s.name, s.lines)) {
      omittedServices.add(s.name);
    }
  }

  const nonProxyServices = services.filter((s) => !omittedServices.has(s.name));
  const nonInfraServices = nonProxyServices.filter((s) => !isInfraService(s.name, s.lines));

  // Step 3: Process non-proxy services
  function processService(entry: ServiceEntry): string[] {
    const sLines = stripOmittedDependsOn(entry.lines, omittedServices);
    const isInfra = isInfraService(entry.name, sLines);
    const hasPorts = sLines.some((l) => /^\s*ports:\s*$/.test(l));
    const hasExpose = sLines.some((l) => /^\s*expose:\s*$/.test(l));
    const hasPegasNetworkAlready = sLines.some((l) => l.includes("pegas-network"));

    // Web service criteria:
    // 1. Not infra, and exposes or has ports or pegas-network
    // 2. OR not infra, and is the sole non-infra service (or named web/app/site/server) when a proxy was omitted!
    const isSoleOrNamedApp =
      !isInfra &&
      (nonInfraServices.length === 1 ||
        ["web", "app", "site", "frontend", "server", "backend"].includes(entry.name.toLowerCase()));
    const isWeb =
      !isInfra &&
      (hasPorts || hasExpose || hasPegasNetworkAlready || (omittedServices.size > 0 && isSoleOrNamedApp));

    if (!isWeb) {
      return [entry.header, ...sLines];
    }

    const remainingLines: string[] = [];
    const exposedPorts: string[] = [];
    let hasNetworks = false;
    let hasPegasNetwork = false;

    // Detect indentation of keys inside this service
    let propIndent = entry.indent + 2;
    for (const l of sLines) {
      const ind = l.search(/\S/);
      if (ind > entry.indent) {
        propIndent = ind;
        break;
      }
    }
    const propIndentStr = " ".repeat(propIndent);
    const itemIndentStr = " ".repeat(propIndent + 2);

    let i = 0;
    while (i < sLines.length) {
      const line = sLines[i];
      const lineIndent = line.search(/\S/);

      // Check ports:
      const portsMatch = line.match(/^(\s*)ports:\s*$/);
      if (portsMatch && lineIndent === propIndent) {
        i++;
        const preservedPortLines: string[] = [];
        while (i < sLines.length) {
          const pLine = sLines[i];
          const pTrimmed = pLine.trim();
          const pIndent = pLine.search(/\S/);

          if (pTrimmed === "" || pTrimmed.startsWith("#")) {
            i++;
            continue;
          }

          if (pIndent > propIndent) {
            const parsed = parsePortEntry(pTrimmed);
            if (parsed) {
              if (isWeb) {
                // Public web port -> expose
                exposedPorts.push(parsed.container.toString());
              } else {
                preservedPortLines.push(pLine);
              }
            } else {
              preservedPortLines.push(pLine);
            }
            i++;
          } else {
            break;
          }
        }

        if (preservedPortLines.length > 0) {
          remainingLines.push(line);
          remainingLines.push(...preservedPortLines);
        }
        continue;
      }

      // Check expose:
      const exposeMatch = line.match(/^(\s*)expose:\s*$/);
      if (exposeMatch && lineIndent === propIndent) {
        remainingLines.push(line);
        i++;
        while (i < sLines.length) {
          const eLine = sLines[i];
          const eTrimmed = eLine.trim();
          const eIndent = eLine.search(/\S/);
          if (eTrimmed === "" || eTrimmed.startsWith("#")) {
            remainingLines.push(eLine);
            i++;
            continue;
          }
          if (eIndent > propIndent) {
            const clean = eTrimmed.replace(/^-\s*/, "").replace(/^['"]|['"]$/g, "");
            exposedPorts.push(clean);
            remainingLines.push(eLine);
            i++;
          } else {
            break;
          }
        }
        continue;
      }

      // Check networks:
      const networksMatch = line.match(/^(\s*)networks:\s*$/);
      if (networksMatch && lineIndent === propIndent) {
        hasNetworks = true;
        remainingLines.push(line);
        i++;
        while (i < sLines.length) {
          const nextLine = sLines[i];
          const nextTrimmed = nextLine.trim();
          const nextIndent = nextLine.search(/\S/);
          if (nextTrimmed === "" || nextTrimmed.startsWith("#")) {
            remainingLines.push(nextLine);
            i++;
            continue;
          }
          if (nextIndent > propIndent) {
            if (nextTrimmed.startsWith("-")) {
              const netName = nextTrimmed.replace(/^-\s*/, "").trim();
              if (netName === "pegas-network") {
                hasPegasNetwork = true;
              }
            } else if (nextTrimmed.startsWith("pegas-network:")) {
              hasPegasNetwork = true;
            }
            remainingLines.push(nextLine);
            i++;
          } else {
            break;
          }
        }
        continue;
      }

      remainingLines.push(line);
      i++;
    }

    // Web service transformations:
    // 1. Ensure expose: section exists if exposedPorts found
    const hasExposeSection = remainingLines.some((l) => {
      const ind = l.search(/\S/);
      return ind === propIndent && /^\s*expose:\s*$/.test(l);
    });

    if (!hasExposeSection) {
      let insertIdx = remainingLines.length;
      const netIdx = remainingLines.findIndex((l) => {
        const ind = l.search(/\S/);
        return ind === propIndent && /^\s*networks:\s*$/.test(l);
      });
      if (netIdx !== -1) {
        insertIdx = netIdx;
      }

      if (exposedPorts.length === 0) {
        // Check for PORT in environment or fallback to 3000
        let detectedPort = "3000";
        for (const l of sLines) {
          const m = l.match(/PORT\s*=\s*["']?(\d+)["']?/i) || l.match(/PORT\s*:\s*["']?(\d+)["']?/i);
          if (m) {
            detectedPort = m[1];
            break;
          }
        }
        exposedPorts.push(detectedPort);
      }

      if (exposedPorts.length > 0) {
        const unique = [...new Set(exposedPorts)];
        const exposeLines = [
          `${propIndentStr}expose:`,
          ...unique.map((p) => `${itemIndentStr}- "${p}"`),
        ];
        remainingLines.splice(insertIdx, 0, ...exposeLines);
      }
    }

    // 2. Ensure networks: default + pegas-network with scoped alias
    const scopedAlias = `${projectName}-${entry.name}`;
    const netIndentStr = " ".repeat(propIndent + 2);
    const aliasIndentStr = " ".repeat(propIndent + 4);
    const itemAliasIndentStr = " ".repeat(propIndent + 6);

    const aliasSnippet = [
      `${netIndentStr}default:`,
      `${netIndentStr}pegas-network:`,
      `${aliasIndentStr}aliases:`,
      `${itemAliasIndentStr}- ${scopedAlias}`,
    ];

    if (!hasNetworks) {
      remainingLines.push(`${propIndentStr}networks:`);
      remainingLines.push(...aliasSnippet);
    } else {
      const netIdx = remainingLines.findIndex((l) => {
        const ind = l.search(/\S/);
        return ind === propIndent && /^\s*networks:\s*$/.test(l);
      });

      if (netIdx !== -1) {
        let existingPegasNetworkIdx = -1;
        let hasScopedAlias = false;
        let listPegasNetworkIdx = -1;

        for (let k = netIdx + 1; k < remainingLines.length; k++) {
          const nl = remainingLines[k];
          const nind = nl.search(/\S/);
          if (nind <= propIndent && nl.trim() !== "" && !nl.trim().startsWith("#")) {
            break;
          }
          if (nl.trim() === "- pegas-network") {
            listPegasNetworkIdx = k;
          } else if (nl.trim() === "pegas-network:") {
            existingPegasNetworkIdx = k;
          }
          if (nl.trim() === `- ${scopedAlias}`) {
            hasScopedAlias = true;
          }
        }

        if (listPegasNetworkIdx !== -1) {
          remainingLines.splice(listPegasNetworkIdx, 1, ...aliasSnippet.slice(1));
        } else if (existingPegasNetworkIdx !== -1) {
          if (!hasScopedAlias) {
            let aliasHeaderIdx = -1;
            for (let k = existingPegasNetworkIdx + 1; k < remainingLines.length; k++) {
              const nl = remainingLines[k];
              const nind = nl.search(/\S/);
              if (nind <= propIndent + 2 && nl.trim() !== "" && !nl.trim().startsWith("#")) {
                break;
              }
              if (nl.trim() === "aliases:") {
                aliasHeaderIdx = k;
                break;
              }
            }

            if (aliasHeaderIdx !== -1) {
              remainingLines.splice(aliasHeaderIdx + 1, 0, `${itemAliasIndentStr}- ${scopedAlias}`);
            } else {
              remainingLines.splice(
                existingPegasNetworkIdx + 1,
                0,
                `${aliasIndentStr}aliases:`,
                `${itemAliasIndentStr}- ${scopedAlias}`
              );
            }
          }
        } else {
          remainingLines.splice(netIdx + 1, 0, ...aliasSnippet);
        }
      }
    }

    // 3. Ensure logging rotation exists
    const hasLogging = sLines.some((l) => /^\s*logging:\s*$/.test(l));
    if (!hasLogging) {
      const logIndentStr = propIndentStr;
      const logSubIndentStr = " ".repeat(propIndent + 2);
      const logOptIndentStr = " ".repeat(propIndent + 4);
      const loggingSnippet = [
        `${logIndentStr}logging:`,
        `${logSubIndentStr}driver: "json-file"`,
        `${logSubIndentStr}options:`,
        `${logOptIndentStr}max-size: "50m"`,
        `${logOptIndentStr}max-file: "3"`,
      ];

      const netIdx = remainingLines.findIndex((l) => {
        const ind = l.search(/\S/);
        return ind === propIndent && /^\s*networks:\s*$/.test(l);
      });
      if (netIdx !== -1) {
        remainingLines.splice(netIdx, 0, ...loggingSnippet);
      } else {
        remainingLines.push(...loggingSnippet);
      }
    }

    return [entry.header, ...remainingLines];
  }

  // Step 4: Assemble output lines
  const outputLines: string[] = [...otherLinesBeforeServices];
  outputLines.push("services:");

  for (const s of services) {
    if (omittedServices.has(s.name)) {
      continue; // Proxy service omitted
    }
    outputLines.push(...processService(s));
  }

  outputLines.push(...otherLinesAfterServices);

  // Ensure root pegas-network network declaration
  let finalContent = outputLines.join("\n");
  if (!/pegas-network:\s*\n\s*external:\s*true/m.test(finalContent)) {
    const rootNetIndex = finalContent.search(/^networks:\s*$/m);
    if (rootNetIndex !== -1) {
      const afterNet = finalContent.indexOf("\n", rootNetIndex) + 1;
      finalContent =
        finalContent.slice(0, afterNet) +
        "  pegas-network:\n    external: true\n" +
        finalContent.slice(afterNet);
    } else {
      finalContent =
        finalContent.trimEnd() +
        "\n\nnetworks:\n  pegas-network:\n    external: true\n";
    }
  }

  return finalContent;
}

export async function findPegasCompose(dir: string): Promise<string | null> {
  const candidates = [
    path.join(".pegas", "docker-compose.yml"),
    path.join(".pegas", "docker-compose.yaml"),
    path.join(".pegas", "compose.yml"),
    path.join(".pegas", "compose.yaml"),
  ];

  for (const file of candidates) {
    try {
      await fs.access(path.join(dir, file));
      return file;
    } catch {}
  }

  return findRootCompose(dir);
}

export async function findRootCompose(dir: string): Promise<string | null> {
  const candidates = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ];

  for (const file of candidates) {
    try {
      await fs.access(path.join(dir, file));
      return file;
    } catch {}
  }

  return null;
}

export async function setupProjectCompose(
  projectDir: string,
  projectName?: string,
  dryRun = false
): Promise<{ created: boolean; updated: boolean; file: string }> {
  const slug = projectName || (await detectProjectSlug(projectDir));
  const existingFile = await findRootCompose(projectDir);

  const pegasDir = path.join(projectDir, ".pegas");
  const targetRelativePath = path.join(".pegas", "docker-compose.yml");
  const targetFullPath = path.join(projectDir, targetRelativePath);

  if (!existingFile) {
    if (!dryRun) {
      await fs.mkdir(pegasDir, { recursive: true });
      await fs.writeFile(
        targetFullPath,
        createDefaultCompose(slug),
        "utf-8"
      );
    }
    return { created: true, updated: false, file: targetRelativePath };
  }

  const rootFullPath = path.join(projectDir, existingFile);
  const original = await fs.readFile(rootFullPath, "utf-8");
  const patched = patchExistingCompose(original, slug);

  let existingPegasCompose = "";
  try {
    existingPegasCompose = await fs.readFile(targetFullPath, "utf-8");
  } catch {}

  const isDifferent = patched !== existingPegasCompose;

  if (isDifferent) {
    if (!dryRun) {
      await fs.mkdir(pegasDir, { recursive: true });
      await fs.writeFile(targetFullPath, patched, "utf-8");
    }
    return {
      created: !existingPegasCompose,
      updated: Boolean(existingPegasCompose),
      file: targetRelativePath,
    };
  }

  return { created: false, updated: false, file: targetRelativePath };
}
