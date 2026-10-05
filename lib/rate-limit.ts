// Sliding-window limits kept in memory per server instance: a guard against runaway loops and
// password guessing, not billing. Spending caps belong in the Google AI Studio project.

const hits = new Map<string, number[]>();

export type Limit = { max: number; windowMs: number };

export const LIMITS = {
  transcribe: { max: 40, windowMs: 60_000 },
  login: { max: 8, windowMs: 10 * 60_000 },
} satisfies Record<string, Limit>;

/** Returns the seconds to wait when the key is over its limit, otherwise records the hit and returns 0. */
export function rateLimit(key: string, limit: Limit, now = Date.now()): number {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < limit.windowMs);
  if (recent.length >= limit.max) {
    hits.set(key, recent);
    return Math.max(1, Math.ceil((limit.windowMs - (now - recent[0])) / 1000));
  }
  recent.push(now);
  hits.set(key, recent);
  return 0;
}

export function resetRateLimits() {
  hits.clear();
}

/** Client address as seen by Vercel (first entry of x-forwarded-for). */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export function tooManyRequests(retryAfter: number, message: string): Response {
  return Response.json(
    { error: message, retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
  );
}
