import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type {
  CleanPageError,
  CleanPageLink,
  CleanPageMetadata,
  CleanPageOptions,
  CleanPageResult,
} from "../types";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 20_000;
const MAX_FETCH_BYTES = 8 * 1024 * 1024; // 8MB cap on raw HTML fetch

const USER_AGENT =
  "CleanPageBot/1.0 (+https://cleanpage.example.com/bot; agent content extraction service)";

/** Result of a raw fetch attempt before extraction. */
interface FetchedPage {
  html: string;
  finalUrl: string;
  statusCode: number;
}

export class ExtractionError extends Error {
  code: CleanPageError["error_code"];
  retryable: boolean;
  constructor(code: CleanPageError["error_code"], message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function validateUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ExtractionError("INVALID_URL", `"${rawUrl}" is not a valid absolute URL.`, false);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractionError("INVALID_URL", "Only http/https URLs are supported.", false);
  }
  // Block obvious SSRF targets to internal/loopback ranges.
  const hostname = url.hostname.toLowerCase();
  const blocked = ["localhost", "127.0.0.1", "0.0.0.0", "::1"];
  if (blocked.includes(hostname) || hostname.endsWith(".internal") || hostname.startsWith("169.254.")) {
    throw new ExtractionError("INVALID_URL", "URL resolves to a disallowed internal address.", false);
  }
  return url;
}

async function fetchPage(url: URL, timeoutMs: number): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cf: {
        // Cloudflare-specific: don't cache paywalled/dynamic pages by default.
        cacheTtl: 0,
        cacheEverything: false,
      } as RequestInitCfProperties,
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        throw new ExtractionError(
          "BLOCKED_BY_SITE",
          `Site returned HTTP ${res.status}. It may require authentication or be blocking automated requests.`,
          false
        );
      }
      throw new ExtractionError(
        "FETCH_FAILED",
        `Site returned HTTP ${res.status}.`,
        res.status >= 500
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html") && !contentType.includes("xml") && contentType !== "") {
      throw new ExtractionError(
        "FETCH_FAILED",
        `URL did not return HTML content (content-type: ${contentType}).`,
        false
      );
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const html = await res.text();
      return { html, finalUrl: res.url || url.toString(), statusCode: res.status };
    }

    let received = 0;
    const chunks: Uint8Array[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > MAX_FETCH_BYTES) {
          controller.abort();
          throw new ExtractionError(
            "FETCH_FAILED",
            `Page exceeds the ${(MAX_FETCH_BYTES / 1024 / 1024).toFixed(0)}MB size limit.`,
            false
          );
        }
        chunks.push(value);
      }
    }
    const html = new TextDecoder("utf-8").decode(concatChunks(chunks));
    return { html, finalUrl: res.url || url.toString(), statusCode: res.status };
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ExtractionError("TIMEOUT", `Fetch timed out after ${timeoutMs}ms.`, true);
    }
    throw new ExtractionError(
      "FETCH_FAILED",
      `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`,
      true
    );
  } finally {
    clearTimeout(timer);
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Heuristic paywall / anti-bot / empty-shell detection on raw HTML. */
function detectFailureSignals(html: string, textLength: number): string | null {
  const lower = html.toLowerCase();
  const paywallMarkers = [
    "subscribe to continue reading",
    "this content is for subscribers",
    "you have reached your article limit",
    "metered-content",
    "paywall",
  ];
  if (paywallMarkers.some((m) => lower.includes(m))) {
    return "PAYWALL_DETECTED";
  }

  const botWallMarkers = [
    "checking your browser before accessing",
    "enable javascript and cookies to continue",
    "captcha",
    "cf-browser-verification",
    "access denied",
  ];
  if (botWallMarkers.some((m) => lower.includes(m)) && textLength < 500) {
    return "BLOCKED_BY_SITE";
  }

  return null;
}

function toMarkdown(root: any): string {
  // Lightweight, dependency-free HTML -> Markdown conversion tuned for
  // article bodies produced by Readability (headings, paragraphs, lists,
  // links, blockquotes, code, images, tables).
  const lines: string[] = [];

  function walk(node: any, listDepth = 0): void {
    if (node.nodeType === 3) {
      // Text node
      const text = (node.textContent || "").replace(/\s+/g, " ");
      if (text.trim()) lines.push(text);
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName?.toLowerCase();
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Number(tag[1]);
        lines.push(`\n${"#".repeat(level)} ${inlineText(node)}\n`);
        break;
      }
      case "p":
        lines.push(`\n${inlineText(node)}\n`);
        break;
      case "blockquote":
        lines.push(`\n> ${inlineText(node)}\n`);
        break;
      case "pre":
        lines.push(`\n\`\`\`\n${node.textContent || ""}\n\`\`\`\n`);
        break;
      case "ul":
      case "ol": {
        let i = 1;
        for (const child of Array.from(node.children || [])) {
          const c = child as any;
          if (c.tagName?.toLowerCase() === "li") {
            const marker = tag === "ol" ? `${i++}.` : "-";
            lines.push(`${"  ".repeat(listDepth)}${marker} ${inlineText(c)}`);
          }
        }
        lines.push("");
        break;
      }
      case "img": {
        const alt = node.getAttribute?.("alt") || "";
        const src = node.getAttribute?.("src") || "";
        if (src) lines.push(`\n![${alt}](${src})\n`);
        break;
      }
      case "table":
        lines.push(`\n${tableToMarkdown(node)}\n`);
        break;
      default:
        for (const child of Array.from(node.childNodes || [])) {
          walk(child as any, listDepth);
        }
    }
  }

  function inlineText(node: any): string {
    let out = "";
    for (const child of Array.from(node.childNodes || [])) {
      const c = child as any;
      if (c.nodeType === 3) {
        out += (c.textContent || "").replace(/\s+/g, " ");
      } else if (c.nodeType === 1) {
        const tag = c.tagName?.toLowerCase();
        if (tag === "a") {
          const href = c.getAttribute?.("href") || "";
          out += `[${inlineText(c)}](${href})`;
        } else if (tag === "strong" || tag === "b") {
          out += `**${inlineText(c)}**`;
        } else if (tag === "em" || tag === "i") {
          out += `*${inlineText(c)}*`;
        } else if (tag === "code") {
          out += `\`${c.textContent || ""}\``;
        } else if (tag === "br") {
          out += "\n";
        } else {
          out += inlineText(c);
        }
      }
    }
    return out.trim();
  }

  function tableToMarkdown(table: any): string {
    const rows: string[][] = [];
    for (const row of Array.from(table.querySelectorAll?.("tr") || [])) {
      const cells = Array.from((row as any).querySelectorAll("th,td")).map((cell) =>
        inlineText(cell as any).replace(/\|/g, "\\|")
      );
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return "";
    const header = rows[0]!;
    const body = rows.slice(1);
    const headerLine = `| ${header.join(" | ")} |`;
    const sepLine = `| ${header.map(() => "---").join(" | ")} |`;
    const bodyLines = body.map((r) => `| ${r.join(" | ")} |`);
    return [headerLine, sepLine, ...bodyLines].join("\n");
  }

  walk(root);
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractLinks(root: any, baseUrl: string): CleanPageLink[] {
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const links: CleanPageLink[] = [];
  for (const a of Array.from(root.querySelectorAll?.("a[href]") || [])) {
    const href = (a as any).getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    const key = resolved.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const text = ((a as any).textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
    links.push({
      url: key,
      text: text || key,
      type: resolved.hostname === base.hostname ? "internal" : "external",
    });
    if (links.length >= 200) break;
  }
  return links;
}

function extractImages(root: any, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  for (const img of Array.from(root.querySelectorAll?.("img[src]") || [])) {
    const src = (img as any).getAttribute("src");
    if (!src) continue;
    try {
      const resolved = new URL(src, base);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        seen.add(resolved.toString());
      }
    } catch {
      /* skip malformed src */
    }
    if (seen.size >= 50) break;
  }
  return Array.from(seen);
}

function estimateReadingTime(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 225));
}

/** Deterministic heuristic quality score (0-100), independent of any LLM step. */
function scoreQuality(params: {
  wordCount: number;
  hasTitle: boolean;
  hasAuthorOrDate: boolean;
  paragraphCount: number;
  notesCount: number;
}): number {
  let score = 40;
  if (params.wordCount > 150) score += 20;
  if (params.wordCount > 500) score += 10;
  if (params.hasTitle) score += 10;
  if (params.hasAuthorOrDate) score += 10;
  if (params.paragraphCount >= 3) score += 10;
  score -= params.notesCount * 5;
  return Math.max(0, Math.min(100, score));
}

function extractMetaContent(document: any, names: string[]): string | null {
  for (const name of names) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    const content = el?.getAttribute?.("content");
    if (content) return content.trim();
  }
  return null;
}

/**
 * Fetches a URL and runs the full deterministic extraction pipeline.
 * Throws ExtractionError on any unrecoverable failure.
 */
export async function extractCleanPage(
  rawUrl: string,
  options: CleanPageOptions = {}
): Promise<CleanPageResult> {
  const url = validateUrl(rawUrl);
  const timeoutMs = Math.min(options.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const notes: string[] = [];

  const fetched = await fetchPage(url, timeoutMs);

  const failureSignal = detectFailureSignals(fetched.html, fetched.html.length);
  if (failureSignal === "PAYWALL_DETECTED") {
    throw new ExtractionError(
      "PAYWALL_DETECTED",
      "The page appears to be behind a paywall or subscription wall; full content is not accessible.",
      false
    );
  }
  if (failureSignal === "BLOCKED_BY_SITE") {
    throw new ExtractionError(
      "BLOCKED_BY_SITE",
      "The site appears to be blocking automated access (bot-check/CAPTCHA) or requires JavaScript rendering.",
      false
    );
  }

  const { document } = parseHTML(fetched.html);

  // Readability mutates the DOM, so operate on a document dedicated to it.
  const reader = new Readability(document, { charThreshold: 200 });
  let article: ReturnType<Readability["parse"]>;
  try {
    article = reader.parse();
  } catch (err) {
    throw new ExtractionError(
      "EXTRACTION_FAILED",
      `Readability failed to parse the document: ${err instanceof Error ? err.message : String(err)}`,
      false
    );
  }

  if (!article || !article.content || article.textContent.trim().length < 40) {
    throw new ExtractionError(
      "EMPTY_CONTENT",
      "No substantial article content could be extracted from this page (it may be a listing page, app shell, or require JavaScript rendering).",
      false
    );
  }

  // Re-parse the extracted content fragment for markdown/link/image walking.
  const { document: fragDoc } = parseHTML(`<div id="root">${article.content}</div>`);
  const root = fragDoc.getElementById("root");

  let clean_markdown = toMarkdown(root);
  let plain_text = (article.textContent || "").replace(/\n{3,}/g, "\n\n").trim();

  const maxLen = options.max_length;
  if (maxLen && maxLen > 0) {
    if (clean_markdown.length > maxLen) {
      clean_markdown = clean_markdown.slice(0, maxLen).trimEnd() + "\n\n…(truncated)";
      notes.push(`clean_markdown truncated to ${maxLen} characters`);
    }
    if (plain_text.length > maxLen) {
      plain_text = plain_text.slice(0, maxLen).trimEnd() + " …(truncated)";
    }
  }

  const links = extractLinks(root, fetched.finalUrl);
  const images = options.include_images === false ? [] : extractImages(root, fetched.finalUrl);

  const wordCount = plain_text.split(/\s+/).filter(Boolean).length;
  const author =
    article.byline?.trim() ||
    extractMetaContent(document, ["article:author", "author", "og:author"]) ||
    null;
  const publishedDate =
    extractMetaContent(document, [
      "article:published_time",
      "og:published_time",
      "date",
      "pubdate",
    ]) || null;
  const siteName =
    article.siteName?.trim() ||
    extractMetaContent(document, ["og:site_name"]) ||
    url.hostname;
  const language =
    document.documentElement?.getAttribute?.("lang") ||
    extractMetaContent(document, ["og:locale"]) ||
    options.language ||
    null;

  const metadata: CleanPageMetadata = {
    author,
    published_date: publishedDate,
    site_name: siteName,
    language,
    word_count: wordCount,
    reading_time_minutes: estimateReadingTime(wordCount),
    fetched_at: new Date().toISOString(),
    final_url: fetched.finalUrl,
    status_code: fetched.statusCode,
  };

  if (wordCount < 120) {
    notes.push("Extracted content is short; page may be partially JS-rendered or a summary/listing page.");
  }

  const paragraphCount = (root?.querySelectorAll?.("p") || []).length;
  const quality_score = scoreQuality({
    wordCount,
    hasTitle: !!article.title,
    hasAuthorOrDate: !!(author || publishedDate),
    paragraphCount,
    notesCount: notes.length,
  });

  return {
    title: article.title?.trim() || url.hostname,
    clean_markdown,
    plain_text,
    structured_facts: [], // filled in by enrichment.ts when extract_facts is requested
    metadata,
    links,
    images,
    quality_score,
    extraction_notes: notes,
  };
}
