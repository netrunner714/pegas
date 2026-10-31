import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import child_process from "node:child_process";
import path from "node:path";
import { createRuntimeCompose } from "./runtime-compose.js";
import { PegasContract } from "./types.js";

describe("declarative runtime Compose generation", () => {
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pegas-test-"));
    fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "shop",
      scripts: { dev: "pnpm dev", start: "pnpm start" },
      packageManager: "pnpm@9.0.0",
    }));
    fs.writeFileSync(path.join(projectRoot, "Dockerfile.dev"), "FROM node:24\n");
    fs.writeFileSync(path.join(projectRoot, ".dockerignore"), "node_modules\n");
    fs.writeFileSync(path.join(projectRoot, ".env.local"), "SECRET=1\n");
    fs.writeFileSync(path.join(projectRoot, ".gitignore"), ".env.local\n");
    child_process.execFileSync("git", ["init", "-q"], { cwd: projectRoot });
  });

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
        domains: {},
        image: "postgres:17",
        port: 5432,
      },
    },
  };

  it("generates an ephemeral JSON/YAML manifest with project-scoped network aliases", () => {
    const result = createRuntimeCompose(contract, {
      projectRoot,
      projectId: "shop-a1b2c3d4e5f6",
    });
    const parsed = JSON.parse(result.content);

    expect(parsed.name).toBe("pegas-shop-a1b2c3d4e5f6-development");
    expect(parsed.services.web.build.context).toBe(path.resolve(projectRoot, "."));
    expect(parsed.services.web.build.dockerfile).toBe("Dockerfile.dev");
    expect(parsed.services.web.command).toEqual(["pnpm", "dev", "--host", "0.0.0.0"]);
    expect(parsed.services.web.expose).toEqual(["3000"]);
    expect(parsed.services.web.ports).toBeUndefined();
    expect(parsed.services.web.environment).toEqual({
      NODE_ENV: "development",
      PEGAS_ENV: "development",
      CHOKIDAR_USEPOLLING: "true",
      WATCHPACK_POLLING: "true",
    });
    expect(parsed.services.web.env_file).toEqual([path.resolve(projectRoot, ".env.local")]);
    expect(parsed.services.web.networks["pegas-network"].aliases).toEqual([
      "shop-a1b2c3d4e5f6-development-web",
    ]);
    expect(parsed.services.web.labels["pegas.environment"]).toBe("development");
    expect(parsed.services.postgres.image).toBe("postgres:17");
    expect(parsed.services.postgres.volumes).toBeUndefined();
    expect(parsed.networks["pegas-network"]).toEqual({
      external: true,
      name: "pegas-network",
    });
  });

  it("isolates app source and node_modules while leaving infrastructure unmounted", () => {
    const result = createRuntimeCompose(contract, {
      projectRoot,
      projectId: "shop-a1b2c3d4e5f6",
    });
    const parsed = JSON.parse(result.content);
    const appVolumes = parsed.services.web.volumes as Array<Record<string, unknown> | string>;

    expect(appVolumes).toContainEqual({
      type: "bind",
      source: projectRoot,
      target: "/workspace",
      bind: { create_host_path: true },
    });
    expect(appVolumes).toContain(
      "pegas-shop-a1b2c3d4e5f6-web-development-dependencies:/workspace/node_modules"
    );
    expect(parsed.services.web.working_dir).toBe("/workspace");
    expect(parsed.volumes["pegas-shop-a1b2c3d4e5f6-web-development-dependencies"]).toEqual({});
    expect(parsed.services.postgres.working_dir).toBeUndefined();
  });

  it("produces stable per-service hashes independent of checkout path", () => {
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pegas-test2-"));
    fs.cpSync(projectRoot, secondRoot, { recursive: true });
    // check-ignore must pass for envFile in the second checkout too.
    child_process.execFileSync("git", ["init", "-q"], { cwd: secondRoot });
    const first = createRuntimeCompose(contract, {
      projectRoot,
      projectId: "shop-one",
    });
    const second = createRuntimeCompose(contract, {
      projectRoot: secondRoot,
      projectId: "shop-two",
    });
    expect(first.serviceHashes).toEqual(second.serviceHashes);
  });

  it("resolves a default stack image for app services without an explicit image or build", () => {
    const contractless: PegasContract = {
      runtime: "docker",
      services: { web: { role: "app", port: 3000, domains: {} } },
    };
    const result = createRuntimeCompose(contractless, {
      projectRoot,
      projectId: "shop-one",
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.services.web.image).toContain("pegas/shop-one/web:");
    expect(parsed.services.web.build.dockerfile_inline).toContain("FROM node:");
    expect(parsed.services.web.labels["pegas.role"]).toBe("app");
  });
});
