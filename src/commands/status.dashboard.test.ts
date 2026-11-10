import { describe, it, expect } from "bun:test";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  matchContainerForRoute,
  parseCaddyProjectFile,
  inferServiceFromDomain,
  inferServiceFromUpstream,
  probeTcpPort,
  firstHostPort,
  shortEnv,
  formatUptime,
  formatMemUsage,
  type DockerContainerInfo,
} from "./status.js";

/**
 * Issue #9: сопоставление маршрутов с контейнерами по меткам Pegas.
 *
 * Критерии приёмки issue:
 * - тесты покрывают несколько проектов, сценариев и сервисов с одинаковыми именами;
 * - статус корректно показывает running/stopped/missing;
 * - отсутствующий контейнер не сопоставляется с контейнером другого проекта.
 */

/** Фабрика контейнера с метками Pegas v3 (те, что ставит генератор манифеста). */
function labeled(
  over: Partial<DockerContainerInfo> & { id: string; pegasProject: string; pegasProjectName: string; pegasScenario: string; pegasService: string }
): DockerContainerInfo {
  return {
    name: `pegas-${over.pegasProjectName}-${over.pegasService}-${over.pegasScenario}-${over.pegasProject}`,
    image: "img:latest",
    state: "running",
    status: "Up 2 hours (healthy)",
    networks: ["pegas-network"],
    ports: "",
    composeProject: `pegas-${over.pegasProjectName}-${over.pegasScenario}-${over.pegasProject}`,
    composeService: over.pegasService,
    ...over,
  } as DockerContainerInfo;
}

describe("issue #9: сопоставление по меткам, несколько проектов и сценариев", () => {
  // Три проекта, в каждом сервис с именем "db"; два сценария — одинаковые имена
  // сервисов обязаны различаться метками, а не совпадать по подстроке имени.
  const containers: DockerContainerInfo[] = [
    labeled({ id: "a-dev", pegasProject: "aaa111", pegasProjectName: "alpha", pegasScenario: "development", pegasService: "db" }),
    labeled({ id: "a-prod", pegasProject: "aaa111", pegasProjectName: "alpha", pegasScenario: "production", pegasService: "db" }),
    labeled({ id: "b-dev", pegasProject: "bbb222", pegasProjectName: "beta", pegasScenario: "development", pegasService: "db" }),
    labeled({ id: "b-web", pegasProject: "bbb222", pegasProjectName: "beta", pegasScenario: "development", pegasService: "web" }),
    labeled({ id: "c-dev", pegasProject: "ccc333", pegasProjectName: "gamma", pegasScenario: "development", pegasService: "api" }),
  ];

  it("одноимённые сервисы разных проектов различаются (критерий приёмки #9)", () => {
    expect(matchContainerForRoute("aaa111-development-db:5432", "alpha", containers, { service: "db", env: "development" })?.id).toBe("a-dev");
    expect(matchContainerForRoute("bbb222-development-db:5432", "beta", containers, { service: "db", env: "development" })?.id).toBe("b-dev");
  });

  it("сценарии одного проекта различаются: development ≠ production", () => {
    expect(matchContainerForRoute("aaa111-production-db:5432", "alpha", containers, { service: "db", env: "production" })?.id).toBe("a-prod");
    expect(matchContainerForRoute("aaa111-development-db:5432", "alpha", containers, { service: "db", env: "development" })?.id).toBe("a-dev");
  });

  it("отсутствующий сервис НЕ сопоставляется с контейнером другого проекта", () => {
    // 'web' есть только в beta; в alpha его нет — матчинг обязан вернуть undefined
    expect(matchContainerForRoute("aaa111-development-web:3000", "alpha", containers, { service: "web", env: "development" })).toBeUndefined();
    // проект, которого вообще нет среди контейнеров
    expect(matchContainerForRoute("zzz-development-db:5432", "delta", containers, { service: "db", env: "development" })).toBeUndefined();
    // имя сервиса чужого проекта не должно «перетекать»
    expect(matchContainerForRoute("ccc333-development-api:80", "alpha", containers, { service: "api", env: "development" })).toBeUndefined();
  });

  it("upstream-алиас без метаданных маршрута матчится по тройке меток", () => {
    // route-файлы, записанные до появления строки `# pegas:...`
    expect(matchContainerForRoute("bbb222-development-web:80", "beta", containers)?.id).toBe("b-web");
    expect(matchContainerForRoute("ccc333-development-api:80", "gamma", containers)?.id).toBe("c-dev");
  });

  it("сценарий с дефисом в имени не ломает разбор алиаса", () => {
    const withDash: DockerContainerInfo[] = [
      labeled({ id: "d1", pegasProject: "ddd444", pegasProjectName: "delta", pegasScenario: "pre-prod", pegasService: "db" }),
    ];
    // Имя сервиса и сценарий содержат дефисы: прежнее разбиение по дефису было неоднозначным,
    // сверка с тройкой меток целиком — однозначна.
    expect(matchContainerForRoute("ddd444-pre-prod-db:5432", "delta", withDash)?.id).toBe("d1");
    // Чужой сценарий того же проекта не матчится
    expect(matchContainerForRoute("ddd444-prod-db:5432", "delta", withDash)).toBeUndefined();
  });

  it("контейнеры compose без меток Pegas матчатся по compose-меткам", () => {
    const legacy: DockerContainerInfo[] = [
      {
        id: "l1", name: "/proj1_web_1", image: "app:latest", state: "running", status: "Up",
        networks: ["pegas-network"], ports: "3000", composeProject: "proj1", composeService: "web",
      },
    ];
    expect(matchContainerForRoute("web:3000", "proj1", legacy)?.id).toBe("l1");
    expect(matchContainerForRoute("web:3000", "other", legacy)).toBeUndefined();
  });

  it("host-маршруты (driver: bun) не имеют контейнера", () => {
    for (const up of ["host.docker.internal:3000", "127.0.0.1:3000", "localhost:3000"]) {
      expect(matchContainerForRoute(up, "alpha", containers, { service: "db", env: "development" })).toBeUndefined();
    }
  });

  it("регистр имён не влияет на сопоставление", () => {
    expect(matchContainerForRoute("x:1", "ALPHA", containers, { service: "DB", env: "DEVELOPMENT" })?.id).toBe("a-dev");
  });
});

