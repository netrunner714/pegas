import { describe, it, expect, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import child_process from "node:child_process";
import {
  getCaPaths,
  getCaddyHomeEnv,
  buildProvisionCaddyfile,
  provisionCa,
  detectWsl,
  canBindLowPorts,
  buildInstallTrustCommands,
  buildRemoveTrustCommands,
  isCaTrusted,
  PEGAS_CA_NAME,
} from "./ca.js";

function tmpHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pegas-ca-"));
}

describe("pegas ca (unit)", () => {
  it("getCaPaths and getCaddyHomeEnv isolate Pegas storage under ~/.pegas", () => {
    const fakeHome = "/tmp/fake-home";
    const paths = getCaPaths(fakeHome);

    expect(paths.pegasHome).toBe(path.join(fakeHome, ".pegas"));
    expect(paths.caCertPath).toBe(path.join(fakeHome, ".pegas", "ca", "root.crt"));
    expect(paths.caddyRootCert).toBe(
      path.join(fakeHome, ".pegas", "caddy", "data", "caddy", "pki", "authorities", "local", "root.crt")
    );

    const env = getCaddyHomeEnv(paths);
    expect(env.XDG_DATA_HOME).toBe(path.join(fakeHome, ".pegas", "caddy", "data"));
    expect(env.XDG_CONFIG_HOME).toBe(path.join(fakeHome, ".pegas", "caddy", "config"));
    expect(env.XDG_CACHE_HOME).toBe(path.join(fakeHome, ".pegas", "caddy", "cache"));
  });

  it("buildProvisionCaddyfile declares Pegas CA with skip_install_trust", () => {
    const caddyfile = buildProvisionCaddyfile();
    expect(caddyfile).toContain(`name "${PEGAS_CA_NAME}"`);
    expect(caddyfile).toContain("ca local");
    expect(caddyfile).toContain("skip_install_trust");
    expect(caddyfile).toContain("admin off");
  });

  it("provisionCa runs caddy validate and exports root.crt (mocked caddy)", async () => {
    const home = await tmpHome();
    const paths = getCaPaths(home);
    const fakeCaddy = path.join(home, "caddy");

    let validateCalled = false;
    let capturedEnv: Record<string, string> = {};
    const spy = spyOn(child_process, "spawnSync").mockImplementation(((cmd: string, args: string[], opts: any) => {
      validateCalled = cmd === fakeCaddy && args.includes("validate");
      capturedEnv = opts?.env || {};
      // Имитируем материализацию PKI Caddy
      const rootDir = path.dirname(paths.caddyRootCert);
      require("node:fs").mkdirSync(rootDir, { recursive: true });
      require("node:fs").writeFileSync(paths.caddyRootCert, "FAKE_ROOT_CERT");
      return { status: 0, stdout: "", stderr: "" };
    }) as any);

    try {
      const res = await provisionCa(fakeCaddy, { paths });
      expect(res.created).toBe(true);
      expect(res.certPath).toBe(paths.caCertPath);
      expect(validateCalled).toBe(true);
      expect(capturedEnv.XDG_DATA_HOME).toContain(path.join(home, ".pegas", "caddy"));

      const exported = await fs.readFile(paths.caCertPath, "utf-8");
      expect(exported).toBe("FAKE_ROOT_CERT");

      // Повторный вызов идемпотентен
      const res2 = await provisionCa(fakeCaddy, { paths });
      expect(res2.created).toBe(false);
    } finally {
      spy.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("provisionCa throws when caddy validate fails", async () => {
    const home = await tmpHome();
    const paths = getCaPaths(home);
    const fakeCaddy = path.join(home, "caddy");

    const spy = spyOn(child_process, "spawnSync").mockImplementation((() => {
      return { status: 1, stdout: "", stderr: "caddy exploded" };
    }) as any);

    try {
      let threw = "";
      try {
        await provisionCa(fakeCaddy, { paths });
      } catch (err: any) {
        threw = err.message;
      }
      expect(threw).toContain("Не удалось создать локальный CA");
      expect(threw).toContain("caddy exploded");
    } finally {
      spy.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("detectWsl detects WSL_DISTRO_NAME, /proc/version, and native Linux", () => {
    expect(detectWsl({ WSL_DISTRO_NAME: "Ubuntu" }, () => null)).toBe(true);
    expect(detectWsl({}, () => "Linux version 6.6 (microsoft-standard-WSL2)")).toBe(true);
    expect(detectWsl({}, () => "Linux version 6.8.0-generic")).toBe(false);
    expect(detectWsl({}, () => null)).toBe(false);
  });

  it("canBindLowPorts respects platform, uid and setcap output", () => {
    expect(canBindLowPorts("win32", 1000)).toBe(true);
    expect(canBindLowPorts("linux", 0)).toBe(true);
    expect(canBindLowPorts("linux", 1000)).toBe(false);
    expect(canBindLowPorts("darwin", 1000)).toBe(false);
  });

  it("canBindLowPorts detects cap_net_bind_service via getcap", () => {
    const origExec = child_process.execFileSync;
    (child_process as any).execFileSync = (cmd: string, args: string[]) => {
      if (cmd === "getcap") {
        return Buffer.from(`${args[0]} = cap_net_bind_service+ep`);
      }
      return Buffer.from("");
    };
    try {
      expect(canBindLowPorts("linux", 1000, "/usr/bin/caddy")).toBe(true);
    } finally {
      (child_process as any).execFileSync = origExec;
    }
  });

  it("buildInstallTrustCommands covers linux, darwin, windows and WSL", () => {
    const opts = { certPath: "/tmp/root.crt", caddyPath: "/usr/bin/caddy" };

    const linux = buildInstallTrustCommands("linux", opts);
    expect(linux[0].cmd).toBe("sudo");
    expect(linux[0].args).toContain("/usr/local/share/ca-certificates/pegas-root-ca.crt");
    expect(linux.some((c) => c.args.join(" ").includes("update-ca-certificates"))).toBe(true);
    expect(linux.some((c) => c.args.join(" ").includes("setcap") && c.args.includes(opts.caddyPath))).toBe(true);

    const darwin = buildInstallTrustCommands("darwin", opts);
    expect(darwin[0].args).toContain("add-trusted-cert");
    expect(darwin[0].args).toContain("/Library/Keychains/System.keychain");

    const win = buildInstallTrustCommands("win32", opts);
    expect(win[0].cmd).toBe("certutil.exe");
    expect(win[0].args).toContain("-user");
    expect(win[0].args).toContain(opts.certPath);

    const wsl = buildInstallTrustCommands("linux", { ...opts, wsl: true });
    expect(wsl[0].cmd).toBe("certutil.exe");
    expect(wsl[0].args).toContain("__WSLPATH__");
  });

  it("buildRemoveTrustCommands covers linux, darwin, windows and WSL", () => {
    const linux = buildRemoveTrustCommands("linux", {});
    expect(linux.some((c) => c.args.join(" ").includes("pegas-root-ca.crt"))).toBe(true);

    const darwin = buildRemoveTrustCommands("darwin", {});
    expect(darwin[0].args).toContain("delete-certificate");
    expect(darwin[0].args).toContain(PEGAS_CA_NAME);

    const win = buildRemoveTrustCommands("win32", {});
    expect(win[0].cmd).toBe("certutil.exe");
    expect(win[0].args).toContain("-delstore");

    const wsl = buildRemoveTrustCommands("linux", { wsl: true });
    expect(wsl[0].cmd).toBe("certutil.exe");
  });

  it("isCaTrusted returns false without exported cert and true for linux store file", async () => {
    const home = await tmpHome();
    const paths = getCaPaths(home);

    // 1. Нет экспортированного сертификата — не доверен
    expect(await isCaTrusted("linux", paths)).toBe(false);

    // 2. Экспортирован невалидный PEM — fingerprint не извлечь, не доверен
    await fs.mkdir(paths.caDir, { recursive: true });
    await fs.writeFile(paths.caCertPath, "NOT_A_CERT");
    expect(await isCaTrusted("linux", paths)).toBe(false);

    // 3. В системном хранилище лежит ТОТ ЖЕ сертификат (fingerprint совпадает) — доверен
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const testCa = path.join(home, "test-ca.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-keyout", path.join(home, "k.pem"), "-out", testCa, "-days", "1", "-nodes", "-subj", "/CN=pegas-test"]);
    await fs.copyFile(testCa, paths.caCertPath);
    const storeCert = path.join(home, "pegas-root-ca.crt");
    await fs.copyFile(testCa, storeCert);
    expect(await isCaTrusted("linux", paths, { linuxStoreCertPath: storeCert, wsl: false })).toBe(true);

    // 4. В хранилище ДРУГОЙ сертификат (fingerprint не совпадает) — не доверен
    const otherCa = path.join(home, "other-ca.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-keyout", path.join(home, "k2.pem"), "-out", otherCa, "-days", "1", "-nodes", "-subj", "/CN=other"]);
    await fs.copyFile(otherCa, storeCert);
    expect(await isCaTrusted("linux", paths, { linuxStoreCertPath: storeCert, wsl: false })).toBe(false);

    await fs.rm(home, { recursive: true, force: true });
  });
});
