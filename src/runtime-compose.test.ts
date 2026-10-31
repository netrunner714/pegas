import { describe, it, expect } from "bun:test";
import path from "node:path";
import { createRuntimeCompose } from "./runtime-compose.js";
import { PegasContract } from "./types.js";

describe("declarative runtime Compose generation", () => {
  const contract: PegasContract = {
    projectName: "shop",
    runtime: "docker",
    services: {
      web: {
        role: "app",
        domains: {},
        build: { context: ".", dockerfile: "Dockerfile.dev" },
        command: ["pnpm", "dev", "--host", "0.0.0.0"],
        port: 3000,
        env: { NODE_ENV: "development" },
        envFile: ".env.local",
        hmr: { fileWatch: "polling" },
      },
      postgres: {
        role: "infra",
        image: "postgres:17",
        port: 5432,
      },
    },
  };

  it("generates an ephemeral JSON/YAML manifest with project-scoped network aliases", () => {
    const result = createRuntimeCompose(contract, {
      projectRoot: "/work/apps/shop",
      projectId: "shop-a1b2c3d4e5f6",
    });
    const parsed = JSON.parse(result.content);

    expect(parsed.services.web.build.context).toBe(path.resolve("/work/apps/shop", "."));
    expect(parsed.services.web.build.dockerfile).toBe("Dockerfile.dev");
    expect(parsed.services.web.command).toEqual(["pnpm", "dev", "--host", "0.0.0.0"]);
    expect(parsed.services.web.expose).toEqual(["3000"]);
    expect(parsed.services.web.ports).toBeUndefined();
    expect(parsed.services.web.environment).toEqual({ NODE_ENV: "development" });
    expect(parsed.services.web.env_file).toEqual([path.resolve("/work/apps/shop", ".env.local")]);
    expect(parsed.services.web.networks["pegas-network"].aliases).toEqual([
      "shop-a1b2c3d4e5f6-web",
    ]);
    expect(parsed.services.postgres.image).toBe("postgres:17");
    expect(parsed.services.postgres.volumes).toBeUndefined();
    expect(parsed.networks["pegas-network"]).toEqual({
      external: true,
      name: "pegas-network",
    });
  });

  it("isolates app source and node_modules while leaving infrastructure unmounted", () => {
    const result = createRuntimeCompose(contract, {
      projectRoot: "/work/apps/shop",
      projectId: "shop-a1b2c3d4e5f6",
    });
    const parsed = JSON.parse(result.content);
    const appVolumes: string[] = parsed.services.web.volumes;

    expect(appVolumes).toContain("/work/apps/shop:/workspace");
    expect(appVolumes).toContain(
      "pegas-shop-a1b2c3d4e5f6-web-node-modules:/workspace/node_modules"
    );
    expect(parsed.services.web.working_dir).toBe("/workspace");
    expect(parsed.volumes["pegas-shop-a1b2c3d4e5f6-web-node-modules"]).toEqual({});
    expect(parsed.services.postgres.working_dir).toBeUndefined();
  });

  it("produces stable per-service hashes independent of checkout path", () => {
    const first = createRuntimeCompose(contract, {
      projectRoot: "/work/apps/shop",
      projectId: "shop-one",
    });
    const second = createRuntimeCompose(contract, {
      projectRoot: "/other/checkout/shop",
      projectId: "shop-two",
    });
    expect(first.serviceHashes).toEqual(second.serviceHashes);
  });

  it("rejects app services without an explicit image or build until stack defaults exist", () => {
    const invalid: PegasContract = {
      runtime: "docker",
      services: { web: { role: "app", port: 3000, domains: {} } },
    };
    expect(() =>
      createRuntimeCompose(invalid, {
        projectRoot: "/work/apps/shop",
        projectId: "shop-one",
      })
    ).toThrow("has no build or image");
  });
});
