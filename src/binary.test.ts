import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import child_process from "node:child_process";
import { findOrDownloadCaddy, getCaddyReleaseInfo } from "./binary.js";

describe("caddy binary resolution", () => {
  it("getCaddyReleaseInfo maps platform and architecture correctly", () => {
    const linuxX64 = getCaddyReleaseInfo("linux", "x64");
    expect(linuxX64.filename).toBe("caddy_2.9.1_linux_amd64.tar.gz");
    expect(linuxX64.url).toContain("v2.9.1/caddy_2.9.1_linux_amd64.tar.gz");

    const linuxArm64 = getCaddyReleaseInfo("linux", "arm64");
    expect(linuxArm64.filename).toBe("caddy_2.9.1_linux_arm64.tar.gz");

    const linuxArm = getCaddyReleaseInfo("linux", "arm");
    expect(linuxArm.filename).toBe("caddy_2.9.1_linux_armv7.tar.gz");

    const macArm = getCaddyReleaseInfo("darwin", "arm64");
    expect(macArm.filename).toBe("caddy_2.9.1_mac_arm64.tar.gz");

    const macX64 = getCaddyReleaseInfo("darwin", "x64");
    expect(macX64.filename).toBe("caddy_2.9.1_mac_amd64.tar.gz");

    const winX64 = getCaddyReleaseInfo("win32", "x64");
    expect(winX64.filename).toBe("caddy_2.9.1_windows_amd64.zip");

    const winArm64 = getCaddyReleaseInfo("win32", "arm64");
    expect(winArm64.filename).toBe("caddy_2.9.1_windows_arm64.zip");

    expect(() => getCaddyReleaseInfo("freebsd", "x64")).toThrow("Unsupported platform");
    expect(() => getCaddyReleaseInfo("linux", "s390x")).toThrow("Unsupported platform or architecture");
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

  it("handles download failure when remote returns non-200", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-download-err-"));
    const origFetch = globalThis.fetch;

    try {
      globalThis.fetch = async () =>
        new Response("Server Error", { status: 500, statusText: "Internal Server Error" });

      expect(findOrDownloadCaddy({ cacheDir: tmpDir, skipCache: true, silent: true })).rejects.toThrow(
        "Failed to download Caddy"
      );
    } finally {
      globalThis.fetch = origFetch;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("downloads, extracts, and mirrors Caddy binary successfully", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-download-ok-"));
    const origFetch = globalThis.fetch;

    // Create a real tar.gz containing a dummy caddy executable
    const tarDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-tar-gen-"));
    const dummyCaddy = path.join(tarDir, "caddy");
    await fs.writeFile(dummyCaddy, "#!/bin/sh\necho caddy", "utf-8");
    await fs.chmod(dummyCaddy, 0o755);
    const tarFile = path.join(tarDir, "caddy.tar.gz");
    child_process.execSync(`tar -czf "${tarFile}" -C "${tarDir}" caddy`);
    const tarBuffer = await fs.readFile(tarFile);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      globalThis.fetch = async () =>
        new Response(tarBuffer, {
          status: 200,
          headers: { "Content-Type": "application/gzip" },
        });

      const binaryPath = await findOrDownloadCaddy({
        cacheDir: tmpDir,
        skipCache: true,
        skipMirror: true,
        silent: false,
      });
      expect(binaryPath).toBe(path.join(tmpDir, "caddy"));
      expect(await fs.access(binaryPath).then(() => true).catch(() => false)).toBe(true);

      // Verify logs
      expect(logs.some((l) => l.includes("Downloading official release"))).toBe(true);
      expect(logs.some((l) => l.includes("Caddy installed to"))).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(tarDir, { recursive: true, force: true });
    }
  });
});
