// PWA unit coverage for apps/web: the web app manifest (app/manifest.ts),
// the icon generation routes (app/icon.ts, app/apple-icon.ts, app/icons/*),
// the service worker's actual behavior (public/sw.js, executed in a Node vm
// with a minimal service-worker environment), and source invariants that pin
// the privacy posture: only the static offline page is ever cached, only
// top-level same-origin GET navigations outside the BFF's /api surface are
// intercepted, network-first with HTTP error responses preserved, and cache
// cleanup scoped to the worker's own prefix. Hermetic: no network, no
// browser, no Next.js runtime beyond the type-only manifest import.

import "./helpers/register-web-aliases.mjs";

import { readFileSync } from "node:fs";
import zlib from "node:zlib";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const webRoot = join(projectRoot, "apps", "web");
const manifest = (await import("../../apps/web/src/app/manifest.ts")).default();

const appIconRoute = (await import("../../apps/web/src/app/icon.ts")).default;
const appleIconRoute = (await import("../../apps/web/src/app/apple-icon.ts")).default;
const manifestIconRoutes = {
  "/icons/icon-192.png": (await import("../../apps/web/src/app/icons/icon-192.png/route.ts")).GET,
  "/icons/icon-512.png": (await import("../../apps/web/src/app/icons/icon-512.png/route.ts")).GET,
  "/icons/icon-maskable-512.png": (
    await import("../../apps/web/src/app/icons/icon-maskable-512.png/route.ts")
  ).GET,
};
const { MASKABLE_SAFE_RADIUS } = await import("../../apps/web/src/lib/icons.ts");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decodes the PNG bytes an icon route delivers (the repo's encoder uses
 * filter type 0 scanlines and RGBA color type 6), exposing the IHDR format
 * fields and a pixel accessor so tests verify what is actually served.
 */
function decodePng(bytes) {
  const png = Buffer.from(bytes);
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), "PNG signature");
  let off = 8;
  let width, height, bitDepth, colorType;
  const idat = [];
  while (off < png.length) {
    const length = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    if (type === "IHDR") {
      width = png.readUInt32BE(off + 8);
      height = png.readUInt32BE(off + 12);
      bitDepth = png[off + 16];
      colorType = png[off + 17];
    } else if (type === "IDAT") {
      idat.push(png.subarray(off + 8, off + 8 + length));
    }
    off += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  return {
    width,
    height,
    bitDepth,
    colorType,
    pixel: (x, y) => {
      const o = y * stride + 1 + x * 4;
      return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
    },
  };
}

/** RGBA bytes as a Response body, decoded for pixel-level assertions. */
async function decodedRouteResponse(get) {
  const response = await get();
  assert.equal(response.headers.get("content-type"), "image/png");
  return decodePng(new Uint8Array(await response.arrayBuffer()));
}

