import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

/**
 * Parses a semver-like version string into [major, minor, patch].
 * Strips prefixes like '^', '~', 'v', and pre-release metadata.
 */
export function parseSemver(v: string): [number, number, number] {
  if (!v || typeof v !== "string") return [0, 0, 0];
  const match = v.match(/\d+(\.\d+)*/);
  if (!match) return [0, 0, 0];
  const parts = match[0].split(".").map((n) => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Compares two semver versions.
 * Returns > 0 if a > b, < 0 if a < b, 0 if a == b.
 */
export function compareSemver(a: string, b: string): number {
  const [majA, minA, patA] = parseSemver(a);
  const [majB, minB, patB] = parseSemver(b);
  if (majA !== majB) return majA - majB;
  if (minA !== minB) return minA - minB;
  return patA - patB;
}

