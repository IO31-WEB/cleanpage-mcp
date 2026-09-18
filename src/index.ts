import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { getConfig } from "./config";
import {
  handleMcpRequest,
  isPaidToolCall,
  extractRequestedUrl,
  type JsonRpcRequest,
} from "./mcp/server";
import {
  buildChallenge,
  buildPaymentRequirements,
  decodePaymentHeader,
  encodeSettlementResponse,
  settlePayment,
  verifyPayment,
} from "./payments/x402";
import { checkFreeRateLimit, getAnalytics, recordCall } from "./middleware/limits";
import { buildToolDefinitions } from "./mcp/tools";
import { extractCleanPage, ExtractionError } from "./extraction/extractor";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "X-PAYMENT"], exposeHeaders: ["X-PAYMENT-RESPONSE"] }));

// ---------------------------------------------------------------------------
// Free discovery endpoints (also mirrored as MCP tools health/list_capabilities/pricing)
// ---------------------------------------------------------------------------

app.get("/health", (c) => c.json({ status: "ok", service: "cleanpage", time: new Date().toISOString() }));

app.get("/capabilities", (c) => {
  const config = getConfig(c.env);
  return c.json({ server: "cleanpage", version: "1.0.0", tools: buildToolDefinitions(config) });
});

app.get("/pricing", (c) => {
  const config = getConfig(c.env);
  return c.json({
    clean_page: {
      price_usd: config.priceUsd,
      currency: "USDC",
      network: config.network,
      scheme: "x402/exact",
      payTo: config.paymentAddress,
      facilitator: config.facilitatorUrl,
    },
  });
});

app.get("/analytics", async (c) => {
  // Basic, non-sensitive aggregate counters — safe to expose publicly so
  // agents/humans can gauge reliability before paying. Remove or auth-gate
  // this route if you'd rather keep revenue figures private.
  const snap = await getAnalytics(c.env);
  return c.json(snap);
});

// ---------------------------------------------------------------------------
// Free, rate-limited, truncated demo endpoint for the landing page's "paste
// a URL, see sample output" widget. This is NOT the paid tool — output is
// capped and unsuitable for real agent use, existing purely so a human (or
// a curious agent) can preview quality before paying for clean_page.
// ---------------------------------------------------------------------------
app.post("/api/demo", async (c) => {
  const env = c.env;
  const config = getConfig(env);
  const clientKey = c.req.header("cf-connecting-ip") || "unknown";
  const { allowed } = await checkFreeRateLimit(env, `demo:${clientKey}`, Math.max(5, Math.floor(config.freeRateLimitPerMin / 2)));
  if (!allowed) {
    return c.json({ error: true, message: "Demo rate limit reached. Try again in a minute, or call the paid tool directly." }, 429);
  }

  let payload: { url?: string };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: true, message: "Invalid JSON body; expected { url }." }, 400);
  }
  if (!payload.url) {
    return c.json({ error: true, message: "Missing required field: url" }, 400);
  }

  try {
    const result = await extractCleanPage(payload.url, { max_length: 700, include_images: false });
    return c.json({
      title: result.title,
      clean_markdown: result.clean_markdown,
      metadata: result.metadata,
      quality_score: result.quality_score,
      note: "Demo output is truncated to 700 characters and excludes images/facts. Call the clean_page MCP tool for full output.",
    });
  } catch (err) {
    const e = err instanceof ExtractionError ? err : null;
    return c.json(
      {
        error: true,
        error_code: e?.code ?? "INTERNAL_ERROR",
        message: e?.message ?? (err instanceof Error ? err.message : "Extraction failed"),
      },
      422
    );
  }
});

// ---------------------------------------------------------------------------
// MCP endpoint — Streamable HTTP transport (stateless): a single POST
// endpoint accepting JSON-RPC 2.0 requests/notifications and returning
// JSON-RPC responses. This implements the wire protocol directly (rather
// than depending on a Node-oriented SDK transport) so it runs natively on
// Cloudflare Workers. See README "MCP transport" for details.
// ---------------------------------------------------------------------------

