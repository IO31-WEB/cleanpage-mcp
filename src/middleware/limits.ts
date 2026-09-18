import type { Env } from "../types";

/**
 * Simple fixed-window rate limiter for free/discovery endpoints, backed by KV.
 * Paid tool calls are NOT rate-limited here — payment itself is the throttle —
 * but abuse protection (e.g. repeated failed-payment probing) can layer on top.
 */
export async function checkFreeRateLimit(
  env: Env,
  clientKey: string,
  limitPerMin: number
): Promise<{ allowed: boolean; remaining: number }> {
  const window = Math.floor(Date.now() / 60_000); // 1-minute buckets
  const key = `ratelimit:${clientKey}:${window}`;

  const current = Number.parseInt((await env.CLEANPAGE_KV.get(key)) || "0", 10);
  if (current >= limitPerMin) {
    return { allowed: false, remaining: 0 };
  }

  // Best-effort increment; small race window is acceptable for this purpose.
  await env.CLEANPAGE_KV.put(key, String(current + 1), { expirationTtl: 90 });
  return { allowed: true, remaining: limitPerMin - current - 1 };
}

export interface AnalyticsSnapshot {
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  total_revenue_usd: number;
}

const ANALYTICS_KEY = "analytics:v1";

export async function recordCall(
  env: Env,
  outcome: "success" | "failure",
  priceUsd: number
): Promise<void> {
  const raw = await env.CLEANPAGE_KV.get(ANALYTICS_KEY);
  const snap: AnalyticsSnapshot = raw
    ? JSON.parse(raw)
    : { total_calls: 0, successful_calls: 0, failed_calls: 0, total_revenue_usd: 0 };

  snap.total_calls += 1;
  if (outcome === "success") {
    snap.successful_calls += 1;
    snap.total_revenue_usd += priceUsd;
  } else {
    snap.failed_calls += 1;
  }

  // Fire-and-forget style write; callers should not block the response on this.
  await env.CLEANPAGE_KV.put(ANALYTICS_KEY, JSON.stringify(snap));
}

export async function getAnalytics(env: Env): Promise<AnalyticsSnapshot> {
  const raw = await env.CLEANPAGE_KV.get(ANALYTICS_KEY);
  return raw
    ? JSON.parse(raw)
    : { total_calls: 0, successful_calls: 0, failed_calls: 0, total_revenue_usd: 0 };
}
