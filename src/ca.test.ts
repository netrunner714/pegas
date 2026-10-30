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
  buildLinuxInstallTrustCommands,
  buildLinuxRemoveTrustCommands,
  findLinuxTrustFile,
  LINUX_TRUST_STORE_DIRS,
  getCertSha1,
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
    let callCount = 0;
    const spy = spyOn(child_process, "spawnSync").mockImplementation(((cmd: string, args: string[], opts: any) => {
      validateCalled = cmd === fakeCaddy && args.includes("validate");
      capturedEnv = opts?.env || {};
      callCount++;
      // Имитируем материализацию PKI Caddy (только на первом вызове —
      // идемпотентный повтор не должен требовать валидации)
      if (callCount === 1) {
        const rootDir = path.dirname(paths.caddyRootCert);
        require("node:fs").mkdirSync(rootDir, { recursive: true });
        require("node:fs").writeFileSync(paths.caddyRootCert, "FAKE_ROOT_CERT");
      }
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

      // Повторный вызов идемпотентен: PKI и экспорт побайтово идентичны —
      // валидация не нужна, PKI не материализуется заново
      const pkiBefore = await fs.readFile(paths.caddyRootCert, "utf-8");
      const res2 = await provisionCa(fakeCaddy, { paths });
      expect(res2.created).toBe(false);
      expect(callCount).toBe(1);
      const pkiAfter = await fs.readFile(paths.caddyRootCert, "utf-8");
      expect(pkiAfter).toBe(pkiBefore);
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
    // WSL: CA ставится в Windows, но право на 443 — Linux-сторона: setcap обязателен
    expect(wsl.some((c) => c.cmd === "sudo" && c.args.join(" ").includes("setcap") && c.args.includes(opts.caddyPath))).toBe(
      true
    );
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

describe("pegas ca (fixes)", () => {
  /** Генерирует тестовый CA-сертификат (ECC P-256) через openssl. */
  async function genCert(home: string, name: string): Promise<string> {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const certPath = path.join(home, `${name}.pem`);
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-keyout", path.join(home, `${name}.key`), "-out", certPath,
      "-days", "1", "-nodes", "-subj", `/CN=${name}`,
    ]);
    return certPath;
  }

  it("provisionCa перезаписывает stale-экспорт при расхождении с живым PKI", async () => {
    const home = await tmpHome();
    const paths = getCaPaths(home);
    const fakeCaddy = path.join(home, "caddy");

    const spy = spyOn(child_process, "spawnSync").mockImplementation(((cmd: string, args: string[]) => {
      // Имитируем: живой PKI Caddy — сертификат NEW_CERT
      require("node:fs").mkdirSync(path.dirname(paths.caddyRootCert), { recursive: true });
      require("node:fs").writeFileSync(paths.caddyRootCert, "NEW_CERT");
      return { status: 0, stdout: "", stderr: "" };
    }) as any);

    try {
      // stale-экспорт от старого CA
      await fs.mkdir(paths.caDir, { recursive: true });
      await fs.writeFile(paths.caCertPath, "OLD_STALE_CERT");

      const res = await provisionCa(fakeCaddy, { paths });
      expect(res.created).toBe(true);
      const exported = await fs.readFile(paths.caCertPath, "utf-8");
      expect(exported).toBe("NEW_CERT");
    } finally {
      spy.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("buildLinuxInstallTrustCommands различает Debian и RHEL семейства", () => {
    const debian = buildLinuxInstallTrustCommands({
      certPath: "/tmp/root.crt", caddyPath: "/usr/bin/caddy", rhelFamily: false,
    });
    expect(debian[0].args).toContain("/usr/local/share/ca-certificates/pegas-root-ca.crt");
    expect(debian.some((c) => c.args.includes("update-ca-certificates"))).toBe(true);
    expect(debian.some((c) => c.args.join(" ").includes("setcap") && c.args.join(" ").includes("cap_net_bind_service=+ep"))).toBe(true);

    const rhel = buildLinuxInstallTrustCommands({
      certPath: "/tmp/root.crt", caddyPath: "/usr/bin/caddy", rhelFamily: true,
    });
    expect(rhel[0].args).toContain("/etc/pki/ca-trust/source/anchors/pegas-root-ca.crt");
    expect(rhel.some((c) => c.args.includes("update-ca-trust"))).toBe(true);
  });

  it("buildLinuxRemoveTrustCommands отзывает setcap симметрично install", () => {
    const cmds = buildLinuxRemoveTrustCommands({ caddyPath: "/usr/bin/caddy", rhelFamily: false });
    const setcapCmd = cmds.find((c) => c.args.join(" ").includes("setcap"));
    expect(setcapCmd).toBeDefined();
    // Синтаксис libcap >= 2.71: setcap -r <file> (пары действие-файл,
    // «-r cap_net_bind_service file» трактует cap как имя файла и падает)
    expect(setcapCmd!.args.join(" ")).toBe("sudo setcap -r /usr/bin/caddy".replace("sudo ", ""));
    // без caddyPath setcap не отзывается
    const noCap = buildLinuxRemoveTrustCommands({ rhelFamily: false });
    expect(noCap.some((c) => c.args.join(" ").includes("setcap"))).toBe(false);
  });

  it("buildInstallTrustCommands WSL ставит CA в обе системы (Windows + Linux-side)", () => {
    const wsl = buildInstallTrustCommands("linux", { certPath: "/tmp/root.crt", caddyPath: "/usr/bin/caddy", wsl: true });
    // Windows-сторона (браузеры)
    expect(wsl[0].cmd).toBe("certutil.exe");
    // Linux-сторона (curl/node/git внутри WSL): cp + update-ca-certificates
    expect(wsl.some((c) => c.cmd === "sudo" && c.args.join(" ").includes("cp") && c.args.includes("/tmp/root.crt"))).toBe(true);
    expect(wsl.some((c) => c.cmd === "sudo" && c.args.join(" ").includes("update-ca-certificates"))).toBe(true);
    // setcap — Linux-сторона
    expect(wsl.some((c) => c.cmd === "sudo" && c.args.join(" ").includes("setcap"))).toBe(true);
  });

  it("buildRemoveTrustCommands WSL чистит обе системы (Windows + Linux-side + setcap)", () => {
    const wsl = buildRemoveTrustCommands("linux", { wsl: true, sha1: "abc123", caddyPath: "/usr/bin/caddy" });
    expect(wsl[0].cmd).toBe("certutil.exe");
    expect(wsl[0].args).toContain("abc123");
    expect(wsl.some((c) => c.cmd === "sudo" && c.args.join(" ").includes("rm") && c.args.join(" ").includes("pegas-root-ca.crt"))).toBe(true);
    expect(wsl.some((c) => c.cmd === "sudo" && c.args.join(" ").includes("update-ca-certificates"))).toBe(true);
    expect(wsl.some((c) => c.cmd === "sudo" && c.args.join(" ") === "setcap -r /usr/bin/caddy")).toBe(true);
  });

  it("isCaTrusted linux ищет fingerprint по всем trust-каталогам, включая чужие имена", async () => {
    const home = await tmpHome();
    const paths = getCaPaths(home);
    await fs.mkdir(paths.caDir, { recursive: true });
    const cert = await genCert(home, "finder-test");
    await fs.copyFile(cert, paths.caCertPath);

    const sha1 = getCertSha1(paths.caCertPath);
    expect(sha1).toBeTruthy();

    // Поиск доверия находит файл по fingerprint даже под «чужим» именем
    // (конвенция Caddy: Pegas_Local_Root_CA_-_2026_ECC_Root_<serial>.crt)
    const found = await findLinuxTrustFile(sha1!);
    expect(found).toBe(null); // на тестовой машине trust-каталоги не содержат наш тестовый cert

    // Сканируем каталог с сертификатом: мокаем LINUX_TRUST_STORE_DIRS через нетривиальный путь
    const fakeStoreDir = path.join(home, "fake-store");
    await fs.mkdir(fakeStoreDir, { recursive: true });
    await fs.copyFile(cert, path.join(fakeStoreDir, "Pegas_Local_Root_CA_-_2026_ECC_Root_12345.crt"));
    const dirBefore = [...LINUX_TRUST_STORE_DIRS];
    (LINUX_TRUST_STORE_DIRS as any).push(fakeStoreDir);
    try {
      expect(await findLinuxTrustFile(sha1!)).toBe(path.join(fakeStoreDir, "Pegas_Local_Root_CA_-_2026_ECC_Root_12345.crt"));
      // и чужой сертификат не находится
      const other = await genCert(home, "other-cert");
      const otherSha1 = getCertSha1(other);
      expect(await findLinuxTrustFile(otherSha1!)).toBe(null);
    } finally {
      (LINUX_TRUST_STORE_DIRS as any).length = 0;
      LINUX_TRUST_STORE_DIRS.push(...dirBefore);
    }

    await fs.rm(home, { recursive: true, force: true });
  });

  it("isCaTrusted darwin передаёт -Z в security find-certificate", async () => {
    const home = await tmpHome();
    const paths = getCaPaths(home);
    await fs.mkdir(paths.caDir, { recursive: true });
    const cert = await genCert(home, "darwin-test");
    await fs.copyFile(cert, paths.caCertPath);
    const sha1 = getCertSha1(paths.caCertPath)!;

    let capturedArgs: string[] = [];
    const spy = spyOn(child_process, "execFileSync").mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === "security") {
        capturedArgs = args;
        return `SHA-1 hash: ${sha1.replace(/(..)(?=.)/g, "$1:")}\n`;
      }
      throw new Error("unexpected cmd");
    }) as any);

    try {
      expect(await isCaTrusted("darwin", paths, { wsl: false })).toBe(true);
      expect(capturedArgs).toContain("-Z");
    } finally {
      spy.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("isCaTrusted certutil-таймаут увеличен (WSL interop cold-start)", async () => {
    // Проверяем через мок: таймаут для certutil.exe должен быть >= 30 сек
    const home = await tmpHome();
    const paths = getCaPaths(home);
    await fs.mkdir(paths.caDir, { recursive: true });
    const cert = await genCert(home, "win-test");
    await fs.copyFile(cert, paths.caCertPath);
    const sha1 = getCertSha1(paths.caCertPath)!;

    let capturedTimeout = 0;
    const spy = spyOn(child_process, "execFileSync").mockImplementation(((cmd: string, args: string[], opts: any) => {
      if (cmd === "certutil.exe") {
        capturedTimeout = opts?.timeout || 0;
        return `SHA1: ${sha1}`;
      }
      throw new Error("unexpected cmd");
    }) as any);

    try {
      expect(await isCaTrusted("linux", paths, { wsl: true })).toBe(true);
      expect(capturedTimeout).toBeGreaterThanOrEqual(30_000);
    } finally {
      spy.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
