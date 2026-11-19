// PWA foundation tests (offline): manifest validity and service-worker caching policy.
// Run: node --test storefront-tests/pwa.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = (p) => path.join(root, "public", p);

test("manifest: installable fields and icons that exist", () => {
  const m = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8"));
  for (const k of ["name", "short_name", "start_url", "scope", "display", "theme_color", "background_color", "icons"]) assert.ok(m[k], k);
  assert.equal(m.display, "standalone");
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  assert.ok(m.icons.some((i) => i.purpose === "maskable"));
  for (const i of m.icons) {
    const file = pub(i.src.replace(/^\//, ""));
    assert.ok(existsSync(file), i.src);
    const b = readFileSync(file);
    assert.equal(b.subarray(1, 4).toString(), "PNG");
    const [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)];
    assert.equal(`${w}x${h}`, i.sizes, `${i.src} is really ${i.sizes}`);
  }
  const html = readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color" content="#1B6B3C">/);
});

function loadWorker({ online = true } = {}) {
  const listeners = {}, cache = new Map(), calls = { fetch: [], respondWith: 0, cached: [] };
  const caches = {
    open: async () => ({ addAll: async (urls) => { calls.cached.push(...urls); urls.forEach((u) => cache.set(u, `cached:${u}`)); } }),
    keys: async () => ["taajamandi-shell-v0", "taajamandi-shell-v1"],
    delete: async (k) => { calls.deleted = (calls.deleted || []).concat(k); return true; },
    match: async (u) => cache.get(u),
  };
  const self = {
    addEventListener: (t, fn) => (listeners[t] = fn),
    skipWaiting: async () => {}, clients: { claim: async () => {} },
  };
  const fetch = async (req) => { calls.fetch.push(req.url); if (!online) throw new Error("offline"); return `network:${req.url}`; };
  vm.runInNewContext(readFileSync(pub("sw.js"), "utf8"), { self, caches, fetch, Promise });
  const dispatch = async (type, request) => {
    let responded = null, waits = [];
    listeners[type]({ request, waitUntil: (p) => waits.push(p), respondWith: (p) => { calls.respondWith++; responded = p; } });
    await Promise.all(waits);
    return responded ? await responded : undefined;
  };
  return { dispatch, calls };
}

test("service worker precaches only the offline page and an icon; removes old caches", async () => {
  const { dispatch, calls } = loadWorker();
  await dispatch("install", null);
  assert.deepEqual(calls.cached, ["/offline.html", "/icons/icon-192.png"]);
  await dispatch("activate", null);
  assert.deepEqual(calls.deleted, ["taajamandi-shell-v0"]);
});

test("service worker: navigations are network-first with offline fallback; data requests are never intercepted", async () => {
  let w = loadWorker({ online: true });
  await w.dispatch("install", null);
  assert.equal(await w.dispatch("fetch", { method: "GET", mode: "navigate", url: "https://taajamandi.vercel.app/" }), "network:https://taajamandi.vercel.app/");
  w = loadWorker({ online: false });
  await w.dispatch("install", null);
  assert.equal(await w.dispatch("fetch", { method: "GET", mode: "navigate", url: "https://taajamandi.vercel.app/" }), "cached:/offline.html");
  const before = w.calls.respondWith;
  for (const req of [
    { method: "GET", mode: "cors", url: "https://x.supabase.co/rest/v1/product_variants?select=price_paise" },
    { method: "POST", mode: "cors", url: "https://x.supabase.co/functions/v1/create-order" },
    { method: "GET", mode: "no-cors", url: "https://taajamandi.vercel.app/js/store.js" },
  ]) await w.dispatch("fetch", req);
  assert.equal(w.calls.respondWith, before, "prices, orders and scripts always come from the network");
});
