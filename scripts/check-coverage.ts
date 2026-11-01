#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";

// ANSI colors
const green = (t: string) => `\x1b[32m${t}\x1b[0m`;
const red = (t: string) => `\x1b[31m${t}\x1b[0m`;
const yellow = (t: string) => `\x1b[33m${t}\x1b[0m`;
const bold = (t: string) => `\x1b[1m${t}\x1b[0m`;
const cyan = (t: string) => `\x1b[36m${t}\x1b[0m`;
const dim = (t: string) => `\x1b[2m${t}\x1b[0m`;

const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, "");
const padEnd = (str: string, width: number) => str + " ".repeat(Math.max(0, width - stripAnsi(str).length));
const padStart = (str: string, width: number) => " ".repeat(Math.max(0, width - stripAnsi(str).length)) + str;

interface FileCoverage {
  file: string;
  linesFound: number;
  linesHit: number;
  percentage: number;
  uncoveredLines: number[];
}

function formatRanges(lines: number[]): string {
  if (lines.length === 0) return "";
  const ranges: string[] = [];
  let start = lines[0];
  let end = lines[0];

  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === end + 1) {
      end = lines[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = lines[i];
      end = lines[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(", ");
}

async function findSourceFiles(dir: string, repoRoot: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findSourceFiles(fullPath, repoRoot)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts") &&
      entry.name !== "types.ts" // pure interface/types file
    ) {
      results.push(path.relative(repoRoot, fullPath).replace(/\\/g, "/"));
    }
  }
  return results;
}

