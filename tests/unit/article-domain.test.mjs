// Unit tests for the article domain's database-free logic: bounded RSS/Atom
// fetching and parsing, the reaction prompt envelopes and output contracts,
// the synthetic source key, and the fixed error-category taxonomy. No
// database, no network: the fetch tests inject a fake pinned-connector
// transport (a node-shaped request function), and everything else is a pure
// function of its inputs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import {
  DEFAULT_FEED_TIMEOUT_MS,
  MAX_EXCERPT_CHARS,
  MAX_FEED_BYTES,
  MAX_ITEM_URL_CHARS,
  boundedFetchText,
  checkAddressSafety,
  checkFeedUrlSafety,
  parseFeed,
  resolveFeedHost,
} from "../../apps/worker/src/articles/rss.ts";
import {
  ARTICLE_INTEREST_CONSOLIDATION_RESPONSE_FORMAT,
  ARTICLE_REACTION_GENERATION_PROMPT_VERSION,
  ARTICLE_REACTION_REVIEW_PROMPT_VERSION,
  MAX_ARTICLE_INPUT_CHARS,
  MAX_REACTION_CHARS,
  articleSourceKey,
  articleTaskPresets,
  parseArticleInterestConsolidation,
  parseReactionReview,
  parseReactionText,
  renderArticleInterestConsolidationInput,
  renderArticleReactionInput,
  renderArticleReviewInput,
} from "../../apps/worker/src/articles/prompts.ts";
import { buildMemoryLlmRequestBody } from "../../apps/worker/src/memory/llm.ts";
import {
  ArticleConfigError,
  ArticleConfigurationInvalidError,
  ArticleConfigurationMissingError,
  ArticleDisabledError,
  articleErrorCategory,
} from "../../apps/worker/src/articles/errors.ts";

const CANARY = "CanaryToken42";

// --- URL safety -----------------------------------------------------------

