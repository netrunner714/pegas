import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { VERSION } from "./version.js";
import {
  setupProjectContract,
  updatePackageJson,
  slugify,
  detectProjectSlug,
  normalizeDomain,
  toAsciiDomain,
  detectComposeWebService,
  createDefaultContract,
  CONTRACT_FILENAME,
} from "./contract.js";
import { getRouteFilePath } from "./gateway.js";

describe("contract & package.json integration", () => {
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
    expect(content.projectName).toBe("my-awesome-site");
    expect(content.devGateway).toEqual({
      httpPort: 8080,
      httpsPort: 8443,
      skipInstallTrust: true,
      admin: false,
    });
    expect(content.services.web.port).toBe(3000);
    expect(content.services.web.domains.development).toEqual(["my-awesome-site.localhost"]);
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
    expect(content.services.web.domains.development).toEqual([`${slug}.localhost`]);
    expect(content.services.web.domains.production).toEqual([`${slug}.com`]);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not overwrite existing pegas.json", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-contract-"));
    const custom = { custom: "preserved" };
    await fs.writeFile(path.join(tmpDir, CONTRACT_FILENAME), JSON.stringify(custom), "utf-8");

    const res = await setupProjectContract(tmpDir);
    expect(res.created).toBe(false);

    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CONTRACT_FILENAME), "utf-8"));
    expect(content).toEqual(custom);

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
    expect(updated.scripts.dev).toBe("pegas up --env development -- next dev");
    expect(updated.scripts.deploy).toBe("pegas up --env production");
    expect(updated.devDependencies["@netrunner714/pegas"]).toBe(`^${VERSION}`);

    // Test idempotence
    const secondActions = await updatePackageJson(tmpDir);
    expect(secondActions.length).toBe(0);
    const updatedAgain = JSON.parse(await fs.readFile(path.join(tmpDir, "package.json"), "utf-8"));
    expect(updatedAgain.scripts.dev).toBe("pegas up --env development -- next dev");

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
    expect(contractRes.contract?.services?.web?.domains?.development).toEqual(["dry-app.localhost"]);
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
