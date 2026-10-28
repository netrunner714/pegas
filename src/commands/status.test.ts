import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { handleStatus } from "./status.js";

describe("pegas status", () => {
  it("handleStatus outputs json payload with docker and gateway status", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-status-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    // Mock a route file
    await fs.writeFile(path.join(confDir, "app.ru.caddy"), "app.ru { reverse_proxy web:3000 }\n");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleStatus({
        gatewayDir: tmpGateway,
        json: true,
      });
    } finally {
      console.log = origLog;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    expect(logs.length).toBe(1);
    const res = JSON.parse(logs[0]);
    expect(res.gatewayDir).toBe(tmpGateway);
    expect(res.activeRoutesCount).toBe(1);
    expect(res.network.name).toBe("pegas-network");
    expect(typeof res.docker).toBe("boolean");
    expect(typeof res.compose).toBe("boolean");
  });

  it("handleStatus outputs formatted terminal report", async () => {
    const tmpGateway = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gw-status-"));
    const confDir = path.join(tmpGateway, "conf.d");
    await fs.mkdir(confDir, { recursive: true });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await handleStatus({
        gatewayDir: tmpGateway,
        json: false,
      });
    } finally {
      console.log = origLog;
      await fs.rm(tmpGateway, { recursive: true, force: true });
    }

    const output = logs.join("\n");
    expect(output).toContain("Pegas Gateway Status");
    expect(output).toContain("Docker Engine");
    expect(output).toContain("Gateway Location");
  });
});
