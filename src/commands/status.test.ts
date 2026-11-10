import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  handleStatus,
  parseCaddyProjectFile,
  matchContainerForRoute,
  formatDockerStatus,
  resolveInfraEndpoint,
} from "./status.js";

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

  it("matchContainerForRoute сопоставляет по меткам, а не по эвристике имён (issue #9)", () => {
    const containers = [
      {
        id: "1",
        name: "/proj1_web_1",
        image: "app:latest",
        state: "running",
        status: "Up 2 hours",
        networks: ["pegas-network"],
        ports: "3000",
        composeProject: "proj1",
        composeService: "web",
      },
      {
        id: "2",
        name: "/pegas-myapp-api-production-abc123",
        image: "api:latest",
        state: "running",
        status: "Up",
        networks: ["pegas-network"],
        ports: "",
        pegasProject: "abc123",
        pegasProjectName: "myapp",
        pegasScenario: "production",
        pegasService: "api",
      },
      {
        id: "3",
        name: "/pegas-myapp-db-development-abc123",
        image: "postgres:18",
        state: "running",
        status: "Up",
        networks: ["pegas-network"],
        ports: "5432",
        pegasProject: "abc123",
        pegasProjectName: "myapp",
        pegasScenario: "development",
        pegasService: "db",
      },
    ];

    // Host-маршруты (driver: bun) не имеют контейнера
    expect(matchContainerForRoute("host.docker.internal:3000", "proj1", containers)).toBeUndefined();
    expect(matchContainerForRoute("127.0.0.1:3000", "proj1", containers)).toBeUndefined();
    expect(matchContainerForRoute("localhost:3000", "proj1", containers)).toBeUndefined();

    // 1. Метки Pegas + метаданные маршрута (точный путь)
    expect(matchContainerForRoute("x:1", "myapp", containers, { service: "api", env: "production" })?.id).toBe("2");

    // 2. Сетевой алиас <runtimeId>-<scenario>-<service> сверяется с тройкой меток
    expect(matchContainerForRoute("abc123-development-db:5432", "myapp", containers)?.id).toBe("3");

    // 3. Метки compose (контейнеры не из манифеста v3)
    expect(matchContainerForRoute("web:3000", "proj1", containers)?.id).toBe("1");

    // Критерий приёмки #9: отсутствующий сервис НЕ сопоставляется с контейнером другого проекта
    expect(matchContainerForRoute("web:3000", "other", containers)).toBeUndefined();
    expect(matchContainerForRoute("api:8000", "myapp", containers, { service: "api", env: "development" })).toBeUndefined();
    // Имя сервиса из другого проекта не матчится: сервис 'db' есть только в myapp/development
    expect(matchContainerForRoute("db:5432", "other", containers, { service: "db", env: "development" })).toBeUndefined();
  });

  it("formatDockerStatus formats various container states and host dev properly", () => {
    // Undefined container with host upstream
    const hostRes = formatDockerStatus(undefined, "host.docker.internal:3000");
    expect(hostRes.state).toBe("host");
    expect(hostRes.statusText).toBe("Host (dev)");

    // Undefined container with regular upstream
    const notStarted = formatDockerStatus(undefined, "web:3000");
    expect(notStarted.state).toBe("stopped");
    expect(notStarted.statusText).toBe("Not started");

    // Running healthy
    const healthy = formatDockerStatus({ state: "running", status: "Up 1 hour (healthy)" } as any);
    expect(healthy.state).toBe("running");
    expect(healthy.statusText).toBe("Up (healthy)");

    // Running unhealthy
    const unhealthy = formatDockerStatus({ state: "running", status: "Up 1 hour (unhealthy)" } as any);
    expect(unhealthy.state).toBe("running");
    expect(unhealthy.statusText).toBe("Up (unhealthy)");

    // Running starting
    const starting = formatDockerStatus({ state: "running", status: "Up 10 seconds (health: starting)" } as any);
    expect(starting.state).toBe("running");
    expect(starting.statusText).toBe("Up (starting)");

    // Running plain Up
    const plainUp = formatDockerStatus({ state: "running", status: "Up 5 minutes" } as any);
    expect(plainUp.state).toBe("running");
    expect(plainUp.statusText).toBe("Up (5 minutes)");

    // Restarting
    const restarting = formatDockerStatus({ state: "restarting", status: "Restarting (1) 2s ago" } as any);
    expect(restarting.state).toBe("restarting");

    // Exited
    const exited = formatDockerStatus({ state: "exited", status: "Exited (0) 5 minutes ago" } as any);
    expect(exited.state).toBe("exited");
    expect(exited.statusText).toBe("Exited (0) 5 minutes ago");
  });

  it("resolveInfraEndpoint returns appropriate endpoints from labels or fallbacks", () => {
    // 1. pegasEndpoint label
    expect(
      resolveInfraEndpoint(
        { pegasEndpoint: "custom.redis.com:6379" } as any,
        "myproj",
        "redis",
        "6379->6379"
      )
    ).toBe("custom.redis.com:6379");

    // 2. pegasDomains label with host port
    expect(
      resolveInfraEndpoint(
        { pegasDomains: "pg.example.com, alt.example.com" } as any,
        "myproj",
        "db",
        "5432->5432"
      )
    ).toBe("pg.example.com:5432");

    // 3. pegasDomains without port
    expect(
      resolveInfraEndpoint(
        { pegasDomains: "pg.example.com" } as any,
        "myproj",
        "db",
        "-"
      )
    ).toBe("pg.example.com");

    // 4. Порт проброшен на хост, меток нет: фактический адрес, а не выдуманный
    //    домен (issue #30: `<svc>.<proj>.localhost` не существует ни в DNS, ни в Caddy)
    expect(
      resolveInfraEndpoint(
        {} as any,
        "myproj",
        "redis",
        "6379->6379"
      )
    ).toBe("localhost:6379");

    // 5. Порт не проброшен: сервис доступен только внутри сети pegas-network
    expect(
      resolveInfraEndpoint(
        {} as any,
        "myproj",
        "redis",
        "-"
      )
    ).toBe("(internal)");
  });
});
