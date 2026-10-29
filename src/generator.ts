import { RouteSnippetOptions } from "./types.js";

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
  if (spa && apiUpstream) {
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
