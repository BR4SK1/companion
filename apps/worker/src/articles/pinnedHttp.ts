/**
 * Pinned-connection bounded text fetch over node:http / node:https.
 *
 * Security properties:
 * - The TCP connection is pinned to a validated address: the request's
 *   `lookup` hook resolves the hostname (all addresses) and EVERY resolved
 *   address must pass the caller-supplied address validator before any
 *   address is handed to Node's connect logic. Node connects only to
 *   addresses this hook returned, so the socket can only be created to an
 *   address that validated for this very request — the validation-to-
 *   connection window of the previous fetch-based transport (DNS
 *   rebinding) is closed. IP-literal hosts skip the lookup hook (Node
 *   connects directly); they are decided by the structural URL checks at
 *   this layer and by `checkAddressSafety` at the domain boundary.
 * - The original hostname is preserved for everything above TCP: the Host
 *   header comes from the URL and TLS SNI (`servername`) is set to the
 *   hostname, so certificate hostname validation — Node's defaults, never
 *   weakened here — applies to the hostname while the socket connects to
 *   the pinned address.
 * - Redirects are rejected, never followed: a feed cannot launder its
 *   destination through a redirect, and every hop would otherwise need its
 *   own revalidation.
 * - Bounded work: one overall deadline covering resolution, connection,
 *   response headers, and body; a declared content-length pre-check; an
 *   incremental byte cap applied to the DECOMPRESSED body (compressed
 *   responses are streamed through zlib, so a small hostile payload cannot
 *   expand past the cap); external cancellation via AbortSignal; every
 *   early reject destroys the request/socket.
 * - Every request uses a one-shot non-keep-alive agent, so each fetch
 *   re-resolves and re-validates instead of silently reusing a pooled
 *   connection pinned under an earlier validation.
 *
 * Not claimed here: the DNS resolver's own answers are trusted once they
 * validate (a public-but-hostile address is an ordinary fetch target) and
 * no DNSSEC is performed. This module is the transport behind
 * `boundedFetchText` in rss.ts; it does not fetch pages.
 */

