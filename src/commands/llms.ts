import { COMMANDS, GLOBAL_OPTIONS, CliOptionDef } from "../help.js";

/**
 * Генерируемый контекст для LLM-агентов (`llms.txt`).
 *
 * Секция CLI Usage строится из `COMMANDS` в help.ts — единого источника
 * истины о командах. При изменении CLI достаточно запустить
 * `bun run build`: llms.txt перегенерируется.
 */

const CORE_CONCEPTS = `## Core Concepts
- Declarative environment manager for Docker multi-app setups: \`pegas.json\` is the single source of truth.
- \`runtime: "docker"\` in pegas.json opts into the container runtime; \`init\` auto-detects it (Dockerfile or compose files present).
- One shared Docker bridge network \`pegas-network\`; one shared Caddy Gateway container owning ports 80/443.
- Never expose 80:80 or 443:443 in application compose files; the Gateway owns host ports and proxies by network aliases.
- The launch manifest is generated from pegas.json and is ephemeral (passed via stdin); user compose files are not the source of truth.
- Containers carry Docker labels: \`pegas.project\`, \`pegas.environment\`, \`pegas.service\`, \`pegas.manifest-hash\`.
- Service aliases inside the shared network are \`<checkout-id>-<environment>-<service>\`: several checkouts and environments coexist.
- Each project gets an isolated declarative route file \`conf.d/<projectName>.caddy\` (per environment); hot-reload with validation and rollback.
- Auto-provisions Let's Encrypt SSL on first request.
- Dev containers bind-mount sources and keep dependencies in named volumes; apps run their real dev commands inside containers.
- \`pegas dev\` never manages lifecycle: it verifies the environment matches the contract and attaches to logs; Ctrl+C only detaches.
- Local dev HTTPS: \`pegas ca install\` (one-time), clean URLs on port 443 (\`[service].[project].localhost\`).`;

const CONTRACT_EXAMPLE = `## Example pegas.json (docker runtime)
\`\`\`jsonc
{
  "projectName": "my-app",
  "runtime": "docker",
  "services": {
    "web": {
      "role": "app",
      "port": 3000,
      "domains": {
        "development": ["my-app.localhost"],
        "production": ["my-app.com"]
      }
    },
    "postgres": {
      "role": "infra",
      "image": "postgres:18-alpine",
      "env": { "POSTGRES_USER": "app", "POSTGRES_PASSWORD": "see envFile" },
      "volumes": ["pgdata:/var/lib/postgresql"]
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

    if (cmd.name === "dev") {
      invocations.push("npx pegas dev -- <command>");
      invocations.push("npx pegas dev");
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