describe("feed url safety", () => {
  it("accepts public http(s) feed urls", () => {
    assert.deepEqual(checkFeedUrlSafety("https://example.com/feed.xml"), { ok: true });
    assert.deepEqual(checkFeedUrlSafety("http://example.com/feed.xml"), { ok: true });
  });

  it("rejects non-http(s) schemes", () => {
    for (const url of [
      "ftp://example.com/feed.xml",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      const verdict = checkFeedUrlSafety(url);
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.match(verdict.reason, /http\(s\)/);
    }
  });

  it("rejects urls with embedded credentials", () => {
    const verdict = checkFeedUrlSafety("https://user:pass@example.com/feed.xml");
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.reason, /credentials/);
  });

  it("rejects loopback and private IPv4 literals", () => {
    const cases = [
      "http://127.0.0.1/feed",
      "http://10.1.2.3/feed",
      "http://192.168.0.5/feed",
      "http://172.16.9.9/feed",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/feed",
      "http://0.0.0.0/feed",
    ];
    for (const url of cases) {
      const verdict = checkFeedUrlSafety(url);
      assert.equal(verdict.ok, false, url);
      if (!verdict.ok) assert.match(verdict.reason, /private|loopback|carrier|NAT/i);
    }
  });

  it("rejects malformed IPv4 literals", () => {
    // The WHATWG URL parser itself rejects these hosts (an invalid IPv4
    // literal is an invalid URL), so any bounded rejection reason is correct.
    for (const url of ["http://999.1.1.1/feed", "http://1.2.3.4.5/feed"]) {
      const verdict = checkFeedUrlSafety(url);
      assert.equal(verdict.ok, false, url);
    }
  });

  it("rejects IPv6 loopback and private literals", () => {
    for (const url of [
      "http://[::1]/feed",
      "http://[fe80::1]/feed",
      "http://[fc00::1]/feed",
      "http://[fd12:3456::1]/feed",
    ]) {
      const verdict = checkFeedUrlSafety(url);
      assert.equal(verdict.ok, false, url);
      if (!verdict.ok) {
        assert.match(verdict.reason, /loopback|private|link-local|unique-local/i);
      }
    }
  });

  it("rejects IPv4-mapped and NAT64 IPv6 literals by their embedded address, and IPv4-compatible outright", () => {
    // WHATWG URL normalizes dotted-quad embedded forms to hex, so these
    // arrive as ::ffff:7f00:1 etc.; mapped and NAT64 translations route
    // through the embedded address, which runs the full IPv4 checks.
    const rejected = [
      "http://[::ffff:127.0.0.1]/feed", // mapped loopback
      "http://[::ffff:10.0.0.1]/feed", // mapped private
      "http://[::ffff:a9fe:a9fe]/feed", // mapped 169.254.169.254
      "http://[64:ff9b::7f00:1]/feed", // NAT64 loopback
    ];
    for (const url of rejected) {
      const verdict = checkFeedUrlSafety(url);
      assert.equal(verdict.ok, false, url);
      if (!verdict.ok) assert.match(verdict.reason, /embedded|loopback|private/i);
    }
    // The deprecated IPv4-compatible ::/96 form (RFC 4291 §2.5.5.1) is not a
    // translation mechanism and is not globally reachable: rejected outright.
    for (const url of ["http://[::7f00:1]/feed", "http://[::a9fe:a9fe]/feed"]) {
      const verdict = checkFeedUrlSafety(url);
      assert.equal(verdict.ok, false, url);
      if (!verdict.ok) assert.match(verdict.reason, /compatible/i);
    }
    // Embedded PUBLIC addresses are ordinary global addresses: allowed.
    assert.deepEqual(checkFeedUrlSafety("http://[::ffff:8.8.8.8]/feed"), { ok: true });
    assert.deepEqual(checkFeedUrlSafety("http://[64:ff9b::808:808]/feed"), { ok: true });
  });

  it("rejects multicast, reserved, and documentation IPv4 literals (IANA special-purpose set)", () => {
    const rejected = [
      "http://224.0.0.1/feed", // multicast lower boundary
      "http://239.255.255.255/feed", // multicast upper boundary
      "http://240.0.0.1/feed", // reserved lower boundary
      "http://254.1.2.3/feed", // reserved interior
      "http://192.0.0.8/feed", // IETF protocol assignments
      "http://192.0.2.1/feed", // TEST-NET-1
      "http://198.51.100.1/feed", // TEST-NET-2
      "http://203.0.113.1/feed", // TEST-NET-3
      "http://192.88.99.1/feed", // deprecated 6to4 relay anycast
      "http://198.18.0.1/feed", // benchmarking lower boundary
      "http://198.19.255.254/feed", // benchmarking upper boundary
    ];
    for (const url of rejected) {
      const verdict = checkFeedUrlSafety(url);
      assert.equal(verdict.ok, false, url);
      if (!verdict.ok) {
        assert.match(verdict.reason, /multicast|reserved|non-globally/i, url);
      }
    }
    // Adjacent globally-reachable boundaries stay allowed.
    for (const url of [
      "http://223.255.255.254/feed", // last global unicast before multicast
      "http://198.20.0.1/feed", // after the benchmarking /15
      "http://192.0.3.1/feed", // after IETF assignments and TEST-NET-1
      "http://203.0.114.1/feed", // after TEST-NET-3
    ]) {
      assert.deepEqual(checkFeedUrlSafety(url), { ok: true }, url);
    }
  });

  it("rejects the IPv6 special-purpose ranges that are not globally reachable", () => {
    const rejected = [
      "http://[100::1]/feed", // discard-only lower boundary (RFC 6666)
      "http://[100::ffff:ffff:ffff:ffff]/feed", // discard-only upper boundary
      "http://[2001:db8::1]/feed", // documentation (RFC 3849)
      "http://[2001:db8:ffff:ffff::1]/feed", // documentation within /32
      "http://[2001:2::1]/feed", // benchmarking (RFC 5180)
      "http://[2001:2:0:0:ffff:ffff:ffff:ffff]/feed", // benchmarking within /48
      "http://[2001:10::1]/feed", // ORCHID lower boundary (RFC 4843)
      "http://[2001:1f::1]/feed", // ORCHID upper boundary
      "http://[2001:20::1]/feed", // ORCHIDv2 lower boundary (RFC 7370)
      "http://[2001:2f::1]/feed", // ORCHIDv2 upper boundary
      "http://[64:ff9b:1::1]/feed", // local-use NAT64 (RFC 8215)
      "http://[2002:c000:201::1]/feed", // deprecated 6to4 (RFC 7526)
      // Mapped translations run the full IPv4 policy: mapped multicast and
      // mapped documentation ranges are rejected through the embedded check.
      "http://[::ffff:224.0.0.1]/feed", // mapped multicast
      "http://[::ffff:198.51.100.5]/feed", // mapped TEST-NET-2
    ];
    for (const url of rejected) {
      const verdict = checkFeedUrlSafety(url);
      assert.equal(verdict.ok, false, url);
      if (!verdict.ok) {
        assert.match(
          verdict.reason,
          /discard|documentation|benchmark|orchid|nat64|6to4|non-globally|multicast|reserved/i,
          url,
        );
      }
    }
    // Adjacent globally-reachable boundaries stay allowed.
    for (const url of [
      "http://[101::1]/feed", // after the discard-only /64
      "http://[2001:3::1]/feed", // after Teredo /32, before ORCHID /28s
      "http://[2001:2:1::1]/feed", // beyond the benchmarking /48
      "http://[2001:30::1]/feed", // after the ORCHIDv2 /28
      "http://[2001:db7::1]/feed", // below the documentation /32
      "http://[64:ff9b:2::1]/feed", // beyond local-use NAT64 /48
      "http://[2606:4700:4700::1111]/feed", // ordinary global unicast
    ]) {
      assert.deepEqual(checkFeedUrlSafety(url), { ok: true }, url);
    }
  });

  it("rejects the full link-local, unique-local, multicast, unspecified, and broadcast ranges", () => {
    const rejected = [
      "http://[fe90::1]/feed", // fe80::/10 beyond fe80:
      "http://[febf:ffff::1]/feed", // fe80::/10 upper boundary
      "http://[::]/feed", // unspecified
      "http://[ff12::1]/feed", // multicast beyond ff00:
      "http://255.255.255.255/feed", // limited broadcast
    ];
    for (const url of rejected) {
      const verdict = checkFeedUrlSafety(url);
      assert.equal(verdict.ok, false, url);
    }
    // Adjacent ranges stay allowed: fec0:: (deprecated site-local), fb00::
    // (below fc00::/7), feff:: (below ff00::/8), and global addresses.
    for (const url of [
      "http://[fec0::1]/feed",
      "http://[fb00::1]/feed",
      "http://[feff::1]/feed",
      "http://[2606:4700::1]/feed",
    ]) {
      assert.deepEqual(checkFeedUrlSafety(url), { ok: true }, url);
    }
  });

  it("rejects malformed IPv6 literals rather than guessing", () => {
    for (const host of [
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      ":1::2",
      "1:2:3:4:5:6:7:8::",
      "::1:2:3:4:5:6:7:8",
      "zzzz::1",
    ]) {
      const verdict = checkAddressSafety(host);
      assert.equal(verdict.ok, false, host);
      if (!verdict.ok) assert.match(verdict.reason, /malformed/);
    }
  });

  it("rejects localhost forms", () => {
    for (const url of ["http://localhost/feed", "http://api.localhost/feed"]) {
      const verdict = checkFeedUrlSafety(url);
      assert.equal(verdict.ok, false, url);
      if (!verdict.ok) assert.match(verdict.reason, /localhost/);
    }
  });

  it("rejects unparseable urls", () => {
    assert.equal(checkFeedUrlSafety("not a url at all").ok, false);
  });
});

