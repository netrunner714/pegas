import { describe, it, expect } from "bun:test";
import { generateCaddyfileSnippet } from "./generator.js";

describe("Caddyfile snippet generator", () => {
  it("generates standard proxy config with www redirect and security headers", () => {
    const snippet = generateCaddyfileSnippet({
      domain: "example.com",
      upstream: "web:3000",
    });

    expect(snippet).toContain("www.example.com {");
    expect(snippet).toContain("redir https://example.com{uri} permanent");
    expect(snippet).toContain("example.com {");
    expect(snippet).toContain("reverse_proxy web:3000");
    expect(snippet).toContain("encode gzip zstd");
    expect(snippet).toContain("Strict-Transport-Security");
  });

  it("omits www redirect for subdomains", () => {
    const snippet = generateCaddyfileSnippet({
      domain: "api.example.com",
      upstream: "api:8000",
    });

    expect(snippet).not.toContain("www.api.example.com {");
    expect(snippet).toContain("api.example.com {");
    expect(snippet).toContain("reverse_proxy api:8000");
  });

  it("generates SPA + API config", () => {
    const snippet = generateCaddyfileSnippet({
      domain: "app.example.com",
      spa: true,
      upstream: "frontend:80",
      apiUpstream: "backend:4000",
      apiPrefix: "/api/*",
    });

    expect(snippet).toContain("handle /api/* {");
    expect(snippet).toContain("reverse_proxy backend:4000");
    expect(snippet).toContain("handle {");
    expect(snippet).toContain("reverse_proxy frontend:80");
  });

  it("respects --no-www option", () => {
    const snippet = generateCaddyfileSnippet({
      domain: "example.com",
      upstream: "web:3000",
      noWww: true,
    });

    expect(snippet).not.toContain("www.example.com {");
  });
});
