import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { handleLlms, LLMS_TXT_CONTENT, buildLlmsText } from "./llms.js";
import { COMMANDS } from "../help.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

describe("pegas llms", () => {
  it("exports LLMS_TXT_CONTENT containing core Pegas concepts", () => {
    expect(LLMS_TXT_CONTENT).toContain("# pegas");
    expect(LLMS_TXT_CONTENT).toContain("pegas-network");
    expect(LLMS_TXT_CONTENT).toContain("pegas dev");
    expect(LLMS_TXT_CONTENT).toContain("pegas deploy");
    expect(LLMS_TXT_CONTENT).toContain("pegas init");
  });

  it("LLMS_TXT_CONTENT is derived from the current COMMANDS registry (no stale commands)", () => {
    // Каждая команда из help.ts обязана попасть в llms-контекст
    for (const cmd of COMMANDS) {
      expect(LLMS_TXT_CONTENT).toContain(`pegas ${cmd.name}`);
    }
    // И наоборот: несуществующих команд быть не должно
    expect(LLMS_TXT_CONTENT).not.toContain("pegas add ");
    expect(LLMS_TXT_CONTENT).not.toContain("pegas remove ");
    expect(LLMS_TXT_CONTENT).not.toContain("pegas list");
  });

  it("committed llms.txt matches buildLlmsText() — regenerate with 'bun run gen:llms' when stale", async () => {
    const committed = await fs.readFile(path.join(REPO_ROOT, "llms.txt"), "utf-8");
    expect(committed).toBe(buildLlmsText());
  });

  it("buildLlmsText() is deterministic", () => {
    expect(buildLlmsText()).toBe(buildLlmsText());
  });

  it("handleLlms outputs plain text markdown by default", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      handleLlms({ json: false });
    } finally {
      console.log = origLog;
    }

    expect(logs.length).toBe(1);
    expect(logs[0]).toBe(LLMS_TXT_CONTENT);
  });

  it("handleLlms outputs structured JSON with json: true", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      handleLlms({ json: true });
    } finally {
      console.log = origLog;
    }

    const res = JSON.parse(logs[0]);
    expect(res.llms).toBe(LLMS_TXT_CONTENT);
  });
});
