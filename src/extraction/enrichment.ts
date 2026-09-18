import type { Env, StructuredFact } from "../types";
import type { CleanPageConfig } from "../config";

/**
 * Optional, cheap LLM pass that extracts structured facts (claims, entities,
 * statistics, quotes, dates) from already-extracted plain text.
 *
 * This is intentionally *not* on the critical path for the core deterministic
 * extraction — if it's disabled, unconfigured, or fails, clean_page still
 * returns a full result with an empty structured_facts array plus a note.
 */
export async function extractStructuredFacts(
  plainText: string,
  env: Env,
  config: CleanPageConfig
): Promise<{ facts: StructuredFact[]; note?: string }> {
  if (!config.llmEnrichmentEnabled) {
    return { facts: [], note: "Fact extraction skipped: LLM enrichment is disabled." };
  }

  // Cap input to keep this a "cheap" call.
  const excerpt = plainText.slice(0, 6000);

  const systemPrompt =
    "You extract structured facts from article text for an AI agent consuming this data. " +
    "Return ONLY a JSON array (no prose, no markdown fences) of objects shaped like: " +
    '{"claim": string, "category": "fact"|"entity"|"statistic"|"quote"|"date", "confidence": number between 0 and 1}. ' +
    "Extract at most 10 of the most important, self-contained, verifiable items. " +
    "Each claim must be a complete standalone sentence in your own words, not a copied quotation.";

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY as string,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.llmModel,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: excerpt }],
      }),
    });

    if (!res.ok) {
      return { facts: [], note: `Fact extraction skipped: enrichment API returned HTTP ${res.status}.` };
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = data.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();

    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error("Enrichment response was not a JSON array");

    const facts: StructuredFact[] = parsed
      .filter((f) => f && typeof f.claim === "string")
      .slice(0, 10)
      .map((f) => ({
        claim: String(f.claim).slice(0, 500),
        category: (["fact", "entity", "statistic", "quote", "date"].includes(f.category)
          ? f.category
          : "fact") as StructuredFact["category"],
        confidence: typeof f.confidence === "number" ? Math.max(0, Math.min(1, f.confidence)) : 0.6,
      }));

    return { facts };
  } catch (err) {
    return {
      facts: [],
      note: `Fact extraction skipped due to an enrichment error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
