import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleDisconnect } from "./disconnect.js";

describe("pegas disconnect v3", () => {
  it("удаляет route-файл проекта и рапортует в json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-disc-"));
    await fs.writeFile(path.join(dir, "pegas.json"), JSON.stringify({ projectName: "my-app" }));
    const gwDir = path.join(dir, "gateway");
    await fs.mkdir(path.join(gwDir, "conf.d"), { recursive: true });
    await fs.writeFile(path.join(gwDir, "Caddyfile"), "import conf.d/*.caddy\n");
    await fs.writeFile(path.join(gwDir, "docker-compose.yml"), "services: {}\n");
    await fs.writeFile(path.join(gwDir, "conf.d", "my-app-development.caddy"), "# routes\n");

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await handleDisconnect({ cwd: dir, gatewayDir: gwDir, noExit: true, json: true });
    } finally {
      console.log = orig;
    }
    const jsonLines = logs.filter((l) => l.trim().startsWith("{"));
    const out = JSON.parse(jsonLines[jsonLines.length - 1]);
    expect(out.status).toBe("disconnected");
    expect(String(out.removedRouteFile)).toContain("my-app-development.caddy");
    expect(await fs.access(path.join(gwDir, "conf.d", "my-app-development.caddy")).then(() => true, () => false)).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("проект без route-файла: тихий сценарий, не ошибка", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-disc2-"));
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await handleDisconnect({ cwd: dir, gatewayDir: path.join(dir, "gw"), noExit: true, json: true });
    } finally {
      console.log = orig;
    }
    const jsonLines = logs.filter((l) => l.trim().startsWith("{"));
    const out = JSON.parse(jsonLines[jsonLines.length - 1]);
    expect(out.status).toBe("disconnected");
    expect(out.removedRouteFile).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
