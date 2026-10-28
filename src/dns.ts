import dns from "node:dns/promises";
import https from "node:https";

export interface DnsValidationOptions {
  skipDnsCheck?: boolean;
  strictDns?: boolean;
  serverIp?: string;
  json?: boolean;
  noExit?: boolean;
}

export interface DnsValidationResult {
  valid: boolean;
  warnings: string[];
  serverIp?: string;
}

function fetchIpFromUrl(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data.trim()));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });

    req.on("error", reject);
  });
}

/**
 * Discovers the server's public IPv4 address with zero external dependencies.
 * Respects PEGAS_SERVER_IP environment variable override.
 */
export async function getPublicIp(timeoutMs = 2500): Promise<string> {
  if (process.env.PEGAS_SERVER_IP) {
    return process.env.PEGAS_SERVER_IP.trim();
  }

  try {
    return await fetchIpFromUrl("https://api.ipify.org", timeoutMs);
  } catch {
    // Fallback to icanhazip
    return await fetchIpFromUrl("https://icanhazip.com", timeoutMs);
  }
}

/**
 * Checks whether a domain should be validated via public DNS.
 * Skips localhost, local development domains, and IP addresses.
 */
export function isPublicDomain(domain: string): boolean {
  const clean = domain.trim().toLowerCase();
  if (!clean || clean === "yourdomain.com") return false;
  if (clean === "localhost" || clean.endsWith(".localhost")) return false;
  if (clean.endsWith(".local") || clean.endsWith(".test") || clean.endsWith(".internal")) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(clean) || clean.includes(":")) return false;
  return clean.includes(".");
}

/**
 * Validates production domains against the server's public IP address before
 * configuring Caddy routes. Protects against Let's Encrypt ACME rate limit bans.
 */
export async function validateDomains(
  domains: string[],
  options: DnsValidationOptions = {}
): Promise<DnsValidationResult> {
  if (options.skipDnsCheck || !domains || domains.length === 0) {
    return { valid: true, warnings: [] };
  }

  const targets = [...new Set(domains.map((d) => d.trim()))].filter(isPublicDomain);
  if (targets.length === 0) {
    return { valid: true, warnings: [] };
  }

  let serverIp = options.serverIp;
  if (!serverIp) {
    try {
      serverIp = await getPublicIp();
    } catch {
      const msg = "⚠️  Warning: Unable to determine server's public IP. Skipping DNS pre-flight verification.";
      if (!options.json) {
        console.warn(msg);
      }
      return { valid: true, warnings: [msg] };
    }
  }

  const warnings: string[] = [];
  let hasMismatches = false;

  for (const domain of targets) {
    try {
      const records = await dns.resolve4(domain);

      if (!records.includes(serverIp)) {
        const warn = `⚠️  DNS Warning: '${domain}' resolves to ${records.join(", ")}, but this server's public IP is ${serverIp}.\n    Let's Encrypt SSL certificate issuance will fail until DNS propagates.`;
        warnings.push(warn);
        hasMismatches = true;
        if (!options.json) {
          console.warn(`\n${warn}`);
        }
      }
    } catch (err: any) {
      if (err.code === "ENOTFOUND" || err.code === "ENODATA") {
        const warn = `⚠️  DNS Warning: '${domain}' does not resolve to any IPv4 address (ENOTFOUND).\n    Let's Encrypt SSL certificate issuance will fail until DNS propagates.`;
        warnings.push(warn);
        hasMismatches = true;
        if (!options.json) {
          console.warn(`\n${warn}`);
        }
      } else {
        const warn = `⚠️  DNS Warning: Failed to query DNS for '${domain}': ${err.message}`;
        warnings.push(warn);
        if (!options.json) {
          console.warn(`\n${warn}`);
        }
      }
    }
  }

  if (hasMismatches && options.strictDns) {
    const errMsg = "❌ Error: Strict DNS check failed (--strict-dns). Deploy aborted to prevent Let's Encrypt rate limits.";
    if (!options.json) {
      console.error(`\n${errMsg}`);
    }
    return {
      valid: false,
      warnings,
      serverIp,
    };
  }

  return {
    valid: !hasMismatches,
    warnings,
    serverIp,
  };
}