export async function runCoverageCheck(opts?: { minTotal?: number; minFile?: number }) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const lcovPath = path.join(repoRoot, ".tmp", "coverage", "lcov.info");

  let lcovContent = "";
  try {
    lcovContent = await fs.readFile(lcovPath, "utf-8");
  } catch {
    console.error(red("❌ Error: '.tmp/coverage/lcov.info' not found. Run 'bun test' first."));
    process.exit(1);
  }

  // Parse CLI args or environment variables for thresholds
  const args = process.argv.slice(2);
  let minTotal = opts?.minTotal ?? parseFloat(process.env.COVERAGE_MIN_TOTAL || "80");
  let minFile = opts?.minFile ?? parseFloat(process.env.COVERAGE_MIN_FILE || "60");

  for (const arg of args) {
    if (arg.startsWith("--min-total=")) {
      minTotal = parseFloat(arg.split("=")[1]);
    } else if (arg.startsWith("--min-file=")) {
      minFile = parseFloat(arg.split("=")[1]);
    }
  }

  const filesMap = new Map<string, FileCoverage>();
  let current: { file: string; linesFound: number; linesHit: number; uncovered: number[] } | null = null;

  for (const line of lcovContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("SF:")) {
      const filePath = trimmed.slice(3).replace(/\\/g, "/");
      current = { file: filePath, linesFound: 0, linesHit: 0, uncovered: [] };
    } else if (trimmed.startsWith("DA:") && current) {
      const parts = trimmed.slice(3).split(",");
      const lineNo = parseInt(parts[0], 10);
      const count = parseInt(parts[1], 10);
      current.linesFound++;
      if (count > 0) {
        current.linesHit++;
      } else {
        current.uncovered.push(lineNo);
      }
    } else if (trimmed === "end_of_record" && current) {
      if (current.linesFound > 0) {
        const percentage = parseFloat(((current.linesHit / current.linesFound) * 100).toFixed(1));
        filesMap.set(current.file, {
          file: current.file,
          linesFound: current.linesFound,
          linesHit: current.linesHit,
          percentage,
          uncoveredLines: current.uncovered,
        });
      }
      current = null;
    }
  }

  // Discover any files in src/ that were completely omitted from coverage (0% tested)
  const srcDir = path.join(repoRoot, "src");
  const allSourceFiles = await findSourceFiles(srcDir, repoRoot);
  const untouchedFiles: string[] = [];

  for (const srcFile of allSourceFiles) {
    if (!filesMap.has(srcFile)) {
      untouchedFiles.push(srcFile);
      try {
        const content = await fs.readFile(path.join(repoRoot, srcFile), "utf-8");
        const lines = content.split("\n");
        let codeLineCount = 0;
        const uncovered: number[] = [];
        lines.forEach((l, idx) => {
          const t = l.trim();
          if (t && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*")) {
            codeLineCount++;
            uncovered.push(idx + 1);
          }
        });
        const total = codeLineCount || lines.length;
        filesMap.set(srcFile, {
          file: srcFile,
          linesFound: total,
          linesHit: 0,
          percentage: 0,
          uncoveredLines: uncovered.length > 0 ? uncovered : [1],
        });
      } catch {
        filesMap.set(srcFile, {
          file: srcFile,
          linesFound: 1,
          linesHit: 0,
          percentage: 0,
          uncoveredLines: [1],
        });
      }
    }
  }

  const files = Array.from(filesMap.values()).sort((a, b) => a.file.localeCompare(b.file));

  let totalLinesFound = 0;
  let totalLinesHit = 0;
  const failingFiles: FileCoverage[] = [];

  for (const f of files) {
    totalLinesFound += f.linesFound;
    totalLinesHit += f.linesHit;
    if (f.percentage < minFile) {
      failingFiles.push(f);
    }
  }

  const totalPercentage = totalLinesFound > 0 ? parseFloat(((totalLinesHit / totalLinesFound) * 100).toFixed(1)) : 0;
  const isTotalFailed = totalPercentage < minTotal;
  const isFailed = isTotalFailed || failingFiles.length > 0;

  console.log(bold("\n========================================================================================================================"));
  console.log(bold("  📊 CODE COVERAGE REPORT & GATEKEEPER"));
  console.log(bold("========================================================================================================================"));
  console.log(`  Minimum total required:     ${bold(minTotal.toString())}%`);
  console.log(`  Minimum per-file required:  ${bold(minFile.toString())}%\n`);

  console.log(
    `  ${padEnd(bold("Status"), 8)} ${padEnd(bold("File"), 26)} ${padStart(bold("Coverage"), 8)} ${padStart(bold("Lines"), 11)}   ${bold(
      "Uncovered Line #s"
    )}`
  );
  console.log(`  ${"-".repeat(8)} ${"-".repeat(26)} ${"-".repeat(8)} ${"-".repeat(11)}   ${"-".repeat(56)}`);

  for (const f of files) {
    const isFileFailing = f.percentage < minFile;
    const badge = isFileFailing ? red("✖ FAIL") : green("✔ PASS");
    const pctStr = `${f.percentage}%`;
    const countStr = `(${f.linesHit}/${f.linesFound})`;
    const colorFn = isFileFailing ? red : f.percentage >= 80 ? green : yellow;

    let uncoveredDisplay = "";
    if (f.percentage === 100) {
      uncoveredDisplay = green("All covered");
    } else if (f.percentage === 0) {
      uncoveredDisplay = red("⚠️ Completely uncovered (0% tested)");
    } else {
      const fullRanges = formatRanges(f.uncoveredLines);
      uncoveredDisplay = fullRanges.length > 55 ? `${fullRanges.slice(0, 52)}...` : fullRanges;
    }

    console.log(`  ${padEnd(badge, 8)} ${padEnd(f.file, 26)} ${padStart(colorFn(pctStr), 8)} ${padStart(countStr, 11)}   ${dim(uncoveredDisplay)}`);
  }

  console.log(`  ${"-".repeat(8)} ${"-".repeat(26)} ${"-".repeat(8)} ${"-".repeat(11)}   ${"-".repeat(56)}`);
  const totalColor = isTotalFailed ? red : green;
  console.log(
    `  ${padEnd(isTotalFailed ? red("✖ FAIL") : green("✔ PASS"), 8)} ${padEnd(bold("OVERALL TOTAL"), 26)} ${padStart(
      totalColor(`${totalPercentage}%`),
      8
    )} ${padStart(`(${totalLinesHit}/${totalLinesFound})`, 11)}`
  );
  console.log(bold("========================================================================================================================"));

  if (untouchedFiles.length > 0) {
    console.log(`\n${bold(red("⚠️  COMPLETELY UNTESTED MODULES (0% Coverage):"))}`);
    for (const f of untouchedFiles) {
      console.log(`   • ${red(bold(f))} — No tests import or execute this file!`);
    }
  }

  if (isFailed) {
    console.error(`\n${bold(red("❌ Coverage threshold check FAILED:"))}`);
    if (isTotalFailed) {
      console.error(
        `   • Overall coverage is ${red(`${totalPercentage}%`)}, which is below required ${bold(`${minTotal}%`)}`
      );
    }
    if (failingFiles.length > 0) {
      console.error(`   • ${failingFiles.length} file(s) fell below per-file threshold (${minFile}%):`);
      for (const f of failingFiles) {
        const ranges = formatRanges(f.uncoveredLines);
        console.error(`     - ${bold(f.file)}: ${red(`${f.percentage}%`)} < ${minFile}%`);
        console.error(`       Uncovered lines: ${dim(ranges)}`);
      }
    }
    console.error("\nAdd or update unit tests to cover missing lines and raise percentages above thresholds.\n");
    process.exit(1);
  }

  console.log(bold(green(`\n✨ All code coverage thresholds passed! (${totalPercentage}% >= ${minTotal}%)\n`)));
}

if (import.meta.main) {
  runCoverageCheck().catch((err) => {
    console.error("Coverage check error:", err);
    process.exit(1);
  });
}
