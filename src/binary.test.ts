import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { findOrDownloadCaddy, getCaddyReleaseInfo } from "./binary.js";

describe("caddy binary resolution", () => {
  it("getCaddyReleaseInfo maps platform and architecture correctly", () => {
    const linux = getCaddyReleaseInfo("linux", "x64");
    expect(linux.filename).toBe("caddy_2.9.1_linux_amd64.tar.gz");
    expect(linux.url).toContain("v2.9.1/caddy_2.9.1_linux_amd64.tar.gz");

    const mac = getCaddyReleaseInfo("darwin", "arm64");
    expect(mac.filename).toBe("caddy_2.9.1_mac_arm64.tar.gz");

    const win = getCaddyReleaseInfo("win32", "x64");
    expect(win.filename).toBe("caddy_2.9.1_windows_amd64.zip");

    expect(() => getCaddyReleaseInfo("freebsd", "x64")).toThrow("Unsupported platform");
  });

  it("respects CADDY_PATH environment variable override", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-caddy-env-"));
    const fakeCaddy = path.join(tmpDir, process.platform === "win32" ? "caddy.exe" : "caddy");
    await fs.writeFile(fakeCaddy, "#!/bin/sh\necho caddy", "utf-8");
    await fs.chmod(fakeCaddy, 0o755);

    const orig = process.env.CADDY_PATH;
    try {
      process.env.CADDY_PATH = fakeCaddy;
      const found = await findOrDownloadCaddy({ silent: true });
      expect(found).toBe(fakeCaddy);
    } finally {
      if (orig !== undefined) {
        process.env.CADDY_PATH = orig;
      } else {
        delete process.env.CADDY_PATH;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("finds binary from explicit options.cacheDir", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-caddy-custom-"));
    const binaryName = process.platform === "win32" ? "caddy.exe" : "caddy";
    const customBinary = path.join(tmpDir, binaryName);
    await fs.writeFile(customBinary, "#!/bin/sh\necho test", "utf-8");
    await fs.chmod(customBinary, 0o755);

    const found = await findOrDownloadCaddy({ cacheDir: tmpDir, silent: true });
    expect(found).toBe(customBinary);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("finds existing binary in repository .cache/bin", async () => {
    const repoCacheBin = path.join(process.cwd(), ".cache", "bin");
    const binaryName = process.platform === "win32" ? "caddy.exe" : "caddy";
    const cachedFile = path.join(repoCacheBin, binaryName);

    if (await fs.access(cachedFile).then(() => true).catch(() => false)) {
      const found = await findOrDownloadCaddy({ silent: true });
      expect(found).toBeDefined();
      expect(await fs.access(found).then(() => true).catch(() => false)).toBe(true);
    }
  });
});
