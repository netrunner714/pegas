#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";

// ANSI colors
const green = (t: string) => `\x1b[32m${t}\x1b[0m`;
const red = (t: string) => `\x1b[31m${t}\x1b[0m`;
const yellow = (t: string) => `\x1b[33m${t}\x1b[0m`;
const bold = (t: string) => `\x1b[1m${t}\x1b[0m`;
const cyan = (t: string) => `\x1b[36m${t}\x1b[0m`;

interface FileCoverage {
  file: string;
  linesFound: number;
  linesHit: number;
  percentage: number;
}

async function runCoverageCheck() {
  const lcovPath = path.resolve(import.meta.dir, "../coverage/lcov.info");

  let lcovContent = "";
  try {
    lcovContent = await fs.readFile(lcovPath, "utf-8");
  } catch {
    console.error(red("❌ Error: 'coverage/lcov.info' not found. Run 'bun test --coverage' first."));
    process.exit(1);
  }

  // Parse CLI args or environment variables for thresholds
  const args = process.argv.slice(2);
  let minTotal = parseFloat(process.env.COVERAGE_MIN_TOTAL || "65");
  let minFile = parseFloat(process.env.COVERAGE_MIN_FILE || "35");

  for (const arg of args) {
    if (arg.startsWith("--min-total=")) {
      minTotal = parseFloat(arg.split("=")[1]);
    } else if (arg.startsWith("--min-file=")) {
      minFile = parseFloat(arg.split("=")[1]);
    }
  }

  const files: FileCoverage[] = [];
  let current: { file: string; linesFound: number; linesHit: number } | null = null;

  for (const line of lcovContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("SF:")) {
      current = { file: trimmed.slice(3), linesFound: 0, linesHit: 0 };
    } else if (trimmed.startsWith("DA:") && current) {
      const parts = trimmed.slice(3).split(",");
      const count = parseInt(parts[1], 10);
      current.linesFound++;
      if (count > 0) {
        current.linesHit++;
      }
    } else if (trimmed === "end_of_record" && current) {
      if (current.linesFound > 0) {
        const percentage = parseFloat(((current.linesHit / current.linesFound) * 100).toFixed(1));
        files.push({ ...current, percentage });
      }
      current = null;
    }
  }

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

  console.log("\n" + bold("================================================================================"));
  console.log(bold("  📊 CODE COVERAGE THRESHOLD GATEKEEPER"));
  console.log(bold("================================================================================"));
  console.log(`  Minimum total required:     ${bold(minTotal.toString())}%`);
  console.log(`  Minimum per-file required:  ${bold(minFile.toString())}%\n`);

  for (const f of files) {
    const isFileFailing = f.percentage < minFile;
    const badge = isFileFailing ? red("✖ FAIL") : green("✔ PASS");
    const pctStr = `${f.percentage}%`.padStart(6);
    const countStr = `(${f.linesHit}/${f.linesFound})`.padStart(11);
    const colorFn = isFileFailing ? red : f.percentage >= 80 ? green : yellow;

    console.log(`  ${badge}  ${f.file.padEnd(26)} ${colorFn(pctStr)} ${countStr}`);
  }

  console.log("  ------------------------------------------------------------------");
  const totalColor = isTotalFailed ? red : green;
  console.log(
    `  ${isTotalFailed ? red("✖ FAIL") : green("✔ PASS")}  ${bold("OVERALL TOTAL".padEnd(26))} ${totalColor(
      `${totalPercentage}%`.padStart(6)
    )} ${`(${totalLinesHit}/${totalLinesFound})`.padStart(11)}`
  );
  console.log(bold("================================================================================"));

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
        console.error(`     - ${f.file}: ${f.percentage}% < ${minFile}%`);
      }
    }
    console.error("\nAdd or update unit tests to raise code coverage above required thresholds.\n");
    process.exit(1);
  }

  console.log(bold(green(`\n✨ All code coverage thresholds passed! (${totalPercentage}% >= ${minTotal}%)\n`)));
}

runCoverageCheck().catch((err) => {
  console.error("Coverage check error:", err);
  process.exit(1);
});