function readWebFile(relativePath) {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

/** Source with comments removed, so guardrails check code, not prose. */
function readCode(relativePath) {
  return readWebFile(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("web app manifest", () => {
  it("meets the installability criteria", () => {
    assert.ok(manifest.name || manifest.short_name);
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.display, "standalone");
    const sizes = (manifest.icons ?? []).map((icon) => icon.sizes);
    assert.ok(sizes.includes("192x192"));
    assert.ok(sizes.includes("512x512"));
  });

  it("contains only static, user-agnostic values", () => {
    const serialized = JSON.stringify(manifest);
    assert.doesNotMatch(serialized, /token|secret|cookie|session/i);
    assert.doesNotMatch(manifest.start_url, /\?/); // no per-user query
  });

  it("declares an any and a maskable icon whose delivered bytes match", async () => {
    const purposes = (manifest.icons ?? []).map((icon) => icon.purpose);
    assert.ok(purposes.includes("any"));
    assert.ok(purposes.includes("maskable"));
    for (const icon of manifest.icons ?? []) {
      const get = manifestIconRoutes[icon.src];
      assert.ok(get, `manifest icon src must map to an icon route: ${icon.src}`);
      const image = await decodedRouteResponse(get);
      assert.equal(`${image.width}x${image.height}`, icon.sizes);
      assert.equal(icon.type, "image/png");
      // Delivered format: 8-bit RGBA.
      assert.equal(image.bitDepth, 8, icon.src);
      assert.equal(image.colorType, 6, icon.src);
    }
  });

  it("uses the app theme's light background as its chrome colors", () => {
    // src/theme/theme.ts SCHEME_THEME_COLORS.light (importing the theme
    // module would pull MUI into the hermetic suite, so the value is pinned
    // here and must be kept in sync deliberately).
    assert.equal(manifest.background_color, "#f4f3f9");
    assert.equal(manifest.theme_color, "#f4f3f9");
  });
});

describe("generated icon assets", () => {
  it("favicon and Apple icons: PNG format and declared dimensions", async () => {
    assert.deepEqual(
      (await import("../../apps/web/src/app/icon.ts")).size,
      { width: 32, height: 32 },
    );
    const favicon = await decodedRouteResponse(appIconRoute);
    assert.equal(favicon.width, 32);
    assert.equal(favicon.height, 32);
    assert.equal(favicon.bitDepth, 8);
    assert.equal(favicon.colorType, 6);

    // Apple home-screen icons are 180x180 and full bleed (Apple masks them).
    assert.deepEqual(
      (await import("../../apps/web/src/app/apple-icon.ts")).size,
      { width: 180, height: 180 },
    );
    const apple = await decodedRouteResponse(appleIconRoute);
    assert.equal(apple.width, 180);
    assert.equal(apple.height, 180);
  });

  it("manifest icons deliver the declared sizes", async () => {
    for (const get of Object.values(manifestIconRoutes)) {
      const image = await decodedRouteResponse(get);
      assert.ok(
        (image.width === 192 || image.width === 512) && image.width === image.height,
      );
    }
  });

  it("'any' icons have rounded corners; full-bleed icons cover the square", async () => {
    const anyIcon = await decodedRouteResponse(manifestIconRoutes["/icons/icon-512.png"]);
    // Corner pixels are transparent (rounded), edge-center pixels opaque.
    assert.equal(anyIcon.pixel(0, 0)[3], 0);
    assert.equal(anyIcon.pixel(Math.floor(anyIcon.width / 2), 0)[3], 255);

    for (const fullBleed of [
      decodedRouteResponse(manifestIconRoutes["/icons/icon-maskable-512.png"]),
      decodedRouteResponse(appleIconRoute),
    ]) {
      const image = await fullBleed;
      // Every pixel is opaque: the OS applies its own mask.
      const corner = image.pixel(0, 0);
      assert.equal(corner[3], 255);
      const opposite = image.pixel(image.width - 1, image.height - 1);
      assert.equal(opposite[3], 255);
    }
  });

  it("the maskable glyph stays inside the safe-zone circle", async () => {
    const image = await decodedRouteResponse(
      manifestIconRoutes["/icons/icon-maskable-512.png"],
    );
    const center = (image.width - 1) / 2;
    // The glyph is white on the colored background; near-white pixels must
    // all lie within the maskable safe zone (radius 0.4 around the center),
    // with a small epsilon for anti-aliased edge pixels.
    const limit = MASKABLE_SAFE_RADIUS * image.width + 1.5;
    let glyphPixels = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const [r, g, b] = image.pixel(x, y);
        if (r > 200 && g > 200 && b > 200) {
          glyphPixels++;
          const dx = x - center;
          const dy = y - center;
          assert.ok(
            Math.sqrt(dx * dx + dy * dy) <= limit,
            `white pixel at ${x},${y} outside the safe zone`,
          );
        }
      }
    }
    // The glyph is actually present, not just a plain background square.
    assert.ok(glyphPixels > 0);
  });

  it("glyph and background use the app theme's colors", async () => {
    const image = await decodedRouteResponse(manifestIconRoutes["/icons/icon-512.png"]);
    // Glyph pixel: white. Background pixel (top strip, outside the bubble):
    // the light primary color #5b4bc4.
    const background = image.pixel(Math.floor(image.width / 2), Math.floor(image.height * 0.1));
    assert.deepEqual(background, [0x5b, 0x4b, 0xc4, 255]);
    const glyph = image.pixel(Math.floor(image.width / 2), Math.floor(image.height * 0.35));
    assert.deepEqual(glyph, [0xff, 0xff, 0xff, 255]);
  });
});

