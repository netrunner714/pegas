import { describe, it, expect, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Замок спавна PM-команд: до импорта update.js, чтобы перехватить его биндинг child_process. */
let spawnedCommand = "";
// Мок реального модуля целиком (через require), подменяя синхронные спавны
const actualCp = require("node:child_process");
const spawnSyncMock = (bin: string, args: string[]) => {
  spawnedCommand = [bin, ...(args || [])].join(" ");
  return { status: 0, stdout: "", stderr: "" };
};
const cpMock = { ...actualCp, spawnSync: spawnSyncMock, execFileSync: spawnSyncMock, execSync: spawnSyncMock };
mock.module("node:child_process", () => ({
  ...cpMock,
  default: cpMock,
}));

const { handleUpdate } = await import("./update.js");
const { resolveTargetVersion } = await import("./update.js");

describe("pegas update", () => {
  it("resolveTargetVersion: same-major по умолчанию, major с allowMajor", async () => {
    const r1 = await resolveTargetVersion("2.0.5", false, "2.1.0");
    expect(r1.targetVer).toBe("2.1.0");
    expect(r1.hasNewerMajor).toBe(false);

    const r2 = await resolveTargetVersion("2.0.5", false, "3.0.0");
    expect(r2.targetVer).toBe("2.0.5");
    expect(r2.hasNewerMajor).toBe(true);
    expect(r2.availableMajor).toBe("3.0.0");

    const r3 = await resolveTargetVersion("2.0.5", true, "3.0.0");
    expect(r3.targetVer).toBe("3.0.0");
    expect(r3.hasNewerMajor).toBe(false);
  });

  it("resolveTargetVersion: недоступный registry → фиксируем текущую версию", async () => {
    // VERSION пакета — кандидат даже без registry: локальный CLI всегда «доступен».
    const local = await import("../version.js").then((m) => m.VERSION).catch(() => undefined);
    const current = local ?? "2.0.5";
    const r = await resolveTargetVersion(current, false, null);
    expect(r.targetVer).toBe(current);
    expect(r.hasNewerMajor).toBe(false);
  });

  it("handleUpdate: обновление версии — package.json переписан, pm-команда вызвана", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-upd4-"));
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", packageManager: "pnpm@9.0.0", devDependencies: { "@netrunner714/pegas": "^2.0.5" } }, null, 2)
    );

    // Замок реестра: доступна 2.1.0 (same major)
    const origFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      value: async () => ({ ok: true, json: async () => ({ version: "2.1.0" }) }),
      configurable: true,
      writable: true,
    });

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await handleUpdate({ cwd: dir, json: true, noExit: true });
    } finally {
      Object.defineProperty(globalThis, "fetch", { value: origFetch, configurable: true, writable: true });
      console.log = orig;
    }

    const jsonLines = logs.filter((l) => l.trim().startsWith("{"));
    expect(jsonLines.join("\n")).toContain('"status":"success"');
    expect(jsonLines.join("\n")).toContain('"newVersion":"2.1.0"');
    expect(spawnedCommand).toBe("pnpm update @netrunner714/pegas");
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
    expect(pkg.devDependencies["@netrunner714/pegas"]).toBe("^2.1.0");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("handleUpdate: нет зависимости — ошибка с подсказкой установки", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-upd2-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "y" }));

    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    const origExit = process.exit;
    (process as any).exit = ((code?: number) => {
      throw new Error("EXIT_" + code);
    }) as any;
    try {
      await handleUpdate({ cwd: dir, json: false, noExit: false });
    } catch {}
    process.exit = origExit;
    console.error = orig;
    expect(errors.join("\n")).toContain("bun add -d @netrunner714/pegas");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("handleUpdate: нет package.json — внятная ошибка", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-upd3-"));
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    const origExit = process.exit;
    (process as any).exit = ((code?: number) => {
      throw new Error("EXIT_" + code);
    }) as any;
    try {
      await handleUpdate({ cwd: dir, json: false, noExit: false });
    } catch {}
    process.exit = origExit;
    console.error = orig;
    expect(errors.join("\n")).toContain("package.json");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
