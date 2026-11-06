/**
 * Bounded RSS/Atom excerpt fetching and parsing.
 *
 * Safety properties:
 * - Only http(s) URLs; credentials embedded in URLs are rejected.
 * - Address-aware host validation (`feedSafety.ts`): IPv4 and IPv6 literals
 *   are parsed in full and checked against the ranges a feed host must
 *   never take — loopback, unspecified, private/CGNAT/broadcast IPv4, the
 *   embedded-IPv4 IPv6 forms (IPv4-mapped ::ffff:0:0/96, IPv4-compatible
 *   ::/96, NAT64 64:ff9b::/96, whose embedded address runs the IPv4
 *   checks), link-local (fe80::/10), unique-local (fc00::/7), and multicast
 *   (ff00::/8). Names are decided by resolution: every address a hostname
 *   resolves to must pass the same checks.
 * - Connection pinning (`pinnedHttp.ts`): the fetch is made over node
 *   http/https with a connect-time lookup hook that validates EVERY
 *   resolved address and hands Node only validated ones, so the socket is
 *   created only to an address that validated for this very request — the
 *   DNS-rebinding window between validation and connection is closed. The
 *   original hostname is preserved for the Host header and TLS SNI, and
 *   certificate chain/hostname validation uses Node's defaults (never
 *   weakened). Each request uses a one-shot agent so every fetch
 *   re-resolves and re-validates.
 * - No redirect following: redirects are rejected so a feed cannot be
 *   laundered through a redirect into an internal address.
 * - Bounded size (content-length pre-check plus an incremental read cap on
 *   the DECOMPRESSED body, so a small compressed payload cannot expand
 *   past the cap), bounded timeout, external cancellation, and a bounded
 *   excerpt length at parse time. Early rejects destroy the
 *   request/socket, so a rejected fetch never leaves a connection draining.
 * - Excerpt-level only: the fetched XML is parsed for titles, links, and
 *   summary/description text. No full-page fetching exists in this module.
 *
 * Parsing is deliberately tolerant (real feeds are messy) but bounded: any
 * entry without an http(s) URL and a non-empty title is skipped, and item
 * URLs are canonicalized and length-capped before they can reach
 * persistence (an oversized or control-character URL is isolated at parse
 * time instead of poisoning the persistence transaction). Unknown entity
 * forms are left as-is by the decoder; text is whitespace-normalized,
 * stripped of control characters and inline tags, and script/style blocks
 * are removed before tag stripping (never evaluated).
 *
 * Residual honesty: the DNS resolver's answers are trusted once they
 * validate — a public-but-hostile feed host is an ordinary fetch target —
 * and no DNSSEC is performed. The protections here are transport-level
 * (what may be CONNECTED to), not content vetting.
 */

import {
  checkAddressSafety,
  checkFeedUrlSafety,
  type FeedHostLookup,
  type FeedUrlSafety,
} from "./feedSafety.ts";
import { pinnedFetchText, type AddressValidator, type PinnedRequestFn } from "./pinnedHttp.ts";
import type { FeedArticle } from "./types.ts";

// Public safety surface re-exported from its own module: the feed domain's
// import path stays stable for callers and tests.
export {
  checkAddressSafety,
  checkFeedUrlSafety,
  DEFAULT_RESOLVE_TIMEOUT_MS,
  resolveFeedHost,
  systemLookup,
} from "./feedSafety.ts";
export type { FeedHostLookup, FeedUrlSafety, ResolvedAddress } from "./feedSafety.ts";

/** Maximum feed document size accepted (bytes, decompressed). */
export const MAX_FEED_BYTES = 2_000_000;
/** Default feed fetch timeout. */
export const DEFAULT_FEED_TIMEOUT_MS = 12_000;
/** Maximum excerpt characters kept per article. */
export const MAX_EXCERPT_CHARS = 5_000;
/** Maximum canonical item URL length accepted at parse time. */
export const MAX_ITEM_URL_CHARS = 2_048;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([\da-f]+);/gi, (_m, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : "";
    })
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const point = Number.parseInt(code, 10);
      return Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Strip a wrapper element and its CDATA envelope if present. */
function unwrapCdata(inner: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  return match !== null ? match[1]! : inner;
}

function elementText(block: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `<\\s*(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*(?:[\\w.-]+:)?${escaped}\\s*>`,
    "i",
  ).exec(block);
  if (match === null) return null;
  return unwrapCdata(match[1]!);
}

