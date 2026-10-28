import { describe, it, expect } from "bun:test";
import { handleLlms, LLMS_TXT_CONTENT } from "./llms.js";

describe("pegas llms", () => {
  it("exports LLMS_TXT_CONTENT containing core Pegas concepts", () => {
    expect(LLMS_TXT_CONTENT).toContain("# pegas");
    expect(LLMS_TXT_CONTENT).toContain("pegas-network");
    expect(LLMS_TXT_CONTENT).toContain("pegas dev");
    expect(LLMS_TXT_CONTENT).toContain("pegas deploy");
    expect(LLMS_TXT_CONTENT).toContain("pegas init");
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
