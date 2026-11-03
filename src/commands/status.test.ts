import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { handleStatus, parseCaddyProjectFile } from "./status.js";

describe("pegas status", () => {
  it("parses caddyfile with nested handle and cors blocks accurately", () => {
    const caddyContent = `
api.example.com {
    @cors_preflight {
        method OPTIONS
    }
    handle @cors_preflight {
        respond "" 204
    }
    handle {
        reverse_proxy host.docker.internal:3001 {
            header_down -Access-Control-Allow-Origin
        }
    }
}
site.example.com {
    reverse_proxy host.docker.internal:3000
}
`;
    const routes = parseCaddyProjectFile(caddyContent, "example-development.caddy");
    expect(routes.length).toBe(2);
    expect(routes[0].domains).toEqual(["api.example.com"]);
    expect(routes[0].upstream).toBe("host.docker.internal:3001");
    expect(routes[1].domains).toEqual(["site.example.com"]);
    expect(routes[1].upstream).toBe("host.docker.internal:3000");
  });
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
