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

export function patchExistingCompose(content: string, projectName = "app"): string {
  // Normalize Windows CRLF line endings
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const outputLines: string[] = [];

  let inServices = false;
  let serviceNameIndent: number | null = null;
  let currentServiceName: string | null = null;
  let currentServiceHeader: string | null = null;
  let currentServiceLines: string[] = [];
  let inNetworksSection = false;

  function processService(name: string, header: string, sLines: string[]): string[] {
    const isInfra = isInfraService(name, sLines);
    const hasPorts = sLines.some((l) => /^\s*ports:\s*$/.test(l));
    const hasExpose = sLines.some((l) => /^\s*expose:\s*$/.test(l));
    const hasPegasNetworkAlready = sLines.some((l) => l.includes("pegas-network"));

    // Microservices / background workers without ports are not web-facing
    const isWeb = !isInfra && (hasPorts || hasExpose || hasPegasNetworkAlready);
    if (!isWeb) {
      return [header, ...sLines];
    }

    const remainingLines: string[] = [];
    const exposedPorts: string[] = [];
    let hasNetworks = false;
    let hasPegasNetwork = false;

    // Detect indentation of keys inside this service
    let propIndent = 4;
    for (const l of sLines) {
      const ind = l.search(/\S/);
      if (ind > (serviceNameIndent ?? 2)) {
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
    if (isWeb) {
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

        if (exposedPorts.length > 0) {
          const unique = [...new Set(exposedPorts)];
          const exposeLines = [
            `${propIndentStr}expose:`,
            ...unique.map((p) => `${itemIndentStr}- "${p}"`),
          ];
          remainingLines.splice(insertIdx, 0, ...exposeLines);
        }
      }

      // 2. Ensure networks: pegas-network with unique alias: [projectName-name]
      const scopedAlias = `${projectName}-${name}`;
      const netIndentStr = " ".repeat(propIndent + 2);
      const aliasIndentStr = " ".repeat(propIndent + 4);
      const itemAliasIndentStr = " ".repeat(propIndent + 6);

      const aliasSnippet = [
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
            remainingLines.splice(listPegasNetworkIdx, 1, ...aliasSnippet);
          } else if (existingPegasNetworkIdx !== -1) {
            if (!hasScopedAlias) {
              // Replace any un-scoped alias or add the scoped alias
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
                // Update or append the scoped alias
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

      // 3. Ensure logging rotation exists to protect disk space from log exhaustion
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
    }

    return [header, ...remainingLines];
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    const lineIndent = line.search(/\S/);

    // Top-level key check (indent 0)
    if (lineIndent === 0 && /^[a-zA-Z0-9_-]+:\s*$/.test(line)) {
      if (currentServiceName && currentServiceHeader) {
        const processed = processService(currentServiceName, currentServiceHeader, currentServiceLines);
        outputLines.push(...processed);
        currentServiceName = null;
        currentServiceHeader = null;
        currentServiceLines = [];
      }
      if (/^services:\s*$/.test(line)) {
        inServices = true;
        serviceNameIndent = null;
        inNetworksSection = false;
      } else {
        inServices = false;
        inNetworksSection = /^networks:\s*$/.test(line);
      }
      outputLines.push(line);
      continue;
    }

    if (inServices) {
      if (serviceNameIndent === null && lineIndent > 0 && /^[a-zA-Z0-9._-]+:\s*$/.test(trimmed)) {
        serviceNameIndent = lineIndent;
      }

      if (serviceNameIndent !== null && lineIndent === serviceNameIndent && /^[a-zA-Z0-9._-]+:\s*$/.test(trimmed)) {
        if (currentServiceName && currentServiceHeader) {
          const processed = processService(currentServiceName, currentServiceHeader, currentServiceLines);
          outputLines.push(...processed);
          currentServiceLines = [];
        }
        currentServiceName = trimmed.replace(/:\s*$/, "");
        currentServiceHeader = line;
        continue;
      }

      if (currentServiceName) {
        currentServiceLines.push(line);
        continue;
      }
    }

    outputLines.push(line);
  }

  if (currentServiceName && currentServiceHeader) {
    const processed = processService(currentServiceName, currentServiceHeader, currentServiceLines);
    outputLines.push(...processed);
  }

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

  if (!existingFile) {
    const targetFile = "docker-compose.yml";
    if (!dryRun) {
      await fs.writeFile(
        path.join(projectDir, targetFile),
        createDefaultCompose(slug),
        "utf-8"
      );
    }
    return { created: true, updated: false, file: targetFile };
  }

  const fullPath = path.join(projectDir, existingFile);
  const original = await fs.readFile(fullPath, "utf-8");
  const patched = patchExistingCompose(original, slug);

  if (patched !== original) {
    if (!dryRun) {
      await fs.writeFile(fullPath, patched, "utf-8");
    }
    return { created: false, updated: true, file: existingFile };
  }

  return { created: false, updated: false, file: existingFile };
}
