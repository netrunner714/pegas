import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import child_process from "node:child_process";
import { findOrDownloadCaddy, PEGAS_CADDY_VERSION } from "./binary.js";

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
 *
 * Экспорт сверяется с живым PKI Caddy по SHA-1 fingerprint: при расхождении
 * (stale-экспорт после частичного `rm -rf ~/.pegas` или перегенерации CA)
 * экспорт перезаписывается актуальным сертификатом — иначе в trust store ОС
 * уедет протухший сертификат, а leaf'ы будет подписывать уже другой CA.
 */
export async function provisionCa(
  caddyPath: string,
  options: { dryRun?: boolean; paths?: CaPaths } = {}
): Promise<{ certPath: string; created: boolean }> {
  const paths = options.paths || getCaPaths();

  await fs.mkdir(paths.caDir, { recursive: true });

  // Уже provision'ен ранее и экспорт совпадает с живым PKI — ничего не делаем.
  // Расхождение (stale-экспорт после частичного `rm -rf ~/.pegas`, перегенерация
  // CA) -> пересоздаём/реэкспортируем. Побайтовое сравнение: реальные файлы
  // root.crt в PKI и экспорте идентичны (Caddy не меняет root при повторной
  // материализации), а для сравнения fingerprint оба файла обязаны быть PEM.
  const existingExported = await fs
    .access(paths.caCertPath)
    .then(() => true)
    .catch(() => false);
  if (existingExported) {
    let pkiBytes: Buffer | null = null;
    try {
      pkiBytes = await fs.readFile(paths.caddyRootCert);
    } catch {}
    let exportedBytes: Buffer | null = null;
    try {
      exportedBytes = await fs.readFile(paths.caCertPath);
    } catch {}
    if (pkiBytes !== null && exportedBytes !== null && pkiBytes.equals(exportedBytes)) {
      return { certPath: paths.caCertPath, created: false };
    }
    // Иначе: PKI не существует или файлы разошлись (stale-экспорт,
    // перегенерация CA) — PKI будет (пере)создан ниже, экспорт перезапишется.
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
    // Windows-утилита вызывается из WSL; путь конвертируется wslpath'ом на этапе исполнения.
    // В WSL две системы и два класса потребителей доверия:
    //  1) браузеры в Windows — Windows user Root store (certutil.exe);
    //  2) curl/node/git, запущенные внутри WSL, — системный бандл Linux-стороны.
    // Поэтому CA ставится в ОБОА хранилища, а право на порт 443 — setcap
    // на Linux-стороне (бинарник Caddy живёт там).
    const commands: TrustCommand[] = [
      { cmd: "certutil.exe", args: ["-user", "-addstore", "Root", "__WSLPATH__"] },
    ];
    commands.push(...buildLinuxInstallTrustCommands({ certPath: opts.certPath, caddyPath: opts.caddyPath }));
    return commands;
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
  // linux (нативный)
  return buildLinuxInstallTrustCommands(opts);
}

/**
 * Команды установки Root CA в системное хранилище доверия Linux.
 *
 * Чистая функция (для тестов): детект семейства по доступности каталога
 * или утилиты update-ca-trust. Debian-семейство — /usr/local/share/ca-certificates
 * + update-ca-certificates; RHEL-семейство — /etc/pki/ca-trust/source/anchors
 * + update-ca-trust.
 */
export function buildLinuxInstallTrustCommands(opts: {
  certPath: string;
  caddyPath: string;
  rhelFamily?: boolean;
}): TrustCommand[] {
  const rhel = opts.rhelFamily ?? isRhelFamily();
  const storeDir = rhel ? "/etc/pki/ca-trust/source/anchors" : "/usr/local/share/ca-certificates";
  const refreshCmd = rhel ? "update-ca-trust" : "update-ca-certificates";
  const commands: TrustCommand[] = [
    { cmd: "sudo", args: ["cp", opts.certPath, path.join(storeDir, LINUX_TRUST_CERT_NAME)] },
    { cmd: "sudo", args: [refreshCmd] },
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

/** Детект RHEL-семейства по доступности update-ca-trust / каталога pki. */
export function isRhelFamily(): boolean {
  if (process.platform !== "linux") return false;
  const fsSync = require("node:fs");
  try {
    fsSync.accessSync("/etc/pki/ca-trust", fsSync.constants.F_OK);
    return true;
  } catch {}
  try {
    fsSync.accessSync("/usr/bin/update-ca-trust", fsSync.constants.X_OK);
    return true;
  } catch {}
  return false;
}

/**
 * Команды удаления Root CA из системного хранилища доверия Linux.
 * Дополнительно отзывает setcap с бинарника Caddy (симметрично install).
 * rhelFamily задаётся явно или детектится через isRhelFamily().
 */
export function buildLinuxRemoveTrustCommands(opts: {
  caddyPath?: string;
  rhelFamily?: boolean;
}): TrustCommand[] {
  const rhel = opts.rhelFamily ?? isRhelFamily();
  const storeDir = rhel ? "/etc/pki/ca-trust/source/anchors" : "/usr/local/share/ca-certificates";
  const commands: TrustCommand[] = [
    { cmd: "sudo", args: ["rm", "-f", path.join(storeDir, LINUX_TRUST_CERT_NAME)] },
  ];
  if (rhel) {
    commands.push({ cmd: "sudo", args: ["update-ca-trust"] });
  } else {
    // Debian-семейство: без --fresh update-ca-certificates оставляет сироту
    // pegas-root-ca.pem в /etc/ssl/certs (бандл не чистит отсутствующие).
    // --fresh пересобирает бандл с нуля — медленнее (~секунда), но чисто.
    commands.push({ cmd: "sudo", args: ["update-ca-certificates", "--fresh"] });
  }
  if (opts.caddyPath) {
    // Синтаксис setcap -r <file> (libcap >= 2.71): пары «действие-файл»;
    // «-r cap_net_bind_service file» трактует cap как имя файла и падает.
    commands.push({ cmd: "sudo", args: ["setcap", "-r", opts.caddyPath] });
  }
  return commands;
}
export function buildRemoveTrustCommands(
  platform: string,
  opts: { wsl?: boolean; sha1?: string; caddyPath?: string }
): TrustCommand[] {
  if (platform === "win32" || opts.wsl) {
    // certutil -delstore принимает hex-hash без разделителей.
    // WSL: симметрично install чистим обе стороны — Windows user store
    // и системный бандл Linux-стороны (+ отзыв setcap).
    const commands: TrustCommand[] = [
      { cmd: "certutil.exe", args: ["-user", "-delstore", "Root", opts.sha1 || PEGAS_CA_NAME] },
    ];
    if (opts.wsl) {
      commands.push(...buildLinuxRemoveTrustCommands({ caddyPath: opts.caddyPath }));
    }
    return commands;
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
  return buildLinuxRemoveTrustCommands({ caddyPath: opts.caddyPath });
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

    // certutil-команды (Windows-сторона WSL) и Linux-команды (setcap) идут вперемешку
    if (command.cmd === "certutil.exe") {
      let certutilArgs = args;
      if (wsl) {
        const winPath = child_process
          .execFileSync("wslpath", ["-w", options.certPath], { encoding: "utf-8", timeout: 5000 })
          .trim();
        certutilArgs = ["-user", "-addstore", "Root", winPath];
      }
      // Тихий режим: сырой вывод certutil на смеси языков захламляет итоговый отчёт
      child_process.execFileSync("certutil.exe", certutilArgs, {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 30_000,
      });
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
  caddyPath?: string;
}): Promise<void> {
  const platform = options.platform || process.platform;
  const wsl = options.wsl ?? detectWsl();
  const paths = options.paths || getCaPaths();
  const sha1 = getCertSha1(paths.caCertPath) || undefined;
  const caddyPath = options.caddyPath || (await resolveCaddyPathForSetcap());
  const commands = buildRemoveTrustCommands(platform, { wsl, sha1, caddyPath });
  assertOsMutationAllowed();

  // Зачистка «чужих» установок того же CA: файл в trust-каталоге Linux,
  // поставленный не Pegas (например, самим Caddy по своей конвенции имён).
  if (sha1 && platform === "linux") {
    const foreignFile = await findLinuxTrustFile(sha1);
    if (foreignFile && !foreignFile.endsWith(LINUX_TRUST_CERT_NAME)) {
      commands.splice(0, 0, { cmd: "sudo", args: ["rm", "-f", foreignFile] });
    }
  }

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
 * Путь к бинарнику Caddy для отзыва setcap при `pegas ca remove`.
 * Приоритет: versioned-бинарник в ~/.pegas/bin (как при install), затем plain.
 */
async function resolveCaddyPathForSetcap(): Promise<string | undefined> {
  try {
    const homeBin = path.join(os.homedir(), ".pegas", "bin");
    const candidates = [
      path.join(homeBin, `caddy-v${PEGAS_CADDY_VERSION}`),
      path.join(homeBin, process.platform === "win32" ? "caddy.exe" : "caddy"),
    ];
    for (const candidate of candidates) {
      if (await fs.access(candidate).then(() => true).catch(() => false)) {
        return candidate;
      }
    }
  } catch {}
  return undefined;
}

/**
 * Каталоги системного trust store Linux (Debian- и RHEL-семейства) и имя
 * файла, под которым Pegas копирует свой CA. Используются install/remove и
 * поиском доверия по fingerprint.
 */
export const LINUX_TRUST_STORE_DIRS = [
  "/usr/local/share/ca-certificates", // Debian/Ubuntu/Alpine (update-ca-certificates)
  "/etc/pki/ca-trust/source/anchors", // RHEL/Fedora/CentOS (update-ca-trust)
  "/usr/share/pki/ca-trust-source/anchors", // SUSE / системный уровень
];
export const LINUX_TRUST_CERT_NAME = "pegas-root-ca.crt";

/**
 * Ищет сертификат с SHA-1 fingerprint `sha1` в trust-каталогах Linux.
 * Сравнивает фактическое содержимое всех *.crt/*.pem-файлов, а не имена:
 * CA мог быть установлен как Pegas (`pegas-root-ca.crt`), так и самим Caddy
 * (конвенция `Pegas_Local_Root_CA_-_2026_ECC_Root_<serial>.crt`).
 * Возвращает путь к найденному файлу или null.
 */
export async function findLinuxTrustFile(sha1: string): Promise<string | null> {
  const fsSync = require("node:fs");
  for (const dir of LINUX_TRUST_STORE_DIRS) {
    let entries: string[] = [];
    try {
      entries = fsSync.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".crt") && !entry.endsWith(".pem")) continue;
      const filePath = path.join(dir, entry);
      try {
        const pem = fsSync.readFileSync(filePath);
        const candidate = new crypto.X509Certificate(pem).fingerprint.replace(/:/g, "").toLowerCase();
        if (candidate === sha1) return filePath;
      } catch {}
    }
  }
  return null;
}

/**
 * Вспомогательный: ищет подстроку-hex в выводе security/certutil.
 * Strip-хекс с последующим includes: сепараторы (двоеточия, пробелы)
 * вырезаются, поэтому формат отпечатка (DD:68:... или dd68...) роли не играет.
 */
function hexIncludes(output: string, sha1: string): boolean {
  return output.replace(/[^0-9a-fA-F]/g, "").toLowerCase().includes(sha1);
}
/**
 * Проверяет, установлен ли Root CA в системное хранилище доверия.
 *
 * Идентификация — по SHA-1 fingerprint экспортированного root.crt, а не по
 * имени: Caddy дописывает к subject'у свой суффикс ("- 2026 ECC Root"),
 * поэтому поиск по имени ненадёжен по построению (certutil требует точного
 * совпадения CN и возвращает NTE_NOT_FOUND на частичном имени).
 *
 * На Linux ищет сертификат по fingerprint во всех trust-каталогах
 * (Debian и RHEL-семейства) — независимо от того, кто его установил
 * (Pegas под именем pegas-root-ca.crt или сам Caddy по своей конвенции).
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

  const wsl = options.wsl ?? detectWsl();

  try {
    if (platform === "linux" && !wsl) {
      // Приоритет — точный путь (для тестов и legacy-установок), затем
      // системный поиск по fingerprint во всех trust-каталогах.
      if (options.linuxStoreCertPath) {
        try {
          const storePem = require("node:fs").readFileSync(options.linuxStoreCertPath);
          const storeSha1 = new crypto.X509Certificate(storePem).fingerprint.replace(/:/g, "").toLowerCase();
          return storeSha1 === sha1;
        } catch {}
      }
      return (await findLinuxTrustFile(sha1)) !== null;
    }
    if (platform === "darwin") {
      // macOS security не умеет искать по хэшу напрямую — верифицируем через
      // экспорт ключей и поиск отпечатка в выводе. -Z обязателен: без него
      // security find-certificate не печатает SHA-1 hash вовсе.
      const out = child_process.execFileSync(
        "security",
        ["find-certificate", "-c", PEGAS_CA_NAME, "-a", "-Z", "/Library/Keychains/System.keychain"],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf-8" }
      );
      return hexIncludes(out, sha1);
    }
    if (platform === "win32" || wsl) {
      const out = child_process.execFileSync("certutil.exe", ["-user", "-store", "Root"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
        encoding: "utf-8",
      });
      // certutil выводит отпечатки как "(sha1): dd688ea2e845e3..." — ищем без разделителей
      return hexIncludes(out, sha1);
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
  caddyPath?: string;
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

  await removeCaTrust({ paths, wsl: detectWsl(), caddyPath: options.caddyPath });

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
