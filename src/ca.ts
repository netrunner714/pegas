import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import child_process from "node:child_process";
import { findOrDownloadCaddy } from "./binary.js";

/**
 * Локальный Root CA Pegas для доверенного dev-HTTPS.
 *
 * Caddy, запускаемый Pegas (dev и ca), использует выделенное хранилище
 * ~/.pegas/caddy/data (через XDG_DATA_HOME и т.д.), чтобы CA был стабильным
 * и не пересекался с другими Caddy на машине. Экспортированный корневой
 * сертификат кладётся в ~/.pegas/ca/root.crt и регистрируется в системном
 * хранилище доверия ОС.
 */

export const PEGAS_CA_DIRNAME = ".pegas";
export const PEGAS_CA_NAME = "Pegas Local Root CA";

/**
 * SHA-1 fingerprint сертификата (hex, без разделителей) — единственный
 * надёжный идентификатор CA в trust store. Caddy всегда дописывает к
 * subject'у свой суффикс ("- 2026 ECC Root"), поэтому поиск по имени
 * ненадёжен по построению; отпечаток же стабилен всегда.
 */
export function getCertSha1(certPath: string): string | null {
  try {
    const pem = require("node:fs").readFileSync(certPath);
    const x509 = new crypto.X509Certificate(pem);
    return x509.fingerprint.replace(/:/g, "").toLowerCase();
  } catch {
    return null;
  }
}

export interface CaPaths {
  /** ~/.pegas */
  pegasHome: string;
  /** ~/.pegas/ca */
  caDir: string;
  /** ~/.pegas/ca/root.crt — экспортированный корневой сертификат */
  caCertPath: string;
  /** ~/.pegas/caddy — выделенная "домашняя" директория Caddy */
  caddyHome: string;
  /** Путь к root.crt внутри хранилища Caddy */
  caddyRootCert: string;
}

export function getCaPaths(home: string = os.homedir()): CaPaths {
  const pegasHome = path.join(home, PEGAS_CA_DIRNAME);
  const caDir = path.join(pegasHome, "ca");
  const caddyHome = path.join(pegasHome, "caddy");
  return {
    pegasHome,
    caDir,
    caCertPath: path.join(caDir, "root.crt"),
    caddyHome,
    caddyRootCert: path.join(caddyHome, "data", "caddy", "pki", "authorities", "local", "root.crt"),
  };
}

/**
 * Возвращает переменные окружения, изолирующие хранилище Caddy Pegas
 * от общесистемного (~/.local/share/caddy и т.п.).
 */
export function getCaddyHomeEnv(paths: CaPaths = getCaPaths()): Record<string, string> {
  return {
    XDG_DATA_HOME: path.join(paths.caddyHome, "data"),
    XDG_CONFIG_HOME: path.join(paths.caddyHome, "config"),
    XDG_CACHE_HOME: path.join(paths.caddyHome, "cache"),
  };
}

/**
 * Минимальный Caddyfile для провижининга локального CA без запуска сервера:
 * `caddy validate` материализует PKI-авторитет в хранилище.
 */
export function buildProvisionCaddyfile(): string {
  return [
    "{",
    "\tadmin off",
    "\tskip_install_trust",
    "\tpki {",
    `\t\tca local {`,
    `\t\t\tname "${PEGAS_CA_NAME}"`,
    `\t\t}`,
    "\t}",
    "}",
    "",
  ].join("\n");
}

export function detectWsl(
  env: NodeJS.ProcessEnv = process.env,
  procVersionReader: () => string | null = readProcVersion
): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  const procVersion = procVersionReader();
  if (procVersion && /microsoft/i.test(procVersion)) return true;
  return false;
}

function readProcVersion(): string | null {
  try {
    return require("node:fs").readFileSync("/proc/version", "utf-8");
  } catch {
    return null;
  }
}

/**
 * Провижинит локальный CA (если его ещё нет) и экспортирует root.crt
 * в ~/.pegas/ca/root.crt.
 */
