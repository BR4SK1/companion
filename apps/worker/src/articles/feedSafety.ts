/**
 * Feed URL and resolved-address safety.
 *
 * Enforced rules, fail closed:
 * - Only http(s) URLs; credentials embedded in URLs are rejected.
 * - Address-aware host validation: IPv4 and IPv6 literals are parsed in
 *   full and checked against a documented policy — an address that is not
 *   globally reachable unicast is never a valid feed host. The enforced
 *   set follows the IANA special-purpose address registries (RFC 6890 and
 *   successors) rather than an ad-hoc minimal list:
 *   - IPv4: 0.0.0.0/8 (this network), 10/8, 100.64/10 (CGNAT), 127/8
 *     (loopback), 169.254/16 (link-local), 172.16/12, 192.168/16 (private),
 *     192.0.0.0/24 (IETF protocol assignments), 192.0.2.0/24 and
 *     198.51.100.0/24 and 203.0.113.0/24 (documentation, RFC 5737),
 *     192.88.99.0/24 (deprecated 6to4 relay anycast, RFC 7526),
 *     198.18.0.0/15 (benchmarking, RFC 2544), 224/4 (multicast), and
 *     240/4 (reserved, including the 255.255.255.255 broadcast address).
 *   - IPv6: the unspecified address and ::1 loopback, link-local fe80::/10,
 *     unique-local fc00::/7, multicast ff00::/8, the deprecated IPv4-
 *     compatible ::/96 form (RFC 4291 §2.5.5.1), local-use NAT64
 *     64:ff9b:1::/48 (RFC 8215), discard-only 100::/64 (RFC 6666),
 *     documentation 2001:db8::/32 (RFC 3849), benchmarking 2001:2::/48
 *     (RFC 5180), ORCHID 2001:10::/28 (RFC 4843) and ORCHIDv2 2001:20::/28
 *     (RFC 7370), and deprecated 6to4 2002::/16 (RFC 7526 — the relay
 *     infrastructure is withdrawn, so the form is not reliably globally
 *     reachable).
 *   - Translated forms route through the underlying IPv4 policy: an
 *     IPv4-mapped ::ffff:a.b.c.d or NAT64 64:ff9b::a.b.c.d address runs the
 *     full IPv4 checks on its embedded address, so a mapped private,
 *     multicast, or reserved address is rejected and a mapped global one is
 *     an ordinary destination. Names are decided only by resolution: every
 *     address a feed hostname resolves to must pass the same checks
 *     (`resolveFeedHost`), and the pinned connector (`pinnedHttp.ts`)
 *     re-applies the same validation inside its connect-time lookup hook so
 *     the connection can only be made to an address that validated for that
 *     very request.
 *
 * Not claimed here: the DNS resolver's answers are trusted once they
 * validate (a public-but-hostile address is an ordinary fetch target) and
 * no DNSSEC is performed.
 */

import { promises as dnsPromises } from "node:dns";

const IP_V4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export type FeedUrlSafety = { ok: true } | { ok: false; reason: string };

/**
 * The IPv4 checks shared by dotted-quad literals and the addresses embedded
 * in mapped/NAT64 IPv6 forms. The enforced set is the IANA special-purpose
 * registry's not-globally-reachable unicast space (see the module
 * docstring for the documented policy and ranges).
 */
function ipv4Unsafe(a: number, b: number, c: number): string | null {
  if (
    // 0.0.0.0/8 "this network", 10.0.0.0/8 private, 127.0.0.0/8 loopback,
    // 224.0.0.0/4 multicast, and 240.0.0.0/4 reserved (which includes the
    // 255.255.255.255 limited-broadcast address):
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    // 100.64.0.0/10 carrier-grade NAT, 169.254.0.0/16 link-local,
    // 172.16.0.0/12 private, 192.168.0.0/16 private:
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // 192.0.0.0/24 IETF protocol assignments (RFC 6890):
    (a === 192 && b === 0 && c === 0) ||
    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 documentation (RFC 5737):
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    // 192.88.99.0/24 deprecated 6to4 relay anycast (RFC 7526):
    (a === 192 && b === 88 && c === 99) ||
    // 198.18.0.0/15 benchmarking (RFC 2544):
    (a === 198 && (b === 18 || b === 19))
  ) {
    return "a loopback, private, carrier-grade NAT, broadcast, multicast, reserved, or otherwise non-globally-reachable IPv4 address";
  }
  return null;
}

