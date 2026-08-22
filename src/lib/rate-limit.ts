/**
 * Fixed-window rate limiter, in memory.
 *
 * Honest about what this is: process-local. On a single instance it is exact; across several
 * serverless instances each keeps its own window, so the effective limit is the configured
 * limit multiplied by the instance count. That is acceptable here because the limiter exists
 * to stop accidental hammering and to bound Alpaca API usage, not to enforce a billing quota
 * — and because every path it guards is *already* protected by the operator token and the
 * risk engine. Swapping in Redis would make it exact; nothing else would need to change.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Unix ms at which the current window resets. */
  resetAt: number;
  /** Seconds the caller should wait, for the Retry-After header. */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Bounds memory if a caller is cycling through spoofed keys. */
const MAX_TRACKED_KEYS = 10_000;

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  const existing = windows.get(key);

  if (!existing || now >= existing.resetAt) {
    if (windows.size >= MAX_TRACKED_KEYS) evictExpired(now);
    const fresh: Window = { count: 1, resetAt: now + windowMs };
    windows.set(key, fresh);
    return { allowed: true, remaining: limit - 1, resetAt: fresh.resetAt, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  const remaining = Math.max(0, limit - existing.count);
  const allowed = existing.count <= limit;
  return {
    allowed,
    remaining,
    resetAt: existing.resetAt,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

function evictExpired(now: number) {
  for (const [key, window] of windows) {
    if (now >= window.resetAt) windows.delete(key);
  }
  // Still full of live windows: drop the oldest so memory stays bounded under attack.
  if (windows.size >= MAX_TRACKED_KEYS) {
    const oldest = [...windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt).slice(0, MAX_TRACKED_KEYS / 2);
    for (const [key] of oldest) windows.delete(key);
  }
}

/**
 * Best-effort client identity. Behind Vercel/most proxies `x-forwarded-for` is set by the
 * platform; the leftmost entry is the client. It is spoofable in principle, which is why it
 * is never used for authorization — only for throttling.
 */
export function clientKey(request: Request, scope: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "local";
  return `${scope}:${ip}`;
}

/** Test seam: the module-level map would otherwise leak state between cases. */
export function resetRateLimits() {
  windows.clear();
}

export function rateLimitHeaders(result: RateLimitResult, limit: number): Record<string, string> {
  const headers: Record<string, string> = {
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(result.remaining),
    "x-ratelimit-reset": String(Math.ceil(result.resetAt / 1000)),
  };
  if (!result.allowed) headers["retry-after"] = String(result.retryAfterSeconds);
  return headers;
}
