# CleanPage

A paid MCP tool that turns any URL into clean, structured, agent-optimized content. Agents pay **$0.02 USDC per successful call** via **x402** on **Base** — no accounts, no API keys, no subscriptions.

```
clean_page(url) → { title, clean_markdown, plain_text, structured_facts,
                     metadata, links, images, quality_score, extraction_notes }
```

Built for Cloudflare Workers. Full TypeScript. No paid infra required beyond a domain and a Base wallet address.

---

## How agents use this

1. **Discover** the service for free — no payment needed for any of this:
   - `GET /.well-known/agent.json` — machine-readable capability card
   - `GET /.well-known/mcp.json` — MCP connection + pricing manifest
   - `GET /llms.txt` — plain-text summary for LLM crawlers
   - MCP tools `health`, `list_capabilities`, `pricing` (all free)

2. **Connect** an MCP client to `https://<your-domain>/mcp` over Streamable HTTP:
   ```json
   {
     "mcpServers": {
       "cleanpage": { "url": "https://<your-domain>/mcp", "transport": "streamable-http" }
     }
   }
   ```

3. **Call `clean_page`** with no payment attached first:
   ```
   POST /mcp
   { "jsonrpc": "2.0", "id": 1, "method": "tools/call",
     "params": { "name": "clean_page", "arguments": { "url": "https://example.com/article" } } }
   ```
   The response is **HTTP 402** with an `accepts` array describing exactly what payment is required (amount, network, asset, payee address).

4. **Sign and retry.** Construct a USDC `transferWithAuthorization` (EIP-3009) payment payload for the requested amount, base64-encode it, and retry the *same* request with an `X-PAYMENT` header. Most x402 client libraries (e.g. `x402-fetch`, `x402-axios`) do steps 3–4 for you automatically.

5. **Get the result.** On success, the response carries the full JSON result plus an `X-PAYMENT-RESPONSE` header with the settlement transaction hash. **Failed extractions (paywalls, bot-blocks, empty pages) are never charged** — settlement only happens after a successful extraction.

Full protocol details: see `/llms.txt` and `/.well-known/mcp.json` once deployed, or the "For agents" section of the landing page.

---

## Project structure

```
cleanpage/
├── src/
│   ├── index.ts                # Hono app: routes, x402 payment gate, static asset fallback
│   ├── types.ts                # Shared types (Env, CleanPageResult, etc.)
│   ├── config.ts                # Reads env vars into a typed config object
│   ├── mcp/
│   │   ├── server.ts            # JSON-RPC 2.0 / MCP method dispatcher (stateless)
│   │   └── tools.ts             # Tool schemas + descriptions (clean_page, health, ...)
│   ├── extraction/
│   │   ├── extractor.ts         # Core pipeline: fetch → Readability → markdown/links/metadata
│   │   └── enrichment.ts        # Optional cheap LLM pass for structured_facts
│   ├── payments/
│   │   └── x402.ts              # x402 payment requirements, facilitator verify/settle
│   └── middleware/
│       └── limits.ts            # KV-backed rate limiting + call/revenue analytics
├── public/                       # Static assets served at the Worker's root
│   ├── index.html                # Landing page (live demo, pricing, docs, for-agents)
│   ├── robots.txt                 # Explicitly welcomes agent/LLM crawlers
│   ├── llms.txt                   # Plain-text agent-facing summary
│   └── .well-known/
│       ├── agent.json             # Agent discovery/capability card
│       └── mcp.json               # MCP connection + pricing manifest
├── wrangler.toml                  # Cloudflare Workers config (bindings, vars)
├── package.json
├── tsconfig.json
└── .env.example                   # Documents every config value
```

---

## Architecture notes

**MCP transport.** The MCP Streamable HTTP transport is implemented directly in `src/mcp/server.ts` as a stateless JSON-RPC 2.0 dispatcher (`initialize`, `tools/list`, `tools/call`, `ping`), rather than via the official SDK's Node-oriented HTTP transport class. This is a deliberate choice for correctness on Cloudflare Workers: the SDK's transport targets Node's `http.IncomingMessage`/`ServerResponse`, which Workers doesn't have. The dispatcher here follows the same wire protocol (JSON-RPC over a single POST endpoint, one server-scoped session per request) so any standard MCP client can connect to it. If you later run this on a Node-based host, you can swap in `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` directly.

