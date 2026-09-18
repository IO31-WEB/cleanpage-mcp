import type { CleanPageConfig } from "../config";

/**
 * Minimal, dependency-free implementation of the resource-server side of the
 * x402 protocol (https://x402.org), talking to a facilitator over plain HTTP.
 *
 * Flow:
 *  1. Agent calls the paid tool with no payment -> we return HTTP 402 with a
 *     `paymentRequirements` object describing how to pay.
 *  2. Agent constructs a payment payload (EIP-3009 `transferWithAuthorization`
 *     signature for USDC) and retries the SAME request with an `X-PAYMENT`
 *     header containing the base64-encoded payment payload.
 *  3. We POST the payload + requirements to the facilitator's /verify
 *     endpoint. If valid, we proceed to do the (paid) work.
 *  4. After the work succeeds, we POST to the facilitator's /settle endpoint
 *     to broadcast the transfer on-chain, and echo settlement info back to
 *     the agent via an `X-PAYMENT-RESPONSE` header.
 *
 * Note: because USDC on Base supports EIP-3009 meta-transactions, this
 * server never touches a private key — the facilitator submits the signed
 * authorization on-chain and gas is sponsored by the facilitator. Only
 * PAYMENT_ADDRESS (a public wallet address) is required in configuration.
 */

// USDC contract addresses (6 decimals) — standard, well-known deployments.
const USDC_ASSET: Record<"base" | "base-sepolia", string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export interface PaymentRequirements {
  scheme: "exact";
  network: "base" | "base-sepolia";
  maxAmountRequired: string; // atomic USDC units (6 decimals), as string
  resource: string; // canonical URL/identifier of the paid resource
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
}

export interface X402ChallengeBody {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
  extensions?: {
    bazaar: {
      info: {
        input: {
          type: "mcp";
          toolName: string;
          description: string;
          transport: string;
          inputSchema: Record<string, unknown>;
          example?: Record<string, unknown>;
        };
        output: {
          type: "json";
          example: Record<string, unknown>;
        };
      };
    };
  };
}

export function usdToAtomicUsdc(usd: number): string {
  // USDC has 6 decimals.
  return Math.round(usd * 1_000_000).toString();
}

export function buildPaymentRequirements(
  config: CleanPageConfig,
  resource: string,
  description: string
): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.network,
    maxAmountRequired: usdToAtomicUsdc(config.priceUsd),
    resource,
    description,
    mimeType: "application/json",
    payTo: config.paymentAddress,
    maxTimeoutSeconds: 60,
    asset: USDC_ASSET[config.network],
  };
}

export function buildChallenge(requirements: PaymentRequirements): X402ChallengeBody {
  return {
    x402Version: 1,
    error: "payment_required",
    accepts: [requirements],
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "mcp",
            toolName: "clean_page",
            description:
              "Fetch a URL and return clean markdown, plain text, metadata, links, images, structured facts, and a quality score.",
            transport: "streamable-http",
            inputSchema: {
              type: "object",
              properties: {
                url: {
                  type: "string",
                  format: "uri",
                  description: "Absolute URL of the page to extract (http/https only).",
                },
                options: {
                  type: "object",
                  properties: {
                    include_images: {
                      type: "boolean",
                      description: "Include extracted image URLs. Default true.",
                    },
                    max_length: {
                      type: "integer",
                      description: "Truncate clean_markdown/plain_text to this many characters.",
                    },
                    language: {
                      type: "string",
                      description: "ISO language hint, e.g. 'en'.",
                    },
                    extract_facts: {
                      type: "boolean",
                      description: "Run structured fact/claim extraction. Adds latency, no extra charge.",
                    },
                    timeout_ms: {
                      type: "integer",
                      description: "Fetch timeout in milliseconds (max 20000). Default 10000.",
                    },
                  },
                },
              },
              required: ["url"],
            },
            example: {
              url: "https://en.wikipedia.org/wiki/Model_Context_Protocol",
              options: { extract_facts: true },
            },
          },
          output: {
            type: "json",
            example: {
              title: "Example Page Title",
              clean_markdown: "# Heading\n\nBody text...",
              plain_text: "Heading Body text...",
              quality_score: 85,
              metadata: {
                author: null,
                published: null,
                site_name: "example.com",
                language: "en",
                word_count: 1200,
              },
              links: [],
              images: [],
              structured_facts: [],
              extraction_notes: [],
            },
          },
        },
      },
    },
  };
}

interface FacilitatorVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
}

interface FacilitatorSettleResponse {
  success: boolean;
  error?: string;
  txHash?: string;
  networkId?: string;
}

/** Decodes the X-PAYMENT header (base64 JSON) sent by the paying agent. */
export function decodePaymentHeader(header: string | null): unknown | null {
  if (!header) return null;
  try {
    const json = atob(header);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function verifyPayment(
  facilitatorUrl: string,
  paymentPayload: unknown,
  requirements: PaymentRequirements
): Promise<FacilitatorVerifyResponse> {
  try {
    const res = await fetch(`${facilitatorUrl.replace(/\/$/, "")}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: requirements }),
    });
    if (!res.ok) {
      return { isValid: false, invalidReason: `facilitator_verify_http_${res.status}` };
    }
    return (await res.json()) as FacilitatorVerifyResponse;
  } catch (err) {
    return {
      isValid: false,
      invalidReason: `facilitator_unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function settlePayment(
  facilitatorUrl: string,
  paymentPayload: unknown,
  requirements: PaymentRequirements
): Promise<FacilitatorSettleResponse> {
  try {
    const res = await fetch(`${facilitatorUrl.replace(/\/$/, "")}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: requirements }),
    });
    if (!res.ok) {
      return { success: false, error: `facilitator_settle_http_${res.status}` };
    }
    return (await res.json()) as FacilitatorSettleResponse;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function encodeSettlementResponse(settlement: FacilitatorSettleResponse): string {
  return btoa(JSON.stringify(settlement));
}