// ---------------------------------------------------------------------------
// Service worker behavior (public/sw.js in a Node vm).
// ---------------------------------------------------------------------------

const CURRENT_CACHE = "companion-offline-v1";

function loadServiceWorker(options) {
  const handlers = new Map();
  const stores = new Map();
  const deleted = [];
  const network = {
    fail: options.network === "fail",
    errorStatus: options.network === "http-error" ? 503 : undefined,
  };
  const origin = options.origin ?? "https://companion.example.com";

  for (const name of options.preseededCaches ?? []) {
    stores.set(name, new Map());
  }

  const networkFetch = (request) => {
    if (network.fail) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    if (network.errorStatus !== undefined) {
      return Promise.resolve({
        ok: false,
        status: network.errorStatus,
        url: request.url,
        body: "unavailable",
      });
    }
    return Promise.resolve({ ok: true, status: 200, url: request.url, body: "network" });
  };

  const context = vm.createContext({
    self: {
      addEventListener: (type, fn) => {
        handlers.set(type, fn);
      },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
      location: { origin },
    },
    caches: {
      open: (name) => {
        let store = stores.get(name);
        if (!store) {
          store = new Map();
          stores.set(name, store);
        }
        return Promise.resolve({
          add: async (request) => {
            await networkFetch(request);
            const key = new URL(request.url).pathname;
            // Store a response-like record keyed by path, as the worker
            // retrieves it via cache.match("/offline.html").
            store.set(key, { ok: true, status: 200, url: key, body: "offline page" });
          },
          match: async (url) => store.get(url),
        });
      },
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (name) => {
        deleted.push(name);
        stores.delete(name);
        return Promise.resolve(true);
      },
    },
    fetch: networkFetch,
    Request: class {
      url;
      cache;
      constructor(input, init) {
        this.url = new URL(input, origin).href;
        if (init) Object.assign(this, init);
      }
    },
    URL,
    console,
  });

  vm.runInContext(readWebFile("public/sw.js"), context);

  const runPhase = async (phase) => {
    let pending;
    const handler = handlers.get(phase);
    handler?.({
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    await pending;
  };

  const dispatchFetch = async (request) => {
    let responded;
    const handler = handlers.get("fetch");
    handler?.({
      request,
      respondWith: (promise) => {
        responded = promise;
      },
    });
    if (!responded) return { intercepted: false, response: undefined };
    return { intercepted: true, response: await responded };
  };

  return {
    stores,
    deleted,
    install: () => runPhase("install"),
    activate: () => runPhase("activate"),
    dispatchFetch,
    /** Flip the network off after a successful install (going "offline"). */
    goOffline: () => {
      network.fail = true;
    },
  };
}

const nav = (path, overrides = {}) => ({
  url: `https://companion.example.com${path}`,
  mode: "navigate",
  method: "GET",
  ...overrides,
});

describe("service worker behavior", () => {
  it("installs only the offline page into its own cache", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: ["other-app-data"] });
    await sw.install();
    assert.deepEqual([...sw.stores.keys()].sort(), [
      "companion-offline-v1",
      "other-app-data",
    ]);
    assert.deepEqual([...sw.stores.get(CURRENT_CACHE).keys()], ["/offline.html"]);
  });

  it("activation deletes only same-prefix caches, preserving unrelated ones", async () => {
    const sw = loadServiceWorker({
      network: "ok",
      preseededCaches: [
        "other-app-data",
        "another-pwa-runtime-cache",
        "companion-offline-v0",
      ],
    });
    await sw.install();
    await sw.activate();
    assert.deepEqual(sw.deleted, ["companion-offline-v0"]);
    assert.deepEqual([...sw.stores.keys()].sort(), [
      "another-pwa-runtime-cache",
      CURRENT_CACHE,
      "other-app-data",
    ]);
  });

  it("passes navigations through to the network while reachable", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: ["other-app-data"] });
    await sw.install();
    const result = await sw.dispatchFetch(nav("/"));
    assert.equal(result.intercepted, true);
    assert.equal(result.response.url, "https://companion.example.com/");
    assert.equal(result.response.body, "network");
    // Nothing beyond the offline page was stored.
    assert.equal(sw.stores.get("other-app-data").size, 0);
    assert.deepEqual([...sw.stores.get(CURRENT_CACHE).keys()], ["/offline.html"]);
  });

  it("serves the offline page only for failed non-API navigations", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: [] });
    await sw.install();
    sw.goOffline();
    const result = await sw.dispatchFetch(nav("/"));
    assert.equal(result.intercepted, true);
    assert.equal(result.response.url, "/offline.html");
  });

  it("rethrows when the network fails and no offline page is cached", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: [] });
    await sw.install();
    sw.stores.get(CURRENT_CACHE).clear();
    sw.goOffline();
    await assert.rejects(sw.dispatchFetch(nav("/")));
  });

  it("preserves HTTP error responses instead of substituting the fallback", async () => {
    const sw = loadServiceWorker({ network: "http-error", preseededCaches: [] });
    await sw.install();
    const result = await sw.dispatchFetch(nav("/"));
    assert.equal(result.intercepted, true);
    assert.equal(result.response.status, 503);
    assert.equal(result.response.url, "https://companion.example.com/");
    // The error response was not cached either.
    assert.deepEqual([...sw.stores.get(CURRENT_CACHE).keys()], ["/offline.html"]);
  });

  it("never intercepts BFF API paths, even as navigations while offline", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: [] });
    await sw.install();
    sw.goOffline();
    for (const path of [
      "/api",
      "/api/",
      "/api/thread",
      "/api/messages",
      "/api/auth/login",
      "/api/auth/callback",
      "/api/test-gate/session",
    ]) {
      const result = await sw.dispatchFetch(nav(path));
      assert.equal(result.intercepted, false, path);
    }
  });

  it("never intercepts subresource or non-GET requests", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: [] });
    await sw.install();
    sw.goOffline();
    for (const request of [
      nav("/api/messages", { mode: "cors", method: "POST" }),
      nav("/api/thread", { mode: "cors" }),
      nav("/", { mode: "same-origin", method: "POST" }),
    ]) {
      const result = await sw.dispatchFetch(request);
      assert.equal(result.intercepted, false, request.url);
    }
  });

  it("never answers a cross-origin navigation from its cache", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: [] });
    await sw.install();
    sw.goOffline();
    const result = await sw.dispatchFetch({
      url: "https://other.example.net/page",
      mode: "navigate",
      method: "GET",
    });
    assert.equal(result.intercepted, false);
  });
});