describe("issue #30: разбор route-файла с метаданными", () => {
  it("строка `# pegas:...` даёт точные сервис, сценарий и проект", () => {
    const content = [
      "# Auto-generated by Pegas for project: demo [development]",
      "# pegas:project=demo | service=booking-client | env=development | driver=bun | owner=connect | port=3001",
      "booking.demo.localhost {",
      "    reverse_proxy host.docker.internal:3001",
      "}",
    ].join("\n");
    const routes = parseCaddyProjectFile(content, "demo-development.caddy");
    expect(routes.length).toBe(1);
    expect(routes[0].projectName).toBe("demo");
    expect(routes[0].service).toBe("booking-client");
    expect(routes[0].serviceSource).toBe("meta");
    expect(routes[0].env).toBe("development");
    expect(routes[0].meta?.driver).toBe("bun");
    expect(routes[0].meta?.port).toBe(3001);
  });

  it("legacy-файл без метаданных: имя сервиса выводится из домена, сценарий — из имени файла", () => {
    const content = [
      "# Auto-generated by Pegas for project: 815records [development]",
      "site.815records.localhost {",
      "    reverse_proxy host.docker.internal:3000",
      "}",
    ].join("\n");
    const routes = parseCaddyProjectFile(content, "815records-development.caddy");
    expect(routes[0].projectName).toBe("815records");
    expect(routes[0].service).toBe("site");
    expect(routes[0].serviceSource).toBe("inferred");
    expect(routes[0].env).toBe("development");
  });

  it("файл без шапки Pegas: сценарий отсекается от имени проекта по белому списку", () => {
    const content = "app.exogram.localhost {\n    reverse_proxy host.docker.internal:3100\n}\n";
    const routes = parseCaddyProjectFile(content, "exogram-development.caddy");
    // Прежнее поведение давало projectName "exogram-development" и service "host.docker.internal"
    expect(routes[0].projectName).toBe("exogram");
    expect(routes[0].env).toBe("development");
    expect(routes[0].service).toBe("app");
    expect(routes[0].service).not.toBe("host.docker.internal");
  });

  it("суффикс вне белого списка не отсекается: имя проекта с дефисом сохраняется", () => {
    const content = "web.my-app.caddy.localhost {\n    reverse_proxy host.docker.internal:3000\n}\n";
    const routes = parseCaddyProjectFile(content, "my-app-tools.caddy");
    expect(routes[0].projectName).toBe("my-app-tools");
  });

  it("SPA-маршрут с несколькими reverse_proxy даёт одну строку, а не дубли", () => {
    const content = [
      "# pegas:project=demo | service=web | env=development | driver=docker | owner=deploy",
      "app.demo.localhost {",
      "    handle /api/* {",
      "        reverse_proxy abc123-development-api:8000",
      "    }",
      "    handle {",
      "        reverse_proxy abc123-development-web:3000",
      "    }",
      "}",
    ].join("\n");
    const routes = parseCaddyProjectFile(content, "demo-development.caddy");
    expect(routes.length).toBe(1);
    expect(routes[0].upstream).toBe("abc123-development-api:8000");
  });

  it("www-редирект добавляется к доменам, но не порождает отдельный маршрут", () => {
    const content = [
      "www.example.com {",
      "    redir https://example.com{uri} permanent",
      "}",
      "",
      "# pegas:project=example | service=web | env=production | driver=docker | owner=deploy",
      "example.com {",
      "    reverse_proxy abc-production-web:80",
      "}",
    ].join("\n");
    const routes = parseCaddyProjectFile(content, "example.caddy");
    expect(routes.length).toBe(1);
    expect(routes[0].domains).toEqual(["example.com", "www.example.com"]);
  });

  it("несколько блоков в одном файле: каждый получает свои метаданные", () => {
    const content = [
      "# pegas:project=demo | service=site | env=development | driver=bun | owner=connect | port=3000",
      "site.demo.localhost {",
      "    reverse_proxy host.docker.internal:3000",
      "}",
      "",
      "# pegas:project=demo | service=worker | env=development | driver=docker | owner=deploy | port=3200",
      "worker.demo.localhost {",
      "    reverse_proxy abc123-development-worker:3200",
      "}",
    ].join("\n");
    const routes = parseCaddyProjectFile(content, "demo-development.caddy");
    expect(routes.length).toBe(2);
    const byService = Object.fromEntries(routes.map((r) => [r.service, r]));
    expect(byService.site.meta?.driver).toBe("bun");
    expect(byService.worker.meta?.driver).toBe("docker");
    expect(byService.worker.meta?.port).toBe(3200);
  });
});

