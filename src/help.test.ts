import { describe, it, expect } from "bun:test";
import { generateHelpText, getParseArgsOptions, COMMANDS } from "./help.js";
import { VERSION } from "./version.js";

describe("dynamic help text generation", () => {
  it("generates full global help text with version, commands, and options", () => {
    const help = generateHelpText();

    expect(help).toContain(`pegas v${VERSION}`);
    expect(help).toContain("USAGE:");
    expect(help).toContain("COMMANDS:");
    expect(help).toContain("GLOBAL OPTIONS:");
    expect(help).toContain("EXAMPLES:");

    // Checks that all commands appear in help
    for (const cmd of COMMANDS) {
      expect(help).toContain(cmd.name);
    }
  });

  it("generates command-specific help for subcommands", () => {
    const devHelp = generateHelpText("dev");
    expect(devHelp).toContain("pegas dev");
    expect(devHelp).toContain("--cwd");
    expect(devHelp).toContain("GLOBAL OPTIONS:");

    const initHelp = generateHelpText("init");
    expect(initHelp).toContain("pegas init");
    expect(initHelp).toContain("--force");
    expect(initHelp).toContain("--dry-run");

    const updateHelp = generateHelpText("update");
    expect(updateHelp).toContain("pegas update");
    expect(updateHelp).toContain("--latest");
  });

  it("derives complete parseArgs options from definitions", () => {
    const opts = getParseArgsOptions();

    expect(opts["gateway-dir"].type).toBe("string");
    expect(opts["json"].type).toBe("boolean");
    expect(opts["force"].type).toBe("boolean");
    expect(opts["latest"].type).toBe("boolean");
    expect(opts["env"].type).toBe("string");
    expect(opts["env"].short).toBe("e");
  });
});
