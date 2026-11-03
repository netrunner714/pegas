import { describe, it, expect } from "bun:test";
import { getPegasAllowedOrigins, isPegasOriginAllowed } from "./cors.js";

describe("cors utilities", () => {
  it("getPegasAllowedOrigins parses PEGAS_ALLOWED_ORIGINS and deduplicates", () => {
    const orig = process.env.PEGAS_ALLOWED_ORIGINS;
    try {
      process.env.PEGAS_ALLOWED_ORIGINS = "https://app.localhost, https://api.localhost, https://app.localhost";
      const origins = getPegasAllowedOrigins(["https://extra.com", "https://app.localhost"]);
      expect(origins).toEqual(["https://app.localhost", "https://api.localhost", "https://extra.com"]);
    } finally {
      if (orig === undefined) delete process.env.PEGAS_ALLOWED_ORIGINS;
      else process.env.PEGAS_ALLOWED_ORIGINS = orig;
    }
  });

  it("isPegasOriginAllowed validates origins correctly", () => {
    const check = isPegasOriginAllowed(["https://mysite.com"]);

    expect(check(undefined)).toBe(true);
    expect(check("http://localhost:3000")).toBe(true);
    expect(check("http://127.0.0.1:8080")).toBe(true);
    expect(check("https://mysite.com")).toBe(true);
    expect(check("https://evil.com")).toBe(false);
    expect(check("not-a-valid-url")).toBe(false);
  });
});