// --- Resolved-host safety (pre-connection DNS validation) -------------------

describe("feed host resolution", () => {
  const url = "https://feeds.example.com/feed.xml";
  const fakeLookup = (addresses) => async () => addresses;

  it("accepts a name that resolves only to public addresses", async () => {
    const verdict = await resolveFeedHost(url, {
      lookup: fakeLookup([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]),
    });
    assert.deepEqual(verdict, { ok: true });
  });

  it("rejects when any resolved address is loopback, private, or link-local", async () => {
    for (const addresses of [
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "10.1.2.3", family: 4 }],
      [{ address: "169.254.169.254", family: 4 }],
      [{ address: "93.184.216.34", family: 4 }, { address: "192.168.0.5", family: 4 }],
      [{ address: "::1", family: 6 }],
      [{ address: "::ffff:7f00:1", family: 6 }], // IPv4-mapped loopback
      [{ address: "fd00::1", family: 6 }],
    ]) {
      const verdict = await resolveFeedHost(url, { lookup: fakeLookup(addresses) });
      assert.equal(verdict.ok, false, JSON.stringify(addresses));
      if (!verdict.ok) assert.match(verdict.reason, /resolved to/);
    }
  });

  it("fails closed on lookup errors and resolution timeouts", async () => {
    const failing = async () => {
      const error = new Error("queryA ESERVFAIL");
      error.code = "ESERVFAIL";
      throw error;
    };
    const failed = await resolveFeedHost(url, { lookup: failing });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.reason, /could not be resolved/);

    const hanging = () => new Promise(() => undefined);
    const timedOut = await resolveFeedHost(url, {
      lookup: hanging,
      timeoutMs: 20,
    });
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) assert.match(timedOut.reason, /timed out/);
  });

  it("does not resolve IP-literal hosts (the literal checks decided them)", async () => {
    let called = 0;
    const lookup = async () => {
      called += 1;
      return [];
    };
    const literal = await resolveFeedHost("https://[2606:4700::1]/feed", { lookup });
    assert.deepEqual(literal, { ok: true });
    const literalV4 = await resolveFeedHost("https://93.184.216.34/feed", { lookup });
    assert.deepEqual(literalV4, { ok: true });
    assert.equal(called, 0);
  });

  it("rejects a structurally unsafe url before resolving", async () => {
    let called = 0;
    const lookup = async () => {
      called += 1;
      return [];
    };
    const verdict = await resolveFeedHost("http://user:pass@example.com/feed", { lookup });
    assert.equal(verdict.ok, false);
    assert.equal(called, 0);
  });
});

// --- Feed parsing -----------------------------------------------------------

const RSS_FEED = `<rss version="2.0"><channel>
<item>
  <title>First &amp; title</title>
  <link>https://example.com/a</link>
  <description><![CDATA[<p>Some <b>bold</b> text</p>]]></description>
  <pubDate>Tue, 01 Apr 2025 10:00:00 GMT</pubDate>
</item>
<item>
  <title>Second title</title>
  <link>https://example.com/b</link>
  <description>Second excerpt</description>
</item>
<item>
  <title></title>
  <link>https://example.com/empty-title</link>
</item>
<item>
  <title>No url item</title>
  <description>has no link at all</description>
</item>
</channel></rss>`;

const ATOM_FEED = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <title>Atom entry</title>
  <link rel="alternate" href="https://example.org/entry"/>
  <summary>An atom summary</summary>
  <published>2025-04-02T08:00:00Z</published>
</entry>
<entry>
  <title>Rel-missing entry</title>
  <link href="https://example.org/rel-missing"/>
  <summary>content</summary>