/** The embedded-IPv4 checks for an address packed into the low 32 bits. */
function ipv4ValueUnsafe(value: number): string | null {
  return ipv4Unsafe(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
  );
}

/**
 * Parse an IPv6 literal into its left (head) and right (tail) 16-bit groups
 * around `::`, with an embedded trailing IPv4 form folded into the tail.
 * Returns null for anything malformed (including zone-indexed hosts, which
 * are link-local-scoped by definition).
 */
interface ParsedIpv6 {
  readonly head: readonly number[];
  readonly tail: readonly number[];
}

function parseIpv6Groups(host: string): ParsedIpv6 | null {
  const lowered = host.toLowerCase();
  if (lowered.includes("%") || lowered.length === 0) return null;
  let value = lowered;
  if (value.includes(".")) {
    // Embedded IPv4: replace the trailing dotted quad with its two hex groups.
    const cut = value.lastIndexOf(":");
    if (cut < 0) return null;
    const match = IP_V4_PATTERN.exec(value.slice(cut + 1));
    if (match === null) return null;
    const octets = match.slice(1).map((octet) => Number.parseInt(octet, 10));
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return null;
    }
    const [a, b, c, d] = octets as [number, number, number, number];
    value = `${value.slice(0, cut)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  let headText: string[];
  let tailText: string[];
  if (compressed) {
    headText = halves[0] === "" ? [] : halves[0]!.split(":");
    tailText = halves[1] === "" ? [] : halves[1]!.split(":");
  } else {
    if (halves[0] === "") return null;
    headText = halves[0]!.split(":");
    tailText = [];
  }
  const head: number[] = [];
  const tail: number[] = [];
  for (const group of [...headText, ...tailText]) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
  }
  for (const group of headText) head.push(Number.parseInt(group, 16));
  for (const group of tailText) tail.push(Number.parseInt(group, 16));
  const total = head.length + tail.length;
  if (total > 8) return null;
  if (compressed && total === 8) return null; // "::" must compress at least one group
  if (!compressed && total !== 8) return null;
  return { head, tail };
}

function ipv6GroupsToValue(groups: ParsedIpv6): bigint {
  let value = 0n;
  for (const group of groups.head) value = (value << 16n) | BigInt(group);
  value <<= BigInt(16 * (8 - groups.head.length - groups.tail.length));
  for (const group of groups.tail) value = (value << 16n) | BigInt(group);
  return value;
}

/**
 * Classify a 128-bit IPv6 value against the documented policy: the
 * special-purpose ranges that are not globally reachable unicast, with
 * mapped/translated forms routed through the IPv4 policy. Returns a bare
 * description when the address is unsafe, null when it is an ordinary
 * global address.
 */
function classifyIpv6Value(value: bigint): string | null {
  if (value === 0n) return "the unspecified IPv6 address";
  if (value === 1n) return "the IPv6 loopback";
  const top16 = value >> 112n;
  const second16 = (value >> 96n) & 0xffffn;
  const high32 = value >> 96n;
  const high48 = value >> 80n;
  const high64 = value >> 64n;
  const high96 = value >> 32n;
  const low32 = Number(value & 0xffffffffn);
  if (top16 >= 0xff00n) return "a multicast IPv6 address";
  if (top16 >= 0xfe80n && top16 <= 0xfebfn) return "a link-local IPv6 address";
  if (top16 >= 0xfc00n && top16 <= 0xfdffn) return "a unique-local IPv6 address";
  // Deprecated IPv4-compatible ::/96 (RFC 4291 §2.5.5.1): not a translation
  // mechanism, has no routability, and is not globally reachable.
  if (high96 === 0n) return "a deprecated IPv4-compatible IPv6 address";
  // Mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) translations route to
  // the embedded IPv4 address, so the embedded address runs the FULL IPv4
  // policy: a mapped private, multicast, or reserved address is rejected
  // here and a mapped global one is an ordinary destination.
  if (high96 === 0xffffn || high96 === 0x64ff9bn << 64n) {
    const verdict = ipv4ValueUnsafe(low32);
    if (verdict !== null) return `${verdict} embedded in an IPv6 literal`;
  }
  // Local-use NAT64 (RFC 8215): not globally reachable.
  if (high48 === 0x64ff9b0001n) return "a local-use NAT64 IPv6 address";
  // Discard-only range (RFC 6666): top 64 bits = 100:: — not globally
  // reachable.
  if (high64 === 0x100n << 48n) return "a discard-only IPv6 address";
  // Documentation range (RFC 3849): reserved, never allocated.
  if (high32 === 0x20010db8n) return "a documentation IPv6 address";
  // Benchmarking range (RFC 5180): not for global traffic.
  if (high48 === 0x200100020000n) return "a benchmarking IPv6 address";
  // ORCHID (RFC 4843) and ORCHIDv2 (RFC 7370): not globally routed.
  if (top16 === 0x2001n && second16 >= 0x10n && second16 <= 0x2fn) {
    return "an ORCHID IPv6 address";
  }
  // Deprecated 6to4 (RFC 7526): the relay infrastructure is withdrawn, so
  // the form is not reliably globally reachable.
  if (top16 === 0x2002n) return "a deprecated 6to4 IPv6 address";
  return null;
}

/**
 * Address-literal checks without URL context: the host is either a
 * dotted-quad IPv4 literal, an IPv6 literal, or a name (names are only
 * decided by resolution — see `resolveFeedHost` and the pinned connector's
 * lookup hook). Returns a bare description on rejection so callers can
 * compose their own messages.
 */
export function checkAddressSafety(host: string): FeedUrlSafety {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return { ok: false, reason: "the localhost name" };
  }
  const v4 = IP_V4_PATTERN.exec(normalized);
  if (v4 !== null) {
    const octets = v4.slice(1).map((octet) => Number.parseInt(octet, 10));
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return { ok: false, reason: "a malformed IPv4 literal" };
    }
    const [a, b, c] = octets as [number, number, number];
    const verdict = ipv4Unsafe(a, b, c);
    return verdict !== null ? { ok: false, reason: verdict } : { ok: true };
  }
  if (normalized.includes(":")) {
    const groups = parseIpv6Groups(normalized);
    if (groups === null) return { ok: false, reason: "a malformed IPv6 literal" };
    const verdict = classifyIpv6Value(ipv6GroupsToValue(groups));
    return verdict !== null ? { ok: false, reason: verdict } : { ok: true };
  }
  return { ok: true };
}

/**
 * Structural URL safety checks enforced before any network request. Only
 * http/https, no embedded credentials, and an address-aware host check (see
 * `checkAddressSafety` for the enforced ranges).
 */
export function checkFeedUrlSafety(rawUrl: string): FeedUrlSafety {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "feed url is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `feed url scheme ${parsed.protocol} is not http(s)` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "feed url must not embed credentials" };
  }
  const verdict = checkAddressSafety(parsed.hostname);
  return verdict.ok ? verdict : { ok: false, reason: `feed url host is ${verdict.reason}` };
}

/** One resolved address (as produced by a DNS lookup). */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** The injectable host lookup (all addresses, both families). */
export type FeedHostLookup = (host: string) => Promise<readonly ResolvedAddress[]>;

/** The platform lookup backing the default host resolution. */
export function systemLookup(host: string): Promise<readonly ResolvedAddress[]> {
  return dnsPromises.lookup(host, { all: true, verbatim: true }).then((results) =>
    results.map((result) => ({ address: result.address, family: result.family })),
  );
}

/** Default bounded wait for feed-host resolution. */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Resolve a feed URL's hostname and validate EVERY address it resolves to
 * before any request is made. IP-literal hosts skip resolution (the literal
 * checks already decided them). Fails closed: an unresolvable host or a
 * resolution timeout rejects the fetch. This is the cheap pre-connection
 * check with the clean error taxonomy; the authoritative per-request
 * enforcement is the pinned connector's lookup-time validation
 * (`pinnedHttp.ts`), which connects only to addresses validated for that
 * very request.
 */
export async function resolveFeedHost(
  url: string,
  options: { lookup?: FeedHostLookup; timeoutMs?: number } = {},
): Promise<FeedUrlSafety> {
  const structural = checkFeedUrlSafety(url);
  if (!structural.ok) return structural;
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (IP_V4_PATTERN.test(hostname) || hostname.includes(":")) return { ok: true };
  const lookup = options.lookup ?? systemLookup;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("feed host resolution timed out")), timeoutMs);
      }),
    ]);
    for (const entry of addresses) {
      const verdict = checkAddressSafety(entry.address);
      if (!verdict.ok) {
        return { ok: false, reason: `feed url host resolved to ${verdict.reason}` };
      }
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timed?\s*out|timeout/i.test(message);
    return {
      ok: false,
      reason: timedOut ? "feed url host resolution timed out" : "feed url host could not be resolved",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
