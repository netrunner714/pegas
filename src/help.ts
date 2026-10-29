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
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: ["$ pegas update", "$ pegas update --latest"],
  },
  {
    name: "dev",
    summary: "Start local HTTPS proxy and development environment",
    usage: "dev [options] [-- <command...>]",
    options: [
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: [
      "$ pegas dev",
      "$ pegas dev -- next dev",
    ],
  },
  {
    name: "deploy",
    summary: "Deploy project containers and configure Caddy routes",
    usage: "deploy <env> [options]",
    options: [
      {
        name: "env",
        type: "string",
        short: "e",
        placeholder: "<name>",
        description: "Target environment contour (e.g. production, stage)",
      },
      {
        name: "cwd",
        type: "string",
        placeholder: "<path>",
        description: "Target project directory",
      },
    ],
    examples: [
      "$ pegas deploy production",
      "$ pegas deploy stage",
    ],
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
    name: "status",
    summary: "Check gateway health and active project routes",
    usage: "status [options]",
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
      label += " [env]";
    } else if (cmd.name === "dev") {
      label += " [-- <command>]";
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
    { name: "dev", options: COMMANDS.find((c) => c.name === "dev")?.options || [] },
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
  lines.push(`  $ pegas dev`);
  lines.push(`  $ pegas deploy`);
  lines.push(`  $ pegas status`);
  lines.push("");

  return lines.join("\n");
}
