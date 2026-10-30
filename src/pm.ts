import fs from "node:fs/promises";
import path from "node:path";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

/**
 * Detects the package manager used in a project.
 * Inspects package.json packageManager field first, then lockfiles, falling back to npm.
 */
export async function detectPackageManager(projectDir: string): Promise<PackageManager> {
  // 1. package.json "packageManager"
  try {
    const raw = await fs.readFile(path.join(projectDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.packageManager === "string") {
      const pmField = pkg.packageManager.toLowerCase();
      if (pmField.startsWith("bun")) return "bun";
      if (pmField.startsWith("pnpm")) return "pnpm";
      if (pmField.startsWith("yarn")) return "yarn";
      if (pmField.startsWith("npm")) return "npm";
    }
  } catch {}

  // 2. Lockfiles
  const lockfiles: Array<{ file: string; pm: PackageManager }> = [
    { file: "bun.lockb", pm: "bun" },
    { file: "bun.lock", pm: "bun" },
    { file: "pnpm-lock.yaml", pm: "pnpm" },
    { file: "yarn.lock", pm: "yarn" },
    { file: "package-lock.json", pm: "npm" },
  ];

  for (const { file, pm } of lockfiles) {
    try {
      await fs.access(path.join(projectDir, file));
      return pm;
    } catch {}
  }

  return "npm";
}

/**
 * Returns the exact CLI update command for a package based on the package manager.
 */
export function getUpdateCommand(pm: PackageManager, pkgName = "@netrunner714/pegas"): string {
  switch (pm) {
    case "bun":
      return `bun update ${pkgName}`;
    case "pnpm":
      return `pnpm update ${pkgName}`;
    case "yarn":
      return `yarn upgrade ${pkgName}`;
    case "npm":
    default:
      return `npm update ${pkgName}`;
  }
}

/**
 * Returns the exact CLI remove command for a package based on the package manager.
 */
export function getRemoveCommand(pm: PackageManager, pkgName = "@netrunner714/pegas"): string {
  switch (pm) {
    case "bun":
      return `bun remove ${pkgName}`;
    case "pnpm":
      return `pnpm remove ${pkgName}`;
    case "yarn":
      return `yarn remove ${pkgName}`;
    case "npm":
    default:
      return `npm uninstall ${pkgName}`;
  }
}
