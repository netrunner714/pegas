import { COMMANDS, GLOBAL_OPTIONS, CliOptionDef } from "../help.js";

/**
 * Генерируемый контекст для LLM-агентов (`llms.txt`).
 *
 * Секция CLI Usage строится из `COMMANDS` в help.ts — единого источника
 * истины о командах. При изменении CLI достаточно запустить
 * `bun run build` (или `bun run gen:llms`): llms.txt перегенерируется.
 */

const CORE_CONCEPTS = `## Core Concepts
- Manages single reverse proxy (Caddy 2) listening on :80 and :443.
- All Docker projects attach to a shared Docker bridge network named \`pegas-network\`.
- Never expose 80:80 or 443:443 in application compose files.
- Each project gets an isolated declarative drop-in configuration in \`conf.d/<projectName>.caddy\`.
- Hot-reloads Caddy via API with zero downtime and automatic validation rollback.
- Auto-provisions Let's Encrypt SSL on first request.
- Local dev: trusted HTTPS via \`pegas ca install\` (one-time), clean URLs on port 443 (\`[service].[project].localhost\`).`;

const COMPOSE_EXAMPLE = `## Example Docker Compose Patch for Any App
\`\`\`yaml
services:
  app:
    expose:
      - "3000"
    networks:
      pegas-network:
        aliases:
          - <projectName>-app

networks:
  pegas-network:
    external: true
\`\`\``;

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
  lines.push("> Agent-native zero-config Caddy reverse proxy for Docker multi-app VPS setups.");
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
  lines.push(COMPOSE_EXAMPLE);
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
