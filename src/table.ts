/**
 * Zero-dependency ASCII/Unicode Table Formatter
 * Supports ANSI colors and visual character width (including emoji support).
 */

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Кодпоинты 0x2600–0x27BF со свойством Emoji_Presentation (Unicode).
 *
 * Только они занимают две терминальные ячейки в этом диапазоне. Остальные
 * символы там — текстового представления и рисуются в одну ячейку: прежняя
 * проверка «весь диапазон 0x2600–0x27BF широкий» ломала выравнивание таблиц на
 * символах вроде ★ (U+2605), ✓ (U+2713) и ➖ (U+2796).
 */
const EMOJI_PRESENTATION_2600: ReadonlySet<number> = new Set([
  0x2614, 0x2615, // ☔ ☕
  0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e, 0x264f, // знаки зодиака
  0x2650, 0x2651, 0x2652, 0x2653,
  0x267f, // ♿
  0x2693, // ⚓
  0x26a1, // ⚡
  0x26aa, 0x26ab, // ⚪ ⚫
  0x26bd, 0x26be, // ⚽ ⚾
  0x26c4, 0x26c5, // ⛄ ⛅
  0x26ce, // ⛎
  0x26d4, // ⛔
  0x26ea, // ⛪
  0x26f2, 0x26f3, // ⛲ ⛳
  0x26f5, // ⛵
  0x26fa, // ⛺
  0x26fd, // ⛽
  0x2705, // ✅
  0x270a, 0x270b, // ✊ ✋
  0x2728, // ✨
  0x274c, 0x274e, // ❌ ❎
  0x2753, 0x2754, 0x2755, // ❓ ❔ ❕
  0x2757, // ❗
  0x2795, 0x2796, 0x2797, // ➕ ➖ ➗
  0x27b0, // ➰
  0x27bf, // ➿
]);

/**
 * Диапазоны East Asian Wide/Fullwidth: CJK-иероглифы, хангыль, полная ширина.
 * Без них имена проектов с CJK-символами разъезжали бы в таблице.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],   // Jamo
  [0x2e80, 0x303e],   // CJK-радикалы, пунктуация
  [0x3041, 0x33ff],   // кана, CJK-символы
  [0x3400, 0x4dbf],   // CJK Ext A
  [0x4e00, 0x9fff],   // CJK Unified
  [0xa000, 0xa4cf],   // Yi
  [0xa960, 0xa97f],   // Jamo Extended-A
  [0xac00, 0xd7a3],   // Hangul
  [0xf900, 0xfaff],   // CJK Compatibility
  [0xfe10, 0xfe19],   // вертикальные формы
  [0xfe30, 0xfe6f],   // CJK-формы совместимости
  [0xff00, 0xff60],   // полная ширина
  [0xffe0, 0xffe6],   // полная ширина (знаки)
  [0x1f300, 0x1f9ff], // эмодзи-блоки
  [0x1fa70, 0x1faff], // эмодзи (расширения)
  [0x20000, 0x3fffd], // CJK Ext B+
];

/** Ширина одного кодпоинта в терминальных ячейках. */
function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  // Невидимые: вариант-селекторы, zero-width joiner/space, комбинирующие метки.
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return 0;
  if (cp === 0xfe0e || cp === 0xfe0f) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp >= 0x20d0 && cp <= 0x20f0) return 0;
  // Управляющие символы не занимают ячеек.
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;

  if (cp >= 0x2600 && cp <= 0x27bf) {
    return EMOJI_PRESENTATION_2600.has(cp) ? 2 : 1;
  }
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

/**
 * Calculates the visible column width in terminal cells.
 * Accounts for ANSI codes (0 width) and wide characters / emojis (2 width).
 *
 * Символ с Emoji_Presentation=No рисуется в одну ячейку, если за ним не идёт
 * вариатор U+FE0F (VS16) — он переключает представление на эмодзи и делает
 * символ широким. U+FE0E (VS15), наоборот, фиксирует текстовое представление.
 */
export function stringVisualWidth(str: string): number {
  const clean = stripAnsi(str);
  const cps = [...clean].map((ch) => ch.codePointAt(0) || 0);
  let width = 0;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const next = cps[i + 1];
    if (next === 0xfe0f) {
      // VS16: эмодзи-представление — символ широкий, сам вариатор невидим.
      width += 2;
      i++;
      continue;
    }
    if (next === 0xfe0e) {
      // VS15: текстовое представление — символ узкий, вариатор невидим.
      width += 1;
      i++;
      continue;
    }
    width += codePointWidth(cp);
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
