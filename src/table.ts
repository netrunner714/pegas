/**
 * Zero-dependency ASCII/Unicode Table Formatter
 * Supports ANSI colors and visual character width (including emoji support).
 */

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Calculates the visible column width in terminal cells.
 * Accounts for ANSI codes (0 width) and wide characters / emojis (2 width).
 */
export function stringVisualWidth(str: string): number {
  const clean = stripAnsi(str);
  let width = 0;
  for (const char of clean) {
    const cp = char.codePointAt(0) || 0;
    // Emojis (e.g. 🟢, 🔴, 🟡, ⚪) and wide Unicode ranges occupy 2 terminal cells
    if ((cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf)) {
      width += 2;
    } else if (cp >= 0x20 && cp <= 0x7e) {
      width += 1;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Pads a string with spaces to a target visual width, correctly ignoring ANSI color escape sequences.
 */
export function padEndVisual(str: string, targetWidth: number): string {
  const current = stringVisualWidth(str);
  const diff = targetWidth - current;
  return diff > 0 ? str + " ".repeat(diff) : str;
}

export interface RenderTableOptions {
  headers: string[];
  rows: string[][];
}

/**
 * Renders an aligned Unicode box table.
 */
export function renderTable({ headers, rows }: RenderTableOptions): string {
  if (headers.length === 0) return "";

  // Compute maximum width for each column
  const colWidths = headers.map((header, colIdx) => {
    let max = stringVisualWidth(header);
    for (const row of rows) {
      const cell = row[colIdx] || "";
      const w = stringVisualWidth(cell);
      if (w > max) max = w;
    }
    return max;
  });

  const topBorder = "┌─" + colWidths.map((w) => "─".repeat(w)).join("─┬─") + "─┐";
  const midBorder = "├─" + colWidths.map((w) => "─".repeat(w)).join("─┼─") + "─┤";
  const botBorder = "└─" + colWidths.map((w) => "─".repeat(w)).join("─┴─") + "─┘";

  const headerLine =
    "│ " +
    headers
      .map((h, i) => padEndVisual(`\x1b[1m${h}\x1b[0m`, colWidths[i]))
      .join(" │ ") +
    " │";

  const dataLines = rows.map((row) => {
    return (
      "│ " +
      colWidths
        .map((w, colIdx) => padEndVisual(row[colIdx] || "", w))
        .join(" │ ") +
      " │"
    );
  });

  return [topBorder, headerLine, midBorder, ...dataLines, botBorder].join("\n");
}
