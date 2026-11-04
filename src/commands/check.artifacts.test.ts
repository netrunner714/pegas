import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditProjectArtifacts, PEGAS_AGENT_RULES, docsPegasMd } from "./init.js";
import { auditRepository } from "./check.js";

describe("check: свежесть артефактов (детектор, не мутатор)", () => {
  async function repo(withAgents: string, withDocs: string, contractName = "art") {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-art-"));
    await fs.writeFile(path.join(dir, "pegas.json"), JSON.stringify({
      projectName: contractName,
      scenarios: ["development"],
      gateway: { development: { httpPort: 80, httpsPort: 443 } },
      services: {
        web: {
          runtime: { development: { driver: "docker" } },
          image: { development: "node:24" },
          port: { development: 3000 },
        },
      },
    }));
    await fs.mkdir(path.join(dir, ".pegas"), { recursive: true });
    await fs.writeFile(path.join(dir, ".gitignore"), ".pegas\n.env\n");
    if (withAgents !== null) await fs.writeFile(path.join(dir, "AGENTS.md"), withAgents);
    if (withDocs !== null) {
      await fs.mkdir(path.dirname(path.join(dir, "docs/pegas.md")), { recursive: true });
      await fs.writeFile(path.join(dir, "docs/pegas.md"), withDocs);
    }
    return dir;
  }

  it("свежие блок и доки — артефактных warnings нет", async () => {
    const dir = await repo(PEGAS_AGENT_RULES, docsPegasMd("art"));
    const issues = await auditProjectArtifacts(dir, "art");
    expect(issues).toEqual([]);
  });

  it("устаревший блок AGENTS.md → warning с рецептом pegas init", async () => {
    const dir = await repo("<!-- BEGIN:pegas-rules -->\n## Pegas\n- старое правило\n<!-- END:pegas-rules -->", docsPegasMd("art"));
    const issues = await auditProjectArtifacts(dir, "art");
    expect(issues.some((i) => i.includes("AGENTS.md") && i.includes("устарел"))).toBe(true);
  });

  it("нет маркера / нет файлов → warning о создании через pegas init", async () => {
    const dir = await repo("обычный текст без маркеров", null);
    const issues = await auditProjectArtifacts(dir, "art");
    expect(issues.some((i) => i.includes("маркер-блок") || i.includes("AGENTS.md"))).toBe(true);
    expect(issues.some((i) => i.includes("docs/pegas.md"))).toBe(true);
  });

  it("док отличается от канона → warning (например, имя проекта сменилось)", async () => {
    const dir = await repo(PEGAS_AGENT_RULES, docsPegasMd("other-name"));
    const issues = await auditProjectArtifacts(dir, "art");
    expect(issues.some((i) => i.includes("docs/pegas.md") && i.includes("устарел"))).toBe(true);
  });

  it("auditRepository: артефактные issues идут warnings, не errors (валидность не ломают)", async () => {
    const dir = await repo("без маркеров", null);
    const result = await auditRepository(dir);
    expect(result.valid).toBe(true);
    expect(result.artifactIssues.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual(expect.arrayContaining(result.artifactIssues));
    expect(result.errors).toEqual([]);
  });
});