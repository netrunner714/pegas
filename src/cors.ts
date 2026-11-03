/**
 * Utility to extract allowed CORS origins for a Pegas project.
 * Reads from PEGAS_ALLOWED_ORIGINS environment variable injected by Pegas,
 * or allows passing explicit origins.
 */
export function getPegasAllowedOrigins(explicitOrigins?: string[]): string[] {
  const fromEnv = (process.env.PEGAS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...fromEnv, ...(explicitOrigins || [])]));
}

/**
 * Returns a predicate function suitable for Hono, Express, Fastify CORS origin options:
 * `origin: isPegasOriginAllowed()`
 */
export function isPegasOriginAllowed(explicitOrigins?: string[]): (origin: string | undefined) => boolean {
  const allowed = getPegasAllowedOrigins(explicitOrigins);
  return (origin?: string): boolean => {
    if (!origin) return true; // allow same-origin, mobile apps, curl, server-to-server
    try {
      const url = new URL(origin);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
      if (allowed.some((a) => a === origin || a === `${url.protocol}//${url.host}`)) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };
}
