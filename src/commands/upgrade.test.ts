import { describe, it, expect, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let spawnedCommand = "";
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

const { handleUpgrade, getGlobalUpgradeCommand, detectGlobalInstallation } = await import("./upgrade.js");

const NO_INSTALL = { npmRoot: "/tmp/pegas-upgrade-no-npm", homeDir: "/tmp/pegas-upgrade-no-home" };

async function fakeGlobal(version: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-upg-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "@netrunner714/pegas", version }));
  return dir;
}

function mockFetch(version: string | null) {
  const origFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    value: async () => ({ ok: true, json: async () => ({ version }) }),
    configurable: true,
    writable: true,
  });
  return origFetch;
}

describe("pegas upgrade", () => {
  it("getGlobalUpgradeCommand: bun и npm", () => {
    expect(getGlobalUpgradeCommand("bun", "3.5.0")).toBe("bun add -g @netrunner714/pegas@3.5.0");
    expect(getGlobalUpgradeCommand("npm", "3.5.0")).toBe("npm install -g @netrunner714/pegas@3.5.0");
  });

  it("handleUpgrade: обновление глобальной установки", async () => {
    const dir = await fakeGlobal("3.4.0");
    const origFetch = mockFetch("3.5.0");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      spawnedCommand = "";
      await handleUpgrade({ globalDir: dir, ...NO_INSTALL, json: true, noExit: true });
    } finally {
      Object.defineProperty(globalThis, "fetch", { value: origFetch, configurable: true, writable: true });
      console.log = orig;
    }
    const jsonLines = logs.filter((l) => l.trim().startsWith("{"));
    expect(jsonLines.join("\n")).toContain('"status":"success"');
    expect(jsonLines.join("\n")).toContain('"newVersion":"3.5.0"');
    expect(jsonLines.join("\n")).toContain('"scope":"global"');
    expect(spawnedCommand).toBe("npm install -g @netrunner714/pegas@3.5.0");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("handleUpgrade: уже актуальна — up-to-date без спавна", async () => {
    const dir = await fakeGlobal("3.5.0");
    const origFetch = mockFetch("3.5.0");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      spawnedCommand = "";
      await handleUpgrade({ globalDir: dir, ...NO_INSTALL, json: true, noExit: true });
    } finally {
      Object.defineProperty(globalThis, "fetch", { value: origFetch, configurable: true, writable: true });
      console.log = orig;
    }
    expect(logs.join("\n")).toContain('"status":"up-to-date"');
    expect(spawnedCommand).toBe("");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("handleUpgrade: глобальный pegas не установлен — понятная ошибка", async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await handleUpgrade({ globalDir: "/tmp/pegas-upgrade-missing-xyz", ...NO_INSTALL, json: false, noExit: true });
    } finally {
      console.error = orig;
    }
    expect(errors.join("\n")).toContain("глобальный pegas не установлен");
    expect(errors.join("\n")).toContain("bun add -g @netrunner714/pegas");
  });

  it("handleUpgrade: dev-линк — отказ с подсказкой про checkout", async () => {
    const real = await fakeGlobal("3.4.0");
    const link = path.join(os.tmpdir(), "pegas-upg-link-" + Date.now());
    await fs.symlink(real, link);
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await handleUpgrade({ globalDir: link, ...NO_INSTALL, json: false, noExit: true });
    } finally {
      console.error = orig;
      await fs.rm(link, { force: true });
      await fs.rm(real, { recursive: true, force: true });
    }
    expect(errors.join("\n")).toContain("dev-линк");
  });

  it("detectGlobalInstallation: находит fake-установку и её версию", async () => {
    const dir = await fakeGlobal("3.4.0");
    try {
      const found = await detectGlobalInstallation({ globalDir: dir, npmRoot: "/tmp/pegas-upgrade-no-npm", homeDir: "/tmp/pegas-upgrade-no-home" });
      expect(found?.version).toBe("3.4.0");
      expect(found?.linked).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
