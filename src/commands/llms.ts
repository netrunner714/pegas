import { COMMANDS, GLOBAL_OPTIONS, CliOptionDef } from "../help.js";

/**
 * Генерируемый контекст для LLM-агентов (`llms.txt`).
 *
 * Секция CLI Usage строится из `COMMANDS` в help.ts — единого источника
 * истины о командах. При изменении CLI достаточно запустить
 * `bun run build`: llms.txt перегенерируется.
 */

const CORE_CONCEPTS = `## Core Concepts
- Declarative orchestrator for Docker multi-app setups: \`pegas.json\` is the single source of truth.
- Zero scalars: every environment-dependent field is a strict scenario map keyed by the root \`scenarios: string[]\`. No root \`env\`, no role, no upstream, no replicas.
- Per-service runtime map \`runtime: { <scenario>: { driver: "docker" | "bun" } }\` selects the driver for each scenario; host driver services run on the host.
- \`port\` is the logical TCP port of a service; \`ports\` publishes host ports (must be empty outside development); \`publicHost\` marks public TCP exposure.
- Secrets are declared per service (\`secrets: string[]\`, keys match \`[A-Z0-9_]+\`) and injected from the gateway at deploy time; pegas never writes .env files.
- Roles are derived, not declared: \`domains\` => web, image without build => infra, build => app.
- One shared Docker bridge network \`pegas-network\`; one shared Caddy Gateway container owning ports 80/443.
- Never expose 80:80 or 443:443 in application compose files; the Gateway owns host ports and proxies by network aliases.
- The launch manifest is generated from pegas.json and is ephemeral (passed via stdin); user compose files are not the source of truth.
- Containers carry Docker labels: \`pegas.project\`, \`pegas.scenario\`, \`pegas.service\`, \`pegas.manifest-hash\`.
- Service aliases inside the shared network are \`<project-id>-<scenario>-<service>\`: several checkouts and scenarios coexist.
- Container names are explicit and readable: \`pegas-<project>-<service>-<scenario>-<project-id>\`; the compose project is \`pegas-<project>-<scenario>-<project-id>\`. Names are truncated to the 63-char DNS label limit when long, and never exceed it.
- Volume identity is decoupled from naming: volumes are declared with an explicit name \`<project-id>-<scenario>_<volume>\`, so data survives project renames.
- Each project gets an isolated route file \`conf.d/<project>-<scenario>.caddy\` per scenario; hot-reload with validation and rollback. The file is shared by route owners and merged per domain: \`pegas connect\` rewrites only blocks with upstream \`host.docker.internal:<port>\`, \`pegas deploy\` only blocks with scoped upstream \`<project-id>-<scenario>-<service>:<port>\`; foreign blocks are preserved verbatim (\`disconnect\`/\`down\` remove only their own blocks).
- Auto-provisions Let's Encrypt SSL on first request.
- View and stream container logs: \`pegas logs [env] [service] [-f] [--tail N]\`; Ctrl+C only detaches without stopping containers.
- Development: \`pegas connect\` routes host-driver services through the Gateway (\`[service].[project].localhost\`, upstream \`host.docker.internal:<port>\`); \`pegas disconnect\` removes the route.
- Runtime SDK: application code imports \`@netrunner714/pegas/runtime\` for typed access to the orchestration context (currentService port/domains/scenario, services map with internalUrl, secret() and config() readers). Transport: PEGAS_CONTEXT env injected into every container. If code imports the runtime, the package MUST be in \`dependencies\` (it is production code); otherwise \`devDependencies\` only.
- Env access doctrine: pegas is a development guideline, not only a deploy tool. Env is the injection transport, never the source of topology knowledge. Code reads topology via the SDK (currentService/services), secrets via secret(), non-secret config via config()/optionalConfig() for keys declared in services.<name>.env (direct process.env is a legacy fallback only). Hard-banned in code: PORT, APP_DOMAIN, CLIENT_ORIGINS, NODE_ENV/PEGAS_ENV-style branching (e.g. \`if (process.env.NODE_ENV === "development")\`) — the platform derives all of them. The scenario is a launch flag (\`pegas deploy -s <scenario>\`), never a branch in code; it may be used only for logs and labels, never to switch behavior.
- Service discovery: env values of the form \`pegas://<service>\` are expanded at deploy time into the internal network address (\`<scheme>://<projectId>-<scenario>-<service>:<port>\`; scheme by target image: redis, postgresql, http).
- PostgreSQL backups are declarative: a service with \`backup: { <scenario>: { every: "1h", keep: 24 } | null }\` gets an automatic \`<service>-backup\` sidecar with \`pg_dump -Fc\` into a named volume; no host cron/systemd. Password comes from \`passwordSecret\` (default \`POSTGRES_PASSWORD\`, declared in \`secrets\`); user/database from \`POSTGRES_USER\`/\`POSTGRES_DB\` env. Only docker PostgreSQL services without \`build\`/\`scope: "shared"\`.
- \`pegas check\` is a read-only audit of the v3 contract: validator issues, secrets parity, .gitignore hygiene. It never mutates files.
- v2 -> v3 transition is manual: edit pegas.json by hand next to the project, then use \`pegas check\` as the sole guide. There is no migrate command.
- Local dev HTTPS: \`pegas ca install\` (one-time), clean URLs on port 443 (\`[service].[project].localhost\`).`;

const CONTRACT_EXAMPLE = `## Example pegas.json (v3 contract)
\`\`\`jsonc
{
  "projectName": "my-app",
  "scenarios": ["development", "production"],
  "gateway": {
    "development": { "httpPort": 80, "httpsPort": 443 },
    "production": { "httpPort": 80, "httpsPort": 443, "acmeEmail": "ops@my-app.com" }
  },
  "services": {
    "web": {
      "runtime": { "development": { "driver": "bun" }, "production": { "driver": "docker" } },
      "build": { "context": "." },
      "port": { "development": 3000, "production": 3000 },
      "domains": {
        "development": ["my-app.localhost"],
        "production": ["my-app.com"]
      },
      "ports": { "development": ["3000:3000"], "production": [] },
      "secrets": ["APP_URL"]
    },
    "postgres": {
      "runtime": { "development": { "driver": "docker" }, "production": { "driver": "docker" } },
      "image": { "development": "postgres:18-alpine", "production": "postgres:18-alpine" },
      "port": { "development": 5432, "production": 5432 },
      "volumes": { "production": ["pgdata:/var/lib/postgresql"] },
      "publicHost": { "production": { "host": "pg.my-app.com", "port": 5432 } }
    }
  }
}
\`\`\`
Do not patch user compose files or expose host ports: pegas generates the launch manifest,
attaches services to the shared network and routes domains through the shared Gateway.`;

/** Человекочитаемая строка вызова команды с учётом usage. */
function formatUsageLine(cmdName: string, usage: string): string {
  if (cmdName === "ca") {
    return "ca <install|remove>";
  }
  return usage || cmdName;
}

function formatOptionHints(options: CliOptionDef[]): string {
  if (options.length === 0) return "";
  const names = options.map((o) => (o.short ? `-${o.short}` : `--${o.name}`));
  return ` (${names.join(", ")})`;
}

/**
 * Строит полное содержимое llms.txt из актуального списка команд CLI.
 */
export function buildLlmsText(): string {
  const lines: string[] = [];

  lines.push("# pegas");
  lines.push("");
  lines.push("> Agent-native declarative environment manager for Docker multi-app VPS setups (Caddy Gateway, containers, routes, domains).");
  lines.push("");
  lines.push(CORE_CONCEPTS);
  lines.push("");
  lines.push("## CLI Usage for Agents");

  for (const cmd of COMMANDS) {
    const usage = formatUsageLine(cmd.name, cmd.usage || "");
    const hints = formatOptionHints(cmd.options || []);
    const invocations: string[] = [];

    if (cmd.name === "logs") {
      invocations.push("npx pegas logs -f");
      invocations.push("npx pegas logs production");
      invocations.push("npx pegas logs api -f");
    } else if (cmd.name === "connect") {
      invocations.push("npx pegas connect");
    } else if (cmd.name === "disconnect") {
      invocations.push("npx pegas disconnect");
    } else if (cmd.name === "ca") {
      invocations.push("npx pegas ca install");
      invocations.push("npx pegas ca remove");
    } else if (cmd.name === "init" || cmd.name === "update") {
      invocations.push(`npx @netrunner714/pegas ${usage}`);
    } else {
      invocations.push(`npx pegas ${usage}`);
    }

    for (const inv of invocations) {
      lines.push(`- \`${inv}\`${hints} — ${cmd.summary}.`);
    }
  }

  lines.push("");
  lines.push(`## Global Options`);
  for (const opt of GLOBAL_OPTIONS) {
    const label = opt.short ? `-${opt.short}, --${opt.name}` : `--${opt.name}`;
    lines.push(`- \`${label}\`${opt.placeholder ? ` ${opt.placeholder}` : ""} — ${opt.description}.`);
  }

  lines.push("");
  lines.push(CONTRACT_EXAMPLE);
  lines.push("");

  return lines.join("\n");
}

export const LLMS_TXT_CONTENT: string = buildLlmsText();

export function handleLlms(options: { json?: boolean }): void {
  if (options.json) {
    console.log(JSON.stringify({ llms: LLMS_TXT_CONTENT }));
  } else {
    console.log(LLMS_TXT_CONTENT);
  }
}
