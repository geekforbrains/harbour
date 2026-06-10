// In-memory fixed-window rate limiting for the public auth endpoints. Harbour
// runs as a single Next.js process with no Redis or background workers, so a
// per-process Map is the right home for this state. Expired entries are pruned
// lazily (at most once per window) so the map can't grow unbounded under a
// scan of many distinct keys.

type Entry = { count: number; windowStart: number };

export interface RateLimiter {
  /** True when the key has exhausted its budget for the current window. */
  isLimited(key: string): boolean;
  /** Count one attempt against the key, starting a window if needed. */
  record(key: string): void;
  /** Forget one key (e.g. after a successful login), or all keys if omitted. */
  reset(key?: string): void;
  /** Number of tracked keys after pruning — exposed for tests. */
  size(): number;
}

export function createRateLimiter(opts: { limit: number; windowMs: number }): RateLimiter {
  const { limit, windowMs } = opts;
  const entries = new Map<string, Entry>();
  let lastPrune = Date.now();

  function prune(now: number) {
    if (now - lastPrune < windowMs) return;
    lastPrune = now;
    for (const [key, entry] of entries) {
      if (now - entry.windowStart >= windowMs) entries.delete(key);
    }
  }

  // Return the key's entry if its window is still open; drop it otherwise.
  function live(key: string, now: number): Entry | undefined {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (now - entry.windowStart >= windowMs) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    isLimited(key) {
      const now = Date.now();
      prune(now);
      const entry = live(key, now);
      return !!entry && entry.count >= limit;
    },
    record(key) {
      const now = Date.now();
      prune(now);
      const entry = live(key, now);
      if (entry) entry.count++;
      else entries.set(key, { count: 1, windowStart: now });
    },
    reset(key) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * Best-effort client IP: first hop of x-forwarded-for (set by the reverse
 * proxy in production), else "unknown". Direct connections without a proxy all
 * share the "unknown" bucket — acceptable for a single-operator install.
 */
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || "unknown";
}

// Shared limiters for the two intentionally-public auth routes.
// Login: 5 failed attempts per email+IP per 15 minutes (success clears the key).
export const loginLimiter = createRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });
// Set-password: 5 attempts per IP per hour, success or not.
export const setPasswordLimiter = createRateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });
