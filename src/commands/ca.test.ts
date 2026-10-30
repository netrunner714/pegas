import { describe, it, expect } from "bun:test";
import { handleCa } from "./ca.js";

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

  it("remove on machine without CA reports not-installed", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      const ok = await handleCa({ action: "remove", noExit: true });
      expect(ok).toBe(true);
    } finally {
      console.log = origLog;
    }

    // Либо not-installed (чистая машина), либо success (CA уже стоит в этой среде) — оба валидны,
    // но сообщение должно быть машиночитаемым или человекочитаемым.
    expect(
      logs.some((l) => l.includes("не установлен") || l.includes("удалён") || l.includes("success"))
    ).toBe(true);
  });
});