</entry>
</feed>`;

describe("feed parsing", () => {
  it("parses RSS 2.0 items into excerpt-level articles", () => {
    const articles = parseFeed(RSS_FEED, "feed-a");
    assert.equal(articles.length, 2);
    assert.deepEqual(articles[0], {
      feedId: "feed-a",
      url: "https://example.com/a",
      title: "First & title",
      excerpt: "Some bold text",
      publishedAt: new Date("Tue, 01 Apr 2025 10:00:00 GMT"),
    });
    assert.equal(articles[1].title, "Second title");
    assert.equal(articles[1].excerpt, "Second excerpt");
    assert.equal(articles[1].publishedAt, null);
  });

  it("parses Atom entries, skipping entries without a usable link", () => {
    const articles = parseFeed(ATOM_FEED, "feed-b");
    assert.equal(articles.length, 2);
    assert.equal(articles[0].url, "https://example.org/entry");
    assert.equal(articles[0].excerpt, "An atom summary");
    assert.deepEqual(articles[0].publishedAt, new Date("2025-04-02T08:00:00Z"));
    assert.equal(articles[1].url, "https://example.org/rel-missing");
  });

  it("strips dangerous and formatting markup from excerpts", () => {
    const xml = `<rss version="2.0"><channel><item>
<title>Scripted</title>
<link>https://example.com/script</link>
<description><script>alert("${CANARY}")</script>Safe text<style>body{}</style> after</description>
</item></channel></rss>`;
    const [article] = parseFeed(xml, "feed-c");
    assert.ok(article !== undefined);
    assert.ok(!article.excerpt.includes(CANARY));
    assert.ok(!article.excerpt.includes("<script"));
    assert.ok(article.excerpt.includes("Safe text"));
  });

  it("bounds the excerpt length to the configured maximum", () => {
    const long = "x".repeat(50);
    const xml = `<rss version="2.0"><channel><item>
<title>Bounded</title>
<link>https://example.com/long</link>
<description>${Array.from({ length: 10 }, () => long).join(" ")}</description>
</item></channel></rss>`;
    const [article] = parseFeed(xml, "feed-d", { maxExcerptChars: 120 });
    assert.ok(article !== undefined);
    assert.equal(article.excerpt.length, 120);
    // Default cap applies when no option is given.
    const [defaultArticle] = parseFeed(xml, "feed-d");
    assert.ok(defaultArticle !== undefined);
    assert.ok(defaultArticle.excerpt.length <= MAX_EXCERPT_CHARS);
  });

  it("decodes xml entities in titles and excerpts", () => {
    const xml = `<rss version="2.0"><channel><item>
<title>A &amp; B</title>
<link>https://example.com/entities</link>
<description>5 &lt; 6 &amp; 7 &gt; 3</description>
</item></channel></rss>`;
    const [article] = parseFeed(xml, "feed-e");
    assert.ok(article !== undefined);
    assert.equal(article.title, "A & B");
    assert.equal(article.excerpt, "5 < 6 & 7 > 3");
  });

  it("normalizes whitespace inside titles and excerpts", () => {
    const xml = `<rss version="2.0"><channel><item>
<title>  Spaced
out   title </title>
<link>https://example.com/spaced</link>
<description>one
two&#9;three   four</description>
</item></channel></rss>`;
    const [article] = parseFeed(xml, "feed-f");
    assert.ok(article !== undefined);
    assert.equal(article.title, "Spaced out title");
    assert.equal(article.excerpt, "one two three four");
  });

  it("treats a malformed date as an absent date", () => {
    const xml = `<rss version="2.0"><channel><item>
<title>Bad date</title>
<link>https://example.com/bad-date</link>
<pubDate>not a date at all</pubDate>
</item></channel></rss>`;
    const [article] = parseFeed(xml, "feed-g");
    assert.ok(article !== undefined);
    assert.equal(article.publishedAt, null);
  });

  it("returns an empty list for a document without items", () => {
    assert.deepEqual(parseFeed("<rss version='2.0'><channel></channel></rss>", "feed-h"), []);
    assert.deepEqual(parseFeed("", "feed-i"), []);
  });

  it("canonicalizes item urls and skips unusable ones in isolation", () => {
    const xml = `<rss version="2.0"><channel>
<item>
  <title>Canonicalized</title>
  <link>https://EXAMPLE.com/a/../b?id=1#frag</link>
  <description>kept</description>
</item>
<item>
  <title>Oversized url</title>
  <link>https://example.com/${"x".repeat(MAX_ITEM_URL_CHARS + 1)}</link>
  <description>skipped: url over the cap</description>
</item>
<item>
  <title>Control character url</title>
  <link>https://example.com/bad&#1;url</link>
  <description>skipped: control character</description>
</item>
<item>
  <title>Non-http url</title>
  <link>javascript:alert(1)</link>
  <description>skipped: scheme</description>
</item>
<item>
  <title>Good neighbor</title>
  <link>https://example.com/after-bad-items</link>
  <description>still parsed</description>
