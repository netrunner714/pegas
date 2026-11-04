import { describe, it, expect } from "bun:test";
import {
  normalizeDomain,
  toAsciiDomain,
  detectProjectSlug,
  getProjectRuntimeId,
  CONTRACT_FILENAME,
  CONTRACT_SCHEMA_URL,
} from "./contract.js";

describe("контрактные хелперы (v3)", () => {
  it("CONTRACT_FILENAME/CONTRACT_SCHEMA_URL стабильны", () => {
    expect(CONTRACT_FILENAME).toBe("pegas.json");
    expect(CONTRACT_SCHEMA_URL).toBe("https://netrunner714.ru/schemas/pegas.json");
  });

  it("getProjectRuntimeId: детерминизм + различие проектов", () => {
    const a = getProjectRuntimeId("/home/vibe/shop", "shop");
    const b = getProjectRuntimeId("/home/vibe/shop", "shop");
    const c = getProjectRuntimeId("/home/vibe/other", "other");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{10}$/);
  });

  it("toAsciiDomain: IDN → punycode через WHATWG URL", () => {
    expect(toAsciiDomain("example.com")).toBe("example.com");
    expect(toAsciiDomain("президент.рф")).toBe("xn--d1abbgf6aiiy.xn--p1ai");
  });

  it("normalizeDomain: протокол, слэши, пути, порты", () => {
    expect(normalizeDomain("https://example.com/")).toBe("example.com");
    expect(normalizeDomain("http://example.com/path")).toBe("example.com");
    expect(normalizeDomain("example.com:8443")).toBe("example.com");
  });

  it("detectProjectSlug: из package.json имя и из каталога", () => {
    expect(detectProjectSlug("/home/vibe/my-shop")).toBe("my-shop");
    expect(detectProjectSlug("/home/vibe/@scope/app")).toBe("app");
  });
});