describe("service worker source invariants", () => {
  const source = readCode("public/sw.js");

  it("only intercepts top-level GET same-origin navigations outside the API surface", () => {
    assert.ok(source.includes('request.mode !== "navigate"'));
    assert.ok(source.includes('request.method !== "GET"'));
    assert.ok(source.includes("url.origin !== self.location.origin"));
    assert.ok(source.includes('pathname === "/api"'));
    assert.ok(source.includes('pathname.startsWith("/api/")'));
    // The API gate runs before anything can be answered by the worker.
    assert.ok(
      source.indexOf('pathname.startsWith("/api/")') < source.indexOf("event.respondWith"),
    );
    // "/api" appears exactly twice — as the two exclusions — never as a
    // fetch or cache target.
    assert.equal(source.match(/\/api/g)?.length, 2);
    assert.doesNotMatch(source, /cookie|authorization|token|session/i);
  });

  it("caches nothing except the static offline page", () => {
    assert.ok(source.includes('OFFLINE_URL = "/offline.html"'));
    assert.equal(source.match(/cache\.add\(/g)?.length, 1);
    assert.doesNotMatch(source, /cache\.addAll/);
    assert.doesNotMatch(source, /cache\.put/);
    // Navigations always hit the network first; the cache is only consulted
    // when the network request throws.
    assert.ok(source.includes("await fetch(request)"));
    assert.ok(
      source.indexOf("await fetch(request)") < source.indexOf("cache.match("),
    );
  });

  it("scopes cache cleanup to its own prefix", () => {
    assert.ok(source.includes('CACHE_PREFIX = "companion-offline-"'));
    assert.ok(source.includes("name.startsWith(CACHE_PREFIX)"));
    assert.ok(source.includes("name !== CACHE_NAME"));
    assert.equal(source.match(/caches\.delete\(/g)?.length, 1);
  });
});

describe("offline fallback page", () => {
  const source = readWebFile("public/offline.html");

  it("is fully self-contained", () => {
    // No external requests: the page must render with no network at all.
    assert.doesNotMatch(source, /https?:\/\//);
    assert.doesNotMatch(source, /\ssrc="/);
    assert.doesNotMatch(source, /\shref="/);
  });

  it("does not imply offline functionality", () => {
    assert.match(source, /offline/i);
    assert.match(source, /needs a connection/i);
  });
});

describe("service worker registration component", () => {
  const source = readCode("src/components/register-service-worker.tsx");

  it("registers only in production builds, best-effort", () => {
    // The production gate precedes any registration.
    assert.ok(source.includes('process.env.NODE_ENV !== "production"'));
    assert.ok(
      source.indexOf('process.env.NODE_ENV !== "production"') <
        source.indexOf('navigator.serviceWorker.register'),
    );
    assert.ok(source.includes('"serviceWorker" in navigator'));
    assert.ok(source.includes('register("/sw.js")'));
    // Best-effort: a failed registration never surfaces as an error.
    assert.match(source, /\.register\("\/sw\.js"\)\.catch\(\(\) => \{\}\)/);
  });

  it("waits for the page load and renders nothing", () => {
    assert.ok(source.includes('document.readyState === "complete"'));
    assert.ok(source.includes('window.addEventListener("load", register'));
    assert.ok(source.includes("return null;"));
  });
});

describe("root layout wiring", () => {
  const source = readCode("src/app/layout.tsx");

  it("links the manifest and the Apple web-app metadata", () => {
    assert.ok(source.includes('manifest: "/manifest.webmanifest"'));
    assert.ok(source.includes('applicationName: "Companion"'));
    assert.ok(source.includes("appleWebApp"));
    assert.ok(source.includes("capable: true"));
    assert.ok(source.includes('title: "Companion"'));
    assert.ok(source.includes('statusBarStyle: "default"'));
  });

  it("mounts the service worker registration", () => {
    assert.ok(source.includes("register-service-worker"));
    assert.ok(source.includes("<RegisterServiceWorker />"));
  });

  it("keeps the existing viewport and theme handling", () => {
    assert.ok(source.includes('viewportFit: "cover"'));
    assert.ok(source.includes("themeColor:"));
    assert.ok(source.includes("SCHEME_THEME_COLORS.light"));
    assert.ok(source.includes("SCHEME_THEME_COLORS.dark"));
    assert.ok(source.includes("InitColorSchemeScript"));
    assert.ok(source.includes("MODE_STORAGE_KEY"));
    assert.ok(source.includes("COLOR_SCHEME_STORAGE_KEY"));
  });
});