</item>
</channel></rss>`;
    const articles = parseFeed(xml, "feed-j");
    // Bad items are isolated (skipped individually); good items survive.
    assert.equal(articles.length, 2);
    assert.equal(articles[0].url, "https://example.com/b?id=1#frag");
    assert.equal(articles[1].url, "https://example.com/after-bad-items");
  });

  it("strips control characters (including NUL) from titles and excerpts", () => {
    const xml = `<rss version="2.0"><channel><item>
<title>Nul &#0; title</title>
<link>https://example.com/nul</link>
<description>text&#1;with\u0000controls</description>
</item></channel></rss>`;
    const [article] = parseFeed(xml, "feed-k");
    assert.ok(article !== undefined);
    assert.ok(!article.title.includes("\u0000"));
    assert.ok(!article.excerpt.includes("\u0000"));
    assert.ok(!article.excerpt.includes("\u0001"));
    assert.match(article.excerpt, /text with controls/);
  });
});

// --- Bounded feed fetch (fake pinned-connector transport) -------------------

/** A "public" address the fake lookups hand out (no test performs real DNS). */
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

/**
 * A fake response shaped like node's http.IncomingMessage: a real Readable
 * (so `pipe` and zlib decompressors work) carrying a status and headers.
 */
function fakeResponse(status, headers) {
  const res = new Readable({ read() {} });
  res.statusCode = status;
  res.headers = headers;
  return res;
}

/**
 * A fake transport shaped like node's http(s).request: it receives
 * (url, options, callback) and returns a request-like EventEmitter. Like
 * node, it runs the pinned lookup hook from `options.lookup` during the
 * simulated connect, then either fails the request with the lookup error or
 * delivers the configured response. `payload` is a string, Buffer, or chunk
 * array fed to the response stream; `stall` makes the transport never
 * respond (timeout and cancellation tests).
 */
function makeFakeTransport(behavior = {}) {
  const seen = [];
  const lookupCalls = [];
  let destroyCalls = 0;
  const fn = (url, options, callback) => {
    const req = new EventEmitter();
    let destroyed = false;
    req.destroy = () => {
      destroyed = true;
      destroyCalls += 1;
    };
    // Mirror ClientRequest: the connector ends the bodiless GET to flush it.
    req.end = () => {};
    seen.push({ url: String(url), options });
    const deliver = () => {
      if (destroyed) return;
      const status = behavior.status ?? 200;
      const res = fakeResponse(status, behavior.headers ?? {});
      callback(res);
      if (status >= 200 && status < 300 && behavior.payload !== undefined) {
        const chunks = Array.isArray(behavior.payload) ? behavior.payload : [behavior.payload];
        setImmediate(() => {
          for (const chunk of chunks) {
            res.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
          res.push(null);
        });
      } else {
        setImmediate(() => res.push(null));
      }
    };
    if (behavior.stall === true) return req;
    options.lookup(String(new URL(url).hostname), { all: true }, (err, addresses) => {
      lookupCalls.push(err === null ? { addresses } : { error: err.message });
      if (err !== null) {
        req.emit("error", err);
        return;
      }
      deliver();
    });
    return req;
  };
  fn.seen = seen;
  fn.lookupCalls = lookupCalls;
  fn.destroyCount = () => destroyCalls;
  return fn;
}

describe("bounded feed fetch (pinned connector)", () => {
  it("frames a pinned request and decodes the body", async () => {
    const transport = makeFakeTransport({ payload: "<rss>ok</rss>" });
    const result = await boundedFetchText("https://example.com/feed.xml", {
      transport,
      lookupAll: PUBLIC_LOOKUP,
    });
    assert.equal(transport.seen.length, 1);
    const options = transport.seen[0].options;
    assert.equal(options.method, "GET");
    // SNI is the original hostname for non-literal https hosts.
    assert.equal(options.servername, "example.com");
    assert.equal(typeof options.lookup, "function");
    assert.match(options.headers["user-agent"], /companion-article-ingest/);
    assert.match(options.headers.accept, /rss\+xml/);
    assert.equal(result.body, "<rss>ok</rss>");
    assert.equal(result.bytes, "<rss>ok</rss>".length);
  });

  it("serves a public IP-literal host without SNI", async () => {
    const transport = makeFakeTransport({ payload: "<rss>ok</rss>" });
    const result = await boundedFetchText("http://93.184.216.34/feed.xml", {
      transport,
      lookupAll: PUBLIC_LOOKUP,
    });
    assert.equal(transport.seen.length, 1);
    assert.equal(transport.seen[0].options.servername, undefined);
    assert.equal(result.body, "<rss>ok</rss>");
  });

  it("serves an https IPv6 literal host without SNI (brackets never reach the SNI name)", async () => {
    // URL.hostname keeps the brackets on an IPv6 literal ("[2606:...]"). A
    // bracketed host must not be misread as a DNS name: the literal gets no
    // SNI (Node then validates the certificate against the literal's IP
    // SANs), and the bracketed form never reaches the SNI name.
    const transport = makeFakeTransport({ payload: "<rss>ok</rss>" });
    const result = await boundedFetchText("https://[2606:4700:4700::1111]/feed.xml", {
      transport,
      lookupAll: PUBLIC_LOOKUP,
    });
    assert.equal(transport.seen.length, 1);
    assert.equal(transport.seen[0].options.servername, undefined);
    assert.equal(result.body, "<rss>ok</rss>");
  });

  it("rejects a lookup that resolves an unsafe address before any connect", async () => {
    const transport = makeFakeTransport();
    const lookupAll = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await assert.rejects(
      boundedFetchText("https://example.com/feed.xml", { transport, lookupAll }),
      /resolved to/,
    );
    assert.equal(transport.lookupCalls.length, 1);
    assert.match(transport.lookupCalls[0].error, /resolved to/);
  });

  it("rejects rebinds: every connect re-resolves and re-validates", async () => {
    let call = 0;
    const lookupAll = async () => {
      call += 1;
      return call === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "10.0.0.5", family: 4 }];
    };
    const transport = makeFakeTransport({ payload: "<rss>ok</rss>" });
    const first = await boundedFetchText("https://example.com/feed.xml", { transport, lookupAll });
    assert.equal(first.body, "<rss>ok</rss>");
    await assert.rejects(
      boundedFetchText("https://example.com/feed.xml", { transport, lookupAll }),
      /resolved to/,
    );
    assert.equal(transport.lookupCalls.length, 2);
  });

  it("hands the connect exactly the validated addresses", async () => {
    const transport = makeFakeTransport();
    await boundedFetchText("https://example.com/feed.xml", {
      transport,
      lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    assert.deepEqual(transport.lookupCalls[0].addresses, [
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  it("aborts when the streamed body exceeds the byte cap", async () => {
    const transport = makeFakeTransport({
      payload: ["x".repeat(600), "x".repeat(600), "x".repeat(600)],
    });
    await assert.rejects(
      boundedFetchText("https://example.com/big.xml", {
        transport,
        lookupAll: PUBLIC_LOOKUP,
        maxBytes: 1000,
        timeoutMs: 5000,
      }),
      /byte cap/,
    );
  });

  it("rejects a declared content-length over the byte cap", async () => {
    const transport = makeFakeTransport({
      payload: "x",
      headers: { "content-length": String(MAX_FEED_BYTES + 1) },
    });
    await assert.rejects(
      boundedFetchText("https://example.com/declared.xml", { transport, lookupAll: PUBLIC_LOOKUP }),
      /over the .* cap/,
    );
  });

  it("rejects non-2xx responses", async () => {
    const transport = makeFakeTransport({ status: 404, payload: "nope" });
    await assert.rejects(
      boundedFetchText("https://example.com/missing.xml", { transport, lookupAll: PUBLIC_LOOKUP }),
      /HTTP 404/,
    );
  });

  it("rejects redirects instead of following them", async () => {
    const transport = makeFakeTransport({
      status: 302,
      headers: { location: "http://127.0.0.1/feed.xml" },
      payload: "",
    });
    await assert.rejects(
      boundedFetchText("https://example.com/redirect.xml", { transport, lookupAll: PUBLIC_LOOKUP }),
      /redirect/,
    );
    assert.equal(transport.seen.length, 1);
  });

  it("keeps the default timeout and byte cap bounded", () => {
    assert.equal(DEFAULT_FEED_TIMEOUT_MS > 0, true);
    assert.equal(MAX_FEED_BYTES > 0, true);
  });

  it("validates the host through the injected resolver before fetching", async () => {
    const resolutions = [];
    const transport = makeFakeTransport();
    const resolveHost = async (candidate) => {
      resolutions.push(candidate);
      return { ok: false, reason: "feed url host resolved to the IPv6 loopback" };
    };
    await assert.rejects(
      boundedFetchText("https://example.com/feed.xml", { transport, resolveHost }),
      /rejected before fetch/,
    );
    assert.deepEqual(resolutions, ["https://example.com/feed.xml"]);
    assert.equal(transport.seen.length, 0);
  });

  it("destroys the request on an early non-2xx reject", async () => {
    const transport = makeFakeTransport({ status: 500, payload: "nope" });
    await assert.rejects(
      boundedFetchText("https://example.com/fail.xml", { transport, lookupAll: PUBLIC_LOOKUP }),
      /HTTP 500/,
    );
    assert.equal(transport.destroyCount(), 1);
  });

  it("destroys the request when the declared content-length is over the cap", async () => {
    const transport = makeFakeTransport({
      payload: "x",
      headers: { "content-length": String(MAX_FEED_BYTES + 1) },
    });
    await assert.rejects(
      boundedFetchText("https://example.com/declared.xml", { transport, lookupAll: PUBLIC_LOOKUP }),
      /over the .* cap/,
    );
    assert.equal(transport.destroyCount(), 1);
  });

  it("destroys the request and aborts when the streamed body exceeds the cap", async () => {
    const transport = makeFakeTransport({
      payload: ["x".repeat(600), "x".repeat(600), "x".repeat(600)],
    });
    await assert.rejects(
      boundedFetchText("https://example.com/big.xml", {
        transport,
        lookupAll: PUBLIC_LOOKUP,
        maxBytes: 1000,
      }),
      /byte cap/,
    );
    assert.equal(transport.destroyCount(), 1);
  });

  it("aborts the request on the fetch timeout", async () => {
    const transport = makeFakeTransport({ stall: true });
    await assert.rejects(
      boundedFetchText("https://example.com/slow.xml", {
        transport,
        lookupAll: PUBLIC_LOOKUP,
        timeoutMs: 50,
      }),
      /timed out/,
    );
    assert.ok(transport.destroyCount() >= 1);
  });

  it("rejects an already-cancelled external signal before fetching", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = makeFakeTransport();
    await assert.rejects(
      boundedFetchText("https://example.com/feed.xml", {
        transport,
        lookupAll: PUBLIC_LOOKUP,
        signal: controller.signal,
      }),
      /cancelled/,
    );
    assert.equal(transport.seen.length, 0);
  });

  it("rejects an external cancellation raised during the fetch", async () => {
    const controller = new AbortController();
    const transport = makeFakeTransport({ stall: true });
    const pending = boundedFetchText("https://example.com/feed.xml", {
      transport,
      lookupAll: PUBLIC_LOOKUP,
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, /cancelled/);
  });

  it("decodes a gzip-encoded body", async () => {
    const transport = makeFakeTransport({
      payload: gzipSync(Buffer.from("<rss>ok</rss>")),
      headers: { "content-encoding": "gzip" },
    });
    const result = await boundedFetchText("https://example.com/feed.xml", {
      transport,
      lookupAll: PUBLIC_LOOKUP,
    });
    assert.equal(result.body, "<rss>ok</rss>");
    assert.equal(result.bytes, "<rss>ok</rss>".length);
  });

  it("caps the DECOMPRESSED body: a small gzip payload cannot expand past the cap", async () => {
    const transport = makeFakeTransport({
      payload: gzipSync(Buffer.from("y".repeat(5000))),
      headers: { "content-encoding": "gzip" },
    });
    await assert.rejects(
      boundedFetchText("https://example.com/bomb.xml", {
        transport,
        lookupAll: PUBLIC_LOOKUP,
        maxBytes: 1000,
      }),
      /byte cap/,
    );
  });

  it("rejects an unsupported content-encoding", async () => {
    const transport = makeFakeTransport({
      payload: "nope",
      headers: { "content-encoding": "zstd" },
    });
    await assert.rejects(
      boundedFetchText("https://example.com/encoded.xml", {
        transport,
        lookupAll: PUBLIC_LOOKUP,
      }),
      /content-encoding/,
    );
  });
});

// --- Reaction prompts ------------------------------------------------------

const SAMPLE_ARTICLE = {
  sourceName: "example-feed",
  title: "Sample title",
  excerpt: "Sample excerpt",
  url: "https://example.com/sample",
  publishedAt: "2025-04-02T08:00:00Z",
};

describe("reaction prompt envelopes", () => {
  it("renders a deterministic generation input", () => {
    const rendered = renderArticleReactionInput(SAMPLE_ARTICLE);
    assert.match(rendered, /SOURCE ARTICLE/);
    assert.match(rendered, /TITLE: Sample title/);
    assert.match(rendered, /URL: https:\/\/example\.com\/sample/);
    assert.match(rendered, /EXCERPT: Sample excerpt/);
    assert.match(rendered, /END SOURCE ARTICLE/);
    assert.equal(renderArticleReactionInput(SAMPLE_ARTICLE), rendered);
  });

  it("renders a deterministic review input", () => {
    const rendered = renderArticleReviewInput(SAMPLE_ARTICLE, "Proposed reaction text");
    assert.match(rendered, /REVIEW REQUEST/);
    assert.match(rendered, /PROPOSED REACTION:/);
    assert.match(rendered, /Proposed reaction text/);
    assert.equal(renderArticleReviewInput(SAMPLE_ARTICLE, "Proposed reaction text"), rendered);
  });

  it("carries bounded task presets", () => {
    assert.equal(articleTaskPresets.generation.maxTokens > 0, true);
    assert.equal(articleTaskPresets.review.maxTokens > 0, true);
    assert.equal(articleTaskPresets.generation.maxTokens <= MAX_ARTICLE_INPUT_CHARS * 2, true);
  });
});

describe("reaction output contracts", () => {
  it("accepts trimmed non-empty reaction text and bounds its length", () => {
    assert.equal(parseReactionText("  padded  "), "padded");
    assert.equal(parseReactionText("   \n  "), null);
    assert.equal(parseReactionText(""), null);
    const bounded = parseReactionText("y".repeat(MAX_REACTION_CHARS + 500));
    assert.equal(bounded.length, MAX_REACTION_CHARS);
    const custom = parseReactionText("z".repeat(50), 10);
    assert.equal(custom.length, 10);
  });

  it("parses a well-formed review object", () => {
    assert.deepEqual(parseReactionReview('{"verdict":"accept","reason":"fits persona"}'), {
      verdict: "accept",
      reason: "fits persona",
    });
    assert.deepEqual(parseReactionReview('{"verdict":"reject","reason":"off topic"}'), {
      verdict: "reject",
      reason: "off topic",
    });
  });

  it("tolerates surrounding text by taking the first balanced object", () => {
    const parsed = parseReactionReview(
      `Sure! ${CANARY} {"verdict":"accept","reason":"ok"} trailing text`,
    );
    assert.deepEqual(parsed, { verdict: "accept", reason: "ok" });
  });

  it("rejects malformed review output", () => {
    assert.equal(parseReactionReview(`{"verdict":"maybe","reason":"${CANARY}"}`), null);
    assert.equal(parseReactionReview('{"verdict":"accept"}'), null);
    assert.equal(parseReactionReview('{"reason":"no verdict"}'), null);
    assert.equal(parseReactionReview("[1,2,3]"), null);
    assert.equal(parseReactionReview("not json"), null);
    assert.equal(parseReactionReview(""), null);
    // Truncated JSON never resolves to a verdict.
    assert.equal(parseReactionReview('{"verdict":"accept","reason":"unclosed'), null);
  });

  it("bounds the parsed review reason", () => {
    const parsed = parseReactionReview(
      `{"verdict":"reject","reason":"${"r".repeat(800)}"}`,
    );
    assert.ok(parsed !== null);
    assert.ok(parsed.reason.length <= 500);
  });
});

describe("article source key", () => {
  it("is stable and traceable to its reaction row", () => {
    assert.equal(articleSourceKey("00000000-0000-4000-8000-000000000001"), "article:00000000-0000-4000-8000-000000000001");
    assert.equal(
      articleSourceKey("same-id"),
      articleSourceKey("same-id"),
    );
    assert.notEqual(articleSourceKey("a"), articleSourceKey("b"));
  });
});

// --- Error categories ------------------------------------------------------

describe("article error categories", () => {
  it("classifies configuration and disabled states", () => {
    assert.equal(articleErrorCategory(new ArticleConfigurationMissingError(CANARY)), "configuration");
    assert.equal(articleErrorCategory(new ArticleConfigurationInvalidError(CANARY)), "configuration");
    assert.equal(articleErrorCategory(new ArticleDisabledError()), "configuration");
    const base = new ArticleConfigError(CANARY);
    assert.ok(base instanceof Error);
  });

  it("classifies bounded http statuses", () => {
    const error = new Error("failed");
    error.status = 429;
    assert.equal(articleErrorCategory(error), "http_status_429");
    const noStatus = new Error("failed");
    assert.equal(articleErrorCategory(noStatus), "unexpected");
  });

  it("classifies network and timeout failures", () => {
    assert.equal(articleErrorCategory(new TypeError("fetch failed")), "network");
    assert.equal(articleErrorCategory(new RangeError("abort")), "network");
    assert.equal(articleErrorCategory(new Error("request timed out after 12s")), "timeout");
    assert.equal(articleErrorCategory(new Error("something else")), "unexpected");
  });

  it("never leaks error message text into a category", () => {
    const error = new Error(`${CANARY} secret detail`);
    assert.ok(!articleErrorCategory(error).includes(CANARY));
  });

  it("keeps the prompt versions in their namespaces", () => {
    assert.match(ARTICLE_REACTION_GENERATION_PROMPT_VERSION, /^article-/);
    assert.match(ARTICLE_REACTION_REVIEW_PROMPT_VERSION, /^article-/);
  });
});

// --- Consolidation response format (transport envelope) ---------------------

describe("article interest consolidation response format", () => {
  it("sends a json_schema envelope through the real request adapter", () => {
    // The real memory LLM adapter's request builder is the envelope under
    // test: a bare JSON Schema object is NOT a valid OpenRouter
    // response_format and would force the adapter's structured-output
    // fallback on every call.
    const body = buildMemoryLlmRequestBody({
      model: "fake-model",
      taskPreset: articleTaskPresets.consolidation,
      responseFormat: ARTICLE_INTEREST_CONSOLIDATION_RESPONSE_FORMAT,
    });
    const format = body.response_format;
    assert.ok(format !== undefined);
    assert.equal(format.type, "json_schema");
    assert.equal(format.json_schema.name, "article_interest_consolidation");
    assert.equal(format.json_schema.strict, true);
    const schema = format.json_schema.schema;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["observations"]);
    const item = schema.properties.observations.items;
    assert.equal(item.type, "object");
    assert.equal(item.additionalProperties, false);
    assert.deepEqual(item.required, [
      "claim",
      "condition",
      "consequence",
      "topics",
      "sourceFactIds",
      "contradictionFactIds",
    ]);
  });

  it("parses output the strict schema allows, including null optional fields", () => {
    const parsed = parseArticleInterestConsolidation(JSON.stringify({
      observations: [
        {
          claim: "Drawn to thoughtful tea writing",
          condition: null,
          consequence: null,
          topics: ["tea"],
          sourceFactIds: ["article:one", "article:two"],
          contradictionFactIds: null,
        },
      ],
    }));
    assert.ok(parsed !== null);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0].topics, ["tea"]);
    assert.deepEqual(parsed[0].sourceFactIds, ["article:one", "article:two"]);
    assert.equal(parsed[0].condition, undefined);
    assert.equal(parsed[0].contradictionFactIds, undefined);
  });
});