export async function provisionCa(
  caddyPath: string,
  options: { dryRun?: boolean; paths?: CaPaths } = {}
): Promise<{ certPath: string; created: boolean }> {
  const paths = options.paths || getCaPaths();

  await fs.mkdir(paths.caDir, { recursive: true });

  // Уже provision'ен ранее — просто гарантируем экспорт
  const existingExported = await fs
    .access(paths.caCertPath)
    .then(() => true)
    .catch(() => false);
  if (existingExported) {
    return { certPath: paths.caCertPath, created: false };
  }

  if (options.dryRun) {
    return { certPath: paths.caCertPath, created: false };
  }

  await fs.mkdir(path.dirname(paths.caddyRootCert), { recursive: true });

  const res = child_process.spawnSync(
    caddyPath,
    ["validate", "--adapter", "caddyfile", "--config", "-"],
    {
      input: buildProvisionCaddyfile(),
      encoding: "utf-8",
      env: { ...process.env, ...getCaddyHomeEnv(paths) },
      timeout: 30_000,
    }
  );

  if (res.status !== 0) {
    throw new Error(
      `Не удалось создать локальный CA через Caddy: ${res.stderr || res.stdout || "неизвестная ошибка"}`
    );
  }

  const rootCert = await fs.readFile(paths.caddyRootCert);
  await fs.writeFile(paths.caCertPath, rootCert, { mode: 0o644 });

  return { certPath: paths.caCertPath, created: true };
}

/**
 * Может ли текущий процесс слушать привилегированные порты (<1024).
 * Linux: root или setcap cap_net_bind_service на бинарнике Caddy.
 * Windows: всегда да. macOS без root — нет.
 */
export function canBindLowPorts(
  platform: string = process.platform,
  uid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
  caddyPath?: string
): boolean {
  if (platform === "win32") return true;
  if (uid === 0) return true;
  if (platform === "linux" && caddyPath) {
    try {
      const out = child_process
        .execFileSync("getcap", [caddyPath], {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
        })
        .toString();
      return out.includes("cap_net_bind_service");
    } catch {}
  }
  return false;
}

export interface TrustCommand {
  cmd: string;
  args: string[];
}

/**
 * Команды установки Root CA в системное хранилище доверия.
 * Чистая функция — для тестов и исполнения.
 */
export function buildInstallTrustCommands(
  platform: string,
  opts: { certPath: string; caddyPath: string; wsl?: boolean }
): TrustCommand[] {
  if (platform === "win32") {
    // Хранилище текущего пользователя — без UAC
    return [{ cmd: "certutil.exe", args: ["-user", "-addstore", "Root", opts.certPath] }];
  }
  if (opts.wsl) {
    // Windows-утилита вызывается из WSL; путь конвертируется wslpath'ом на этапе исполнения
    return [{ cmd: "certutil.exe", args: ["-user", "-addstore", "Root", "__WSLPATH__"] }];
  }
  if (platform === "darwin") {
    return [
      {
        cmd: "sudo",
        args: [
          "security",
          "add-trusted-cert",
          "-d",
          "-r",
          "trustRoot",
          "-k",
          "/Library/Keychains/System.keychain",
          opts.certPath,
        ],
      },
    ];
  }
  // linux
  const commands: TrustCommand[] = [
    {
      cmd: "sudo",
      args: ["cp", opts.certPath, "/usr/local/share/ca-certificates/pegas-root-ca.crt"],
    },
    { cmd: "sudo", args: ["update-ca-certificates"] },
  ];
  // Golden Path из addon-задачи: разрешаем Caddy слушать 443 без sudo при dev
  if (opts.caddyPath) {
    commands.push({
      cmd: "sudo",
      args: ["setcap", "cap_net_bind_service=+ep", opts.caddyPath],
    });
  }
  return commands;
}

/**
 * Команды удаления Root CA из системного хранилища доверия.
 * Windows/WSL: удаление по SHA-1 hash (имена ненадёжны — см. getCertSha1).
 */
export function buildRemoveTrustCommands(
  platform: string,
  opts: { wsl?: boolean; sha1?: string }
): TrustCommand[] {
  if (platform === "win32" || opts.wsl) {
    // certutil -delstore принимает hex-hash без разделителей
    return [
      { cmd: "certutil.exe", args: ["-user", "-delstore", "Root", opts.sha1 || PEGAS_CA_NAME] },
    ];
  }
  if (platform === "darwin") {
    return [
      {
        cmd: "sudo",
        args: [
          "security",
          "delete-certificate",
          "-Z",
          opts.sha1 || PEGAS_CA_NAME,
          "/Library/Keychains/System.keychain",
        ],
      },
    ];
  }
  return [
    { cmd: "sudo", args: ["rm", "-f", "/usr/local/share/ca-certificates/pegas-root-ca.crt"] },
    { cmd: "sudo", args: ["update-ca-certificates"] },
  ];
}