**Payment gating.** `POST /mcp` peeks at the parsed JSON-RPC body: only `tools/call` requests naming `clean_page` are payment-gated (`src/index.ts`); `health`, `list_capabilities`, `pricing`, and all non-tool-call methods (`initialize`, `tools/list`, etc.) pass straight through, rate-limited but free. This keeps the discovery surface fully open to agents while gating only the one paid capability.

**Settlement timing.** Payment is *verified* before extraction runs, but *settled* (broadcast on-chain) only after extraction succeeds. If extraction fails, the agent's payment authorization is simply discarded — nothing is charged.

**No private key required.** Because USDC on Base supports EIP-3009 meta-transactions, the resource server never holds a private key. `PAYMENT_ADDRESS` is a public wallet address; the facilitator submits the signed authorization on-chain and sponsors gas.

**Extraction engine.** `@mozilla/readability` (the engine behind Firefox Reader Mode) does the core content extraction, running against a DOM built with `linkedom` (a fast, dependency-light DOM implementation that works in Workers — `jsdom` does not). A small hand-written HTML→Markdown walker converts the extracted fragment to markdown, since no existing markdown-conversion library is both Workers-compatible and DOM-based. Heuristics before and after extraction catch common failure modes: paywall markers, bot-check pages, and JS-only empty shells all produce typed errors instead of low-quality output.

**Optional LLM enrichment.** `structured_facts` is populated only when the caller passes `options.extract_facts: true`, and only if `ENABLE_LLM_ENRICHMENT=true` and `ANTHROPIC_API_KEY` is set. It's off the critical path — if the enrichment call fails or is disabled, `clean_page` still returns a complete result with an empty `structured_facts` array and a note explaining why. There's no additional charge for using it.

**Rate limiting & analytics.** Both are implemented with a single KV namespace: a fixed 1-minute-window counter per client IP for free-tier calls, and a running JSON counter object for total calls / successes / failures / revenue, exposed read-only at `GET /analytics`.

---

## Required services / infrastructure

