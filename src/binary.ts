import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";

export interface FindCaddyOptions {
  silent?: boolean;
  cacheDir?: string;
}

export async function findOrDownloadCaddy(options: FindCaddyOptions = {}): Promise<string> {
  const isWin = process.platform === "win32";
  const binaryName = isWin ? "caddy.exe" : "caddy";

  // 1. Check custom environment variable
  if (process.env.CADDY_PATH) {
    try {
      await fs.access(process.env.CADDY_PATH);
      return process.env.CADDY_PATH;
    } catch {}
  }

  // 2. Check explicitly provided cacheDir
  if (options.cacheDir) {
    const customBinary = path.join(options.cacheDir, binaryName);
    try {
      await fs.access(customBinary);
      return customBinary;
    } catch {}
  }

  // 3. Check local repository .cache/bin/ in current or parent directories
  let searchDir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(searchDir, ".cache", "bin", binaryName);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
    const parent = path.dirname(searchDir);
    if (parent === searchDir) break;
    searchDir = parent;
  }

  // 4. Check cached binary in ~/.pegas/bin/
  const homeCacheDir = path.join(os.homedir(), ".pegas", "bin");
  const homeCachedBinary = path.join(homeCacheDir, binaryName);
  try {
    await fs.access(homeCachedBinary);
    return homeCachedBinary;
  } catch {}

  // 5. Check system PATH
  try {
    const whichCmd = isWin ? `where ${binaryName}` : `which ${binaryName}`;
    const sysPath = child_process
      .execSync(whichCmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .split("\n")[0]
      .trim();
    if (sysPath) {
      return sysPath;
    }
  } catch {}

  // 6. Download official Caddy release
  const primaryCacheDir = options.cacheDir || homeCacheDir;
  const targetBinary = path.join(primaryCacheDir, binaryName);

  if (!options.silent) {
    console.log("⬇️  Caddy binary not found in PATH or cache. Downloading official release...");
  }
  await fs.mkdir(primaryCacheDir, { recursive: true });

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

  const plat = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (!plat || !arch) {
    throw new Error(`Unsupported platform or architecture for Caddy: ${process.platform}/${process.arch}`);
  }

  const version = "2.9.1";
  const ext = isWin ? "zip" : "tar.gz";
  const filename = `caddy_${version}_${plat}_${arch}.${ext}`;
  const url = `https://github.com/caddyserver/caddy/releases/download/v${version}/${filename}`;

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
  if (primaryCacheDir !== homeCacheDir) {
    try {
      await fs.mkdir(homeCacheDir, { recursive: true });
      await fs.copyFile(targetBinary, homeCachedBinary);
      await fs.chmod(homeCachedBinary, 0o755);
    } catch {}
  }

  // Mirror to repo .cache/bin/ if .cache exists in cwd or parent
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

  if (!options.silent) {
    console.log(`✓ Caddy installed to ${targetBinary}`);
  }

  return targetBinary;
}
