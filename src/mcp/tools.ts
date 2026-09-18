import { z } from "zod";
import type { CleanPageConfig } from "../config";

/**
 * JSON Schema (not Zod) is what we advertise to MCP clients in tools/list,
 * since that's the wire format the MCP spec uses. Zod schemas below are used
 * server-side to validate incoming tool arguments.
 */

export const cleanPageArgsSchema = z.object({
  url: z.string().url().describe("Absolute URL of the page to extract (http/https only)."),
  options: z
    .object({
      include_images: z.boolean().optional().describe("Include extracted image URLs. Default true."),
      max_length: z
        .number()
        .int()
        .positive()
        .max(200_000)
        .optional()
        .describe("Truncate clean_markdown/plain_text to this many characters."),
      language: z.string().optional().describe("ISO language hint, e.g. 'en'."),
      extract_facts: z
        .boolean()
        .optional()
        .describe("Run structured fact/claim extraction. Adds latency, no extra charge."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(20_000)
        .optional()
        .describe("Fetch timeout in milliseconds (max 20000). Default 10000."),
    })
    .optional(),
});

export function buildToolDefinitions(config: CleanPageConfig) {
  return [
    {
      name: "clean_page",
      description:
        `Fetches a URL and returns clean, structured, agent-optimized content: ` +
        `readable markdown, plain text, metadata (author/date/site/word count), ` +
        `extracted links and images, an optional structured facts array, and a ` +
        `0-100 quality score. Handles common failure modes (paywalls, bot-walls, ` +
        `empty JS shells) with clear typed errors instead of silently returning junk. ` +
        `PAID TOOL: ${config.priceDisplay} per successful call via x402 (USDC on ${config.network}). ` +
        `Call with no payment first to receive the exact payment requirements (HTTP 402), ` +
        `then retry with an X-PAYMENT header. Failed extractions are not charged.`,
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
              include_images: { type: "boolean", description: "Include extracted image URLs. Default true." },
              max_length: {
                type: "integer",
                description: "Truncate clean_markdown/plain_text to this many characters.",
              },
              language: { type: "string", description: "ISO language hint, e.g. 'en'." },
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
      price_usd: config.priceUsd,
      paid: true,
    },
    {
      name: "health",
      description: "Free. Returns service status, version, and uptime signal. Use to check the service is reachable before paying for anything.",
      inputSchema: { type: "object", properties: {} },
      price_usd: 0,
      paid: false,
    },
    {
      name: "list_capabilities",
      description:
        "Free. Returns the full list of tools this server offers, including which are paid, their prices, and their input schemas — so an agent can decide what to call before spending anything.",
      inputSchema: { type: "object", properties: {} },
      price_usd: 0,
      paid: false,
    },
    {
      name: "pricing",
      description:
        "Free. Returns current pricing, accepted payment network/asset, and the x402 payment flow details for paid tools.",
      inputSchema: { type: "object", properties: {} },
      price_usd: 0,
      paid: false,
    },
  ] as const;
}

export type ToolDefinition = ReturnType<typeof buildToolDefinitions>[number];
