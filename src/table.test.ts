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

  it("символы текстового представления занимают одну ячейку (issue #30)", () => {
    // ★/✓/✗ — Emoji_Presentation=No: терминал рисует их узкими.
    // Прежняя проверка «весь диапазон 0x2600–0x27BF широкий» ломала выравнивание.
    expect(stringVisualWidth("★")).toBe(1);
    expect(stringVisualWidth("✓")).toBe(1);
    expect(stringVisualWidth("✗")).toBe(1);
    // Эмодзи-представление в том же диапазоне остаётся широким.
    expect(stringVisualWidth("⚪")).toBe(2);
    expect(stringVisualWidth("➖")).toBe(2);
    expect(stringVisualWidth("✨")).toBe(2);
  });

  it("вариатор U+FE0F переключает текстовый символ на широкое представление", () => {
    expect(stringVisualWidth("⚠")).toBe(1);
    expect(stringVisualWidth("⚠️")).toBe(2);
    // U+FE0E фиксирует текстовое представление даже у эмодзи-символа
    expect(stringVisualWidth("🟢\u{FE0E}")).toBe(1);
  });

  it("невидимые символы не занимают ячеек", () => {
    expect(stringVisualWidth("a\u{200B}b")).toBe(2);
    expect(stringVisualWidth("a\u{FEFF}b")).toBe(2);
    expect(stringVisualWidth("\x1b[32m\x1b[0m")).toBe(0);
  });

  it("широкие символы занимают две ячейки: имена проектов не разъезжаются", () => {
    // CJK-иероглиф U+6F22 и хангыль U+D55C заданы escapes, чтобы тест не зависел
    // от кодировки файла; ширина в терминале у них — 2 ячейки.
    expect(stringVisualWidth("\u{6F22}\u{5B57}")).toBe(4);
    expect(stringVisualWidth("\u{D55C}\u{AE00}")).toBe(4);
    expect(stringVisualWidth("app\u{6F22}")).toBe(5);
  });

  it("renderTable выравнивает строки с узкими и широкими символами", () => {
    const output = renderTable({
      headers: ["", "NAME"],
      rows: [["★", "app"], ["", "app"]],
    });
    // Все линии рамки одной длины — иначе таблица разъезжается в терминале.
    const widths = new Set(output.split("\n").map((l) => stringVisualWidth(l)));
    expect(widths.size).toBe(1);
    expect(output).toContain("★");
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
