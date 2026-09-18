import type { Env } from "./types";

/** Derives runtime configuration from environment bindings/vars. */
export function getConfig(env: Env) {
  const priceUsd = Number.parseFloat(env.CLEAN_PAGE_PRICE_USD || "0.02");
  if (Number.isNaN(priceUsd) || priceUsd <= 0) {
    throw new Error("CLEAN_PAGE_PRICE_USD must be a positive number");
  }

  return {
    paymentAddress: env.PAYMENT_ADDRESS,
    network: env.X402_NETWORK || "base-sepolia",
    facilitatorUrl: env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
    priceUsd,
    priceDisplay: `$${priceUsd.toFixed(2)} USDC`,
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    freeRateLimitPerMin: Number.parseInt(env.FREE_RATE_LIMIT_PER_MIN || "30", 10),
    llmEnrichmentEnabled: env.ENABLE_LLM_ENRICHMENT === "true" && !!env.ANTHROPIC_API_KEY,
    llmModel: env.LLM_MODEL || "claude-haiku-4-5-20251001",
  };
}

export type CleanPageConfig = ReturnType<typeof getConfig>;
