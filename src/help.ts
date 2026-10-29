import { VERSION } from "./version.js";

export interface CliOptionDef {
  name: string;
  type: "string" | "boolean";
  short?: string;
  placeholder?: string;
  description: string;
  default?: any;
}

export interface CliCommandDef {
  name: string;
  aliases?: string[];
  summary: string;
  usage?: string;
  options?: CliOptionDef[];
  examples?: string[];
}

export const GLOBAL_OPTIONS: CliOptionDef[] = [
  {
    name: "gateway-dir",
    type: "string",
    placeholder: "<path>",
    description: "Override path to gateway directory",
  },
  {
    name: "json",
    type: "boolean",
    default: false,
    description: "Output machine-readable JSON (ideal for AI agents and scripts)",
  },
  {
    name: "help",
    type: "boolean",
    short: "h",
    description: "Show this help message",
  },
  {
    name: "version",
    type: "boolean",
    short: "v",
    description: "Show version",
  },
];

export const COMMANDS: CliCommandDef[] = [
  {
    name: "init",
    summary: "Init Pegas in current project",
    usage: "init [options]",
    options: [
      {
        name: "force",
        type: "boolean",
        default: false,
        description: "Reset contract pegas.json to defaults (creates pegas.json.bak)",
      },
      {
        name: "dry-run",
        type: "boolean",
        default: false,
        description: "Print planned project files without writing to disk",
      },
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: ["$ pegas init", "$ pegas init --force", "$ pegas init --dry-run"],
  },
  {
    name: "update",
    summary: "Update @netrunner714/pegas to latest version",
    usage: "update [options]",
    options: [
      {
        name: "latest",
        type: "boolean",
        default: false,
        description: "Upgrade across major versions (e.g. 1.x -> 2.x)",
      },
      {
        name: "dry-run",
        type: "boolean",
        default: false,
        description: "Print planned updates without writing to disk",
      },
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: ["$ pegas update", "$ pegas update --latest", "$ pegas update --dry-run"],
  },
  {
    name: "up",
    summary: "Bring up environment (development, stage, production)",
    usage: "up -e <name> [options] [-- <command...>]",
    options: [
      {
        name: "env",
        type: "string",
        short: "e",
        placeholder: "<name>",
        description: "Target environment contour (development, stage, production, etc.)",
      },
      {
        name: "strict-dns",
        type: "boolean",
        default: false,
        description: "Abort deployment if DNS records do not match server IP",
      },
      {
        name: "skip-dns-check",
        type: "boolean",
        default: false,
        description: "Bypass DNS pre-flight verification",
      },
      {
        name: "skip-up",
        type: "boolean",
        default: false,
        description: "Skip docker compose up step",
      },
      {
        name: "skip-readiness",
        type: "boolean",
        default: false,
        description: "Skip container health / readiness polling",
      },
      {
        name: "system-caddy",
        type: "boolean",
        default: false,
        description: "Use system Caddy binary from PATH",
      },
      {
        name: "caddy-path",
        type: "string",
        placeholder: "<path>",
        description: "Custom path or directory for Caddy binary",
      },
      {
        name: "dry-run",
        type: "boolean",
        default: false,
        description: "Simulate execution without starting containers or updating Caddy",
      },
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: [
      "$ pegas up --env development",
      "$ pegas up --env production",
      "$ pegas up --env stage --strict-dns",
    ],
  },
  {
    name: "dev",
    summary: "Alias for 'pegas up --env development'",
    usage: "dev [options] [-- <command...>]",
    options: [
      {
        name: "infra",
        type: "boolean",
        description: "Boot infrastructure services defined in docker-compose.yml",
      },
      {
        name: "no-infra",
        type: "boolean",
        description: "Do not boot infrastructure services even if enabled in pegas.json",
      },
      {
        name: "system-caddy",
        type: "boolean",
        default: false,
        description: "Use system Caddy binary from PATH",
      },
      {
        name: "caddy-path",
        type: "string",
        placeholder: "<path>",
        description: "Custom path or directory for Caddy binary",
      },
      {
        name: "dry-run",
        type: "boolean",
        default: false,
        description: "Simulate dev environment startup without launching Caddy",
      },
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: [
      "$ pegas dev",
      "$ pegas dev --infra",
      "$ pegas dev -- next dev",
    ],
  },
  {
    name: "deploy",
    summary: "Alias for 'pegas up --env production'",
    usage: "deploy [options]",
    options: [
      {
        name: "strict-dns",
        type: "boolean",
        default: false,
        description: "Abort deployment if DNS records do not match server IP",
      },
      {
        name: "skip-dns-check",
        type: "boolean",
        default: false,
        description: "Bypass DNS pre-flight verification",
      },
      {
        name: "skip-readiness",
        type: "boolean",
        default: false,
        description: "Skip container health / readiness polling",
      },
      {
        name: "dry-run",
        type: "boolean",
        default: false,
        description: "Simulate deployment without starting containers or updating Caddy",
      },
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: ["$ pegas deploy", "$ pegas deploy --strict-dns"],
  },
  {
    name: "down",
    summary: "Tear down project containers and remove Caddy routes",
    usage: "down [options]",
    options: [
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: ["$ pegas down"],
  },
  {
    name: "add",
    summary: "Route a domain to an internal container upstream",
    usage: "add <domain> [options]",
    options: [
      {
        name: "upstream",
        type: "string",
        short: "u",
        placeholder: "<target>",
        description: "Upstream container:port (e.g. web:3000)",
      },
      {
        name: "spa",
        type: "boolean",
        default: false,
        description: "SPA mode (separate frontend and API proxying)",
      },
      {
        name: "api-upstream",
        type: "string",
        placeholder: "<tgt>",
        description: "Upstream for API backend (e.g. api:8000)",
      },
      {
        name: "api-prefix",
        type: "string",
        placeholder: "<pfx>",
        default: "/api/*",
        description: "API path prefix (default: /api/*)",
      },
      {
        name: "no-www",
        type: "boolean",
        default: false,
        description: "Do not auto-generate www redirect",
      },
      {
        name: "force",
        type: "boolean",
        default: false,
        description: "Overwrite existing route file",
      },
      {
        name: "dry-run",
        type: "boolean",
        default: false,
        description: "Print generated config without applying",
      },
    ],
    examples: [
      "$ pegas add myapp.ru --upstream web:3000",
      "$ pegas add api.myapp.ru --upstream api:8000",
      "$ pegas add app.com --spa --api-upstream backend:5000",
    ],
  },
  {
    name: "list",
    aliases: ["ls"],
    summary: "List all active domain routes",
    usage: "list [options]",
    examples: ["$ pegas list", "$ pegas ls"],
  },
  {
    name: "remove",
    aliases: ["rm"],
    summary: "Delete route and reload Caddy",
    usage: "remove <domain> [options]",
    examples: ["$ pegas remove myapp.ru", "$ pegas rm myapp.ru"],
  },
  {
    name: "reload",
    summary: "Validate and hot-reload Caddy configuration",
    usage: "reload [options]",
    examples: ["$ pegas reload"],
  },
  {
    name: "status",
    summary: "Check Docker and gateway health",
    usage: "status [options]",
    examples: ["$ pegas status"],
  },
  {
    name: "llms",
    summary: "Print machine-readable LLM context",
    usage: "llms [options]",
    examples: ["$ pegas llms", "$ pegas llms --json"],
  },
];

/**
 * Derives the options configuration for `node:util` parseArgs
 * from all registered commands and global options.
 */
export function getParseArgsOptions(): Record<
  string,
  { type: "string" | "boolean"; short?: string; default?: any }
> {
  const result: Record<
    string,
    { type: "string" | "boolean"; short?: string; default?: any }
  > = {};

  const allOptions: CliOptionDef[] = [...GLOBAL_OPTIONS];
  for (const cmd of COMMANDS) {
    if (cmd.options) {
      allOptions.push(...cmd.options);
    }
  }

  for (const opt of allOptions) {
    if (!result[opt.name]) {
      result[opt.name] = {
        type: opt.type,
        ...(opt.short ? { short: opt.short } : {}),
        ...(opt.default !== undefined ? { default: opt.default } : {}),
      };
    }
  }

  // Support internal flags
  if (!result.write) {
    result.write = { type: "boolean", default: false };
  }

  return result;
}

function formatOptionLabel(opt: CliOptionDef): string {
  const shortPart = opt.short ? `-${opt.short}, ` : "    ";
  const namePart = `--${opt.name}`;
  const placeholderPart = opt.placeholder ? ` ${opt.placeholder}` : "";
  return `${shortPart}${namePart}${placeholderPart}`;
}

function formatSectionOptions(options: CliOptionDef[], indent = 2): string[] {
  if (options.length === 0) return [];
  const lines: string[] = [];
  const labels = options.map(formatOptionLabel);
  const maxLabelWidth = Math.max(...labels.map((l) => l.length), 20);

  for (let i = 0; i < options.length; i++) {
    const label = labels[i];
    const desc = options[i].description;
    const padding = " ".repeat(Math.max(2, maxLabelWidth - label.length + 2));
    lines.push(`${" ".repeat(indent)}${label}${padding}${desc}`);
  }
  return lines;
}

/**
 * Generates help text dynamically for the full CLI or a specific command.
 */
export function generateHelpText(commandName?: string): string {
  if (commandName) {
    const target = commandName.toLowerCase();
    const cmd = COMMANDS.find((c) => c.name === target || c.aliases?.includes(target));

    if (cmd) {
      const lines: string[] = [];
      const aliasStr = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(", ")})` : "";
      lines.push(`pegas ${cmd.name} — ${cmd.summary}${aliasStr}\n`);
      lines.push(`USAGE:`);
      lines.push(`  $ pegas ${cmd.usage || cmd.name + " [options]"}\n`);

      if (cmd.options && cmd.options.length > 0) {
        lines.push(`OPTIONS FOR '${cmd.name}':`);
        lines.push(...formatSectionOptions(cmd.options));
        lines.push("");
      }

      lines.push(`GLOBAL OPTIONS:`);
      lines.push(...formatSectionOptions(GLOBAL_OPTIONS));
      lines.push("");

      if (cmd.examples && cmd.examples.length > 0) {
        lines.push(`EXAMPLES:`);
        for (const ex of cmd.examples) {
          lines.push(`  ${ex}`);
        }
        lines.push("");
      }

      return lines.join("\n");
    }
  }

  // Global help output
  const lines: string[] = [];
  lines.push(`pegas v${VERSION} — Agent-native Caddy gateway for multi-app VPS\n`);
  lines.push(`USAGE:`);
  lines.push(`  $ pegas <command> [options]\n`);

  lines.push(`COMMANDS:`);
  const cmdLabels: string[] = [];
  for (const cmd of COMMANDS) {
    let label = cmd.name;
    if (cmd.aliases && cmd.aliases.length > 0) {
      label += `, ${cmd.aliases.join(", ")}`;
    }
    if (cmd.name === "up") {
      label += " --env <name>";
    } else if (cmd.name === "dev") {
      label += " [-- <command>]";
    } else if (cmd.name === "add") {
      label += " <domain> [options]";
    } else if (cmd.name === "remove") {
      label += " <domain>";
    }
    cmdLabels.push(label);
  }

  const maxCmdWidth = Math.max(...cmdLabels.map((l) => l.length), 24);
  for (let i = 0; i < COMMANDS.length; i++) {
    const label = cmdLabels[i];
    const desc = COMMANDS[i].summary;
    const padding = " ".repeat(Math.max(2, maxCmdWidth - label.length + 2));
    lines.push(`  ${label}${padding}${desc}`);
  }
  lines.push("");

  // Detailed command option sections
  const commandOptionSections: Array<{ name: string; options: CliOptionDef[] }> = [
    { name: "update", options: COMMANDS.find((c) => c.name === "update")?.options || [] },
    { name: "up", options: COMMANDS.find((c) => c.name === "up")?.options || [] },
    { name: "init", options: COMMANDS.find((c) => c.name === "init")?.options || [] },
    { name: "add", options: COMMANDS.find((c) => c.name === "add")?.options || [] },
    { name: "dev", options: COMMANDS.find((c) => c.name === "dev")?.options || [] },
    { name: "deploy", options: COMMANDS.find((c) => c.name === "deploy")?.options || [] },
  ];

  for (const sec of commandOptionSections) {
    if (sec.options.length > 0) {
      lines.push(`OPTIONS FOR '${sec.name}':`);
      lines.push(...formatSectionOptions(sec.options));
      lines.push("");
    }
  }

  lines.push(`GLOBAL OPTIONS:`);
  lines.push(...formatSectionOptions(GLOBAL_OPTIONS));
  lines.push("");

  lines.push(`EXAMPLES:`);
  lines.push(`  $ pegas init`);
  lines.push(`  $ pegas add myapp.ru --upstream web:3000`);
  lines.push(`  $ pegas add api.myapp.ru --upstream api:8000`);
  lines.push(`  $ pegas list`);
  lines.push("");

  return lines.join("\n");
}
