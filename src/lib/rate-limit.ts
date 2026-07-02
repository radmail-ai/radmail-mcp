// Lightweight in-memory sliding-window rate limiter for the zero-auth hosted
// MCP endpoint (api/mcp.ts). Ported from radmail-web src/lib/rate-limit.ts
// (2026-07-02 fleet errors/perf/cost sweep): the web repo's sandbox MCP got
// this throttle when it shipped, but the sibling hosted radmail-mcp function
// never did — an anonymous agent could loop unmetered tool calls (each one
// exercises triage/search/demand-sink compute) limited only by maxDuration.
//
// Caveat (same as the web repo): per-instance memory. On Vercel Fluid Compute
// a determined distributed attacker gets `limit × instance_count` — this is a
// casual-abuse speed bump, not a DDoS shield. Durable (Upstash/KV) limiter is
// the upgrade path if real abuse appears.

type Hit = { count: number; resetAt: number };

const BUCKETS = new Map<string, Hit>();

// Bound the map so a spray of unique IPs can't grow it without limit.
const MAX_KEYS = 10_000;

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Returns ok:false once `limit` requests for `key` have arrived inside
 * `windowMs`. Window is fixed-per-key (resets `windowMs` after the first hit).
 */
export function checkRateLimit(key: string, limit = 60, windowMs = 60_000): RateLimitResult {
  const now = Date.now();
  const existing = BUCKETS.get(key);

  if (!existing || now >= existing.resetAt) {
    if (BUCKETS.size >= MAX_KEYS) {
      // Drop expired entries before inserting a fresh one.
      for (const [k, v] of BUCKETS) {
        if (now >= v.resetAt) BUCKETS.delete(k);
      }
    }
    BUCKETS.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit) {
    return { ok: false, remaining: 0, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
  }

  existing.count += 1;
  return { ok: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
}

/** Best-effort client IP from the edge headers Vercel sets. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
