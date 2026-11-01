import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { VERSION } from "./version.js";
import {
  setupProjectContract,
  reconcileContract,
  updatePackageJson,
  upgradePackageJson,
  slugify,
  detectProjectSlug,
  normalizeDomain,
  toAsciiDomain,
  detectComposeWebService,
  createDefaultContract,
  CONTRACT_FILENAME,
  CONTRACT_SCHEMA_URL,
  validatePegasContract,
  getProjectRuntimeId,
} from "./contract.js";
import { getRouteFilePath } from "./gateway.js";

describe("contract & package.json integration", () => {
  it("keeps legacy contracts valid and validates opt-in Docker contract fields", () => {
    const legacy = {
      projectName: "legacy-app",
      services: { web: { port: 3000, domains: { development: ["legacy.localhost"] } } },
    };
    expect(validatePegasContract(legacy)).toEqual([]);

    const docker = {
      ...legacy,
      runtime: "docker",
      services: {
        web: {
          ...legacy.services.web,
          role: "app",
          build: { context: ".", dockerfile: "Dockerfile" },
          command: ["npm", "run", "dev"],
          env: { NODE_ENV: "development" },
          envFile: ".env.local",
          volumes: ["pegas-web-node-modules:/app/node_modules"],
          bindMount: ".",
          hmr: { fileWatch: "polling" },
        },
        postgres: { role: "infra", image: "postgres:17", port: 5432, domains: {} },
      },
    };
    expect(validatePegasContract(docker)).toEqual([]);
  });

  it("reports precise paths for invalid Docker contract fields", () => {
    const issues = validatePegasContract({
      runtime: "docker",
      services: {
        web: {
          image: "node:24",
          build: { context: "" },
          command: [],
          role: "worker",
          hmr: { fileWatch: "sometimes" },
        },
      },
    });
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain("services.web");
    expect(paths).toContain("services.web.build.context");
    expect(paths).toContain("services.web.command");
    expect(paths).toContain("services.web.role");
    expect(paths).toContain("services.web.hmr.fileWatch");
  });

  it("creates stable checkout-specific runtime identities", () => {
    const first = getProjectRuntimeId("/work/apps/shop", "shop");
    expect(getProjectRuntimeId("/work/apps/shop", "shop")).toBe(first);
    expect(getProjectRuntimeId("/work/apps/shop-copy", "shop")).not.toBe(first);
    expect(first).toMatch(/^shop-[a-f0-9]{12}$/);
  });
  it("toAsciiDomain handles IDN Cyrillic and unicode domains with Punycode", () => {
    expect(toAsciiDomain("россия.рф")).toBe("xn--h1alffa9f.xn--p1ai");
    expect(toAsciiDomain("президент.рф")).toBe("xn--d1abbgf6aiiy.xn--p1ai");
    expect(toAsciiDomain("xn--h1alffa9f.xn--p1ai")).toBe("xn--h1alffa9f.xn--p1ai");
    expect(toAsciiDomain("google.com")).toBe("google.com");

    const filePath = getRouteFilePath("/tmp/gateway", "россия.рф");
    expect(filePath).toContain("xn--h1alffa9f.xn--p1ai.caddy");
  });

  it("normalizeDomain cleans protocol, trailing slashes, paths, and ports", () => {
    expect(normalizeDomain("https://my-site.com/")).toBe("my-site.com");
    expect(normalizeDomain("https://example.com?q=123")).toBe("example.com");
    expect(normalizeDomain("example.com/search?q=123&sort=asc#results")).toBe("example.com");
    expect(normalizeDomain("http://user:pass@api.mysite.com:8080/v1/health?token=xyz")).toBe("api.mysite.com");
    expect(normalizeDomain("  MY-APP.RU:443  ")).toBe("my-app.ru");
    expect(normalizeDomain("sub.domain.com.")).toBe("sub.domain.com");
  });

  it("slugify correctly strips scopes and special characters", () => {
    expect(slugify("@myorg/super-app")).toBe("super-app");
    expect(slugify("My Cool Project!")).toBe("my-cool-project");
    expect(slugify("---test_123---")).toBe("test-123");
    expect(slugify("")).toBe("app");
  });

  it("creates pegas.json contract with smart slug-derived domains from package.json", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-contract-"));
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "@acme/my-awesome-site" }),
      "utf-8"
    );

    const res = await setupProjectContract(tmpDir);

    expect(res.created).toBe(true);
    expect(res.file).toBe("pegas.json");
    expect(res.slug).toBe("my-awesome-site");

    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CONTRACT_FILENAME), "utf-8"));
    expect(content.$schema).toBe(CONTRACT_SCHEMA_URL);
    expect(content.projectName).toBe("my-awesome-site");
    expect(content.devGateway).toEqual({
      httpPort: 80,
      httpsPort: 443,
      skipInstallTrust: false,
      admin: false,
    });
    expect(content.services.web.port).toBe(3000);
    expect(content.services.web.domains.development).toEqual([
      "web.my-awesome-site.localhost",
      "my-awesome-site.localhost",
    ]);
    expect(content.services.web.domains.production).toEqual(["my-awesome-site.com"]);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects existing docker-compose web service and port if present", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-contract-compose-"));
    const composeContent = `services:
  backend:
    build: .
    ports:
      - "8000:8000"
`;
    await fs.writeFile(path.join(tmpDir, "docker-compose.yml"), composeContent, "utf-8");

    const detected = await detectComposeWebService(tmpDir);
    expect(detected).toEqual({ name: "backend", port: "8000" });

    const res = await setupProjectContract(tmpDir);
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CONTRACT_FILENAME), "utf-8"));
    expect(content.services.backend.port).toBe(8000);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates pegas.json contract using directory name fallback if package.json has no name", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-dir-app-"));
    const slug = path.basename(tmpDir).toLowerCase().replace(/[^a-z0-9-]+/g, "-");

    const res = await setupProjectContract(tmpDir);
    expect(res.created).toBe(true);
    expect(res.slug).toBe(slug);

    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CONTRACT_FILENAME), "utf-8"));
    expect(content.projectName).toBe(slug);
    expect(content.services.web.domains.development).toEqual([`web.${slug}.localhost`, `${slug}.localhost`]);
    expect(content.services.web.domains.production).toEqual([`${slug}.com`]);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reconcileContract fills in missing blocks like devGateway while preserving custom fields and services", () => {
    const existing = {
      projectName: "custom-app",
      customField: "preserved",
      services: {
        api: {
          port: 8000,
          domains: { development: ["api.localhost"] },
        },
      },
    };
    const defaultContract = createDefaultContract("slug", "web", 3000);
    const { contract, addedFields } = reconcileContract(existing, defaultContract);

    expect(addedFields).toContain("devGateway");
    expect(addedFields).toContain("$schema");
    expect(contract.$schema).toBe(CONTRACT_SCHEMA_URL);
    expect(contract.projectName).toBe("custom-app");
    expect(contract.services.api.port).toBe(8000);
    expect(contract.services.api.domains.development).toEqual(["api.localhost"]);
    expect((contract as any).customField).toBe("preserved");
    expect(contract.devGateway).toEqual(defaultContract.devGateway);
  });

  it("reconciles existing pegas.json on init, and completely resets on force: true", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-contract-"));
    const custom = {
      projectName: "custom-app",
      custom: "preserved",
      services: { web: { port: 3000, domains: { development: ["custom.localhost"] } } },
    };
    await fs.writeFile(path.join(tmpDir, CONTRACT_FILENAME), JSON.stringify(custom), "utf-8");

    // Soft reconciliation: fills devGateway, preserves custom fields
    const res = await setupProjectContract(tmpDir);
    expect(res.created).toBe(false);
    expect(res.updated).toBe(true);

    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CONTRACT_FILENAME), "utf-8"));
    expect(content.custom).toBe("preserved");
    expect(content.projectName).toBe("custom-app");
    expect(content.services.web.domains.development).toEqual(["custom.localhost"]);
    expect(content.devGateway).toBeDefined();

    // Overwrites when force: true and creates backup
    const forceRes = await setupProjectContract(tmpDir, false, true);
    expect(forceRes.created).toBe(false);
    expect(forceRes.overwritten).toBe(true);
    expect(forceRes.backupFile).toBe("pegas.json.bak");

    const backupContent = JSON.parse(await fs.readFile(path.join(tmpDir, "pegas.json.bak"), "utf-8"));
    expect(backupContent.custom).toBe("preserved");

    const overwrittenContent = JSON.parse(await fs.readFile(path.join(tmpDir, CONTRACT_FILENAME), "utf-8"));
    expect(overwrittenContent.devGateway).toBeDefined();
    expect(overwrittenContent.custom).toBeUndefined();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("wraps dev script, adds deploy script, and adds pegas to devDependencies in package.json", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-pkg-"));
    const initialPkg = {
      name: "my-app",
      scripts: {
        dev: "next dev",
        build: "next build",
      },
    };
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify(initialPkg, null, 2), "utf-8");

    const actions = await updatePackageJson(tmpDir);
    expect(actions.length).toBeGreaterThan(0);

    const updated = JSON.parse(await fs.readFile(path.join(tmpDir, "package.json"), "utf-8"));
    expect(updated.scripts.dev).toBe("pegas dev -- next dev");
    expect(updated.scripts.deploy).toBe("pegas deploy production");
    expect(updated.devDependencies["@netrunner714/pegas"]).toBe(`^${VERSION}`);

    // Test idempotence
    const secondActions = await updatePackageJson(tmpDir);
    expect(secondActions.length).toBe(0);
    const updatedAgain = JSON.parse(await fs.readFile(path.join(tmpDir, "package.json"), "utf-8"));
    expect(updatedAgain.scripts.dev).toBe("pegas dev -- next dev");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not mutate older pegas version in devDependencies during updatePackageJson (init)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-pkg-preserve-"));
    const initialPkg = {
      name: "my-app",
      scripts: {
        dev: "pegas dev -- next dev",
        deploy: "pegas deploy production",
      },
      devDependencies: {
        "@netrunner714/pegas": "^1.0.0",
      },
    };
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify(initialPkg, null, 2), "utf-8");

    const actions = await updatePackageJson(tmpDir);
    expect(actions.length).toBe(0);

    const updated = JSON.parse(await fs.readFile(path.join(tmpDir, "package.json"), "utf-8"));
    expect(updated.devDependencies["@netrunner714/pegas"]).toBe("^1.0.0");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("upgradePackageJson updates pegas version to target version for pegas update", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-pkg-upgrade-"));
    const initialPkg = {
      name: "my-app",
      devDependencies: {
        "@netrunner714/pegas": "^1.0.0",
      },
    };
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify(initialPkg, null, 2), "utf-8");

    const res = await upgradePackageJson(tmpDir, VERSION);
    expect(res.updated).toBe(true);
    expect(res.oldVersion).toBe("^1.0.0");
    expect(res.newVersion).toBe(`^${VERSION}`);

    const updated = JSON.parse(await fs.readFile(path.join(tmpDir, "package.json"), "utf-8"));
    expect(updated.devDependencies["@netrunner714/pegas"]).toBe(`^${VERSION}`);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("supports dryRun in setupProjectContract and updatePackageJson without writing to disk", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-dry-contract-"));
    const initialPkg = {
      name: "dry-app",
      scripts: {
        dev: "vite",
      },
    };
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify(initialPkg, null, 2), "utf-8");

    // Test dry-run contract generation
    const contractRes = await setupProjectContract(tmpDir, true);
    expect(contractRes.created).toBe(true);
    expect(contractRes.slug).toBe("dry-app");
    expect(contractRes.contract).toBeDefined();
    expect(contractRes.contract?.services?.web?.domains?.development).toEqual(["web.dry-app.localhost", "dry-app.localhost"]);
    expect(await fs.access(path.join(tmpDir, CONTRACT_FILENAME)).then(() => true).catch(() => false)).toBe(false);

    // Test dry-run package.json update
    const actions = await updatePackageJson(tmpDir, true);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some((a) => a.includes("devDependencies"))).toBe(true);

    const untouched = JSON.parse(await fs.readFile(path.join(tmpDir, "package.json"), "utf-8"));
    expect(untouched.scripts.dev).toBe("vite");
    expect(untouched.scripts.deploy).toBeUndefined();
    expect(untouched.devDependencies).toBeUndefined();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("adds .pegas to .gitignore and creates file if missing", async () => {
    const { setupGitignore } = await import("../src/commands/init.js");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-gi-"));

    const action1 = await setupGitignore(tmpDir);
    expect(action1).toContain(".gitignore");

    const content1 = await fs.readFile(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(content1).toContain(".pegas");

    // Idempotent test
    const action2 = await setupGitignore(tmpDir);
    expect(action2).toBeNull();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