/**
 * Устанавливает Root CA в доверенные ОС (исполняет команды из buildInstallTrustCommands).
 */
export async function installCaTrust(options: {
  certPath: string;
  caddyPath: string;
  platform?: string;
  wsl?: boolean;
}): Promise<void> {
  const platform = options.platform || process.platform;
  const wsl = options.wsl ?? detectWsl();
  const commands = buildInstallTrustCommands(platform, {
    certPath: options.certPath,
    caddyPath: options.caddyPath,
    wsl,
  });
  assertOsMutationAllowed();

  for (const command of commands) {
    let args = [...command.args];

    if (platform === "win32" || wsl) {
      if (wsl) {
        const winPath = child_process
          .execFileSync("wslpath", ["-w", options.certPath], { encoding: "utf-8", timeout: 5000 })
          .trim();
        args = ["-user", "-addstore", "Root", winPath];
      }
      // Тихий режим: сырой вывод certutil на смеси языков захламляет итоговый отчёт
      child_process.execFileSync("certutil.exe", args, { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
      continue;
    }

    child_process.execFileSync(command.cmd, args, { stdio: "inherit", timeout: 120_000 });
  }
}

/**
 * Удаляет Root CA из доверенных ОС и зачищает экспортированный сертификат.
 * Windows/WSL/macOS: удаление по SHA-1 fingerprint экспортированного root.crt.
 */
export async function removeCaTrust(options: {
  platform?: string;
  wsl?: boolean;
  paths?: CaPaths;
}): Promise<void> {
  const platform = options.platform || process.platform;
  const wsl = options.wsl ?? detectWsl();
  const paths = options.paths || getCaPaths();
  const sha1 = getCertSha1(paths.caCertPath) || undefined;
  const commands = buildRemoveTrustCommands(platform, { wsl, sha1 });
  assertOsMutationAllowed();

  for (const command of commands) {
    if (command.cmd === "certutil.exe") {
      child_process.execFileSync(command.cmd, command.args, {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 120_000,
      });
    } else {
      child_process.execFileSync(command.cmd, command.args, { stdio: "inherit", timeout: 120_000 });
    }
  }

  await fs.rm(paths.caDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Проверяет, установлен ли Root CA в системное хранилище доверия.
 *
 * Идентификация — по SHA-1 fingerprint экспортированного root.crt, а не по
 * имени: Caddy дописывает к subject'у свой суффикс ("- 2026 ECC Root"),
 * поэтому поиск по имени ненадёжен по построению (certutil требует точного
 * совпадения CN и возвращает NTE_NOT_FOUND на частичном имени).
 */
export async function isCaTrusted(
  platform: string = process.platform,
  paths: CaPaths = getCaPaths(),
  options: { linuxStoreCertPath?: string; wsl?: boolean } = {}
): Promise<boolean> {
  const exported = await fs
    .access(paths.caCertPath)
    .then(() => true)
    .catch(() => false);
  if (!exported) return false;

  const sha1 = getCertSha1(paths.caCertPath);
  if (!sha1) return false;

  const linuxStoreCertPath = options.linuxStoreCertPath || "/usr/local/share/ca-certificates/pegas-root-ca.crt";
  const wsl = options.wsl ?? detectWsl();

  try {
    if (platform === "linux" && !wsl) {
      // На Linux мы сами копируем root.crt в системный каталог — сравниваем содержимое
      try {
        const storePem = require("node:fs").readFileSync(linuxStoreCertPath);
        const storeSha1 = new crypto.X509Certificate(storePem).fingerprint.replace(/:/g, "").toLowerCase();
        return storeSha1 === sha1;
      } catch {
        return false;
      }
    }
    if (platform === "darwin") {
      // macOS security не умеет искать по хэшу напрямую — верифицируем через
      // экспорт ключей и поиск отпечатка в выводе.
      const out = child_process.execFileSync(
        "security",
        ["find-certificate", "-c", PEGAS_CA_NAME, "-a", "/Library/Keychains/System.keychain"],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf-8" }
      );
      return out.replace(/[^0-9a-fA-F]/g, "").toLowerCase().includes(sha1);
    }
    if (platform === "win32" || wsl) {
      const out = child_process.execFileSync("certutil.exe", ["-user", "-store", "Root"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
        encoding: "utf-8",
      });
      // certutil выводит отпечатки как "(sha1): dd688ea2e845e3..." — ищем без разделителей
      return out.replace(/[^0-9a-fA-F]/g, "").toLowerCase().includes(sha1);
    }
  } catch {
    return false;
  }

  // Неплатформенный fallback: экспортированный сертификат существует
  return true;
}

export interface CaInstallOptions {
  json?: boolean;
  dryRun?: boolean;
  noExit?: boolean;
  skipTrust?: boolean;
  paths?: CaPaths;
  caddyPath?: string;
}

/**
 * Guard: мутация системного trust store из тестового окружения запрещена.
 * Юнит-тесты обязаны быть герметичными (исторический баг: тест remove
 * реально выкорчёвывал сертификат из Windows-хранилища пользователя).
 * Явный opt-in — PEGAS_ALLOW_OS_MUTATION=1 для e2e-прогонов.
 * Внутри мутаторов (removeCaTrust/installCaTrust), а не в обёртках —
 * чтобы spyOn-моки тестов перехватывали вызов раньше guard'а.
 */
export function assertOsMutationAllowed(): void {
  if (process.env.NODE_ENV === "test" && process.env.PEGAS_ALLOW_OS_MUTATION !== "1") {
    throw new Error(
      "Попытка мутировать системное хранилище доверия в тестовом окружении (NODE_ENV=test). " +
        "Замокайте removeCaTrust/installCaTrust или выставьте PEGAS_ALLOW_OS_MUTATION=1 для e2e."
    );
  }
}

/**
 * Устанавливает Root CA в доверенные ОС (исполняет команды из buildInstallTrustCommands).
 */
export async function installCa(options: CaInstallOptions = {}): Promise<boolean> {
  const isJson = options.json ?? false;
  const paths = options.paths || getCaPaths();

  if (options.dryRun) {
    const message = "[dry-run] pegas ca install: CA будет создан в ~/.pegas/ca/root.crt и добавлен в доверенные ОС";
    console.log(isJson ? JSON.stringify({ status: "dry-run", message }) : `\n📋 ${message}\n`);
    return true;
  }

  const caddyPath = options.caddyPath || (await findOrDownloadCaddy({ silent: true }));

  const provisioned = await provisionCa(caddyPath, { paths });
  const messages: string[] = [];
  messages.push(
    provisioned.created
      ? `Создан локальный Root CA Pegas: ${paths.caCertPath}`
      : `Локальный Root CA Pegas уже существует: ${paths.caCertPath}`
  );

  if (!options.skipTrust) {
    await installCaTrust({ certPath: paths.caCertPath, caddyPath, wsl: detectWsl() });
    messages.push("Root CA добавлен в системное хранилище доверия ОС");
  }

  messages.push("Готово: локальные dev-домены открываются по HTTPS с доверенным замком (без красных экранов браузера).");

  if (isJson) {
    console.log(JSON.stringify({ status: "success", actions: messages, certPath: paths.caCertPath }));
  } else {
    console.log(`\n🔐 Root CA Pegas успешно установлен\n`);
    for (const m of messages) console.log(`  ✓ ${m}`);
    console.log("");
  }
  return true;
}

export interface CaRemoveOptions {
  json?: boolean;
  dryRun?: boolean;
  noExit?: boolean;
  paths?: CaPaths;
}

/**
 * Полный цикл `pegas ca remove`.
 */
export async function removeCa(options: CaRemoveOptions = {}): Promise<boolean> {
  const isJson = options.json ?? false;
  const paths = options.paths || getCaPaths();

  if (options.dryRun) {
    const message = "[dry-run] pegas ca remove: Root CA будет удалён из доверенных ОС и зачищен";
    console.log(isJson ? JSON.stringify({ status: "dry-run", message }) : `\n📋 ${message}\n`);
    return true;
  }

  const trusted = await isCaTrusted(process.platform, paths);
  if (!trusted) {
    const message = "Локальный Root CA Pegas не установлен в системе — удалять нечего.";
    if (isJson) {
      console.log(JSON.stringify({ status: "not-installed", message }));
    } else {
      console.log(`\nℹ️  ${message}\n`);
    }
    return true;
  }

  await removeCaTrust({ paths, wsl: detectWsl() });

  const messages = [
    "Root CA удалён из системного хранилища доверия ОС",
    "Экспортированный сертификат зачищен",
  ];

  if (isJson) {
    console.log(JSON.stringify({ status: "success", actions: messages }));
  } else {
    console.log(`\n🔐 Root CA Pegas удалён\n`);
    for (const m of messages) console.log(`  ✓ ${m}`);
    console.log("");
  }
  return true;
}