app.post("/mcp", async (c) => {
  const env = c.env;
  const config = getConfig(env);

  let body: JsonRpcRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON body" } },
      400
    );
  }

  // --- Free-tier rate limiting for non-paid calls (abuse protection) ---
  if (!isPaidToolCall(body)) {
    const clientKey = c.req.header("cf-connecting-ip") || "unknown";
    const { allowed } = await checkFreeRateLimit(env, clientKey, config.freeRateLimitPerMin);
    if (!allowed) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32000, message: "Rate limit exceeded. Slow down and retry shortly." },
        },
        429
      );
    }
    const result = await handleMcpRequest(body, env, config);
    return result ? c.json(result) : c.body(null, 204);
  }

  // --- x402 payment gate for clean_page ---
  const requestedUrl = extractRequestedUrl(body) || "unknown";
  const resource = `${config.publicBaseUrl}/mcp#clean_page:${requestedUrl}`;
  const requirements = buildPaymentRequirements(
    config,
    resource,
    `Extract clean, structured content from ${requestedUrl}`
  );

  const paymentHeader = c.req.header("x-payment") || c.req.header("X-PAYMENT") || null;
  const paymentPayload = decodePaymentHeader(paymentHeader);

  if (!paymentPayload) {
    return c.json(buildChallenge(requirements), 402);
  }

  const verification = await verifyPayment(config.facilitatorUrl, paymentPayload, requirements);
  if (!verification.isValid) {
    return c.json(
      { ...buildChallenge(requirements), error: `payment_invalid: ${verification.invalidReason ?? "unknown"}` },
      402
    );
  }

  // Payment verified — do the paid work. We only settle (broadcast on-chain)
  // AFTER a successful extraction, so a failed extraction never charges the
  // agent even though verification succeeded.
  let mcpResult;
  let outcome: "success" | "failure" = "failure";
  try {
    mcpResult = await handleMcpRequest(body, env, config);
    const isToolError = (mcpResult?.result as any)?.isError;
    outcome = isToolError ? "failure" : "success";
  } catch (err) {
    await recordCall(env, "failure", config.priceUsd);
    return c.json(
      { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32603, message: "Internal error during extraction" } },
      500
    );
  }

  if (outcome === "failure") {
    await recordCall(env, "failure", config.priceUsd);
    return c.json(mcpResult);
  }

  const settlement = await settlePayment(config.facilitatorUrl, paymentPayload, requirements);
  await recordCall(env, settlement.success ? "success" : "failure", config.priceUsd);

  if (!settlement.success) {
    // Extraction succeeded but settlement failed (e.g. facilitator hiccup).
    // Surface this transparently rather than silently eating the cost.
    return c.json(
      {
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: { code: -32001, message: `Extraction succeeded but payment settlement failed: ${settlement.error}` },
      },
      402
    );
  }

  const settlementHeader = encodeSettlementResponse(settlement);
  c.header("X-PAYMENT-RESPONSE", settlementHeader);
  return c.json(mcpResult);
});

// GET on /mcp is not part of the stateless flow here (no server-initiated SSE
// stream); respond with a friendly pointer for humans/browsers hitting it.
app.get("/mcp", (c) =>
  c.json({
    message: "This is the CleanPage MCP endpoint. Send JSON-RPC 2.0 requests via POST.",
    docs: `${getConfig(c.env).publicBaseUrl}/`,
  })
);

// ---------------------------------------------------------------------------
// Fallback to static assets (landing page, docs, .well-known/*, robots.txt, llms.txt)
//
// Note: some local dev tooling versions mishandle dotfolder paths like
// /.well-known/*, so those two discovery files are also served directly
// below as a robustness fallback that doesn't depend on the assets binding.
// In production on Cloudflare's Workers Static Assets, dotfolder paths are
// served normally and this fallback is simply never reached.
// ---------------------------------------------------------------------------
app.get("/.well-known/agent.json", async (c) => {
  try {
    const res = await c.env.ASSETS.fetch(new Request(new URL("/.well-known/agent.json", c.req.url)));
    if (res.ok) return res;
  } catch {
    /* fall through to generated copy below, kept in sync with public/.well-known/agent.json */
  }
  const config = getConfig(c.env);
  return c.json({
    name: "CleanPage",
    description:
      "Turns any URL into clean, structured, agent-optimized content: markdown, plain text, metadata, links, structured facts, and a quality score.",
    version: "1.0.0",
    provider: { name: "CleanPage", url: config.publicBaseUrl },
    mcp: {
      endpoint: `${config.publicBaseUrl}/mcp`,
      transport: "streamable-http",
      discovery: `${config.publicBaseUrl}/.well-known/mcp.json`,
    },
    capabilities: buildToolDefinitions(config).map((t) => ({
      id: t.name,
      type: "mcp_tool",
      paid: t.paid,
      description: t.description,
    })),
    payments: {
      protocol: "x402",
      network: config.network,
      asset: "USDC",
      payTo: config.paymentAddress,
      facilitator: config.facilitatorUrl,
    },
    authentication: "none",
    documentation: config.publicBaseUrl,
    llms_txt: `${config.publicBaseUrl}/llms.txt`,
  });
});

app.get("/.well-known/mcp.json", async (c) => {
  try {
    const res = await c.env.ASSETS.fetch(new Request(new URL("/.well-known/mcp.json", c.req.url)));
    if (res.ok) return res;
  } catch {
    /* fall through to generated copy below, kept in sync with public/.well-known/mcp.json */
  }
  const config = getConfig(c.env);
  return c.json({
    name: "cleanpage",
    display_name: "CleanPage",
    description: "Clean, structured, agent-optimized web content extraction.",
    version: "1.0.0",
    protocol_version: "2025-03-26",
    endpoint: `${config.publicBaseUrl}/mcp`,
    transport: "streamable-http",
    stateless: true,
    auth: {
      type: "none",
      payment: {
        type: "x402",
        scheme: "exact",
        network: config.network,
        asset: "USDC",
        facilitator: config.facilitatorUrl,
      },
    },
    tools: buildToolDefinitions(config).map((t) => ({ name: t.name, paid: t.paid, price_usd: t.price_usd })),
    example_client_config: {
      mcpServers: { cleanpage: { url: `${config.publicBaseUrl}/mcp`, transport: "streamable-http" } },
    },
  });
});

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