/** Strip dangerous and formatting markup; keep plain text only. */
function stripMarkup(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanExcerpt(raw: string, maxChars: number): string {
  const text = decodeXmlEntities(stripMarkup(raw))
    // Control characters (including NUL, which PostgreSQL text cannot
    // store, and the ones numeric entities decode into) never reach an
    // excerpt or title — a hostile item cannot poison the persistence
    // transaction for every other item.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxChars);
}

/**
 * Canonicalize and bound an item URL at parse time: must parse as a URL,
 * must be http(s), control characters are rejected outright, and the
 * canonical form is length-capped. Returns null for anything unusable so a
 * hostile item is isolated at parse time instead of failing the persistence
 * transaction for the whole batch.
 */
function canonicalEntryUrl(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const href = parsed.href;
  if (href.length === 0 || href.length > MAX_ITEM_URL_CHARS) return null;
  return href;
}

export interface ParsedFeedOptions {
  readonly maxExcerptChars?: number;
}

/**
 * Parse an RSS 2.0 or Atom document into excerpt-level articles. Entries
 * without an http(s) URL or a non-empty title are skipped. `publishedAt`
 * is null when the feed carries no usable date.
 */
export function parseFeed(
  xml: string,
  feedId: string,
  options: ParsedFeedOptions = {},
): FeedArticle[] {
  const maxExcerptChars = options.maxExcerptChars ?? MAX_EXCERPT_CHARS;
  const isAtom = /<\s*feed[\s>]/i.test(xml);
  const itemBlocks = isAtom
    ? [...xml.matchAll(/<\s*entry\b[^>]*>([\s\S]*?)<\s*\/\s*entry\s*>/gi)].map((m) => m[1]!)
    : [...xml.matchAll(/<\s*item\b[^>]*>([\s\S]*?)<\s*\/\s*item\s*>/gi)].map((m) => m[1]!);

  const articles: FeedArticle[] = [];
  for (const block of itemBlocks) {
    const titleRaw = elementText(block, "title");
    const title = titleRaw === null ? "" : cleanExcerpt(titleRaw, 500);
    if (title.length === 0) continue;

    const rawUrl = extractEntryUrl(block, isAtom);
    if (rawUrl === null) continue;
    const url = canonicalEntryUrl(rawUrl);
    if (url === null) continue;

    const summaryRaw =
      elementText(block, "content:encoded") ??
      (isAtom ? elementText(block, "content") : null) ??
      (isAtom ? elementText(block, "summary") : null) ??
      elementText(block, "description");
    const excerpt = summaryRaw === null ? "" : cleanExcerpt(summaryRaw, maxExcerptChars);

    const dateRaw = elementText(block, "pubDate") ?? elementText(block, "published") ??
      elementText(block, "updated");
    let publishedAt: Date | null = null;
    if (dateRaw !== null) {
      const decoded = cleanExcerpt(dateRaw, 64);
      const parsedDate = new Date(decoded);
      if (!Number.isNaN(parsedDate.getTime())) publishedAt = parsedDate;
    }

    articles.push({ feedId, url, title, excerpt, publishedAt });
  }
  return articles;
}

function extractEntryUrl(block: string, isAtom: boolean): string | null {
  if (isAtom) {
    const links = [...block.matchAll(/<\s*link\b([^>]*)\/?>/gi)];
    for (const match of links) {
      const attrs = match[1] ?? "";
      const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
      if (rel !== "" && rel.toLowerCase() !== "alternate") continue;
      const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
      if (href !== undefined && /^https?:\/\//i.test(href.trim())) {
        return href.trim();
      }
    }
    // Fall back to any plain http(s) text in the block (e.g. RSS-style <link>).
    const plain = elementText(block, "link");
    if (plain !== null && /^https?:\/\//i.test(plain.trim())) return plain.trim();
    return null;
  }
  const link = elementText(block, "link");
  if (link !== null) {
    const decoded = decodeXmlEntities(link).trim();
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }
  const guid = elementText(block, "guid");
  if (guid !== null) {
    const decoded = decodeXmlEntities(guid).trim();
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }
  return null;
}

export interface BoundedFetchResult {
  readonly body: string;
  readonly bytes: number;
}

/**
 * Fetch a feed URL with a hard timeout and a hard byte cap over the pinned
 * connector: the connection is created only to an address that passed the
 * address validation for this very request (the connect-time lookup hook
 * validates EVERY resolved address and fails closed on any unsafe answer),
 * the original hostname is preserved for the Host header and TLS
 * SNI/certificate validation, and redirects are rejected. When `resolveHost`
 * is provided, the host is resolved and validated before the request is
 * made (the runner wires the real resolver; the cheap pre-check keeps the
 * clean error taxonomy while the connector is the authoritative per-request
 * enforcement). Every early reject destroys the request/socket, so a
 * rejected fetch never leaves a connection draining. `lookupAll`,
 * `validateAddress`, and `transport` are injection seams for hermetic
 * tests; production uses the platform resolver, the real address checks,
 * and node http/https.
 */
export async function boundedFetchText(
  url: string,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    resolveHost?: (url: string) => Promise<FeedUrlSafety>;
    signal?: AbortSignal;
    lookupAll?: FeedHostLookup;
    validateAddress?: AddressValidator;
    transport?: PinnedRequestFn;
  } = {},
): Promise<BoundedFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FEED_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_FEED_BYTES;
  if (options.resolveHost !== undefined) {
    const safety = await options.resolveHost(url);
    if (!safety.ok) throw new Error(`feed host rejected before fetch: ${safety.reason}`);
  }
  // IP-literal hosts skip the connector's lookup hook entirely (Node
  // connects directly to a literal), so the structural checks — which are
  // what decide literals — are enforced here, before any request.
  const structural = checkFeedUrlSafety(url);
  if (!structural.ok) throw new Error(structural.reason);
  return pinnedFetchText(url, {
    timeoutMs,
    maxBytes,
    headers: {
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
      "user-agent": "companion-article-ingest/1.0",
    },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.lookupAll !== undefined ? { lookupAll: options.lookupAll } : {}),
    validateAddress: options.validateAddress ?? checkAddressSafety,
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
  });
}
