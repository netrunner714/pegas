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
    summary: "Scaffold Pegas files: AGENTS.md marker block, docs/pegas.md, .pegas/, .gitignore entries (pegas.json is NOT created)",
    usage: "init [options]",
    options: [
      {
        name: "force",
        type: "boolean",
        default: false,
        description: "Re-scaffold even if marker block already exists (idempotent merge)",
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
    summary: "Update local @netrunner714/pegas dependency in the current project",
    usage: "update [options]",
    options: [
      {
        name: "latest",
        type: "boolean",
        default: false,
        description: "Upgrade across major versions (e.g. 2.x -> 3.x)",
      },
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: ["$ pegas update", "$ pegas update --latest"],
  },
  {
    name: "upgrade",
    summary: "Upgrade the global pegas installation on this machine (bun add -g / npm install -g)",
    usage: "upgrade [options]",
    options: [
      {
        name: "latest",
        type: "boolean",
        default: false,
        description: "Upgrade across major versions (e.g. 2.x -> 3.x)",
      },
    ],
    examples: ["$ pegas upgrade", "$ pegas upgrade --latest"],
  },
  {
    name: "connect",
    summary: "Expose development services via shared gateway (routes host services through host.docker.internal)",
    usage: "connect [options]",
    options: [
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
      {
        name: "dry-run",
        type: "boolean",
        default: false,
        description: "Print the route file without writing to disk",
      },
    ],
    examples: ["$ pegas connect", "$ pegas connect --dry-run"],
  },
  {
    name: "disconnect",
    summary: "Remove development route file from the gateway and stop the gateway if unused",
    usage: "disconnect [options]",
    options: [
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: ["$ pegas disconnect"],
  },
  {
    name: "logs",
    summary: "Stream or view container logs for development, stage, and production environments",
    usage: "logs [env] [service] [options]",
    options: [
      {
        name: "env",
        type: "string",
        short: "e",
        placeholder: "<name>",
        description: "Target environment contour (default: development)",
      },
      {
        name: "follow",
        type: "boolean",
        short: "f",
        default: false,
        description: "Follow log output in real time",
      },
      {
        name: "tail",
        type: "string",
        short: "n",
        placeholder: "<lines>",
        description: "Number of lines to show from the end of the logs (default: 100)",
      },
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: [
      "$ pegas logs",
      "$ pegas logs -f",
      "$ pegas logs production",
      "$ pegas logs production -f",
      "$ pegas logs development api -f",
      "$ pegas logs -n 50",
    ],
  },
  {
    name: "deploy",
    summary: "Deploy a scenario from pegas.json: network, shared Gateway, containers, routes",
    usage: "deploy -s <scenario> [options]",
    options: [
      {
        name: "scenario",
        type: "string",
        short: "s",
        placeholder: "<name>",
        description: "Target scenario from pegas.json (e.g. production, stage)",
      },
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
      {
        name: "skip-dns-check",
        type: "boolean",
        default: false,
        description: "Skip DNS pre-flight verification",
      },
      {
        name: "strict-dns",
        type: "boolean",
        default: false,
        description: "Abort deployment if DNS does not resolve to this host",
      },
      {
        name: "skip-up",
        type: "boolean",
        default: false,
        description: "Configure routes without bringing up containers",
      },
      {
        name: "dry-run",
        type: "boolean",
        default: false,
        description: "Read-only validation: contract, secrets, DNS, manifest (docker compose config -q) and a deployment plan — no mutations",
      },
    ],
    examples: [
      "$ pegas deploy -s production",
      "$ pegas deploy --scenario stage",
      "$ pegas deploy -s development --dry-run",
    ],
  },
  {
    name: "down",
    summary: "Remove project containers and Caddy routes (all environments, or one with --env)",
    usage: "down [options]",
    options: [
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
      {
        name: "env",
        type: "string",
        placeholder: "<environment>",
        description: "Remove only this environment (default: all environments of the checkout)",
      },
    ],
    examples: ["$ pegas down", "$ pegas down --env development"],
  },
  {
    name: "ca",
    summary: "Manage local Root CA for trusted dev HTTPS (install/remove)",
    usage: "ca <install|remove> [options]",
    options: [
      {
        name: "dry-run",
        type: "boolean",
        default: false,
        description: "Print planned actions without applying changes",
      },
    ],
    examples: ["$ pegas ca install", "$ pegas ca remove"],
  },
  {
    name: "check",
    summary: "Read-only audit: validate the v3 contract, secrets parity, and .gitignore hygiene (no --fix, never mutates)",
    usage: "check [options]",
    options: [
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: ["$ pegas check", "$ pegas check --json"],
  },
  {
    name: "status",
    summary: "Unified dashboard: gateway health plus every Pegas service with real process health",
    usage: "status [options]",
    options: [
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Project directory whose rows are marked with ★ in the dashboard",
      },
    ],
    examples: ["$ pegas status", "$ pegas status --json"],
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
    if (cmd.name === "deploy") {
      label += " -s <scenario>";
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
    { name: "deploy", options: COMMANDS.find((c) => c.name === "deploy")?.options || [] },
    { name: "init", options: COMMANDS.find((c) => c.name === "init")?.options || [] },
    { name: "connect", options: COMMANDS.find((c) => c.name === "connect")?.options || [] },
    { name: "disconnect", options: COMMANDS.find((c) => c.name === "disconnect")?.options || [] },
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
  lines.push(`  $ pegas connect`);
  lines.push(`  $ pegas deploy -s production`);
  lines.push(`  $ pegas logs -f`);
  lines.push(`  $ pegas status`);
  lines.push(`  $ pegas down`);
  lines.push("");

  return lines.join("\n");
}
