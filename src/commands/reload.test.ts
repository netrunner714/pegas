import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { handleReload } from "./reload.js";

describe("pegas reload", () => {
  it("handleReload handles validation failure cleanly when exitOnError is false", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-reload-"));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      const ok = await handleReload({
        gatewayDir: tmpGateway,
        json: true,
        exitOnError: false,
        silent: true,
      });
      // In unit test without docker caddy running, validation fails
      expect(ok).toBe(false);
    } finally {
      console.log = origLog;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    const res = JSON.parse(logs[0]);
    expect(res.error).toBe("Validation failed");
  });
});
