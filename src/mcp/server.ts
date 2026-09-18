import type { Env } from "../types";
import type { CleanPageConfig } from "../config";
import { buildToolDefinitions, cleanPageArgsSchema } from "./tools";
import { extractCleanPage, ExtractionError } from "../extraction/extractor";
import { extractStructuredFacts } from "../extraction/enrichment";
import { getAnalytics } from "../middleware/limits";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "cleanpage";
const SERVER_VERSION = "1.0.0";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

function ok(id: JsonRpcRequest["id"], result: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function fail(id: JsonRpcRequest["id"], code: number, message: string, data?: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

/** True if this JSON-RPC request is a tools/call invoking the paid `clean_page` tool. */
export function isPaidToolCall(
  body: JsonRpcRequest
): body is JsonRpcRequest & { method: "tools/call"; params: { name: "clean_page" } } {
  return body.method === "tools/call" && body.params?.name === "clean_page";
}

export function extractRequestedUrl(body: JsonRpcRequest): string | undefined {
  return body.params?.arguments?.url;
}

/**
 * Handles a single (already payment-gated, where applicable) JSON-RPC
 * request and returns the JSON-RPC response. Stateless: no session state is
 * kept between calls, which matches the Streamable HTTP transport's
 * stateless mode and Workers' request-scoped execution model.
 */
export async function handleMcpRequest(
  body: JsonRpcRequest,
  env: Env,
  config: CleanPageConfig,
  paymentSettlementHeader?: string
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = body;

  switch (method) {
    case "initialize": {
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          `CleanPage turns any URL into clean, agent-optimized content. ` +
          `Call list_capabilities or pricing first (free) to see costs before calling clean_page (paid, ${config.priceDisplay}/call via x402).`,
      });
    }

    case "notifications/initialized":
      // Notifications have no response per JSON-RPC/MCP spec.
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list": {
      const tools = buildToolDefinitions(config).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
      return ok(id, { tools });
    }

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};

      try {
        if (name === "health") {
          return ok(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { status: "ok", server: SERVER_NAME, version: SERVER_VERSION, time: new Date().toISOString() },
                  null,
                  2
                ),
              },
            ],
          });
        }

        if (name === "list_capabilities") {
          const tools = buildToolDefinitions(config);
          return ok(id, {
            content: [{ type: "text", text: JSON.stringify({ tools }, null, 2) }],
          });
        }

        if (name === "pricing") {
          return ok(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    clean_page: {
                      price_usd: config.priceUsd,
                      currency: "USDC",
                      network: config.network,
                      scheme: "x402/exact",
                      payTo: config.paymentAddress,
                      facilitator: config.facilitatorUrl,
                      flow:
                        "Call clean_page without payment to receive HTTP 402 with payment requirements. " +
                        "Sign and retry with an X-PAYMENT header. Failed extractions are never charged.",
                    },
                  },
                  null,
                  2
                ),
              },
            ],
          });
        }

        if (name === "clean_page") {
          const parsed = cleanPageArgsSchema.safeParse(args);
          if (!parsed.success) {
            return ok(id, {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      error: true,
                      error_code: "INVALID_URL",
                      message: `Invalid arguments: ${parsed.error.message}`,
                      retryable: false,
                    },
                    null,
                    2
                  ),
                },
              ],
            });
          }

          try {
            const result = await extractCleanPage(parsed.data.url, parsed.data.options);

            if (parsed.data.options?.extract_facts) {
              const { facts, note } = await extractStructuredFacts(result.plain_text, env, config);
              result.structured_facts = facts;
              if (note) result.extraction_notes.push(note);
            }

            return ok(id, {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              _meta: paymentSettlementHeader ? { "x402/payment-response": paymentSettlementHeader } : undefined,
            });
          } catch (err) {
            const e =
              err instanceof ExtractionError
                ? err
                : new ExtractionError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err), true);
            return ok(id, {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { error: true, error_code: e.code, message: e.message, retryable: e.retryable },
                    null,
                    2
                  ),
                },
              ],
            });
          }
        }

        return fail(id, ERR.METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      } catch (err) {
        return fail(id, ERR.INTERNAL, err instanceof Error ? err.message : "Internal error");
      }
    }

    default:
      return fail(id, ERR.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

export async function handleAnalytics(env: Env) {
  return getAnalytics(env);
}

export { ERR };