describe("issue #30: вывод имени сервиса", () => {
  it("dev-домен Pegas `<service>.<project>.localhost` разбирается точно", () => {
    expect(inferServiceFromDomain("booking.demo-app.localhost", "demo-app")).toBe("booking");
    expect(inferServiceFromDomain("site.815records.localhost", "815records")).toBe("site");
  });

  it("произвольный домен: первая метка как приближение, www отбрасывается", () => {
    expect(inferServiceFromDomain("api.example.com", "example")).toBe("api");
    expect(inferServiceFromDomain("www.example.com", "example")).toBe("example");
  });

  it("пустой домен не даёт имени", () => {
    expect(inferServiceFromDomain("", "p")).toBe("");
  });

  it("upstream-вывод: имя сервиса — последняя часть алиаса", () => {
    expect(inferServiceFromUpstream("abc123-development-worker:3200")).toBe("worker");
    expect(inferServiceFromUpstream("host.docker.internal:3000")).toBe("");
  });
});

describe("issue #30: реальный TCP-пробник host-процесса", () => {
  it("порт со слушающим сервером определяется как живой", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      await expect(probeTcpPort(port, "127.0.0.1", 500)).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("закрытый порт определяется как offline (ECONNREFUSED)", async () => {
    // Занимаем порт, закрываем — гарантированно свободный адрес для отказа.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(probeTcpPort(port, "127.0.0.1", 500)).resolves.toBe(false);
  });

  it("некорректный порт не роняет status и не подключается", async () => {
    await expect(probeTcpPort(0)).resolves.toBe(false);
    await expect(probeTcpPort(-1)).resolves.toBe(false);
    await expect(probeTcpPort(99999)).resolves.toBe(false);
    await expect(probeTcpPort(Number.NaN)).resolves.toBe(false);
  });

  it("таймаут не даёт зависнуть: нерезолвящийся адрес завершается быстро", async () => {
    const started = Date.now();
    // 10.255.255.1 обычно маршрутизируется в никуда — проверка именно таймаута.
    const result = await probeTcpPort(9, "10.255.255.1", 120);
    expect(result).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("issue #30: форматирование колонок дашборда", () => {
  it("firstHostPort вытаскивает хостовый порт из строки ports", () => {
    // Реальные форматы `docker ps --format '{{.Ports}}'`
    expect(firstHostPort("0.0.0.0:5432->5432/tcp")).toBe("5432");
    expect(firstHostPort("[::]:5432->5432/tcp")).toBe("5432");
    expect(firstHostPort("0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp")).toBe("5432");
    expect(firstHostPort("0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/udp, 2019/tcp")).toBe("80");
    expect(firstHostPort("-")).toBe("");
    expect(firstHostPort(undefined)).toBe("");
  });

  it("expose без публикации не даёт хост-порта: эндпоинт остаётся внутренним", () => {
    // `5432/tcp` — порт доступен только внутри сети pegas-network; прежняя
    // реализация вернула бы "5432" и дашборд пообещал бы localhost:5432
    expect(firstHostPort("5432/tcp")).toBe("");
    expect(firstHostPort("2019/tcp")).toBe("");
  });

  it("shortEnv сокращает имена сценариев для узкой колонки", () => {
    expect(shortEnv("development")).toBe("dev");
    expect(shortEnv("production")).toBe("prod");
    expect(shortEnv("staging")).toBe("stage");
    expect(shortEnv("pre-prod")).toBe("pre-prod");
  });

  it("formatUptime сжимает RunningFor до компактной формы", () => {
    expect(formatUptime("2 hours ago")).toBe("2h");
    expect(formatUptime("3 days ago")).toBe("3d");
    expect(formatUptime("45 minutes ago")).toBe("45m");
    expect(formatUptime(undefined)).toBe("-");
    expect(formatUptime("неизвестно")).toBe("-");
  });

  it("formatMemUsage оставляет использованную память без лимита хоста", () => {
    expect(formatMemUsage("31.16MiB / 7.734GiB")).toBe("31.16MiB");
    expect(formatMemUsage(undefined)).toBe("-");
  });
});

describe("issue #30: JSON-дашборд", () => {
  it("handleStatus выдаёт services, projects (совместимость) и issues", async () => {
    const gw = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-status-dash-"));
    const confDir = path.join(gw, "conf.d");
    await fs.mkdir(confDir, { recursive: true });
    await fs.writeFile(
      path.join(confDir, "demo-development.caddy"),
      [
        "# Auto-generated by Pegas for project: demo [development]",
        "# pegas:project=demo | service=site | env=development | driver=bun | owner=connect | port=3000",
        "site.demo.localhost {",
        "    reverse_proxy host.docker.internal:3000",
        "}",
      ].join("\n") + "\n"
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await (await import("./status.js")).handleStatus({ gatewayDir: gw, json: true, skipProbes: true });
    } finally {
      console.log = origLog;
      await fs.rm(gw, { recursive: true, force: true });
    }

    const payload = JSON.parse(logs[0]);
    // Единый дашборд: сервис — единица вывода
    expect(Array.isArray(payload.services)).toBe(true);
    const site = payload.services.find((s: any) => s.project === "demo" && s.service === "site");
    expect(site).toBeDefined();
    expect(site.driver).toBe("bun");
    expect(site.env).toBe("development");
    expect(site.gateway).toBe("linked");
    expect(site.domains).toContain("site.demo.localhost");
    // Обратная совместимость: прежняя форма списка маршрутов сохранена (e2e читает projects)
    expect(Array.isArray(payload.projects)).toBe(true);
    expect(payload.activeRoutesCount).toBe(1);
    expect(payload.network.name).toBe("pegas-network");
  });
});
