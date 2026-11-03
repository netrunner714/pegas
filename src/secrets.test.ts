import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parseEnvContent,
  getExpectedSecrets,
  isIgnoredByGit,
  syncEnvExample,
  verifySecrets,
  formatSecretsDiagnostic,
} from "./secrets.js";
import type { PegasContract } from "./types.js";

describe("secrets module", () => {
  it("parseEnvContent parses variables, strips export, handles quotes, empty values and comments", () => {
    const raw = `
# Header comment
DATABASE_URL="postgres://user:pass@localhost:5432/db?sslmode=verify-full"
PORT=3000 # inline comment
export JWT_SECRET='super-secret-token'
EMPTY_VAL=
# Another comment
`;
    const parsed = parseEnvContent(raw);
    expect(parsed.get("DATABASE_URL")).toBe("postgres://user:pass@localhost:5432/db?sslmode=verify-full");
    expect(parsed.get("PORT")).toBe("3000");
    expect(parsed.get("JWT_SECRET")).toBe("super-secret-token");
    expect(parsed.get("EMPTY_VAL")).toBe("");
    expect(parsed.size).toBe(4);
  });

  it("getExpectedSecrets prioritizes contract.secrets then falls back to .env.example", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-sec-test-"));
    try {
      // 1. Neither: source is none
      const res1 = await getExpectedSecrets(tmp);
      expect(res1.source).toBe("none");
      expect(res1.secrets).toEqual([]);

      // 2. .env.example present
      await fs.writeFile(path.join(tmp, ".env.example"), "API_KEY=\nSECRET=123\n", "utf-8");
      const res2 = await getExpectedSecrets(tmp);
      expect(res2.source).toBe("example");
      expect(res2.secrets).toEqual(["API_KEY", "SECRET"]);

      // 3. Contract secrets takes precedence
      const contract: PegasContract = {
        runtime: "docker",
        secrets: ["DB_URL", "REDIS_URL"],
        services: { web: { port: 80 } },
      };
      const res3 = await getExpectedSecrets(tmp, contract);
      expect(res3.source).toBe("contract");
      expect(res3.secrets).toEqual(["DB_URL", "REDIS_URL"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("syncEnvExample creates and updates .env.example with missing contract keys", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-sync-test-"));
    try {
      const contract: PegasContract = {
        runtime: "docker",
        secrets: ["KEY_A", "KEY_B"],
        services: { web: { port: 80 } },
      };

      // Initial create
      const sync1 = await syncEnvExample(tmp, contract);
      expect(sync1.updated).toBe(true);
      expect(sync1.added).toEqual(["KEY_A", "KEY_B"]);

      const content1 = await fs.readFile(path.join(tmp, ".env.example"), "utf-8");
      expect(content1).toContain("KEY_A=");
      expect(content1).toContain("KEY_B=");

      // Re-run idempotent
      const sync2 = await syncEnvExample(tmp, contract);
      expect(sync2.updated).toBe(false);

      // Add one more key
      const contract2: PegasContract = {
        ...contract,
        secrets: ["KEY_A", "KEY_B", "KEY_C"],
      };
      const sync3 = await syncEnvExample(tmp, contract2);
      expect(sync3.updated).toBe(true);
      expect(sync3.added).toEqual(["KEY_C"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("isIgnoredByGit checks .gitignore manually when outside git repository", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-git-test-"));
    try {
      await fs.writeFile(path.join(tmp, ".gitignore"), ".env\n.pegas/\n", "utf-8");
      expect(isIgnoredByGit(tmp, ".env")).toBe(true);
      expect(isIgnoredByGit(tmp, ".pegas")).toBe(true);
      expect(isIgnoredByGit(tmp, "package.json")).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("verifySecrets detects missing, empty, and extra secrets and security issues", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-ver-test-"));
    try {
      const contract: PegasContract = {
        runtime: "docker",
        secrets: ["DB_URL", "JWT_SECRET", "EMPTY_KEY"],
        services: { web: { port: 80 } },
      };

      // Case 1: .env missing completely
      const res1 = await verifySecrets(tmp, contract);
      expect(res1.valid).toBe(false);
      expect(res1.envExists).toBe(false);
      expect(res1.missingKeys).toEqual(["DB_URL", "JWT_SECRET", "EMPTY_KEY"]);

      // Case 2: .env exists, but not gitignored
      await fs.writeFile(
        path.join(tmp, ".env"),
        "DB_URL=postgres://...\nJWT_SECRET=secret\nEMPTY_KEY=\nEXTRA_KEY=foo\n",
        "utf-8"
      );
      const res2 = await verifySecrets(tmp, contract);
      expect(res2.valid).toBe(false); // fails because not gitignored and EMPTY_KEY is empty
      expect(res2.emptyKeys).toEqual(["EMPTY_KEY"]);
      expect(res2.extraKeys).toEqual(["EXTRA_KEY"]);
      expect(res2.errors.some((e) => e.includes("NOT gitignored"))).toBe(true);

      // Case 3: .gitignore added, .env.example created, empty key populated -> valid
      await fs.writeFile(path.join(tmp, ".gitignore"), ".env\n", "utf-8");
      await fs.writeFile(
        path.join(tmp, ".env.example"),
        "DB_URL=\nJWT_SECRET=\nEMPTY_KEY=\n",
        "utf-8"
      );
      await fs.writeFile(
        path.join(tmp, ".env"),
        "DB_URL=postgres://...\nJWT_SECRET=secret\nEMPTY_KEY=now_filled\n",
        "utf-8"
      );
      const res3 = await verifySecrets(tmp, contract);
      expect(res3.valid).toBe(true);
      expect(res3.missingKeys).toEqual([]);
      expect(res3.emptyKeys).toEqual([]);

      // Case 4: Rogue/extra env file detected
      await fs.mkdir(path.join(tmp, "apps", "api"), { recursive: true });
      await fs.writeFile(path.join(tmp, "apps", "api", ".env"), "FOO=bar\n", "utf-8");
      const res4 = await verifySecrets(tmp, contract);
      expect(res4.valid).toBe(false);
      expect(res4.extraEnvFiles).toContain("apps/api/.env");
      expect(res4.errors.some((e) => e.includes("Extraneous env file(s) detected"))).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("formatSecretsDiagnostic outputs readable text summary", () => {
    const formatted = formatSecretsDiagnostic({
      valid: false,
      envFile: ".env",
      envExists: true,
      isGitIgnored: true,
      expectedSecrets: ["A", "B"],
      source: "contract",
      missingKeys: ["A"],
      emptyKeys: ["B"],
      extraKeys: ["C"],
      loadedKeys: ["B", "C"],
      warnings: [],
      errors: [],
    });

    expect(formatted).toContain("Secrets Schema (pegas.json contract):");
    expect(formatted).toContain("Expected: 2 variable(s)");
    expect(formatted).toContain(".env exists");
    expect(formatted).toContain("Missing in .env (1): A");
    expect(formatted).toContain("Empty in .env (1): B");
    expect(formatted).toContain("Extra in .env (1): C");
  });
});
