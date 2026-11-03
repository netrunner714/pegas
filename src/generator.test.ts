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

  it("generates multi-path route handlers when routes are specified", () => {
    const snippet = generateCaddyfileSnippet({
      domain: "hub.example.com",
      upstream: "frontend:80",
      routes: {
        "/api/*": "backend:3000",
        "/socket.io/*": { to: "ws:4000", websocket: true },
      },
    });

    expect(snippet).toContain("hub.example.com {");
    expect(snippet).toContain("handle /api/* {");
    expect(snippet).toContain("reverse_proxy backend:3000");
    expect(snippet).toContain("handle /socket.io/* {");
    expect(snippet).toContain("reverse_proxy ws:4000");
    expect(snippet).toContain("handle {");
    expect(snippet).toContain("reverse_proxy frontend:80");
  });

  it("generates automatic CORS preflight and origin validation handlers", () => {
    const snippet = generateCaddyfileSnippet({
      domain: "api.example.com",
      upstream: "api:3001",
      cors: true,
      corsOrigins: ["example.com", "vibedb.example.com"],
    });

    expect(snippet).toContain("api.example.com {");
    expect(snippet).toContain("@cors_origin header_regexp Origin");
    expect(snippet).toContain("example\\.com|vibedb\\.example\\.com");
    expect(snippet).toContain("@cors_preflight {");
    expect(snippet).toContain("method OPTIONS");
    expect(snippet).toContain("handle @cors_preflight {");
    expect(snippet).toContain('header Access-Control-Allow-Origin "{header.Origin}"');
    expect(snippet).toContain('header Access-Control-Allow-Methods');
    expect(snippet).toContain('header Access-Control-Allow-Credentials "true"');
    expect(snippet).toContain('respond "" 204');
    expect(snippet).toContain('header Vary "Origin"');
    expect(snippet).toContain("handle {");
    expect(snippet).toContain('header @cors_origin Access-Control-Allow-Origin "{header.Origin}"');
    expect(snippet).toContain('header @cors_origin Vary "Origin"');
    expect(snippet).toContain("reverse_proxy api:3001 {");
    expect(snippet).toContain("header_down -Access-Control-Allow-Origin");
    expect(snippet).toContain("header_down -Access-Control-Allow-Credentials");
  });
});
