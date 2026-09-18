/**
 * Shared type definitions for CleanPage.
 */

export interface Env {
  // Bindings
  CLEANPAGE_KV: KVNamespace;
  ASSETS: Fetcher;

  // Vars
  PAYMENT_ADDRESS: string;
  X402_NETWORK: "base" | "base-sepolia";
  X402_FACILITATOR_URL: string;
  CLEAN_PAGE_PRICE_USD: string;
  PUBLIC_BASE_URL: string;
  FREE_RATE_LIMIT_PER_MIN: string;
  ENABLE_LLM_ENRICHMENT: string;
  LLM_MODEL: string;

  // Secrets (optional)
  ANTHROPIC_API_KEY?: string;
}

export interface CleanPageOptions {
  include_images?: boolean;
  max_length?: number; // max characters of clean_markdown / plain_text to return
  language?: string; // hint for extraction / enrichment, e.g. "en"
  extract_facts?: boolean; // run structured fact extraction (may use LLM enrichment)
  timeout_ms?: number; // fetch timeout, default 10000, max 20000
}

export interface CleanPageLink {
  url: string;
  text: string;
  type: "internal" | "external";
}

export interface CleanPageMetadata {
  author: string | null;
  published_date: string | null;
  site_name: string | null;
  language: string | null;
  word_count: number;
  reading_time_minutes: number;
  fetched_at: string;
  final_url: string;
  status_code: number | null;
}

export interface StructuredFact {
  claim: string;
  category: "fact" | "entity" | "statistic" | "quote" | "date";
  confidence: number; // 0-1
}

export interface CleanPageResult {
  title: string;
  clean_markdown: string;
  plain_text: string;
  structured_facts: StructuredFact[];
  metadata: CleanPageMetadata;
  links: CleanPageLink[];
  images: string[];
  quality_score: number; // 0-100
  extraction_notes: string[];
}

export interface CleanPageError {
  error: true;
  error_code:
    | "INVALID_URL"
    | "FETCH_FAILED"
    | "TIMEOUT"
    | "PAYWALL_DETECTED"
    | "EMPTY_CONTENT"
    | "BLOCKED_BY_SITE"
    | "EXTRACTION_FAILED"
    | "INTERNAL_ERROR";
  message: string;
  retryable: boolean;
}