import { request as httpRequest, Agent as HttpAgent } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import type { Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import {
  DEFAULT_RESOLVE_TIMEOUT_MS,
  systemLookup,
  type FeedHostLookup,
  type FeedUrlSafety,
} from "./feedSafety.ts";
import type { BoundedFetchResult } from "./rss.ts";

/** Validates one resolved address; a rejection carries why it is unsafe. */
export type AddressValidator = (address: string) => FeedUrlSafety;

interface PinnedLookupAddress {
  readonly address: string;
  readonly family: number;
}

/**
 * The callback shape of Node's connect-time lookup hook: a single address
 * plus family, or — when `all` is set (Node's auto-select-family path) —
 * the full ordered address list.
 */
export type PinnedLookupCallback = (
  error: Error | null,
  address?: string | readonly PinnedLookupAddress[],
  family?: number,
) => void;

export interface PinnedLookupOptions {
  readonly family?: number;
  readonly all?: boolean;
  readonly hints?: number;
}

/**
 * The protocol seam used for hermetic unit tests: the production values are
 * node's own `http.request` / `https.request`, selected by URL scheme.
 */
export type PinnedRequestFn = (
  url: URL,
  options: HttpsRequestOptions & { lookup: LookupFunction },
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface PinnedFetchOptions {
  /** Overall deadline covering resolution, connect, headers, and body. */
  readonly timeoutMs: number;
  /** Hard cap on the DECOMPRESSED body size. */
  readonly maxBytes: number;
  /** Bounded wait for the connect-time lookup. */
  readonly resolveTimeoutMs?: number;
  readonly headers?: Record<string, string>;
  /** External cancellation, composed with the deadline. */
  readonly signal?: AbortSignal;
  /** Injectable all-address lookup (defaults to the platform resolver). */
  readonly lookupAll?: FeedHostLookup;
  /**
   * Per-request address validator applied to EVERY resolved address inside
   * the connect-time lookup hook. Required: a pinned fetch without address
   * validation is not offered.
   */
  readonly validateAddress: AddressValidator;
  /** Injectable protocol seam for tests (defaults to node http/https). */
  readonly transport?: PinnedRequestFn;
}

/**
 * Build the connect-time lookup hook: resolve all addresses (bounded), then
 * validate EVERY one of them and only hand Node addresses that passed. One
 * unsafe answer rejects the whole lookup — fail closed, no partial
 * connections. The returned address(es) are exactly what Node may connect
 * to, and the hook runs inside the same connect call, so there is no
 * window in which the destination can drift after validation.
 */
export function createPinnedLookup(deps: {
  readonly lookupAll: FeedHostLookup;
  readonly validateAddress: AddressValidator;
  readonly resolveTimeoutMs: number;
}): (hostname: string, options: PinnedLookupOptions, callback: PinnedLookupCallback) => void {
  return (hostname, options, callback) => {
    let settled = false;
    const finish = (
      error: Error | null,
      address?: string | readonly PinnedLookupAddress[],
      family?: number,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(error, address, family);
    };
    const timer = setTimeout(() => {
      finish(new Error("feed host resolution timed out"));
    }, deps.resolveTimeoutMs);
    deps.lookupAll(hostname).then(
      (addresses) => {
        if (settled) return;
        if (addresses.length === 0) {
          finish(new Error("feed url host could not be resolved"));
          return;
        }
        for (const entry of addresses) {
          const verdict = deps.validateAddress(entry.address);
          if (!verdict.ok) {
            finish(new Error(`feed url host resolved to ${verdict.reason}`));
            return;
          }
        }
        const requestedFamily = options.family ?? 0;
        const matches = requestedFamily === 4
          ? addresses.filter((entry) => entry.family === 4)
          : requestedFamily === 6
            ? addresses.filter((entry) => entry.family === 6)
            : addresses;
        if (matches.length === 0) {
          finish(new Error(`feed host has no validated IPv${String(requestedFamily)} address`));
          return;
        }
        if (options.all === true) {
          finish(
            null,
            matches.map((entry) => ({ address: entry.address, family: entry.family })),
          );
        } else {
          finish(null, matches[0]!.address, matches[0]!.family);
        }
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = /timed?\s*out|timeout/i.test(message);
        finish(
          new Error(
            timedOut ? "feed host resolution timed out" : "feed url host could not be resolved",
          ),
        );
      },
    );
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Fetch a URL as decoded text with the connection pinned to validated
 * addresses (see the module docstring). Returns the decoded body and the
 * number of DECOMPRESSED bytes received.
 */
export async function pinnedFetchText(
  url: string,
  options: PinnedFetchOptions,
): Promise<BoundedFetchResult> {
  const maxBytes = options.maxBytes;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("feed url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`feed url scheme ${parsed.protocol} is not http(s)`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("feed url must not embed credentials");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0) throw new Error("feed url has no host");
  // URL.hostname keeps the brackets on an IPv6 literal ("[2001:db8::1]").
  // Strip them for everything host-shaped: the isIP literal decision, the
  // SNI name, and validation (checkAddressSafety normalizes internally).
  // The URL object itself — whose serialization carries the RFC-correct
  // bracketed Host form — drives the request.
  const bareHostname = hostname.replace(/^\[|\]$/g, "");

  if (options.signal?.aborted) throw new Error("feed fetch cancelled");

  const isHttps = parsed.protocol === "https:";
  const requestFn = options.transport ?? (isHttps ? httpsRequest : httpRequest);
  const lookupAll = options.lookupAll ?? systemLookup;
  const validateAddress = options.validateAddress;
  const resolveTimeoutMs = options.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  const externalSignal = options.signal;
  if (externalSignal !== undefined) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const lookup = createPinnedLookup({ lookupAll, validateAddress, resolveTimeoutMs });
  // One-shot agent: never reuse a pooled socket pinned under an earlier
  // validation; every fetch re-resolves and re-validates.
  const agent = isHttps ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false });
  // SNI must be the original hostname. Node derives it from `host`, but an
  // IP-literal host must not carry SNI (RFC 6066 forbids SNI for IP
  // literals, and Node validates the certificate against the literal's IP
  // SANs instead); IP literals also skip the lookup hook. isIP decides on
  // the bracket-stripped host: URL.hostname keeps brackets on IPv6.
  const ipLiteral = isIP(bareHostname) !== 0;
  const requestOptions: HttpsRequestOptions & { lookup: LookupFunction } = {
    method: "GET",
    headers: options.headers ?? {},
    // Node's lookup callback unions single-address and all-address shapes
    // awkwardly across versions; the wrapper matches the runtime contract.
    lookup: lookup as unknown as LookupFunction,
    agent,
    signal: controller.signal,
    ...(isHttps && !ipLiteral ? { servername: bareHostname } : {}),
  };

  try {
    return await new Promise<BoundedFetchResult>((resolve, reject) => {
      let settled = false;
      let request: ClientRequest | undefined;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        try {
          request?.destroy();
        } catch {
          // Destruction is best-effort; the original failure must not be masked.
        }
        reject(error);
      };
      const finish = (value: BoundedFetchResult): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      controller.signal.addEventListener(
        "abort",
        () => fail(new Error(timedOut ? "feed fetch timed out" : "feed fetch cancelled")),
        { once: true },
      );
      try {
        request = requestFn(parsed, requestOptions, (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            fail(new Error(`feed fetch returned redirect HTTP ${String(status)}`));
            return;
          }
          if (status < 200 || status >= 300) {
            fail(new Error(`feed fetch failed with HTTP ${String(status)}`));
            return;
          }
          const declaredRaw = response.headers["content-length"];
          if (typeof declaredRaw === "string") {
            const declared = Number.parseInt(declaredRaw, 10);
            if (Number.isInteger(declared) && declared > maxBytes) {
              fail(
                new Error(
                  `feed response declared ${String(declared)} bytes, over the ${String(maxBytes)} cap`,
                ),
              );
              return;
            }
          }
          const encodingHeader = response.headers["content-encoding"];
          const encoding = (
            Array.isArray(encodingHeader) ? encodingHeader.join(",") : encodingHeader ?? ""
          ).trim().toLowerCase();
          let source: Readable = response;
          if (encoding !== "") {
            // Decompressors are Duplex (Transform): readable to consume and
            // writable as pipe() destinations.
            let decompressor: Transform;
            if (encoding === "gzip" || encoding === "x-gzip") decompressor = createGunzip();
            else if (encoding === "deflate") decompressor = createInflate();
            else if (encoding === "br") decompressor = createBrotliDecompress();
            else {
              fail(new Error(`feed response content-encoding ${encoding} is not supported`));
              return;
            }
            // Cap the DECOMPRESSED stream: a small hostile payload cannot
            // expand past the byte cap.
            source = response.pipe(decompressor);
            response.on("error", (error) => fail(toError(error)));
          }
          const chunks: Buffer[] = [];
          let received = 0;
          source.on("data", (chunk) => {
            if (settled) return;
            const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
            received += bytes.length;
            if (received > maxBytes) {
              fail(new Error(`feed response exceeded the ${String(maxBytes)} byte cap`));
              return;
            }
            chunks.push(bytes);
          });
          source.on("end", () => {
            finish({
              body: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)),
              bytes: received,
            });
          });
          source.on("error", (error) => fail(toError(error)));
        });
        request.on("error", (error) => fail(toError(error)));
        // A feed fetch is a bodiless GET: end the request so the headers
        // flush and the request is actually sent (the test transports are
        // synchronous and would mask a missing end otherwise).
        request.end();
      } catch (error) {
        fail(toError(error));
      }
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
    agent.destroy();
  }
}
