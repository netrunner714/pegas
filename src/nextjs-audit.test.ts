import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  auditNextjsDevOrigins,
  builtinDevOrigins,
  blocksUnlistedDevOrigin,
  isDevOriginCovered,
  matchWildcardDomain,
  matchWildcardDomainLegacy,
  parseAllowedDevOrigins,
  recommendedDevOrigins,
  stripComments,
  supportsAllowedDevOrigins,
  NEXTJS_GUIDE_PATH,
  type NextjsAuditFinding,
} from "./nextjs-audit.js";

/**
 * Тесты аудита allowedDevOrigins (issue #28).
 *
 * Домены двух уровней (`<service>.<project>.localhost`) — основной сценарий:
 * именно их Next.js не пропускает. Домены одного уровня (`<project>.localhost`)
 * в Next.js 15.3–16.2 покрыты встроенным списком `*.localhost`, поэтому
 * предупреждение на них не выдаётся — это проверяется отдельно.
 */

/** Временный каталог проекта с package.json и (опционально) конфигом Next. */
async function makeProject(opts: {
  next?: string | null;
  installedNext?: string | null;
  configName?: string;
  configText?: string;
  devDeps?: boolean;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-nextjs-"));
  if (opts.next !== null) {
    const pkg: Record<string, unknown> = { name: "app", version: "1.0.0" };
    if (opts.devDeps) pkg.devDependencies = { next: opts.next };
    else pkg.dependencies = { next: opts.next };
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  }
  if (opts.installedNext) {
    const nm = path.join(dir, "node_modules", "next");
    await fs.mkdir(nm, { recursive: true });
    await fs.writeFile(path.join(nm, "package.json"), JSON.stringify({ name: "next", version: opts.installedNext }));
  }
  if (opts.configName) {
    await fs.writeFile(path.join(dir, opts.configName), opts.configText ?? "");
  }
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Два домена: корень зоны и поддомен сервиса — типичная пара Pegas. */
const DEV_DOMAINS = ["my-app.localhost", "api.my-app.localhost"];

describe("nextjs-audit: обнаружение Next.js", () => {
  it("нет package.json → аудит не применяется, без предупреждения", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-nextjs-empty-"));
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.nextjsDetected).toBe(false);
      expect(r.status).toBe("not-detected");
      expect(r.warning).toBeNull();
      expect(r.hint).toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("битый package.json → не падает, аудит не применяется", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pegas-nextjs-broken-"));
    try {
      await fs.writeFile(path.join(dir, "package.json"), "{ это не json");
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.nextjsDetected).toBe(false);
      expect(r.warning).toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("package.json без next → not-detected", async () => {
    const dir = await makeProject({ next: null });
    try {
      await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { express: "^5" } }));
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.nextjsDetected).toBe(false);
      expect(r.warning).toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("next в devDependencies тоже обнаруживается", async () => {
    const dir = await makeProject({ next: "15.5.0", devDeps: true, configName: "next.config.ts", configText: "export default {}" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.nextjsDetected).toBe(true);
      expect(r.status).toBe("missing-option");
      expect(r.warning).not.toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("версия из node_modules важнее объявленного диапазона", async () => {
    // Диапазон ^14.2.0 сам по себе неоднозначен: установленная 14.2.20 опцию не знает.
    const dir = await makeProject({ next: "^14.2.0", installedNext: "14.2.20" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.nextVersion).toBe("14.2.20");
      expect(r.status).toBe("unsupported");
      expect(r.warning).toBeNull();
    } finally {
      await cleanup(dir);
    }
  });
});

describe("nextjs-audit: версии Next.js", () => {
  it("supportsAllowedDevOrigins: границы по исходникам Next.js", () => {
    expect(supportsAllowedDevOrigins("15.3.0")).toBe(true);
    expect(supportsAllowedDevOrigins("15.2.9")).toBe(false);
    expect(supportsAllowedDevOrigins("14.2.30")).toBe(true);
    expect(supportsAllowedDevOrigins("14.2.29")).toBe(false);
    expect(supportsAllowedDevOrigins("16.4.5")).toBe(true);
    expect(supportsAllowedDevOrigins("13.5.6")).toBe(false);
    // Неизвестная версия трактуется как поддерживающая (лучше предупредить).
    expect(supportsAllowedDevOrigins("latest")).toBe(true);
    expect(supportsAllowedDevOrigins(null)).toBe(true);
  });

  it("unsupported: старая версия Next.js — без предупреждения и без совета", async () => {
    const dir = await makeProject({ next: "15.1.0" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("unsupported");
      expect(r.warning).toBeNull();
      expect(r.hint).toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("builtinDevOrigins: *.localhost до 16.2, **.localhost с 16.3", () => {
    expect(builtinDevOrigins("15.5.0")).toEqual(["*.localhost", "localhost"]);
    expect(builtinDevOrigins("16.2.0")).toEqual(["*.localhost", "localhost"]);
    expect(builtinDevOrigins("16.3.0")).toEqual(["**.localhost", "localhost"]);
    expect(builtinDevOrigins("14.2.33")).toEqual(["*.localhost", "localhost"]);
    expect(builtinDevOrigins(null)).toEqual(["*.localhost", "localhost"]);
  });

  it("blocksUnlistedDevOrigin: warn-режим до 16.2, блокировка с 16.2", () => {
    expect(blocksUnlistedDevOrigin("15.5.0", false)).toBe(false); // опция не задана → только предупреждение
    expect(blocksUnlistedDevOrigin("15.5.0", true)).toBe(true); // опция задана → блокировка
    expect(blocksUnlistedDevOrigin("14.2.33", false)).toBe(false);
    expect(blocksUnlistedDevOrigin("16.2.0", false)).toBe(true);
    expect(blocksUnlistedDevOrigin("16.4.5", true)).toBe(true);
  });

  it("Next.js 16.3+: встроенный **.localhost уже покрывает домены — предупреждения нет", async () => {
    const dir = await makeProject({ next: "16.3.0", configName: "next.config.ts", configText: "export default { reactStrictMode: true }" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("ok");
      expect(r.coversPegasOrigins).toBe(true);
      expect(r.warning).toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("одноуровневый <project>.localhost на 15.5 покрыт встроенным *.localhost — молчим", async () => {
    const dir = await makeProject({ next: "15.5.0", configName: "next.config.ts", configText: "export default {}" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: ["my-app.localhost"] });
      expect(r.status).toBe("ok");
      expect(r.warning).toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("одноуровневый <project>.localhost на 14.2.33 НЕ покрыт: legacy-матчер не понимает *.localhost", async () => {
    const dir = await makeProject({ next: "14.2.33", configName: "next.config.js", configText: "module.exports = {}" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: ["my-app.localhost"] });
      expect(r.status).toBe("missing-option");
      // На ветке 14.2 универсальный шаблон не работает: рецепт — точное имя + **.<project>.localhost.
      expect(r.recommendedOrigins).toEqual(["my-app.localhost", "**.my-app.localhost"]);
      expect(r.warning).toContain("'**.my-app.localhost'");
      // Опция не задана, версия до 16.2 → Next.js пока только предупреждает, не блокирует.
      expect(r.warning).toContain("печатает предупреждение");
      expect(r.warning).not.toContain("403");
    } finally {
      await cleanup(dir);
    }
  });
});

describe("nextjs-audit: сопоставление шаблонов (семантика Next.js)", () => {
  it("* — ровно одна метка, ** — одна и более (15.3+)", () => {
    expect(matchWildcardDomain("my-app.localhost", "*.localhost")).toBe(true);
    expect(matchWildcardDomain("api.my-app.localhost", "*.localhost")).toBe(false);
    expect(matchWildcardDomain("api.my-app.localhost", "**.localhost")).toBe(true);
    expect(matchWildcardDomain("a.b.my-app.localhost", "**.localhost")).toBe(true);
    expect(matchWildcardDomain("localhost", "*.localhost")).toBe(false);
    expect(matchWildcardDomain("api.my-app.localhost", "**.my-app.localhost")).toBe(true);
    expect(matchWildcardDomain("my-app.localhost", "**.my-app.localhost")).toBe(false);
    // Частичная подстановка внутри метки не поддерживается.
    expect(matchWildcardDomain("team.eu.example.com", "*.example.com")).toBe(false);
    expect(matchWildcardDomain("anything", "*")).toBe(false);
    expect(matchWildcardDomain("a.b.c", "**")).toBe(false);
    expect(matchWildcardDomain("a.b.c", "c.**")).toBe(false);
  });

  it("legacy-матчер ветки 14.2: подстановка в двух последних метках запрещена", () => {
    expect(matchWildcardDomainLegacy("my-app.localhost", "*.localhost")).toBe(false);
    expect(matchWildcardDomainLegacy("api.my-app.localhost", "**.localhost")).toBe(false);
    expect(matchWildcardDomainLegacy("api.my-app.localhost", "**.my-app.localhost")).toBe(true);
    expect(matchWildcardDomainLegacy("my-app.localhost", "my-app.localhost")).toBe(true);
  });

  it("isDevOriginCovered: localhost разрешён всегда, регистр не важен", () => {
    expect(isDevOriginCovered("localhost", [])).toBe(true);
    expect(isDevOriginCovered("MY-APP.localhost", ["my-app.localhost"])).toBe(true);
    expect(isDevOriginCovered("api.my-app.localhost", ["example.com"])).toBe(false);
    expect(isDevOriginCovered("api.my-app.localhost", ["**.my-app.localhost"], true)).toBe(true);
    expect(isDevOriginCovered("api.my-app.localhost", ["", null as unknown as string])).toBe(false);
  });

  it("recommendedDevOrigins: корень зоны + рекурсивный шаблон на каждый проект", () => {
    expect(recommendedDevOrigins(DEV_DOMAINS)).toEqual(["my-app.localhost", "**.my-app.localhost"]);
    expect(recommendedDevOrigins(["a.localhost", "b.localhost"])).toEqual([
      "a.localhost",
      "**.a.localhost",
      "b.localhost",
      "**.b.localhost",
    ]);
    expect(recommendedDevOrigins(["example.com"])).toEqual(["**.localhost"]);
    expect(recommendedDevOrigins([])).toEqual(["**.localhost"]);
    // Значения с портом и схемой нормализуются до hostname.
    expect(recommendedDevOrigins(["https://my-app.localhost:443/"])).toEqual(["my-app.localhost", "**.my-app.localhost"]);
  });
});

describe("nextjs-audit: разбор конфига (текстовая эвристика)", () => {
  it("stripComments: строки сохраняются, комментарии и regex-литералы убираются", () => {
    const src = [
      "const re = /https?:\\/\\//; // это комментарий со словом allowedDevOrigins",
      "/* блочный allowedDevOrigins */",
      'const s = "строка с // внутри и allowedDevOrigins";',
      "module.exports = { allowedDevOrigins: ['a.localhost'] };",
    ].join("\n");
    const out = stripComments(src);
    expect(out).toContain('const s = "строка с // внутри и allowedDevOrigins";');
    expect(out).toContain("module.exports = { allowedDevOrigins: ['a.localhost'] };");
    expect(out).not.toContain("это комментарий");
    expect(out).not.toContain("блочный");
    expect(out).not.toContain("/https?:");
  });

  it("parseAllowedDevOrigins: плоский массив строк во всех кавычках", () => {
    expect(parseAllowedDevOrigins("module.exports = { allowedDevOrigins: ['a.localhost', \"b.localhost\"] }")).toEqual({
      found: true,
      entries: ["a.localhost", "b.localhost"],
      complete: true,
    });
    expect(parseAllowedDevOrigins("export default { allowedDevOrigins: [`a.localhost`] }")).toEqual({
      found: true,
      entries: ["a.localhost"],
      complete: true,
    });
  });

  it("parseAllowedDevOrigins: многострочный массив и TS-аннотации", () => {
    const src = `
      import type { NextConfig } from "next";
      interface Base { allowedDevOrigins?: string[] }
      const nextConfig: NextConfig = {
        reactStrictMode: true,
        allowedDevOrigins: [
          "my-app.localhost",
          '**.my-app.localhost',
        ],
      };
      export default nextConfig;
    `;
    const parsed = parseAllowedDevOrigins(src);
    expect(parsed.found).toBe(true);
    expect(parsed.complete).toBe(true);
    expect(parsed.entries).toEqual(["my-app.localhost", "**.my-app.localhost"]);
  });

  it("parseAllowedDevOrigins: defineNextConfig, JSON-ключ и пост-присваивание", () => {
    expect(parseAllowedDevOrigins("export default defineNextConfig({ allowedDevOrigins: ['a.localhost'] })").entries).toEqual(["a.localhost"]);
    expect(parseAllowedDevOrigins('module.exports = { "allowedDevOrigins": ["a.localhost"] }').entries).toEqual(["a.localhost"]);
    const post = "const c = {};\nc.allowedDevOrigins = ['a.localhost'];\nmodule.exports = c;";
    expect(parseAllowedDevOrigins(post).entries).toEqual(["a.localhost"]);
  });

  it("parseAllowedDevOrigins: слово внутри строки или комментария ключом не считается", () => {
    expect(parseAllowedDevOrigins('const note = "добавьте allowedDevOrigins: [\'*\'] в конфиг";').found).toBe(false);
    expect(parseAllowedDevOrigins("// allowedDevOrigins: ['a.localhost']\nmodule.exports = {};").found).toBe(false);
    expect(parseAllowedDevOrigins("/* allowedDevOrigins: ['a.localhost'] */\nexport default {};").found).toBe(false);
    // Чтение чужого свойства без присваивания — не конфиг этого файла.
    expect(parseAllowedDevOrigins("const x = { other: base.allowedDevOrigins };").found).toBe(false);
  });

  it("parseAllowedDevOrigins: вычисляемые значения помечаются неполными", () => {
    const variable = parseAllowedDevOrigins("module.exports = { allowedDevOrigins: devOrigins }");
    expect(variable.found).toBe(true);
    expect(variable.complete).toBe(false);

    const spread = parseAllowedDevOrigins("module.exports = { allowedDevOrigins: ['a.localhost', ...extra] }");
    expect(spread.complete).toBe(false);
    expect(spread.entries).toEqual(["a.localhost"]);

    const call = parseAllowedDevOrigins("module.exports = { allowedDevOrigins: buildOrigins(env) }");
    expect(call.complete).toBe(false);

    const interpolated = parseAllowedDevOrigins("module.exports = { allowedDevOrigins: [`${project}.localhost`] }");
    expect(interpolated.complete).toBe(false);

    const nested = parseAllowedDevOrigins("module.exports = { allowedDevOrigins: [[ 'a.localhost' ]] }");
    expect(nested.complete).toBe(false);
  });

  it("parseAllowedDevOrigins: одиночная строка вместо массива читается", () => {
    expect(parseAllowedDevOrigins("module.exports = { allowedDevOrigins: 'my-app.localhost' }")).toEqual({
      found: true,
      entries: ["my-app.localhost"],
      complete: true,
    });
  });

  it("parseAllowedDevOrigins: вычисляемый ключ — неоднозначность, а не отсутствие опции", () => {
    const src = 'const K = "allowedDevOrigins";\nmodule.exports = { [K]: ["a.localhost"] };';
    const parsed = parseAllowedDevOrigins(src);
    expect(parsed.found).toBe(false);
    expect(parsed.ambiguous).toBe(true);
    expect(parseAllowedDevOrigins("module.exports = { reactStrictMode: true };").ambiguous).toBe(false);
  });

  it("битый/обрезанный конфиг не роняет разбор", () => {
    expect(() => parseAllowedDevOrigins("module.exports = { allowedDevOrigins: ['a.localhost")).not.toThrow();
    const broken = parseAllowedDevOrigins("module.exports = { allowedDevOrigins: ['a.localhost");
    expect(broken.found).toBe(true);
    expect(broken.complete).toBe(false);
    expect(parseAllowedDevOrigins("").found).toBe(false);
    expect(parseAllowedDevOrigins("случайный текст без конфига").found).toBe(false);
  });
});

describe("nextjs-audit: результаты по содержимому конфига", () => {
  it("Next.js есть, конфига нет → missing-config с предупреждением", async () => {
    const dir = await makeProject({ next: "15.5.0" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("missing-config");
      expect(r.configFile).toBeNull();
      expect(r.warning).toContain("next.config");
      expect(r.warning).toContain(NEXTJS_GUIDE_PATH);
      expect(r.warning).toContain("api.my-app.localhost");
      // На Next 15.5 встроенный *.localhost покрывает корень зоны — в непокрытых
      // остаётся только домен сервиса.
      expect(r.uncoveredDomains).toEqual(["api.my-app.localhost"]);
    } finally {
      await cleanup(dir);
    }
  });

  it("конфиг есть, allowedDevOrigins нет → missing-option", async () => {
    const dir = await makeProject({
      next: "15.5.0",
      configName: "next.config.ts",
      configText: 'import type { NextConfig } from "next";\nconst nextConfig: NextConfig = { reactStrictMode: true };\nexport default nextConfig;\n',
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("missing-option");
      expect(r.hasAllowedDevOrigins).toBe(false);
      expect(r.configFile).toBe("next.config.ts");
      expect(r.warning).toContain("allowedDevOrigins");
      expect(r.warning).toContain("'my-app.localhost'");
      expect(r.warning).toContain("'**.my-app.localhost'");
    } finally {
      await cleanup(dir);
    }
  });

  it("битый конфиг (мусор вместо кода) → не падает, даёт предупреждение missing-option", async () => {
    const dir = await makeProject({ next: "15.5.0", configName: "next.config.mjs", configText: "{{{{ ((( not a config" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("missing-option");
      expect(r.warning).not.toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("недоступный для чтения конфиг → indeterminate с подсказкой, а не ложное обвинение", async () => {
    const dir = await makeProject({ next: "15.5.0", configName: "next.config.js", configText: "module.exports = {}" });
    try {
      // Снимаем права на чтение: stat видит файл, readFile бросает EACCES.
      await fs.chmod(path.join(dir, "next.config.js"), 0o000);
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("indeterminate");
      expect(r.configFile).toBe("next.config.js");
      expect(r.warning).toBeNull();
      expect(r.hint).toContain("не удалось прочитать");
    } finally {
      await fs.chmod(path.join(dir, "next.config.js"), 0o644).catch(() => {});
      await cleanup(dir);
    }
  });

  it("каталог с именем next.config.js конфигом не считается", async () => {
    const dir = await makeProject({ next: "15.5.0" });
    try {
      await fs.mkdir(path.join(dir, "next.config.js"), { recursive: true });
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.configFile).toBeNull();
      expect(r.status).toBe("missing-config");
    } finally {
      await cleanup(dir);
    }
  });

  const coveredConfigs: Array<{ name: string; file: string; text: string }> = [
    {
      name: "next.config.ts / export default / одинарные кавычки",
      file: "next.config.ts",
      text: 'import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {\n  allowedDevOrigins: [\'my-app.localhost\', \'**.my-app.localhost\'],\n};\nexport default nextConfig;\n',
    },
    {
      name: "next.config.js / module.exports / двойные кавычки",
      file: "next.config.js",
      text: 'module.exports = {\n  allowedDevOrigins: ["my-app.localhost", "**.my-app.localhost"],\n};\n',
    },
    {
      name: "next.config.mjs / export default / обратные кавычки",
      file: "next.config.mjs",
      text: "export default {\n  allowedDevOrigins: [`my-app.localhost`, `**.my-app.localhost`],\n};\n",
    },
    {
      name: "next.config.js / defineNextConfig",
      file: "next.config.js",
      text: "const { defineNextConfig } = require('./lib');\nmodule.exports = defineNextConfig({\n  allowedDevOrigins: ['my-app.localhost', '**.my-app.localhost'],\n});\n",
    },
    {
      name: "next.config.mts / export default",
      file: "next.config.mts",
      text: 'import type { NextConfig } from "next";\nconst cfg = { allowedDevOrigins: ["**.my-app.localhost", "my-app.localhost"] } satisfies NextConfig;\nexport default cfg;\n',
    },
    {
      name: "рекурсивный шаблон **.localhost покрывает оба уровня",
      file: "next.config.js",
      text: "module.exports = { allowedDevOrigins: ['**.localhost'] };",
    },
    {
      name: "шаблон со значением из другой секции и комментарии",
      file: "next.config.js",
      text: "// allowedDevOrigins: ['example.com'] — закомментировано, не считается\nmodule.exports = {\n  /* шум */\n  rewrites: async () => [{ source: '/a', destination: 'http://b' }],\n  allowedDevOrigins: ['my-app.localhost', '**.my-app.localhost'],\n};\n",
    },
  ];

  for (const c of coveredConfigs) {
    it(`покрытие есть: ${c.name} → ok, без предупреждения`, async () => {
      const dir = await makeProject({ next: "15.5.0", configName: c.file, configText: c.text });
      try {
        const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
        expect(r.status).toBe("ok");
        expect(r.coversPegasOrigins).toBe(true);
        expect(r.warning).toBeNull();
        expect(r.hint).toBeNull();
        expect(r.configFile).toBe(c.file);
      } finally {
        await cleanup(dir);
      }
    });
  }

  it("allowedDevOrigins: ['*.localhost'] НЕ покрывает поддомен сервиса → not-covered с пояснением", async () => {
    const dir = await makeProject({
      next: "15.5.0",
      configName: "next.config.js",
      configText: "module.exports = { allowedDevOrigins: ['*.localhost'] };",
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("not-covered");
      expect(r.uncoveredDomains).toEqual(["api.my-app.localhost"]);
      expect(r.warning).toContain("одному уровню поддомена");
      expect(r.warning).toContain("'**.my-app.localhost'");
    } finally {
      await cleanup(dir);
    }
  });

  it("['*.localhost'] при одноуровневом домене достаточно (встроенный список тоже его покрывает)", async () => {
    const dir = await makeProject({
      next: "15.5.0",
      configName: "next.config.js",
      configText: "module.exports = { allowedDevOrigins: ['*.localhost'] };",
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: ["my-app.localhost"] });
      expect(r.status).toBe("ok");
      expect(r.warning).toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("посторонние значения (['example.com']) → not-covered", async () => {
    const dir = await makeProject({
      next: "15.5.0",
      configName: "next.config.js",
      configText: "module.exports = { allowedDevOrigins: ['example.com', '*.example.com'] };",
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("not-covered");
      expect(r.configuredOrigins).toEqual(["example.com", "*.example.com"]);
      // my-app.localhost покрыт встроенным *.localhost (Next 15.5); поддомен сервиса — нет.
      expect(r.uncoveredDomains).toEqual(["api.my-app.localhost"]);
      expect(r.warning).toContain("api.my-app.localhost");
      expect(r.warning).not.toContain("example.com");
    } finally {
      await cleanup(dir);
    }
  });

  it("пустой массив → not-covered (опция задана, но ничего не разрешает)", async () => {
    const dir = await makeProject({ next: "15.5.0", configName: "next.config.js", configText: "module.exports = { allowedDevOrigins: [] };" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("not-covered");
      expect(r.hasAllowedDevOrigins).toBe(true);
      expect(r.configuredOrigins).toEqual([]);
    } finally {
      await cleanup(dir);
    }
  });

  it("вычисляемое значение → indeterminate: подсказка вместо ложного предупреждения", async () => {
    const dir = await makeProject({
      next: "15.5.0",
      configName: "next.config.js",
      configText: "const origins = require('./origins');\nmodule.exports = { allowedDevOrigins: origins };",
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("indeterminate");
      expect(r.warning).toBeNull();
      expect(r.hint).toContain("вычисляется динамически");
      expect(r.hint).toContain(NEXTJS_GUIDE_PATH);
    } finally {
      await cleanup(dir);
    }
  });

  it("частично вычисляемое значение (спред) → indeterminate, прочитанные строки сохранены", async () => {
    const dir = await makeProject({
      next: "15.5.0",
      configName: "next.config.ts",
      configText: "export default { allowedDevOrigins: ['my-app.localhost', ...extraOrigins] };",
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("indeterminate");
      expect(r.configuredOrigins).toEqual(["my-app.localhost"]);
      expect(r.hint).not.toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("вычисляемый ключ объекта → indeterminate, а не обвинение в отсутствии опции", async () => {
    const dir = await makeProject({
      next: "15.5.0",
      configName: "next.config.js",
      configText: 'const KEY = "allowedDevOrigins";\nmodule.exports = { [KEY]: ["my-app.localhost", "**.my-app.localhost"] };',
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("indeterminate");
      expect(r.warning).toBeNull();
      expect(r.hint).toContain("не удалось разобрать");
    } finally {
      await cleanup(dir);
    }
  });

  it("приоритет файлов: next.config.js читается раньше next.config.ts", async () => {
    const dir = await makeProject({ next: "15.5.0" });
    try {
      await fs.writeFile(path.join(dir, "next.config.js"), "module.exports = { allowedDevOrigins: ['my-app.localhost', '**.my-app.localhost'] };");
      await fs.writeFile(path.join(dir, "next.config.ts"), "export default {};");
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.configFile).toBe("next.config.js");
      expect(r.status).toBe("ok");
    } finally {
      await cleanup(dir);
    }
  });

  it("next.config.cjs принимается запасным вариантом", async () => {
    const dir = await makeProject({
      next: "15.5.0",
      configName: "next.config.cjs",
      configText: "module.exports = { allowedDevOrigins: ['my-app.localhost', '**.my-app.localhost'] };",
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.configFile).toBe("next.config.cjs");
      expect(r.status).toBe("ok");
    } finally {
      await cleanup(dir);
    }
  });
});

describe("nextjs-audit: область применения (dev-домены)", () => {
  it("dev-домены без .localhost → аудит молчит", async () => {
    const dir = await makeProject({ next: "15.5.0", configName: "next.config.js", configText: "module.exports = {};" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: ["dev.example.com", "api.example.com"] });
      expect(r.status).toBe("not-applicable");
      expect(r.warning).toBeNull();
      expect(r.hint).toBeNull();
      expect(r.checkedDomains).toEqual([]);
    } finally {
      await cleanup(dir);
    }
  });

  it("пустой список доменов (в контракте нет development-доменов) → молчит", async () => {
    const dir = await makeProject({ next: "15.5.0", configName: "next.config.js", configText: "module.exports = {};" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: [] });
      expect(r.status).toBe("not-applicable");
      expect(r.warning).toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("только localhost в доменах → молчит (Next его разрешает всегда)", async () => {
    const dir = await makeProject({ next: "15.5.0", configName: "next.config.js", configText: "module.exports = {};" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: ["localhost"] });
      expect(r.status).toBe("not-applicable");
      expect(r.warning).toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("домены не переданы → аудит не блокируется, проверяет канонические формы", async () => {
    const dir = await makeProject({ next: "15.5.0", configName: "next.config.js", configText: "module.exports = {};" });
    try {
      const r = await auditNextjsDevOrigins(dir);
      expect(r.status).toBe("missing-option");
      expect(r.domainsFromContract).toBe(false);
      expect(r.warning).toContain("<project>.localhost");
      expect(r.warning).toContain("'**.localhost'");
      // Без контракта реальные hostname не выдумываются.
      expect(r.checkedDomains).toEqual([]);
      expect(r.uncoveredDomains).toEqual([]);
    } finally {
      await cleanup(dir);
    }
  });

  it("домены не переданы + legacy 14.2 → рецепт с плейсхолдером <project>", async () => {
    const dir = await makeProject({ next: "14.2.33", configName: "next.config.js", configText: "module.exports = {};" });
    try {
      const r = await auditNextjsDevOrigins(dir);
      expect(r.status).toBe("missing-option");
      expect(r.recommendedOrigins).toEqual(["<project>.localhost", "**.<project>.localhost"]);
      expect(r.warning).toContain("'**.<project>.localhost'");
    } finally {
      await cleanup(dir);
    }
  });

  it("неизвестные домены + частичное покрытие → not-covered с условной формулировкой", async () => {
    const dir = await makeProject({
      next: "15.5.0",
      configName: "next.config.js",
      configText: "module.exports = { allowedDevOrigins: ['*.localhost'] };",
    });
    try {
      // Каноническая проба <svc>.<project>.localhost не покрыта *.localhost.
      const r = await auditNextjsDevOrigins(dir);
      expect(r.status).toBe("not-covered");
      expect(r.warning).toContain("<service>.<project>.localhost");
      expect(r.warning).toContain("Если проект публикует");
      // Сообщение собирается из цельных предложений: нет пунктуационных артефактов.
      expect(r.warning).not.toMatch(/\.\s[—–-]/);
      expect(r.warning).not.toMatch(/\.\s+[a-zа-я]/);
    } finally {
      await cleanup(dir);
    }
  });

  it("Next.js 16.2+ блокирует непокрытый origin → предупреждение говорит про 403", async () => {
    const dir = await makeProject({
      next: "16.2.0",
      configName: "next.config.ts",
      configText: "export default { allowedDevOrigins: ['example.com'] };",
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: ["api.my-app.localhost"] });
      expect(r.status).toBe("not-covered");
      expect(r.warning).toContain("403");
      expect(r.builtinOrigins).toEqual(["*.localhost", "localhost"]);
    } finally {
      await cleanup(dir);
    }
  });

  it("14.2 с ['*.localhost'] → not-covered и пояснение про ветку 14.2", async () => {
    const dir = await makeProject({
      next: "14.2.33",
      configName: "next.config.js",
      configText: "module.exports = { allowedDevOrigins: ['*.localhost'] };",
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: ["api.my-app.localhost"] });
      expect(r.status).toBe("not-covered");
      expect(r.warning).toContain("14.2");
      expect(r.warning).toContain("'**.my-app.localhost'");
    } finally {
      await cleanup(dir);
    }
  });

  it("экранированные кавычки в строках читаются корректно", async () => {
    const dir = await makeProject({
      next: "15.5.0",
      configName: "next.config.js",
      configText: 'module.exports = { allowedDevOrigins: ["my-app.localhost", "**.my-app.localhost"], note: "a \\" b" };',
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.status).toBe("ok");
      expect(r.configuredOrigins).toEqual(["my-app.localhost", "**.my-app.localhost"]);
    } finally {
      await cleanup(dir);
    }
  });

  it("домены со схемой и портом нормализуются", async () => {
    const dir = await makeProject({
      next: "15.5.0",
      configName: "next.config.js",
      configText: "module.exports = { allowedDevOrigins: ['my-app.localhost', '**.my-app.localhost'] };",
    });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: ["https://api.my-app.localhost:443/", " MY-APP.localhost "] });
      expect(r.status).toBe("ok");
      expect(r.checkedDomains).toEqual(["api.my-app.localhost", "my-app.localhost"]);
    } finally {
      await cleanup(dir);
    }
  });

  it("домены из разных проектов: непокрытые перечисляются, длинные списки сокращаются", async () => {
    // Пять двухуровневых доменов разных зон: встроенный *.localhost их не
    // покрывает, конфиг пуст → все пять непокрыты, текст сокращается.
    const dir = await makeProject({ next: "15.5.0", configName: "next.config.js", configText: "module.exports = { allowedDevOrigins: ['a.localhost'] };" });
    try {
      const domains = ["api.a.localhost", "api.b.localhost", "api.c.localhost", "api.d.localhost", "api.e.localhost"];
      const r = await auditNextjsDevOrigins(dir, { devDomains: domains });
      expect(r.status).toBe("not-covered");
      expect(r.uncoveredDomains).toEqual(domains);
      expect(r.warning).toContain("и ещё");
      expect(r.recommendedOrigins).toEqual([
        "a.localhost",
        "**.a.localhost",
        "b.localhost",
        "**.b.localhost",
        "c.localhost",
        "**.c.localhost",
        "d.localhost",
        "**.d.localhost",
        "e.localhost",
        "**.e.localhost",
      ]);
    } finally {
      await cleanup(dir);
    }
  });

  it("несуществующий каталог проекта → не падает", async () => {
    const missing = path.join(os.tmpdir(), `pegas-nextjs-absent-${Date.now()}`);
    const r = await auditNextjsDevOrigins(missing, { devDomains: DEV_DOMAINS });
    expect(r.nextjsDetected).toBe(false);
    expect(r.warning).toBeNull();
  });
});

describe("nextjs-audit: форма результата", () => {
  it("все поля инициализированы (JSON-сериализация без undefined)", async () => {
    const dir = await makeProject({ next: "15.5.0", configName: "next.config.js", configText: "module.exports = {};" });
    try {
      const r: NextjsAuditFinding = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      const keys: Array<keyof NextjsAuditFinding> = [
        "status",
        "nextjsDetected",
        "nextVersion",
        "configFile",
        "hasAllowedDevOrigins",
        "coversPegasOrigins",
        "checkedDomains",
        "domainsFromContract",
        "uncoveredDomains",
        "configuredOrigins",
        "builtinOrigins",
        "recommendedOrigins",
        "warning",
        "hint",
      ];
      const parsed = JSON.parse(JSON.stringify(r));
      for (const k of keys) expect(Object.prototype.hasOwnProperty.call(parsed, k)).toBe(true);
      expect(parsed.status).toBe("missing-option");
    } finally {
      await cleanup(dir);
    }
  });

  it("текст предупреждения содержит ссылку на гайд и готовый сниппет", async () => {
    const dir = await makeProject({ next: "15.5.0" });
    try {
      const r = await auditNextjsDevOrigins(dir, { devDomains: DEV_DOMAINS });
      expect(r.warning).toContain(NEXTJS_GUIDE_PATH);
      expect(r.warning).toContain("allowedDevOrigins: ['my-app.localhost', '**.my-app.localhost']");
      expect(r.warning).toContain("перезапустите dev-сервер");
      expect(r.warning).not.toMatch(/[😀-🿿]/u); // без эмодзи: их печатает check.ts
    } finally {
      await cleanup(dir);
    }
  });

  it("гайд существует в репозитории (ссылка из предупреждения резолвится)", async () => {
    const guide = path.join(process.cwd(), NEXTJS_GUIDE_PATH);
    const stat = await fs.stat(guide);
    expect(stat.isFile()).toBe(true);
  });
});
