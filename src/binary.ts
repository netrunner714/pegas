import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";

export interface FindCaddyOptions {
  silent?: boolean;
  cacheDir?: string;
  skipCache?: boolean;
  skipMirror?: boolean;
  customPath?: string;
  useSystemCaddy?: boolean;
}

export function getCaddyReleaseInfo(
  platform = process.platform,
  arch = process.arch,
  version = "2.9.1"
): { plat: string; arch: string; ext: string; filename: string; url: string } {
  const platformMap: Record<string, string> = {
    linux: "linux",
    darwin: "mac",
    win32: "windows",
  };
  const archMap: Record<string, string> = {
    x64: "amd64",
    arm64: "arm64",
    arm: "armv7",
  };

  const plat = platformMap[platform];
  const archName = archMap[arch];
  if (!plat || !archName) {
    throw new Error(`Unsupported platform or architecture for Caddy: ${platform}/${arch}`);
  }

  const ext = platform === "win32" ? "zip" : "tar.gz";
  const filename = `caddy_${version}_${plat}_${archName}.${ext}`;
  const url = `https://github.com/caddyserver/caddy/releases/download/v${version}/${filename}`;

  return { plat, arch: archName, ext, filename, url };
}

export function isCaddyVersionCompatible(
  versionOutput: string,
  minMajor = 2,
  minMinor = 8
): boolean {
  const match = versionOutput.match(/v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  if (major > minMajor) return true;
  if (major === minMajor && minor >= minMinor) return true;
  return false;
}

export function checkCaddyVersion(
  binaryPath: string,
  minMajor = 2,
  minMinor = 8
): boolean {
  try {
    const out = child_process
      .execFileSync(binaryPath, ["version"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      })
      .toString();
    return isCaddyVersionCompatible(out, minMajor, minMinor);
  } catch {
    return false;
  }
}

export async function findOrDownloadCaddy(options: FindCaddyOptions = {}): Promise<string> {
  const isWin = process.platform === "win32";
  const binaryName = isWin ? "caddy.exe" : "caddy";

  // 1. Explicit custom path via option or CADDY_PATH
  const explicitPath = options.customPath || (!options.skipCache ? process.env.CADDY_PATH : undefined);
  if (explicitPath) {
    if (explicitPath.toLowerCase() === "system") {
      options.useSystemCaddy = true;
    } else {
      try {
        await fs.access(explicitPath);
        if (!checkCaddyVersion(explicitPath) && !options.silent) {
          console.warn(`⚠️  Provided Caddy at ${explicitPath} is older than v2.8.0 or incompatible.`);
        }
        return explicitPath;
      } catch {
        if (!options.silent) {
          console.warn(`⚠️  Provided Caddy binary not found at ${explicitPath}`);
        }
      }
    }
  }

  // 2. Explicit system Caddy opt-in (--system-caddy or CADDY_PATH=system)
  if (options.useSystemCaddy) {
    try {
      const whichCmd = isWin ? `where ${binaryName}` : `which ${binaryName}`;
      const sysPath = child_process
        .execSync(whichCmd, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim()
        .split("\n")[0]
        .trim();
      if (sysPath) {
        if (checkCaddyVersion(sysPath)) {
          return sysPath;
        }
        throw new Error(`System Caddy at ${sysPath} is older than v2.8.0 or incompatible.`);
      }
      throw new Error(`Caddy binary not found in system PATH.`);
    } catch (err: any) {
      throw new Error(`Failed to use system Caddy: ${err?.message || "not found in PATH"}`);
    }
  }

  // 3. Check explicitly provided cacheDir
  if (options.cacheDir) {
    const customBinary = path.join(options.cacheDir, binaryName);
    try {
      await fs.access(customBinary);
      return customBinary;
    } catch {}
  }

  const homeCacheDir = path.join(os.homedir(), ".pegas", "bin");
  const homeCachedBinary = path.join(homeCacheDir, binaryName);

  if (!options.skipCache) {
    // 4. Check local repository .cache/bin/ in current or parent directories
    let searchDir = process.cwd();
    for (let i = 0; i < 4; i++) {
      const candidate = path.join(searchDir, ".cache", "bin", binaryName);
      try {
        await fs.access(candidate);
        if (checkCaddyVersion(candidate)) {
          return candidate;
        }
      } catch {}
      const parent = path.dirname(searchDir);
      if (parent === searchDir) break;
      searchDir = parent;
    }

    // 5. Check managed cached binary in ~/.pegas/bin/
    try {
      await fs.access(homeCachedBinary);
      if (checkCaddyVersion(homeCachedBinary)) {
        return homeCachedBinary;
      }
    } catch {}
  }

  // 6. Download official Caddy release into ~/.pegas/bin/
  const primaryCacheDir = options.cacheDir || homeCacheDir;
  const targetBinary = path.join(primaryCacheDir, binaryName);

  if (!options.silent) {
    console.log("⬇️  Managed Caddy not found in cache. Downloading official release...");
  }
  await fs.mkdir(primaryCacheDir, { recursive: true });

  const { filename, url } = getCaddyReleaseInfo();

  const archivePath = path.join(primaryCacheDir, filename);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download Caddy from ${url}: ${res.status} ${res.statusText}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(archivePath, buffer);

  // Extract binary
  if (isWin) {
    child_process.execSync(`tar -xf "${archivePath}" -C "${primaryCacheDir}" "${binaryName}"`);
  } else {
    child_process.execSync(`tar -xzf "${archivePath}" -C "${primaryCacheDir}" "${binaryName}"`);
    await fs.chmod(targetBinary, 0o755);
  }

  // Cleanup archive
  await fs.unlink(archivePath).catch(() => {});

  // Mirror to ~/.pegas/bin/ if primary was different
  if (!options.skipMirror && primaryCacheDir !== homeCacheDir) {
    try {
      await fs.mkdir(homeCacheDir, { recursive: true });
      await fs.copyFile(targetBinary, homeCachedBinary);
      await fs.chmod(homeCachedBinary, 0o755);
    } catch {}
  }

  // Mirror to repo .cache/bin/ if .cache exists in cwd or parent
  if (!options.skipMirror) {
    let repoSearchDir = process.cwd();
    for (let i = 0; i < 4; i++) {
      const repoCacheDir = path.join(repoSearchDir, ".cache");
      const repoCacheBin = path.join(repoCacheDir, "bin");
      try {
        const stat = await fs.stat(repoCacheDir);
        if (stat.isDirectory()) {
          await fs.mkdir(repoCacheBin, { recursive: true });
          const repoBinary = path.join(repoCacheBin, binaryName);
          if (repoBinary !== targetBinary) {
            await fs.copyFile(targetBinary, repoBinary);
            await fs.chmod(repoBinary, 0o755);
          }
          break;
        }
      } catch {}
      const parent = path.dirname(repoSearchDir);
      if (parent === repoSearchDir) break;
      repoSearchDir = parent;
    }
  }

  if (!options.silent) {
    console.log(`✓ Caddy installed to ${targetBinary}`);
  }

  return targetBinary;
}
