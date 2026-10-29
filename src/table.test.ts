import { describe, it, expect } from "bun:test";
import { stripAnsi, stringVisualWidth, padEndVisual, renderTable } from "./table.js";

describe("table utilities", () => {
  it("stripAnsi removes ANSI escape sequences", () => {
    expect(stripAnsi("\x1b[32mhello\x1b[0m")).toBe("hello");
    expect(stripAnsi("\x1b[1m\x1b[31mbold red\x1b[0m")).toBe("bold red");
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  it("stringVisualWidth computes visible terminal width accounting for ANSI and emojis", () => {
    expect(stringVisualWidth("abc")).toBe(3);
    expect(stringVisualWidth("\x1b[32mabc\x1b[0m")).toBe(3);
    // Emojis count as 2 width
    expect(stringVisualWidth("🟢")).toBe(2);
    expect(stringVisualWidth("🟢 Up")).toBe(5);
    expect(stringVisualWidth("\x1b[32m🟢 Up (healthy)\x1b[0m")).toBe(15);
  });

  it("padEndVisual pads strings to visual width correctly", () => {
    expect(padEndVisual("abc", 5)).toBe("abc  ");
    expect(padEndVisual("\x1b[32mabc\x1b[0m", 5)).toBe("\x1b[32mabc\x1b[0m  ");
    expect(padEndVisual("already long", 5)).toBe("already long");
  });

  it("renderTable formats clean Unicode box tables with headers and rows", () => {
    expect(renderTable({ headers: [], rows: [] })).toBe("");

    const output = renderTable({
      headers: ["PROJECT", "STATUS", "PORT"],
      rows: [
        ["app-a", "\x1b[32m🟢 Up\x1b[0m", "3000"],
        ["app-b", "⚪ Stopped", "8080"],
      ],
    });

    expect(output).toContain("┌─");
    expect(output).toContain("├─");
    expect(output).toContain("└─");
    expect(output).toContain("PROJECT");
    expect(output).toContain("STATUS");
    expect(output).toContain("app-a");
    expect(output).toContain("app-b");
    expect(output).toContain("3000");
  });
});
