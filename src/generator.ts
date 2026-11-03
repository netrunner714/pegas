import { RouteSnippetOptions } from "./types.js";

export function buildCorsOriginRegex(domains: string[] = [], customOrigins?: string[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const d of domains) {
    const clean = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      parts.push(clean.replace(/\./g, "\\."));
    }
  }

  // Always allow localhost and 127.0.0.1
  if (!seen.has("localhost")) {
    seen.add("localhost");
    parts.push("localhost(:\\d+)?");
  }
  if (!seen.has("127.0.0.1")) {
    seen.add("127.0.0.1");
    parts.push("127\\.0\\.0\\.1(:\\d+)?");
  }

  if (customOrigins && customOrigins.length > 0) {
    for (const o of customOrigins) {
      const clean = o.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        parts.push(clean.replace(/\./g, "\\."));
      }
    }
  }

  return `^https?:\\/\\/(${parts.join("|")})$`;
}

function isSubdomainOrIp(domain: string): boolean {
  // If IP address
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(domain) || domain.includes(":")) {
    return true;
  }
  // If starts with www. or localhost
  if (domain.startsWith("www.") || domain === "localhost") {
    return true;
  }
  // Check dot parts (e.g., example.com -> 2 parts, api.example.com -> 3 parts)
  const parts = domain.split(".");
  return parts.length > 2;
}

export function generateCaddyfileSnippet(options: RouteSnippetOptions): string {
  const {
    domain,
    upstream,
    spa = false,
    apiUpstream,
    apiPrefix = "/api/*",
    noWww = false,
    security = true,
    routes,
    cors,
    corsOrigins,
  } = options;

  const lines: string[] = [];

  // WWW -> Root redirect (only for 2nd-level domains if noWww is false)
  if (!noWww && !isSubdomainOrIp(domain)) {
    lines.push(`www.${domain} {`);
    lines.push(`    redir https://${domain}{uri} permanent`);
    lines.push(`}`);
    lines.push(``);
  }

  // Main domain block
  lines.push(`${domain} {`);

  // Upstream routing
  if (cors) {
    const corsOpts = typeof cors === "object" && !Array.isArray(cors) && cors !== null ? cors : {};
    const customOrigins = Array.isArray(cors) ? cors : corsOpts.origins;
    const origins = corsOrigins || [];
    const methods = corsOpts.methods || ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"];
    const headers = corsOpts.headers || [
      "Content-Type",
      "Authorization",
      "x-telegram-init-data",
      "X-Requested-With",
      "Accept",
      "Origin",
    ];
    const credentials = corsOpts.credentials !== false;
    const maxAge = corsOpts.maxAge ?? 86400;
    const exposeHeaders = corsOpts.exposeHeaders;

    const regexPattern = buildCorsOriginRegex(origins, customOrigins);

    lines.push(`    encode gzip zstd`);
    lines.push(``);
    lines.push(`    @cors_origin header_regexp Origin ${regexPattern}`);
    lines.push(`    @cors_preflight {`);
    lines.push(`        method OPTIONS`);
    lines.push(`        header_regexp Origin ${regexPattern}`);
    lines.push(`    }`);
    lines.push(`    handle @cors_preflight {`);
    lines.push(`        header Access-Control-Allow-Origin "{header.Origin}"`);
    lines.push(`        header Access-Control-Allow-Methods "${methods.join(", ")}"`);
    lines.push(`        header Access-Control-Allow-Headers "${headers.join(", ")}"`);
    if (exposeHeaders && exposeHeaders.length > 0) {
      lines.push(`        header Access-Control-Expose-Headers "${exposeHeaders.join(", ")}"`);
    }
    if (credentials) {
      lines.push(`        header Access-Control-Allow-Credentials "true"`);
    }
    lines.push(`        header Access-Control-Max-Age "${maxAge}"`);
    lines.push(`        header Vary "Origin"`);
    lines.push(`        respond "" 204`);
    lines.push(`    }`);
    lines.push(``);

    const corsHeaderDown = [
      `            header_down -Access-Control-Allow-Origin`,
      `            header_down -Access-Control-Allow-Credentials`,
      `            header_down -Access-Control-Allow-Methods`,
      `            header_down -Access-Control-Allow-Headers`,
      `            header_down -Access-Control-Expose-Headers`,
    ].join("\n");

    if (routes && Object.keys(routes).length > 0) {
      for (const [pathPrefix, target] of Object.entries(routes)) {
        const targetUpstream = typeof target === "string" ? target : target.to;
        lines.push(`    handle ${pathPrefix} {`);
        lines.push(`        header @cors_origin Access-Control-Allow-Origin "{header.Origin}"`);
        lines.push(`        header @cors_origin Vary "Origin"`);
        if (credentials) {
          lines.push(`        header @cors_origin Access-Control-Allow-Credentials "true"`);
        }
        if (exposeHeaders && exposeHeaders.length > 0) {
          lines.push(`        header @cors_origin Access-Control-Expose-Headers "${exposeHeaders.join(", ")}"`);
        }
        lines.push(`        reverse_proxy ${targetUpstream} {`);
        lines.push(corsHeaderDown);
        lines.push(`        }`);
        lines.push(`    }`);
        lines.push(``);
      }
    }

    lines.push(`    handle {`);
    lines.push(`        header @cors_origin Access-Control-Allow-Origin "{header.Origin}"`);
    lines.push(`        header @cors_origin Vary "Origin"`);
    if (credentials) {
      lines.push(`        header @cors_origin Access-Control-Allow-Credentials "true"`);
    }
    if (exposeHeaders && exposeHeaders.length > 0) {
      lines.push(`        header @cors_origin Access-Control-Expose-Headers "${exposeHeaders.join(", ")}"`);
    }
    lines.push(`        reverse_proxy ${upstream || "app:3000"} {`);
    lines.push(corsHeaderDown);
    lines.push(`        }`);
    lines.push(`    }`);
  } else if (routes && Object.keys(routes).length > 0) {
    lines.push(`    encode gzip zstd`);
    lines.push(``);
    for (const [pathPrefix, target] of Object.entries(routes)) {
      const targetUpstream = typeof target === "string" ? target : target.to;
      lines.push(`    handle ${pathPrefix} {`);
      lines.push(`        reverse_proxy ${targetUpstream}`);
      lines.push(`    }`);
      lines.push(``);
    }
    lines.push(`    handle {`);
    lines.push(`        reverse_proxy ${upstream || "app:80"}`);
    lines.push(`    }`);
  } else if (spa && apiUpstream) {
    lines.push(`    encode gzip zstd`);
    lines.push(``);
    lines.push(`    handle ${apiPrefix} {`);
    lines.push(`        reverse_proxy ${apiUpstream}`);
    lines.push(`    }`);
    lines.push(``);
    lines.push(`    handle {`);
    lines.push(`        reverse_proxy ${upstream || "app:80"}`);
    lines.push(`    }`);
  } else {
    lines.push(`    reverse_proxy ${upstream || "app:3000"}`);
    lines.push(``);
    lines.push(`    encode gzip zstd`);
  }

  // Security headers
  if (security) {
    lines.push(``);
    lines.push(`    header {`);
    lines.push(`        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"`);
    lines.push(`        X-Content-Type-Options nosniff`);
    lines.push(`        Referrer-Policy strict-origin-when-cross-origin`);
    lines.push(`    }`);
  }

  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}
