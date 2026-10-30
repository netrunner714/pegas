import { describe, it, expect, spyOn } from "bun:test";
import { handleCa } from "./ca.js";
import * as caModule from "../ca.js";
import { getCaPaths } from "../ca.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Тесты команды `ca` обязаны быть герметичными: никаких реальных вызовов
 * certutil/security/sudo. Системное хранилище доверия — состояние машины,
 * трогать его из юнит-тестов недопустимо (исторический баг: тест
 * "remove on machine without CA" реально выкорчёвывал сертификат из
 * Windows-хранилища пользователя).
 */

describe("pegas ca command dispatch", () => {
  it("prints error and exits when action is missing or unknown", async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));

    let exitCode: number | null = null;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`EXIT_${exitCode}`);
    }) as any;

    try {
      await handleCa({ noExit: false });
    } catch (err: any) {
      // EXIT_1
    } finally {
      console.error = origError;
      process.exit = origExit;
    }

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("pegas ca install"))).toBe(true);
  });

  it("handles unknown action without exiting when noExit is set", async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));

    try {
      await handleCa({ action: "frobnicate", noExit: true });
    } finally {
      console.error = origError;
    }

    expect(errors.some((e) => e.includes("Не указано действие"))).toBe(true);
  });

  it("dry-run install/remove print preview and succeed", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      const okInstall = await handleCa({ action: "install", dryRun: true, noExit: true });
      const okRemove = await handleCa({ action: "remove", dryRun: true, noExit: true });
      expect(okInstall).toBe(true);
      expect(okRemove).toBe(true);
    } finally {
      console.log = origLog;
    }

    expect(logs.some((l) => l.includes("pegas ca install") && l.includes("dry-run"))).toBe(true);
    expect(logs.some((l) => l.includes("pegas ca remove") && l.includes("dry-run"))).toBe(true);
  });

  it("remove reports not-installed when no CA exists (hermetic: mocked trust removal)", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-ca-cmd-"));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    // Мокаем реальное удаление из ОС: тест не должен трогать trust store
    const removeTrustSpy = spyOn(caModule, "removeCaTrust").mockImplementation(async () => {});

    try {
      const ok = await handleCa({ action: "remove", noExit: true, paths: getCaPaths(tmpHome) });
      expect(ok).toBe(true);
    } finally {
      removeTrustSpy.mockRestore();
      console.log = origLog;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("не установлен") || l.includes("not-installed"))).toBe(true);
  });

  it("remove succeeds when CA is trusted (hermetic: mocked trust removal, tmp export)", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-ca-cmd-"));
    const paths = getCaPaths(tmpHome);

    // Локальный экспорт «существует» — заставляем isCaTrusted пройти только
    // за счёт мока доверия, без реального системного хранилища
    await fs.mkdir(paths.caDir, { recursive: true });
    await fs.writeFile(paths.caCertPath, "stub");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    const trustedSpy = spyOn(caModule, "isCaTrusted").mockImplementation(async () => true);
    const removeTrustSpy = spyOn(caModule, "removeCaTrust").mockImplementation(async () => {});

    try {
      const ok = await handleCa({ action: "remove", noExit: true, paths });
      expect(ok).toBe(true);
    } finally {
      trustedSpy.mockRestore();
      removeTrustSpy.mockRestore();
      console.log = origLog;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }

    expect(logs.some((l) => l.includes("удалён") || l.includes("success"))).toBe(true);
  });
});
