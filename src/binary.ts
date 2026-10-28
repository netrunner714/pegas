import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";

export async function findOrDownloadCaddy(options: { silent?: boolean } = {}): Promise<string> {
  const isWin = process.platform === "win32";
  const binaryName = isWin ? "caddy.exe" : "caddy";

  // 1. Check custom environment variable
  if (process.env.CADDY_PATH) {
    try {
      await fs.access(process.env.CADDY_PATH);
      return process.env.CADDY_PATH;
    } catch {}
  }

  // 2. Check system PATH
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

  // 3. Check cached binary in ~/.pegas/bin/
  const cacheDir = path.join(os.homedir(), ".pegas", "bin");
  const cachedBinary = path.join(cacheDir, binaryName);
  try {
    await fs.access(cachedBinary);
    return cachedBinary;
  } catch {}

  // 4. Download official Caddy release
  if (!options.silent) {
    console.log("⬇️  Caddy binary not found in PATH or cache. Downloading official release...");
  }
  await fs.mkdir(cacheDir, { recursive: true });

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

  const archivePath = path.join(cacheDir, filename);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download Caddy from ${url}: ${res.status} ${res.statusText}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(archivePath, buffer);

  // Extract binary
  if (isWin) {
    child_process.execSync(`tar -xf "${archivePath}" -C "${cacheDir}" "${binaryName}"`);
  } else {
    child_process.execSync(`tar -xzf "${archivePath}" -C "${cacheDir}" "${binaryName}"`);
    await fs.chmod(cachedBinary, 0o755);
  }

  // Cleanup archive
  await fs.unlink(archivePath).catch(() => {});

  if (!options.silent) {
    console.log(`✓ Caddy installed to ${cachedBinary}`);
  }

  return cachedBinary;
}
