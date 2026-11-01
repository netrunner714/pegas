import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import child_process from "node:child_process";
import {
  findOrDownloadCaddy,
  getCaddyReleaseInfo,
  getCaddyBinaryNames,
  PEGAS_CADDY_VERSION,
  isCaddyVersionCompatible,
  checkCaddyVersion,
} from "./binary.js";

describe("caddy binary resolution", () => {
  it("getCaddyBinaryNames generates versioned and plain binary names", () => {
    expect(PEGAS_CADDY_VERSION).toBe("2.9.1");

    const linuxNames = getCaddyBinaryNames("2.9.1", "linux");
    expect(linuxNames.versionedName).toBe("caddy-v2.9.1");
    expect(linuxNames.plainName).toBe("caddy");

    const winNames = getCaddyBinaryNames("2.9.1", "win32");
    expect(winNames.versionedName).toBe("caddy-v2.9.1.exe");
    expect(winNames.plainName).toBe("caddy.exe");
  });

  it("isCaddyVersionCompatible validates minimum Caddy version requirement", () => {
    expect(isCaddyVersionCompatible("v2.9.1 h1:OEYiZ7DbCzAWVb6TNEkjRcSCRGHVoZsJinoDR/n9oaY=")).toBe(true);
    expect(isCaddyVersionCompatible("v2.8.0")).toBe(true);
    expect(isCaddyVersionCompatible("v2.8.4")).toBe(true);
    expect(isCaddyVersionCompatible("v2.10.0")).toBe(true);
    expect(isCaddyVersionCompatible("v3.0.0")).toBe(true);
    expect(isCaddyVersionCompatible("2.8.0")).toBe(true);

    // Incompatible versions
    expect(isCaddyVersionCompatible("v2.7.6")).toBe(false);
    expect(isCaddyVersionCompatible("v2.4.1")).toBe(false);
    expect(isCaddyVersionCompatible("v1.0.5")).toBe(false);
    expect(isCaddyVersionCompatible("Caddy 0.11.0")).toBe(false);
    expect(isCaddyVersionCompatible("devel")).toBe(false);
    expect(isCaddyVersionCompatible("")).toBe(false);
  });

  it("checkCaddyVersion executes binary with version flag and verifies compatibility", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-caddy-ver-"));
    const goodBinary = path.join(tmpDir, "caddy-good");
    const oldBinary = path.join(tmpDir, "caddy-old");
    const nonExecutable = path.join(tmpDir, "caddy-noexec");

    await fs.writeFile(goodBinary, "#!/bin/sh\necho 'v2.9.1 h1:abc'", "utf-8");
    await fs.chmod(goodBinary, 0o755);

    await fs.writeFile(oldBinary, "#!/bin/sh\necho 'v2.6.2'", "utf-8");
    await fs.chmod(oldBinary, 0o755);

    await fs.writeFile(nonExecutable, "not executable", "utf-8");

    expect(checkCaddyVersion(goodBinary)).toBe(true);
    expect(checkCaddyVersion(oldBinary)).toBe(false);
    expect(checkCaddyVersion(nonExecutable)).toBe(false);
    expect(checkCaddyVersion(path.join(tmpDir, "does-not-exist"))).toBe(false);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
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

  it("resolves binary via managed home cache or download", async () => {
    // Repository .cache/bin removed: resolution goes through ~/.pegas/bin or download
    const found = await findOrDownloadCaddy({ silent: true });
    expect(found).toBeDefined();
    expect(await fs.access(found).then(() => true).catch(() => false)).toBe(true);
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
      const { versionedName, plainName } = getCaddyBinaryNames();
      expect(binaryPath).toBe(path.join(tmpDir, versionedName));
      expect(await fs.access(binaryPath).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.access(path.join(tmpDir, plainName)).then(() => true).catch(() => false)).toBe(true);

      // Verify logs
      expect(logs.some((l) => l.includes("Downloading official release"))).toBe(true);
      expect(logs.some((l) => l.includes("installed to"))).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(tarDir, { recursive: true, force: true });
    }
  });

  it("uses system Caddy when explicitly requested with useSystemCaddy", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-caddy-sys-opt-"));
    const goodBinary = path.join(tmpDir, "caddy");
    await fs.writeFile(goodBinary, "#!/bin/sh\necho 'v2.9.1'", "utf-8");
    await fs.chmod(goodBinary, 0o755);

    const origExecSync = child_process.execSync;
    try {
      child_process.execSync = ((cmd: string, opts?: any) => {
        if (cmd.startsWith("which ") || cmd.startsWith("where ")) {
          return Buffer.from(goodBinary + "\n");
        }
        return origExecSync(cmd, opts);
      }) as any;

      const found = await findOrDownloadCaddy({ useSystemCaddy: true, silent: true });
      expect(found).toBe(goodBinary);
    } finally {
      child_process.execSync = origExecSync;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects outdated system Caddy when useSystemCaddy is requested", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-caddy-sys-old-"));
    const sysDir = path.join(tmpDir, "system-bin");
    await fs.mkdir(sysDir, { recursive: true });
    const oldBinary = path.join(sysDir, "caddy");
    await fs.writeFile(oldBinary, "#!/bin/sh\necho 'v2.6.2'", "utf-8");
    await fs.chmod(oldBinary, 0o755);

    const origExecSync = child_process.execSync;
    try {
      child_process.execSync = ((cmd: string, opts?: any) => {
        if (cmd.startsWith("which ") || cmd.startsWith("where ")) {
          return Buffer.from(oldBinary + "\n");
        }
        return origExecSync(cmd, opts);
      }) as any;

      expect(
        findOrDownloadCaddy({
          useSystemCaddy: true,
          silent: true,
        })
      ).rejects.toThrow("older than v2.8.0 or incompatible");
    } finally {
      child_process.execSync = origExecSync;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("by default ignores system PATH and relies on managed cache or downloads", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-caddy-sys-ignore-"));
    const sysDir = path.join(tmpDir, "system-bin");
    await fs.mkdir(sysDir, { recursive: true });
    const sysBinary = path.join(sysDir, "caddy");
    await fs.writeFile(sysBinary, "#!/bin/sh\necho 'v2.9.1'", "utf-8");
    await fs.chmod(sysBinary, 0o755);

    const origExecSync = child_process.execSync;
    const origAccess = fs.access;

    try {
      // Mock that ~/.pegas/bin doesn't exist
      fs.access = (async (p: any, mode: any) => {
        if (String(p).includes(".pegas") || String(p).includes(".cache")) {
          throw new Error("ENOENT");
        }
        return origAccess(p, mode);
      }) as any;

      let whichCalled = false;
      child_process.execSync = ((cmd: string, opts?: any) => {
        if (cmd.startsWith("which ") || cmd.startsWith("where ")) {
          whichCalled = true;
          return Buffer.from(sysBinary + "\n");
        }
        return origExecSync(cmd, opts);
      }) as any;

      // By default without useSystemCaddy, it should NOT call which caddy
      // and proceed directly to download
      let fetchCalled = false;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error("Simulated download stop");
      };

      const downloadDir = path.join(tmpDir, "download");
      try {
        await findOrDownloadCaddy({
          cacheDir: downloadDir,
          skipCache: false,
          silent: true,
        });
      } catch (err: any) {
        expect(err.message).toBe("Simulated download stop");
      } finally {
        globalThis.fetch = origFetch;
      }

      expect(whichCalled).toBe(false);
      expect(fetchCalled).toBe(true);
    } finally {
      fs.access = origAccess;
      child_process.execSync = origExecSync;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("promotes unversioned caddy to versioned caddy in home cache", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-promote-"));
    const origHome = os.homedir;
    (os as any).homedir = () => tmpDir;

    const binDir = path.join(tmpDir, ".pegas", "bin");
    await fs.mkdir(binDir, { recursive: true });

    const { versionedName, plainName } = getCaddyBinaryNames();
    const plainPath = path.join(binDir, plainName);
    await fs.writeFile(plainPath, "#!/bin/sh\necho 'v2.9.1'", "utf-8");
    await fs.chmod(plainPath, 0o755);

    try {
      const found = await findOrDownloadCaddy({ silent: true });
      expect(found).toBe(path.join(binDir, versionedName));
      expect(await fs.access(found).then(() => true).catch(() => false)).toBe(true);
    } finally {
      (os as any).homedir = origHome;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