| Component | What you need | Where to get it |
|---|---|---|
| Hosting | Cloudflare Workers (with Static Assets) | [dash.cloudflare.com](https://dash.cloudflare.com) — free tier works to start |
| Domain + DNS | A domain proxied through Cloudflare | Any registrar; add to Cloudflare, point at the Worker |
| Wallet | A Base wallet address (public address only) | Any EVM wallet — Coinbase Wallet, MetaMask, etc. |
| x402 facilitator | Verifies/settles payments | `https://x402.org/facilitator` (testnet-friendly default); Coinbase-operated or self-hosted facilitators for mainnet production volume |
| KV namespace | Rate limiting + analytics storage | `wrangler kv namespace create CLEANPAGE_KV` |
| LLM (optional) | Structured fact extraction | Anthropic API key, only if `ENABLE_LLM_ENRICHMENT=true` |

No database, no queue, no separate backend — everything runs in the one Worker.

---

## Deployment (step by step)

```bash
# 1. Install dependencies
npm install

# 2. Create the KV namespace used for rate limiting + analytics
npx wrangler kv namespace create CLEANPAGE_KV
npx wrangler kv namespace create CLEANPAGE_KV --preview
# Copy the two returned IDs into wrangler.toml under [[kv_namespaces]]

# 3. Edit wrangler.toml [vars]:
#    - PAYMENT_ADDRESS   → your Base wallet address
#    - PUBLIC_BASE_URL   → your real domain, e.g. https://cleanpage.yourdomain.com
#    - X402_NETWORK      → "base-sepolia" while testing, "base" for mainnet
#    Also update the same URLs/addresses in:
#    - public/.well-known/agent.json
#    - public/.well-known/mcp.json
#    - public/llms.txt
#    - public/index.html (og:url, structured data, MCP config example)

# 4. (Optional) enable LLM fact extraction
npx wrangler secret put ANTHROPIC_API_KEY

# 5. Type-check
npm run typecheck

# 6. Deploy
npm run deploy

# 7. Point your domain at the Worker (Cloudflare dashboard → Workers →
#    your worker → Triggers → Custom Domains), or use the workers.dev
#    subdomain Wrangler prints after deploy.
```

### Local development

```bash
npm run dev
# Worker runs at http://localhost:8787
# Try: curl -X POST http://localhost:8787/mcp -H "Content-Type: application/json" \
#        -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Going from testnet to mainnet

1. Switch `X402_NETWORK` from `base-sepolia` to `base` in `wrangler.toml`.
2. Switch `X402_FACILITATOR_URL` to a mainnet-capable facilitator (confirm your chosen facilitator supports Base mainnet settlement — verify current facilitator options, as this ecosystem is still young and options change).
3. Re-deploy.

---

## Environment variables

See [`.env.example`](.env.example) for the full annotated list. Summary:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PAYMENT_ADDRESS` | yes | — | Base wallet address receiving USDC |
| `X402_NETWORK` | yes | `base-sepolia` | `base` or `base-sepolia` |
| `X402_FACILITATOR_URL` | yes | `https://x402.org/facilitator` | Facilitator used for verify/settle |
| `CLEAN_PAGE_PRICE_USD` | yes | `0.02` | Price per successful `clean_page` call |
| `PUBLIC_BASE_URL` | yes | — | Your deployed URL, used in discovery files |
| `FREE_RATE_LIMIT_PER_MIN` | no | `30` | Free-tier calls per IP per minute |
| `ENABLE_LLM_ENRICHMENT` | no | `true` | Enables `structured_facts` extraction |
| `LLM_MODEL` | no | `claude-haiku-4-5-20251001` | Model used for enrichment |
| `ANTHROPIC_API_KEY` | only if enrichment enabled | — | Secret; set via `wrangler secret put` |

---

## Example MCP client configuration

```json
{
  "mcpServers": {
    "cleanpage": {
      "url": "https://cleanpage.yourdomain.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

## Example tool call and response shape

Request:
```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "clean_page",
    "arguments": { "url": "https://example.com/article", "options": { "extract_facts": true } }
  }
}
```

Successful response (after payment) — `result.content[0].text` is a JSON string shaped like:
```json
{
  "title": "Article title",
  "clean_markdown": "# Article title\n\nBody content as markdown…",
  "plain_text": "Body content as plain text…",
  "structured_facts": [
    { "claim": "…", "category": "fact", "confidence": 0.82 }
  ],
  "metadata": {
    "author": "Jane Doe", "published_date": "2026-08-01T00:00:00Z",
    "site_name": "Example", "language": "en",
    "word_count": 812, "reading_time_minutes": 4,
    "fetched_at": "2026-09-17T12:00:00.000Z",
    "final_url": "https://example.com/article", "status_code": 200
  },
  "links": [{ "url": "https://example.com/other", "text": "related", "type": "internal" }],
  "images": ["https://example.com/hero.jpg"],
  "quality_score": 85,
  "extraction_notes": []
}
```

## Error codes

| `error_code` | Meaning | Retryable |
|---|---|---|
| `INVALID_URL` | Malformed, non-http(s), or a blocked internal address | no |
| `FETCH_FAILED` | Non-2xx response, non-HTML content, or oversized page | sometimes |
| `TIMEOUT` | Page didn't respond within the timeout | yes |
| `PAYWALL_DETECTED` | Subscription/metered paywall detected | no |
| `BLOCKED_BY_SITE` | Bot-check/CAPTCHA or JS-only empty shell | no |
| `EMPTY_CONTENT` | No substantial article content found | no |
| `EXTRACTION_FAILED` | Unexpected parser error | no |

Failed extractions always return before payment settlement, so they're never charged.

---

## Known limitations

- **JavaScript-rendered pages**: extraction fetches raw HTML and does not execute JavaScript, so client-side-rendered SPAs with no server-rendered content will return `EMPTY_CONTENT` or `BLOCKED_BY_SITE`. Adding a headless-browser rendering fallback (e.g. via Cloudflare Browser Rendering) is the natural next step if this matters for your traffic.
- **Facilitator dependency**: payment verification and settlement depend on the configured x402 facilitator's uptime. `x402.org/facilitator` is a good default for development; evaluate production facilitators for reliability guarantees before scaling mainnet volume.
- **Rate limiting is best-effort**: the KV-based counter has a small race window under concurrent bursts from the same IP; it's adequate abuse protection, not a hard guarantee.
