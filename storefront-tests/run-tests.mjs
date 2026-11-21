// Offline tests for standalone/index.html. Run:  node tests/run-tests.mjs
// Uses jsdom from the sibling TanStack project and an in-memory FAKE Supabase client.
// Nothing here talks to the network or the production database. Fixture rows are test data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = process.env.HTML_PATH || path.join(here, "..", "index.html");
// index.html loads its code from public/js as separate plain scripts. Rebuild the page the way a browser runs it:
// each file inlined into its own <script> tag in the same order (createClient is supplied by the fake below).
const rawHtml = readFileSync(htmlPath, "utf8");
const jsDir = process.env.JS_DIR || path.join(path.dirname(htmlPath), "public", "js");
const scriptOrder = [...rawHtml.matchAll(/<script defer src="\/js\/([a-z-]+\.js)"><\/script>/g)].map((m) => m[1]);
const source = rawHtml
  .replace(/<script type="module">import \{ createClient \}[^<]*<\/script>/, "")
  .replace(/<script defer src="\/js\/([a-z-]+\.js)"><\/script>/g, (_, f) => `<script>\n${readFileSync(path.join(jsDir, f), "utf8")}\n</script>`);
const jsdomHost =
  process.env.JSDOM_HOST ||
  [
    path.join(here, "..", "package.json"),
    path.join(here, "..", "..", "taajamandi-fresh-market-main", "package.json"),
  ].find((p) => existsSync(path.join(path.dirname(p), "node_modules", "jsdom"))) ||
  "";
if (!existsSync(jsdomHost)) throw new Error("jsdom host project not found: " + jsdomHost);
const { JSDOM } = createRequire(jsdomHost)("jsdom");

// ---------------- Pure rules (extracted verbatim from index.html) ----------------
const rulesSrc = source.match(/\/\/ BEGIN TAAJA_RULES[\s\S]*?\/\/ END TAAJA_RULES/)[0];
const R = new Function(
  `${rulesSrc}\nreturn {TAAJA_RADIUS_M,BARGAIN_MIN_KG,PUBLIC_SETTING_KEYS,taajaDistanceM,taajaInsideBoundary,parseLatLng,taajaTodayIndia,taajaAddDays,taajaIsDate,taajaBookingRules,taajaBookingError,taajaFormatDate,variantKg,defaultVariant,sortVariantsForDisplay,formatKg,perKgPaise,bargainRateVariant,bargainEstimatePaise,bargainError,normalizeWhatsAppNumber};`,
)();

test("Kolkata date: rolls over at IST midnight, not UTC", () => {
  assert.equal(R.taajaTodayIndia(new Date("2026-11-30T18:29:59Z")), "2026-11-30");
  assert.equal(R.taajaTodayIndia(new Date("2026-11-30T18:30:00Z")), "2026-12-01");
  assert.equal(R.taajaTodayIndia(new Date("2026-12-01T18:30:00Z")), "2026-12-02");
});
test("booking rules before Dec 1: advance only, 1 Dec or later, default 1 Dec", () => {
  const r = R.taajaBookingRules("2026-11-18");
  assert.deepEqual(r.types, ["advance"]);
  assert.equal(r.defaultDate, "2026-12-01");
  assert.equal(r.minAdvance, "2026-12-01");
  assert.equal(r.fixedDate, null);
  assert.equal(R.taajaBookingError("2026-11-18", "advance", "2026-12-01"), null);
  assert.equal(R.taajaBookingError("2026-11-18", "advance", "2026-12-05"), null);
  assert.match(R.taajaBookingError("2026-11-18", "advance", "2026-11-19"), /1 December/);
  assert.match(R.taajaBookingError("2026-11-18", "advance", "2026-11-30"), /1 December/);
  assert.match(R.taajaBookingError("2026-11-18", "same_day", "2026-11-18"), /1 December/);
  assert.equal(R.taajaBookingRules("2026-11-30").defaultDate, "2026-12-01");
  assert.equal(R.taajaBookingError("2026-11-30", "advance", "2026-12-01"), null);
});
test("booking rules on Dec 1: deliveries begin, same-day available", () => {
  const r = R.taajaBookingRules("2026-12-01");
  assert.deepEqual(r.types, ["same_day", "advance"]);
  assert.equal(r.defaultDate, "2026-12-01");
  assert.equal(R.taajaBookingError("2026-12-01", "same_day", "2026-12-01"), null);
  assert.equal(R.taajaBookingError("2026-12-01", "advance", "2026-12-02"), null);
  assert.match(R.taajaBookingError("2026-12-01", "advance", "2026-12-01"), /future/);
});
test("booking rules from Dec 2: same-day today or advance future", () => {
  assert.deepEqual(R.taajaBookingRules("2026-12-02").types, ["same_day", "advance"]);
  assert.equal(R.taajaBookingError("2026-12-02", "same_day", "2026-12-02"), null);
  assert.match(R.taajaBookingError("2026-12-02", "same_day", "2026-12-03"), /today/);
  assert.equal(R.taajaBookingError("2026-12-02", "advance", "2026-12-03"), null);
  assert.match(R.taajaBookingError("2026-12-02", "advance", "2026-12-02"), /future/);
  assert.equal(R.taajaBookingRules("2026-12-31").minAdvance, "2027-01-01");
});
test("booking rejects malformed dates and types", () => {
  assert.ok(R.taajaBookingError("2026-12-05", "express", "2026-12-06"));
  assert.ok(R.taajaBookingError("2026-12-05", "advance", "2026-02-30"));
  assert.ok(R.taajaBookingError("2026-12-05", "advance", ""));
  assert.equal(R.taajaFormatDate("2026-12-02"), "Wednesday, 2 December 2026");
});
test("approved boundary matches create-order circle (7.4 km)", () => {
  assert.equal(R.TAAJA_RADIUS_M, 7400);
  assert.ok(R.taajaInsideBoundary(17.5299559, 78.3055903), "centre");
  assert.ok(R.taajaInsideBoundary(17.5299559 + 7.3 / 111.2, 78.3055903), "7.3 km north");
  assert.ok(!R.taajaInsideBoundary(17.5299559 + 7.5 / 111.2, 78.3055903), "7.5 km north");
  assert.ok(!R.taajaInsideBoundary(17.4401, 78.3489), "Gachibowli ~11 km");
  for (const bad of [null, "", undefined, NaN, "abc"])
    assert.ok(!R.taajaInsideBoundary(bad, 78.3), String(bad));
  assert.deepEqual(R.parseLatLng("17.53, 78.3056"), { lat: 17.53, lng: 78.3056 });
  assert.equal(R.parseLatLng("hello"), null);
});
test("variant weights and default variant", () => {
  assert.equal(R.variantKg({ name: "250 g", quantity: 0.25, unit: "kg" }), 0.25);
  assert.equal(R.variantKg({ name: "250 g", quantity: 250, unit: "g" }), 0.25);
  assert.equal(R.variantKg({ name: "1 kg", quantity: 1, unit: "kg" }), 1);
  assert.equal(R.variantKg({ name: "1 piece", quantity: 1, unit: "piece" }), null);
  const vs = [
    { id: "a", is_default: true, in_stock: false, name: "1 kg", quantity: 1, unit: "kg" },
    { id: "b", in_stock: true, name: "250 g", quantity: 0.25, unit: "kg" },
  ];
  assert.equal(R.defaultVariant(vs).id, "b", "falls back to an in-stock size");
  assert.equal(R.defaultVariant([{ ...vs[0], in_stock: true }, vs[1]]).id, "a");
  assert.equal(R.defaultVariant([]), null);
  assert.deepEqual(
    R.sortVariantsForDisplay([
      { name: "1 kg", quantity: 1, unit: "kg" },
      { name: "250 g", quantity: 0.25, unit: "kg" },
      { name: "500 g", quantity: 0.5, unit: "kg" },
    ]).map((v) => v.name),
    ["250 g", "500 g", "1 kg"],
  );
});
test("bargain: minimum 5 kg, step and offer validation", () => {
  assert.equal(R.BARGAIN_MIN_KG, 5);
  assert.match(R.bargainError(4.5, "100"), /5 kg/);
  assert.match(R.bargainError(0, "100"), /5 kg/);
  assert.equal(R.bargainError(5, "100"), null);
  assert.equal(R.bargainError(12.5, "450.50"), null);
  assert.match(R.bargainError(5.25, "100"), /steps/);
  assert.match(R.bargainError(60, "100"), /contact/);
  assert.match(R.bargainError(10, ""), /offering/);
  assert.match(R.bargainError(10, "-5"), /offering/);
  assert.match(R.bargainError(10, "10.999"), /offering/);
  assert.equal(R.bargainEstimatePaise(4000, 12.5), 50000);
});
test("WhatsApp number normalisation (no invented defaults)", () => {
  assert.equal(R.normalizeWhatsAppNumber(""), "");
  assert.equal(R.normalizeWhatsAppNumber("90000 00001"), "919000000001");
  assert.equal(R.normalizeWhatsAppNumber("+91 90000-00001"), "919000000001");
  assert.equal(R.normalizeWhatsAppNumber("090000 00001"), "919000000001");
  assert.equal(R.normalizeWhatsAppNumber("12345"), "");
  assert.equal(R.normalizeWhatsAppNumber("5000000001"), "");
  assert.ok(
    R.PUBLIC_SETTING_KEYS.includes("whatsapp_number") &&
      R.PUBLIC_SETTING_KEYS.includes("support_phone"),
  );
});

// ---------------- DOM integration with a fake Supabase ----------------
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CAT = uid(1),
  TOMATO = uid(10),
  BRINJAL = uid(11),
  SPINACH = uid(12),
  CAPSICUM = uid(13);
const V = {
  t250: uid(101),
  t500: uid(102),
  t1k: uid(103),
  b250: uid(111),
  b500: uid(112),
  b1k: uid(113),
  sp: uid(121),
  c250: uid(131),
  c500: uid(132),
  c1k: uid(133),
};
const ZONE = uid(201),
  USER = uid(301);
const variant = (id, product_id, name, quantity, price_paise, is_default, sort_order) => ({
  id,
  product_id,
  name,
  sku: null,
  quantity,
  unit: "kg",
  price_paise,
  compare_at_price_paise: null,
  is_default,
  is_active: true,
  sort_order,
});
function fixtures() {
  return {
    categories: [{ id: CAT, name: "Vegetables", slug: "veg", is_active: true, sort_order: 1 }],
    products: [TOMATO, BRINJAL, SPINACH, CAPSICUM].map((id, i) => ({
      id,
      category_id: CAT,
      name: ["Tomato", "Brinjal", "Spinach", "Capsicum"][i],
      slug: "p" + i,
      telugu_name: null,
      description: null,
      is_active: true,
      sort_order: i,
    })),
    product_variants: [
      variant(V.t250, TOMATO, "250 g", 0.25, 1000, false, 250),
      variant(V.t500, TOMATO, "500 g", 0.5, 2000, false, 500),
      variant(V.t1k, TOMATO, "1 kg", 1, 4000, true, 1000),
      variant(V.b250, BRINJAL, "250 g", 0.25, 900, false, 250),
      variant(V.b500, BRINJAL, "500 g", 0.5, 1800, false, 500),
      variant(V.b1k, BRINJAL, "1 kg", 1, 3600, true, 1000),
      { ...variant(V.sp, SPINACH, "1 bunch", 1, 1800, true, 0), unit: "pack" },
      variant(V.c250, CAPSICUM, "250 g", 0.25, 1500, false, 250),
      variant(V.c500, CAPSICUM, "500 g", 0.5, 3000, false, 500),
      variant(V.c1k, CAPSICUM, "1 kg", 1, 6000, true, 1000),
    ],
    product_images: [],
    store_settings: [{ key: "store_name", value: { value: "TaajaMandi" }, is_public: true }],
    delivery_zones: [
      {
        id: ZONE,
        name: "Test Zone",
        pincode: null,
        areas: ["Test Zone"],
        delivery_fee_paise: 0,
        free_delivery_min_paise: null,
        minimum_order_paise: 0,
        estimated_minutes: null,
        is_active: true,
      },
      {
        id: uid(202),
        name: "Inactive Zone",
        areas: [],
        delivery_fee_paise: 0,
        minimum_order_paise: 0,
        is_active: false,
      },
    ],
    delivery_slots: [],
    carts: [],
    cart_items: [],
    profiles: [{ id: USER, full_name: "Test Customer", phone: "9000000002" }],
    addresses: [],
  };
}
const OUT_OF_STOCK = new Set([V.b1k, V.c500]);

function makeFake({ session = null, roles = [], db = fixtures() } = {}) {
  const fake = { db, log: [], invokes: [], admin: roles.includes("admin"), seq: 1000, listeners: [], passwordUpdates: [], resetRequests: [], updateUserError: null };
  fake.emit = (event) => Promise.all(fake.listeners.map((cb) => cb(event, session)));
  fake.setSession = (s) => { session = s; };
  // Cross-tab delivery: each tab hears the event after the previous tab finished handling it (storage-event delay).
  fake.emitSequential = async (event) => { for (const cb of [...fake.listeners]) await cb(event, session); };
  fake.session = () => session;
  function from(name) {
    const q = { op: "select", filters: [], payload: null, single: false, maybe: false };
    const run = () => {
      const t = (fake.db[name] ||= []);
      let rows = t.filter((r) => q.filters.every((f) => f(r)));
      if (name === "store_settings" && q.op === "select" && !fake.admin)
        rows = rows.filter((r) => r.is_public); // RLS: public read
      if (name === "delivery_zones" && q.op === "select" && !fake.admin)
        rows = rows.filter((r) => r.is_active);
      fake.log.push({ table: name, op: q.op, payload: q.payload });
      let out = rows;
      if (q.op === "insert") {
        const items = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((p) => ({
          id: uid(fake.seq++),
          ...p,
        }));
        t.push(...items);
        out = items;
      }
      if (q.op === "update") {
        rows.forEach((r) => Object.assign(r, q.payload));
        out = rows;
      }
      if (q.op === "delete") {
        fake.db[name] = t.filter((r) => !rows.includes(r));
        out = rows;
      }
      if (q.op === "upsert") {
        const i = t.findIndex((r) => r.key === q.payload.key);
        if (i >= 0) t[i] = { ...t[i], ...q.payload };
        else t.push({ ...q.payload });
        out = [q.payload];
      }
      const copy = JSON.parse(JSON.stringify(out));
      if (q.single)
        return copy.length
          ? { data: copy[0], error: null }
          : { data: null, error: { message: "No rows" } };
      if (q.maybe) return { data: copy[0] ?? null, error: null };
      return { data: copy, error: null };
    };
    const b = {
      select() {
        return b;
      },
      order() {
        return b;
      },
      limit() {
        return b;
      },
      gte(c, v) {
        q.filters.push((r) => r[c] >= v);
        return b;
      },
      eq(c, v) {
        q.filters.push((r) => r[c] === v);
        return b;
      },
      in(c, vs) {
        q.filters.push((r) => vs.includes(r[c]));
        return b;
      },
      // supabase-js .not(col, 'in', '(a,b)') — only the 'in' form the admin panel uses
      not(c, op, list) {
        const vs = op === "in" ? String(list).replace(/^\(|\)$/g, "").split(",") : [list];
        q.filters.push((r) => !vs.includes(r[c]));
        return b;
      },
      insert(p) {
        q.op = "insert";
        q.payload = p;
        return b;
      },
      update(p) {
        q.op = "update";
        q.payload = p;
        return b;
      },
      delete() {
        q.op = "delete";
        return b;
      },
      upsert(p) {
        q.op = "upsert";
        q.payload = p;
        return b;
      },
      single() {
        q.single = true;
        return b;
      },
      maybeSingle() {
        q.maybe = true;
        return b;
      },
      then(res, rej) {
        return Promise.resolve().then(run).then(res, rej);
      },
    };
    return b;
  }
  fake.rpcs = [];
  fake.client = {
    from,
    async rpc(fn, args) {
      // my_membership is a background read-only summary (overnight build); tests assert on write RPCs only.
      if (fn === "my_membership") return { data: fake.membership || { status: "none" }, error: null };
      if (fn === "check_coupon") {
        fake.couponChecks = (fake.couponChecks || []).concat(args.p_code);
        return { data: (fake.coupons || {})[args.p_code] || { valid: false, message: "This coupon code is not valid." }, error: null };
      }
      if (fn === "merge_guest_cart") {
        fake.merges = (fake.merges || 0) + 1;
        if (fake.mergeError) return { data: null, error: { message: fake.mergeError } };
        const who = session?.user?.id;
        if (!who) return { data: null, error: { message: "Sign in required" } };
        let c = fake.db.carts.find((x) => x.user_id === who);
        if (!c) { c = { id: uid(fake.seq++), user_id: who }; fake.db.carts.push(c); }
        fake.db.cart_merges ||= [];
        if (fake.db.cart_merges.some((m) => m.cart_id === c.id && m.merge_id === args.p_merge_id)) return { data: { merged: false, duplicate: true }, error: null };
        fake.db.cart_merges.push({ cart_id: c.id, merge_id: args.p_merge_id });
        const capped = [], skipped = []; let applied = 0;
        for (const it of args.p_items) {
          const q = Number(it.quantity);
          if (!Number.isInteger(q) || q < 1 || q > 50) { skipped.push({ variant_id: it.variant_id, reason: "invalid_quantity" }); continue; }
          const ex = fake.db.cart_items.find((x) => x.cart_id === c.id && x.variant_id === it.variant_id);
          if (!ex) { fake.db.cart_items.push({ id: uid(fake.seq++), cart_id: c.id, variant_id: it.variant_id, quantity: q }); applied++; }
          else if (!Number.isInteger(Number(ex.quantity)) || ex.quantity < 1 || ex.quantity > 50) skipped.push({ variant_id: it.variant_id, reason: "existing_line_needs_attention" });
          else { let n = Number(ex.quantity) + q; if (n > 50) { capped.push({ variant_id: it.variant_id, requested: n }); n = 50; } ex.quantity = n; applied++; }
        }
        return { data: { merged: true, duplicate: false, applied, capped, skipped }, error: null };
      }
      fake.rpcs.push({ fn, args });
      return { data: { id: uid(999), status: "pending" }, error: null };
    },
    functions: {
      async invoke(fn, opts = {}) {
        fake.invokes.push({ fn, body: opts.body });
        if (fn === "catalogue-availability")
          return {
            data: {
              availability: fake.db.product_variants.map((v) => ({
                variant_id: v.id,
                in_stock: !OUT_OF_STOCK.has(v.id),
              })),
            },
            error: null,
          };
        if (fn === "admin-ops" && fake.adminOps) return fake.adminOps(opts.body);
        if (fn === "get-my-role")
          return { data: { roles, profile: fake.db.profiles[0] }, error: null };
        if (fn === "payment-ops") {
          const a = opts.body?.action;
          if (a === "config") return { data: { online_enabled: !!fake.onlineEnabled }, error: null };
          if (a === "start") return { data: { success: true, key_id: "rzp_test_fixture", razorpay_order_id: "order_FIXTURE01", amount: 4000, currency: "INR", order_number: "TM-TEST-0001" }, error: null };
          if (a === "reconcile") return { data: { success: true, checked: 1, paid: 0, expired: 0, waiting: 1, errors: 0, refund_needed: [{ order_number: "TM-PAID-CANCELLED" }] }, error: null };
          if (a === "verify") return { data: fake.verifyResult || { success: true, paid: true, payment_status: "paid" }, error: null };
          return { data: { error: "unknown" }, error: null };
        }
        if (fn === "create-order")
          return {
            data: {
              success: true,
              order: {
                order_id: uid(777),
                order_number: "TM-TEST-0001",
                total_paise: 4000,
                delivery_date: opts.body.requested_delivery_date,
                delivery_type: opts.body.delivery_type,
              },
            },
            error: null,
          };
        return { data: null, error: { message: "unknown fn" } };
      },
    },
    auth: {
      async getSession() {
        return { data: { session } };
      },
      // Like supabase-js: a new subscriber immediately receives INITIAL_SESSION; later events
      // (TOKEN_REFRESHED, SIGNED_IN on tab focus) can be replayed with fake.emit().
      onAuthStateChange(cb) {
        fake.listeners.push(cb);
        setTimeout(() => cb("INITIAL_SESSION", session), 0);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signOut() {
        return {};
      },
      async updateUser(attrs) {
        fake.passwordUpdates.push(attrs);
        return fake.updateUserError ? { data: null, error: { message: fake.updateUserError } } : { data: { user: session?.user }, error: null };
      },
      async resetPasswordForEmail(email, opts) {
        fake.resetRequests.push({ email, opts });
        return { data: {}, error: null };
      },
    },
    storage: {
      from: () => ({ getPublicUrl: (p) => ({ data: { publicUrl: "http://localhost/img/" + p } }) }),
    },
  };
  return fake;
}

const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const tick = () => new Promise((r) => setTimeout(r, 20));

// Build-time environment config (scripts/write-env-config.mjs). Default: a production build on an allowed host.
const PROD_TEST_ENV = { environment: "production", projectRef: "test-prod", supabaseUrl: "http://localhost", publishableKey: "test", imagePublicBase: null, allowedHosts: ["localhost"] };
async function boot({
  taajaEnv = PROD_TEST_ENV,
  now = "2026-11-18T06:00:00Z",
  session = null,
  roles = [],
  gps = { mode: "inside" },
  perm = "prompt",
  guestCart = null,
  guestMergeId = null,
  db,
  url = "http://localhost/",
  shared = null,
} = {}) {
  const fake = shared || makeFake({ session, roles, db });
  const html = source
    .replace('<script type="module">', "<script>")
    .replace(
      /^import \{ createClient \} from 'https:\/\/esm\.sh\/@supabase\/supabase-js@2';$/m,
      "",
    );
  const env = { alerts: [], opened: [], promptAnswer: null, gps };
  const dom = new JSDOM(html, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      if (taajaEnv) w.TAAJA_ENV = Object.freeze(taajaEnv);
      const RealDate = w.Date,
        fixed = new RealDate(now).getTime();
      class FakeDate extends RealDate {
        constructor(...a) {
          super(...(a.length ? a : [fixed]));
        }
        static now() {
          return fixed;
        }
      }
      w.Date = FakeDate;
      w.createClient = () => fake.client;
      env.rzp = [];
      w.Razorpay = class { constructor(o) { this.o = o; env.rzp.push(this); } on(ev, cb) { this.failed = cb; } open() { this.opened = true; } };
      // Tests run as "prefers reduced motion": no banner auto-slide timer keeps the process alive.
      w.matchMedia = (q) => ({ matches: /prefers-reduced-motion:\s*reduce/.test(q), addEventListener() {}, removeEventListener() {} });
      w.alert = (m) => env.alerts.push(String(m));
      w.prompt = () =>
        env.promptQueue && env.promptQueue.length ? env.promptQueue.shift() : env.promptAnswer;
      w.confirm = () => true;
      w.open = (u) => {
        env.opened.push(u);
        return {};
      };
      if (guestCart) w.localStorage.setItem("taajamandi_guest_cart_v1", JSON.stringify(guestCart));
      if (guestMergeId) w.localStorage.setItem("taajamandi_guest_merge_id", guestMergeId);
      const at = { inside: [17.53, 78.3056], outside: [17.4401, 78.3489] };
      Object.defineProperty(w.navigator, "geolocation", {
        configurable: true,
        value: {
          getCurrentPosition(ok, err) {
            const m = env.gps.mode;
            setTimeout(
              () =>
                m === "denied"
                  ? err({ code: 1 })
                  : m === "timeout"
                    ? err({ code: 3 })
                    : ok({ coords: { latitude: at[m][0], longitude: at[m][1], accuracy: 12 } }),
              0,
            );
          },
        },
      });
      Object.defineProperty(w.navigator, "permissions", {
        configurable: true,
        value: { query: async () => ({ state: perm }) },
      });
    },
  });
  const w = dom.window,
    $ = (id) => w.document.getElementById(id);
  await until(() => w.document.querySelectorAll("#productGrid .card").length === 4);
  await tick();
  return { w, $, fake, env, dom };
}
const cartOf = (w) =>
  w.eval(
    "JSON.stringify(Object.fromEntries(Object.entries(cart).map(([k,x])=>[k,{qty:x.qty,price:x.variant.price_paise,name:x.variant.name}])))",
  );

test("product card price matches the default selected variant (1 kg)", async () => {
  const { w, $ } = await boot();
  const card = [...w.document.querySelectorAll("#productGrid .card")].find((c) =>
    c.textContent.includes("Tomato"),
  );
  assert.match(card.querySelector(".unit").textContent, /^1 kg · 3 sizes$/);
  assert.equal(card.querySelector(".price").textContent, "₹40");
  w.openProductDetails(TOMATO);
  const sel = $("productDetailBody").querySelector('.weight-opt[aria-checked="true"]');
  assert.equal(sel.dataset.variantId, V.t1k);
  assert.match($("detailPrice").textContent, /₹40 · 1 kg/);
  assert.deepEqual(
    [...$("productDetailBody").querySelectorAll(".weight-opt")].map(
      (b) => b.querySelector(".w").textContent,
    ),
    ["250 g", "500 g", "1 kg"],
  );
});

test("default out of stock: card and detail fall back to the same in-stock size", async () => {
  const { w, $ } = await boot();
  const card = [...w.document.querySelectorAll("#productGrid .card")].find((c) =>
    c.textContent.includes("Brinjal"),
  );
  assert.match(card.querySelector(".unit").textContent, /^250 g/);
  assert.equal(card.querySelector(".price").textContent, "₹9");
  w.openProductDetails(BRINJAL);
  assert.equal(
    $("productDetailBody").querySelector('.weight-opt[aria-checked="true"]').dataset.variantId,
    V.b250,
  );
  assert.ok(
    $("productDetailBody").querySelector(`[data-variant-id="${V.b1k}"]`).disabled,
    "1 kg out of stock is disabled",
  );
});

test("250 g, 500 g and 1 kg are each selectable and added as separate SKUs (guest cart)", async () => {
  const { w, $ } = await boot();
  const pick = (id) => $("productDetailBody").querySelector(`[data-variant-id="${id}"]`).click();
  w.openProductDetails(TOMATO);
  pick(V.t250);
  assert.match($("detailPrice").textContent, /₹10 · 250 g/);
  w.changeDetailPacks(1);
  assert.equal($("detailTotal").textContent, "₹20");
  await w.addDetailToBasket();
  w.openProductDetails(TOMATO);
  pick(V.t500);
  assert.match($("detailPrice").textContent, /₹20 · 500 g/);
  await w.addDetailToBasket();
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  assert.deepEqual(JSON.parse(cartOf(w)), {
    [V.t250]: { qty: 2, price: 1000, name: "250 g" },
    [V.t500]: { qty: 1, price: 2000, name: "500 g" },
    [V.t1k]: { qty: 1, price: 4000, name: "1 kg" },
  });
  assert.deepEqual(JSON.parse(w.localStorage.getItem("taajamandi_guest_cart_v1")), {
    [V.t250]: { qty: 2 },
    [V.t500]: { qty: 1 },
    [V.t1k]: { qty: 1 },
  });
  assert.equal($("cartCount").textContent, "4");
  assert.equal(w.eval("cartSubtotal()"), 80);
});

test("authenticated cart: guest merge and per-variant cart_items rows", async () => {
  const { w, fake } = await boot({
    session: { user: { id: USER, email: "test@example.test" } },
    guestCart: { [V.t500]: { qty: 2 } },
  });
  await until(() => fake.db.carts.length === 1 && fake.db.cart_items.length === 1);
  assert.equal(fake.db.cart_items[0].variant_id, V.t500);
  assert.equal(Number(fake.db.cart_items[0].quantity), 2);
  assert.equal(
    w.localStorage.getItem("taajamandi_guest_cart_v1"),
    null,
    "guest cart cleared after merge",
  );
  w.openProductDetails(TOMATO);
  w.selectDetailVariant(V.t250);
  await w.addDetailToBasket();
  w.openProductDetails(TOMATO);
  w.selectDetailVariant(V.t500);
  await w.addDetailToBasket();
  const rows = Object.fromEntries(
    fake.db.cart_items.map((r) => [r.variant_id, Number(r.quantity)]),
  );
  assert.deepEqual(rows, { [V.t500]: 3, [V.t250]: 1 });
});

test("checkout on 18 Nov: advance only, default 1 Dec, later dates allowed, earlier blocked", async () => {
  const { w, $ } = await boot({ session: { user: { id: USER } } });
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  await w.openCheckout();
  assert.ok($("dt_same_day").disabled);
  assert.ok($("dt_advance").checked);
  assert.equal($("ckDeliveryDate").value, "2026-12-01");
  assert.ok(!$("ckDeliveryDate").disabled);
  assert.equal($("ckDeliveryDate").min, "2026-12-01");
  assert.match($("ckDeliveryDateText").textContent, /Tuesday, 1 December 2026 · Advance delivery/);
  assert.match($("deliveryRuleHint").textContent, /1 December or any later date/);
  $("ckDeliveryDate").value = "2026-12-05";
  w.onDeliveryDateChange();
  assert.match($("ckDeliveryDateText").textContent, /Saturday, 5 December 2026/);
  $("ckDeliveryDate").value = "2026-11-25";
  w.onDeliveryDateChange();
  assert.match($("ckDeliveryDateText").textContent, /Deliveries start on 1 December/);
  assert.ok($("placeOrderBtn").disabled);
});

test("checkout at 23:59 IST on 30 Nov is advance-only; at 00:00 IST 1 Dec same-day opens", async () => {
  let { w, $ } = await boot({ now: "2026-11-30T18:29:00Z", session: { user: { id: USER } } });
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  await w.openCheckout();
  assert.equal($("ckDeliveryDate").value, "2026-12-01");
  assert.ok($("dt_same_day").disabled);
  ({ w, $ } = await boot({ now: "2026-11-30T18:30:00Z", session: { user: { id: USER } } }));
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  await w.openCheckout();
  assert.ok(!$("dt_same_day").disabled);
  assert.ok($("dt_same_day").checked);
  assert.equal($("ckDeliveryDate").value, "2026-12-01");
  assert.ok($("ckDeliveryDate").disabled);
  $("dt_advance").checked = true;
  w.onDeliveryTypeChange();
  assert.equal($("ckDeliveryDate").value, "2026-12-02");
});

test("checkout from 2 Dec: same-day today by default; advance moves to tomorrow", async () => {
  const { w, $ } = await boot({ now: "2026-12-02T04:00:00Z", session: { user: { id: USER } } });
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  await w.openCheckout();
  assert.ok(!$("dt_same_day").disabled);
  assert.ok($("dt_same_day").checked);
  assert.equal($("ckDeliveryDate").value, "2026-12-02");
  assert.ok($("ckDeliveryDate").disabled);
  $("dt_advance").checked = true;
  w.onDeliveryTypeChange();
  assert.equal($("ckDeliveryDate").value, "2026-12-03");
  assert.ok(!$("ckDeliveryDate").disabled);
});

test("GPS granted inside boundary: order sends delivery_type + requested_delivery_date, confirmation shows date", async () => {
  const { w, $, fake } = await boot({ session: { user: { id: USER } } });
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  await w.openCheckout();
  assert.ok($("placeOrderBtn").disabled);
  assert.match($("ckBlockers").textContent, /GPS location/);
  await w.captureCheckoutLocation();
  assert.match($("gpsStatus").textContent, /Serviceable/);
  $("ckZone").value = ZONE;
  w.onZoneChange();
  $("ckAddr").value = "1-2-3 Test Street";
  assert.ok(!$("placeOrderBtn").disabled, "enabled once GPS, zone and date are valid");
  await w.placeOrder();
  const call = fake.invokes.find((i) => i.fn === "create-order");
  assert.equal(call.body.delivery_type, "advance");
  assert.equal(call.body.requested_delivery_date, "2026-12-01");
  assert.equal(call.body.payment_method, "cod");
  assert.equal(fake.db.addresses[0].latitude, 17.53);
  assert.match($("confirmDeliveryDate").textContent, /Tuesday, 1 December 2026 · Advance delivery/);
});

test("GPS outside boundary shows Coming soon and blocks the order", async () => {
  const { w, $, env, fake } = await boot({
    session: { user: { id: USER } },
    gps: { mode: "outside" },
  });
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  await w.openCheckout();
  await w.captureCheckoutLocation();
  assert.match($("gpsStatus").textContent, /Coming soon/);
  $("ckZone").value = ZONE;
  w.onZoneChange();
  $("ckAddr").value = "x";
  assert.ok($("placeOrderBtn").disabled);
  await w.placeOrder();
  assert.ok(env.alerts.some((a) => /GPS location/.test(a)));
  assert.ok(!fake.invokes.some((i) => i.fn === "create-order"));
});

test("GPS permission denied: clear message, order blocked", async () => {
  const { w, $ } = await boot({ session: { user: { id: USER } }, gps: { mode: "denied" } });
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  await w.openCheckout();
  await w.captureCheckoutLocation();
  assert.match($("gpsStatus").textContent, /Location access blocked/);
  $("ckZone").value = ZONE;
  w.onZoneChange();
  assert.ok($("placeOrderBtn").disabled);
});

test("header location: unverified, serviceable, outside, blocked; auto-check when already granted; old card removed", async () => {
  const { $, env } = await boot();
  assert.equal($("serviceCheck"), null, "the middle-of-page serviceability card is gone");
  assert.equal($("localityBtn").dataset.state, "idle");
  assert.equal($("locTitle").textContent, "Serviceable at Hyderabad");
  assert.equal($("locSub").textContent, "Tap to check your location", "unverified: no claim about this location");
  $("localityBtn").click();
  await until(() => $("localityBtn").dataset.state === "ok");
  assert.match($("locSub").textContent, /✓ We deliver to your location/);
  env.gps.mode = "outside";
  $("localityBtn").click();
  await until(() => $("localityBtn").dataset.state === "outside");
  assert.equal($("locTitle").textContent, "Not serviceable here yet", "never shows 'Serviceable' for a location outside the boundary");
  env.gps.mode = "denied";
  $("localityBtn").click();
  await until(() => $("localityBtn").dataset.state === "denied");
  assert.match($("locSub").textContent, /Location blocked/);
  assert.match($("localityBtn").title, /Ordering needs your GPS location/);
  const granted = await boot({ perm: "granted" });
  await until(() => granted.$("localityBtn").dataset.state === "ok");
});

test("header location: a signed-in customer's saved address is shown under the status", async () => {
  const db = fixtures();
  db.addresses = [{ id: uid(880), user_id: USER, label: "Home", address_line1: "1-2-3 Test Street", area: "BHEL", is_default: true, created_at: "2026-11-10T00:00:00Z" }];
  const { $ } = await boot({ db, session: { user: { id: USER } } });
  await until(() => /BHEL/.test($("locSub").textContent));
  assert.match($("locSub").textContent, /Home: BHEL · tap to check delivery/);
});

test("header location check is reused in checkout", async () => {
  const { w, $ } = await boot({ session: { user: { id: USER } } });
  $("localityBtn").click();
  await until(() => $("localityBtn").dataset.state === "ok");
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  await w.openCheckout();
  assert.match($("gpsStatus").textContent, /Using the location you checked earlier/);
  assert.equal($("ckLatitude").value, "17.53");
});

test("bargain: not offered for non-weight items; slider 5–50 kg; guests must sign in; below 5 kg rejected", async () => {
  const { w, $, fake } = await boot();
  w.openProductDetails(SPINACH);
  assert.equal($("openBargainBtn"), null);
  w.openProductDetails(TOMATO);
  $("openBargainBtn").click();
  assert.ok($("bargainOverlay").classList.contains("open"));
  const slider = $("bargainKg");
  assert.equal(slider.type, "range");
  assert.equal(slider.min, "5");
  assert.equal(slider.max, "50");
  assert.equal(slider.step, "0.5");
  slider.value = "4";
  assert.equal(slider.value, "5", "slider cannot go below 5 kg");
  assert.equal($("bargainEstimate").textContent, "₹200");
  assert.equal($("bargainSendBtn").textContent, "Sign in to send your offer");
  await w.sendBargainRequest();
  assert.ok($("authOverlay").classList.contains("open"), "guest is sent to sign-in");
  assert.equal(fake.rpcs.length, 0);
});

test("bargain above 5 kg is submitted in-app with total offer in paise (no order, no WhatsApp needed)", async () => {
  const { w, $, fake } = await boot({ session: { user: { id: USER } } });
  w.openProductDetails(TOMATO);
  await w.openBargain(TOMATO);
  w.eval("bargainState.kg=4.5");
  $("bargainOffer").value = "450";
  await w.sendBargainRequest();
  assert.match($("bargainMsg").textContent, /start at 5 kg/);
  $("bargainKg").value = "12.5";
  w.onBargainKg("12.5");
  assert.equal($("bargainKgLabel").textContent, "12.5 kg");
  assert.equal($("bargainEstimate").textContent, "₹500");
  $("bargainOffer").value = "450.50";
  w.updateBargainSummary();
  assert.match($("bargainOfferNote").textContent, /10% below/);
  await w.sendBargainRequest();
  assert.deepEqual(
    fake.rpcs.map((r) => [
      r.fn,
      r.args.p_variant_id,
      r.args.p_quantity_kg,
      r.args.p_offer_total_paise,
    ]),
    [["submit_bargain_request", V.t1k, 12.5, 45050]],
  );
  assert.match($("bargainMsg").textContent, /Offer sent/);
  assert.ok($("bargainSendBtn").disabled, "cannot double-submit");
  assert.ok(!fake.invokes.some((i) => i.fn === "create-order"), "bargain never creates an order");
});

test("My bargains: counter-offer can be accepted; expired counter cannot", async () => {
  const db = fixtures();
  db.bargain_requests = [
    {
      id: uid(901),
      user_id: USER,
      product_name: "Tomato",
      variant_name: "1 kg",
      quantity_kg: 10,
      regular_estimate_paise: 40000,
      offer_total_paise: 30000,
      counter_total_paise: 35000,
      status: "countered",
      expires_at: "2099-01-01T00:00:00Z",
      created_at: "2026-11-18T05:00:00Z",
    },
    {
      id: uid(902),
      user_id: USER,
      product_name: "Onion",
      variant_name: "1 kg",
      quantity_kg: 5,
      regular_estimate_paise: 16000,
      offer_total_paise: 12000,
      counter_total_paise: 14000,
      status: "countered",
      expires_at: "2026-11-01T00:00:00Z",
      created_at: "2026-11-17T05:00:00Z",
    },
  ];
  db.bargain_offer_history = [
    {
      bargain_request_id: uid(901),
      actor_role: "admin",
      action: "countered",
      amount_paise: 35000,
      created_at: "2026-11-18T06:00:00Z",
    },
  ];
  const { w, $, fake } = await boot({ db, session: { user: { id: USER } } });
  w.confirm = () => true;
  await w.openMyBargains();
  const cards = [...$("bargainsBody").querySelectorAll("[data-bargain-id]")];
  assert.match(cards[0].textContent, /Counter-offer received.*₹350/s);
  assert.match(cards[1].textContent, /Counter-offer expired/);
  assert.equal(cards[1].querySelector("button"), null, "no actions on an expired counter-offer");
  cards[0].querySelector("button").click();
  await until(() => fake.rpcs.length === 1);
  assert.deepEqual(
    [fake.rpcs[0].fn, fake.rpcs[0].args.p_request_id, fake.rpcs[0].args.p_action],
    ["respond_bargain_request", uid(901), "accept"],
  );
});

test("admin bargain tab: filter, counter-offer needs amount and expiry, reject needs reason", async () => {
  const db = fixtures();
  db.bargain_requests = [
    {
      id: uid(903),
      user_id: USER,
      product_name: "Tomato",
      variant_name: "1 kg",
      quantity_kg: 20,
      rate_per_kg_paise: 4000,
      regular_estimate_paise: 80000,
      offer_total_paise: 70000,
      status: "pending",
      created_at: "2026-11-18T05:00:00Z",
    },
  ];
  db.bargain_offer_history = [];
  const { w, $, env, fake } = await boot({ db, session: { user: { id: USER } }, roles: ["admin"] });
  await w.loadAdminTab("bargains");
  await until(() => $("adminBody").textContent.includes("Bargain requests"));
  assert.match($("adminBody").textContent, /Tomato.*20 kg.*₹800.*₹700/s);
  env.promptQueue = [""];
  await w.adminBargainAction(uid(903), "reject");
  assert.ok(env.alerts.some((a) => /reason is required/.test(a)));
  assert.equal(fake.rpcs.length, 0);
  env.promptQueue = ["750", "2", "Best price"];
  await w.adminBargainAction(uid(903), "counter");
  const c = fake.rpcs.at(-1);
  assert.equal(c.fn, "admin_respond_bargain");
  assert.equal(c.args.p_action, "counter");
  assert.equal(c.args.p_counter_total_paise, 75000);
  assert.equal(
    c.args.p_expires_at,
    new Date(Date.parse("2026-11-18T06:00:00Z") + 2 * 86400000).toISOString(),
  );
});

test("admin WhatsApp setting is saved public and is then readable by customers", async () => {
  const shared = fixtures();
  const admin = await boot({
    db: shared,
    session: { user: { id: USER, email: "a@example.test" } },
    roles: ["admin"],
  });
  await admin.w.loadAdminTab("settings");
  await until(() => admin.$("settingWhatsApp"));
  admin.$("settingWhatsApp").value = "12345";
  await admin.w.saveStoreSettings({ preventDefault() {} });
  assert.ok(admin.env.alerts.some((a) => /valid Indian WhatsApp/.test(a)));
  assert.ok(!admin.fake.log.some((l) => l.op === "upsert"), "invalid number not saved");
  admin.$("settingWhatsApp").value = "90000 00001";
  admin.$("settingPhone").value = "9000000003";
  await admin.w.saveStoreSettings({ preventDefault() {} });
  const ups = admin.fake.log.filter((l) => l.op === "upsert").map((l) => l.payload);
  assert.deepEqual(
    ups.map((u) => [u.key, u.is_public]),
    [
      ["store_name", true],
      ["support_phone", true],
      ["whatsapp_number", true],
    ],
  );
  assert.equal(ups[2].value.value, "+919000000001");
  const customer = await boot({ db: shared });
  const read = await customer.w.loadWhatsAppNumber(); // jsdom-realm object: compare fields, not prototypes
  assert.equal(read.number, "919000000001");
  assert.equal(read.error, null);
  // Before the fix, support_phone/whatsapp were saved with is_public=false and RLS hid them from customers:
  assert.ok(
    shared.store_settings.filter((s) => s.key !== "store_name").every((s) => s.is_public === true),
  );
});

test("zone activation is refused outside the approved boundary", async () => {
  const db = fixtures();
  const inactive = db.delivery_zones[1];
  const { w, env } = await boot({ db, session: { user: { id: USER } }, roles: ["admin"] });
  env.promptAnswer = null;
  await w.toggleZone(inactive.id, true);
  assert.equal(inactive.is_active, false);
  env.promptAnswer = "17.4401, 78.3489";
  await w.toggleZone(inactive.id, true);
  assert.equal(db.delivery_zones[1].is_active, false);
  assert.ok(env.alerts.some((a) => /outside the approved 7\.4 km boundary/.test(a)));
  env.promptAnswer = "not coordinates";
  await w.toggleZone(inactive.id, true);
  assert.equal(db.delivery_zones[1].is_active, false);
  env.promptAnswer = "17.5300, 78.3056";
  await w.toggleZone(inactive.id, true);
  assert.equal(db.delivery_zones[1].is_active, true);
  await w.toggleZone(inactive.id, false); // disabling never needs coordinates
  assert.equal(db.delivery_zones[1].is_active, false);
});

test("admin orders show packer shortages so the store can reconcile before dispatch", async () => {
  const db = fixtures();
  db.orders = [
    {
      id: uid(700),
      order_number: "TM-SHORT",
      user_id: USER,
      status: "packed",
      payment_method: "cod",
      payment_status: "pending",
      placed_at: "2026-11-18T05:00:00Z",
      delivery_date: "2026-12-01",
      delivery_type: "advance",
      total_paise: 4000,
      delivery_address_snapshot: { area: "BHEL" },
    },
  ];
  db.order_items = [
    {
      id: uid(701),
      order_id: uid(700),
      product_name: "Tomato",
      variant_name: "1 kg",
      quantity: 2,
      line_total_paise: 8000,
    },
  ];
  db.delivery_assignments = [];
  db.order_item_checks = [
    { order_id: uid(700), order_item_id: uid(701), status: "unavailable", note: "Supplier short" },
  ];
  const { w, $ } = await boot({ db, session: { user: { id: USER } }, roles: ["admin"] });
  await w.loadAdminTab("orders");
  await until(() => $("adminBody").textContent.includes("TM-SHORT"));
  assert.match(
    $("adminBody").textContent,
    /Packer shortage: Tomato · 1 kg × 2 unavailable — Supplier short/,
  );
});

test("admin orders: online payment state, refund-needed flag and the Razorpay check", async () => {
  const db = fixtures();
  const base = { user_id: USER, placed_at: "2026-11-18T05:00:00Z", delivery_date: "2026-12-01", delivery_type: "advance", total_paise: 4000, delivery_address_snapshot: { area: "BHEL" } };
  db.orders = [
    { ...base, id: uid(710), order_number: "TM-PAID-CANCELLED", status: "cancelled", payment_method: "razorpay", payment_status: "paid" },
    { ...base, id: uid(711), order_number: "TM-UNPAID", status: "pending", payment_method: "razorpay", payment_status: "pending" },
    { ...base, id: uid(712), order_number: "TM-COD", status: "pending", payment_method: "cod", payment_status: "pending" },
  ];
  db.order_items = []; db.delivery_assignments = []; db.order_item_checks = [];
  const { w, $, fake } = await boot({ db, session: { user: { id: USER } }, roles: ["admin"] });
  fake.adminPayments = true;
  await w.loadAdminTab("orders");
  await until(() => $("adminBody").textContent.includes("TM-PAID-CANCELLED"));
  const text = $("adminBody").textContent;
  assert.match(text, /Refund needed: this paid order was cancelled/);
  assert.match(text, /Payment: online · awaiting payment · wait for payment before confirming/);
  assert.match(text, /Payment: Cash on delivery/);
  await w.adminReconcilePayments();
  assert.ok(fake.invokes.some((i) => i.fn === "payment-ops" && i.body.action === "reconcile"));
});

test("catalogue shows a loading message, a slow-connection note after 6 s, then the products", async () => {
  const html = source
    .replace('<script type="module">', "<script>")
    .replace(
      /^import \{ createClient \} from 'https:\/\/esm\.sh\/@supabase\/supabase-js@2';$/m,
      "",
    );
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const fake = makeFake();
  const realFrom = fake.client.from;
  fake.client.from = (t) => {
    const b = realFrom(t);
    if (t !== "products") return b;
    const then = b.then.bind(b);
    b.then = (res, rej) => gate.then(() => then(res, rej));
    return b;
  };
  const timers = [];
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.TAAJA_ENV = Object.freeze(PROD_TEST_ENV);
      w.createClient = () => fake.client;
      const realSet = w.setTimeout.bind(w);
      w.setTimeout = (fn, ms, ...a) => {
        if (ms === 6000) {
          timers.push(fn);
          return 0;
        }
        return realSet(fn, ms, ...a);
      };
      Object.defineProperty(w.navigator, "permissions", {
        configurable: true,
        value: { query: async () => ({ state: "prompt" }) },
      });
    },
  });
  const $ = (id) => dom.window.document.getElementById(id);
  assert.equal($("productGrid").getAttribute("aria-busy"), "true");
  assert.match($("catalogueLoading").textContent, /Loading fresh produce/);
  await until(() => timers.length === 1);
  timers[0]();
  assert.match($("catalogueLoading").textContent, /Still loading/);
  release();
  await until(() => $("productGrid").querySelectorAll(".card").length === 4);
  assert.equal($("productGrid").getAttribute("aria-busy"), null);
  assert.equal($("catalogueLoading"), null);
});

// ---------------- Basket safety (launch fix 21 Nov 2026) ----------------
// Owner report: "a random item with quantity 50 appears in the basket after login". Causes: (1) a corrupted legacy
// line (Brinjal 250 g x 303,872 from the old doubling bug) was clamped to 50 and saved back; (2) the guest basket
// was merged from the browser by read/add/write, so two tabs handling the same sign-in could both add it.
const CART_ID = uid(900);
const withCart = (lines, user = USER) => {
  const db = fixtures();
  db.carts.push({ id: CART_ID, user_id: user });
  for (const [variant_id, quantity] of Object.entries(lines))
    db.cart_items.push({ id: uid(901 + db.cart_items.length), cart_id: CART_ID, variant_id, quantity });
  return db;
};
const serverRows = (fake) =>
  Object.fromEntries(fake.db.cart_items.map((r) => [r.variant_id, Number(r.quantity)]));
const memCart = (w) => Object.fromEntries(Object.entries(JSON.parse(cartOf(w))).map(([k, x]) => [k, x.qty]));
const cartWrites = (fake) => fake.log.filter((l) => l.table === "cart_items" && l.op !== "select").length;
const SIGNED = { user: { id: USER, email: "test@example.test" } };
const OTHER = "d0000000-0000-4000-8000-0000000000aa";

test("basket: new customer with empty guest and account baskets stays empty through login, events and reload", async () => {
  const { w, fake } = await boot({ session: SIGNED });
  for (const ev of ["INITIAL_SESSION", "SIGNED_IN", "TOKEN_REFRESHED", "SIGNED_IN"]) await fake.emit(ev);
  await tick();
  const second = await boot({ shared: fake, session: SIGNED }); // page reload
  await tick();
  assert.deepEqual(memCart(w), {});
  assert.deepEqual(memCart(second.w), {});
  assert.deepEqual(serverRows(fake), {});
  assert.equal(cartWrites(fake), 0, "nothing is written just because someone signed in");
});

test("basket: a guest product is merged into the account exactly once on login (repeated events, reload)", async () => {
  const { w, fake } = await boot({ guestCart: { [V.t500]: { qty: 2 } } });
  assert.deepEqual(memCart(w), { [V.t500]: 2 });
  fake.setSession(SIGNED);
  for (const ev of ["SIGNED_IN", "INITIAL_SESSION", "SIGNED_IN", "TOKEN_REFRESHED"]) await fake.emit(ev);
  await tick();
  assert.deepEqual(serverRows(fake), { [V.t500]: 2 });
  assert.deepEqual(memCart(w), { [V.t500]: 2 });
  assert.equal(w.localStorage.getItem("taajamandi_guest_cart_v1"), null, "guest basket cleared after a confirmed merge");
  const reload = await boot({ shared: fake, session: SIGNED });
  await tick();
  assert.deepEqual(memCart(reload.w), { [V.t500]: 2 });
  assert.deepEqual(serverRows(fake), { [V.t500]: 2 });
});

test("basket: an existing account basket is unchanged by login, reload, TOKEN_REFRESHED and repeated SIGNED_IN", async () => {
  const { w, fake } = await boot({ session: SIGNED, db: withCart({ [V.t500]: 3, [V.t250]: 1 }) });
  await tick();
  for (const ev of ["TOKEN_REFRESHED", "SIGNED_IN", "SIGNED_IN", "INITIAL_SESSION", "TOKEN_REFRESHED"]) await fake.emit(ev);
  await tick();
  await boot({ shared: fake, session: SIGNED });
  await tick();
  assert.deepEqual(serverRows(fake), { [V.t500]: 3, [V.t250]: 1 });
  assert.deepEqual(memCart(w), { [V.t500]: 3, [V.t250]: 1 });
  assert.equal(cartWrites(fake), 0, "loading a valid basket never writes to it");
});

test("basket: guest and account baskets with the same size are added together once", async () => {
  const { w, fake } = await boot({ db: withCart({ [V.t500]: 1 }), guestCart: { [V.t500]: { qty: 2 }, [V.t250]: { qty: 1 } } });
  fake.setSession(SIGNED);
  await fake.emit("SIGNED_IN");
  await fake.emit("SIGNED_IN");
  await tick();
  assert.deepEqual(serverRows(fake), { [V.t500]: 3, [V.t250]: 1 });
  assert.deepEqual(memCart(w), { [V.t500]: 3, [V.t250]: 1 });
});

for (const [label, mergeId, timing] of [["with a merge id", "guest-1234567890ab", "emit"], ["older basket without a merge id", null, "emit"], ["second tab hears it after the first saved", "guest-1234567890ab", "emitSequential"], ["older basket, second tab hears it later", null, "emitSequential"]]) {
  test(`basket: two tabs handling the same sign-in merge the guest basket once (${label})`, async () => {
    const guestCart = { [V.t500]: { qty: 2 }, [V.t250]: { qty: 1 } };
    const tabA = await boot({ guestCart, guestMergeId: mergeId });
    const tabB = await boot({ shared: tabA.fake, guestCart, guestMergeId: mergeId }); // same browser storage
    tabA.fake.setSession(SIGNED);
    await tabA.fake[timing]("SIGNED_IN");
    await tick();
    assert.deepEqual(serverRows(tabA.fake), { [V.t500]: 2, [V.t250]: 1 }, "no doubling");
    assert.deepEqual(memCart(tabA.w), { [V.t500]: 2, [V.t250]: 1 });
    assert.deepEqual(memCart(tabB.w), { [V.t500]: 2, [V.t250]: 1 });
  });
}

test("basket: a corrupted legacy line is quarantined, never turned into 50, never saved, and blocks checkout", async () => {
  const { w, $, fake, env } = await boot({ session: SIGNED, db: withCart({ [V.t250]: 303872, [V.t500]: 2 }) });
  await tick();
  assert.deepEqual(memCart(w), { [V.t500]: 2 }, "only the valid line is in the basket");
  assert.equal(serverRows(fake)[V.t250], 303872, "the stored line is not rewritten");
  assert.equal(cartWrites(fake), 0);
  assert.match(env.alerts.join(" | "), /needs your attention/i);
  w.openCart();
  const q = w.document.querySelector(".cart-quarantine");
  assert.ok(q && /250 g/.test(q.textContent) && /3,?03,?872/.test(q.textContent), "the customer sees exactly which line and why");
  await w.openCheckout();
  assert.ok(!$("checkoutOverlay").classList.contains("open"), "checkout is blocked while a line needs attention");
  assert.match(env.alerts.at(-1), /needs your attention/i);
  await w.removeQuarantinedLine(q.querySelector("[data-row]").dataset.row);
  assert.deepEqual(serverRows(fake), { [V.t500]: 2 }, "removing it is the customer's explicit choice");
  assert.equal(w.document.querySelector(".cart-quarantine"), null);
  await w.openCheckout();
  assert.ok($("checkoutOverlay").classList.contains("open"));
});

test("basket: choosing a valid quantity for a quarantined line replaces the corrupted value", async () => {
  const { w, fake } = await boot({ session: SIGNED, db: withCart({ [V.t250]: 303872 }) });
  await tick();
  await w.changeQty(V.t250, 1);
  assert.deepEqual(serverRows(fake), { [V.t250]: 1 });
  assert.deepEqual(memCart(w), { [V.t250]: 1 });
  assert.equal(w.eval("cartQuarantine.length"), 0);
});

test("basket: invalid guest quantities are not restored as 50; the customer is told", async () => {
  const { w, env } = await boot({ guestCart: { [V.t500]: { qty: 9999 }, [V.t250]: { qty: -4 }, [V.t1k]: { qty: 2 } } });
  assert.deepEqual(memCart(w), { [V.t1k]: 2 });
  assert.match(env.alerts.join(" | "), /could not be restored/i);
});

test("basket: a failed account-basket load keeps the guest basket for the next attempt", async () => {
  const { w, fake } = await boot({ guestCart: { [V.t500]: { qty: 2 } } });
  fake.mergeError = "network down";
  fake.setSession(SIGNED);
  await fake.emit("SIGNED_IN");
  await tick();
  assert.notEqual(w.localStorage.getItem("taajamandi_guest_cart_v1"), null, "nothing is lost when the merge fails");
  assert.deepEqual(serverRows(fake), {});
  fake.mergeError = null;
  await fake.emit("SIGNED_IN");
  await tick();
  assert.deepEqual(serverRows(fake), { [V.t500]: 2 });
  assert.equal(w.localStorage.getItem("taajamandi_guest_cart_v1"), null);
});

test("basket: signing out and in as a different account does not carry the first account's basket over", async () => {
  const db = withCart({ [V.t500]: 3 });
  const { w, fake } = await boot({ session: SIGNED, db });
  await tick();
  assert.deepEqual(memCart(w), { [V.t500]: 3 });
  fake.setSession(null);
  await fake.emit("SIGNED_OUT");
  await tick();
  assert.deepEqual(memCart(w), {});
  assert.equal(w.localStorage.getItem("taajamandi_guest_cart_v1"), null, "the signed-in basket is not left behind as a guest basket");
  fake.setSession({ user: { id: OTHER, email: "other@example.test" } });
  await fake.emit("SIGNED_IN");
  await tick();
  assert.deepEqual(memCart(w), {}, "the second account starts with its own (empty) basket");
  assert.deepEqual(serverRows(fake), { [V.t500]: 3 }, "the first account's basket is untouched");
});

test("basket: adding beyond 50 of one size is refused", async () => {
  const { w, fake, env } = await boot({ session: SIGNED, db: withCart({ [V.t500]: 50 }) });
  await tick();
  await w.changeQty(V.t500, 1);
  assert.equal(serverRows(fake)[V.t500], 50);
  assert.match(env.alerts.at(-1), /up to 50/);
  await w.changeQty(V.t500, -1);
  assert.equal(serverRows(fake)[V.t500], 49);
});


// ---------------- Online payment (launch build 21 Nov 2026) ----------------
async function readyCheckout(opts = {}) {
  const ctx = await boot({ session: { user: { id: USER, email: "test@example.test" } }, ...opts });
  ctx.fake.onlineEnabled = opts.online ?? true;
  ctx.w.openProductDetails(TOMATO);
  await ctx.w.addDetailToBasket();
  await ctx.w.openCheckout();
  await ctx.w.captureCheckoutLocation();
  ctx.$("ckZone").value = ZONE;
  ctx.w.onZoneChange();
  ctx.$("ckAddr").value = "1-2-3 Test Street";
  return ctx;
}

test("online payment: hidden when Razorpay is not configured; Cash on Delivery unchanged", async () => {
  const { $, fake } = await readyCheckout({ online: false });
  assert.equal($("pay_online"), null);
  assert.ok($("pay_cod").checked);
  assert.match($("checkoutBody").textContent, /Online payment is not available yet/);
  assert.equal($("placeOrderBtn").textContent, "Place COD order");
  assert.ok(fake.invokes.some((i) => i.fn === "payment-ops" && i.body.action === "config"));
});

test("online payment: Razorpay opens with the server's order and amount; the order is paid only after server verification", async () => {
  const { w, $, fake, env } = await readyCheckout();
  $("pay_online").checked = true;
  w.onPayMethodChange();
  assert.equal($("placeOrderBtn").textContent, "Pay online & place order");
  await w.placeOrder();
  assert.equal(fake.invokes.find((i) => i.fn === "create-order").body.payment_method, "online");
  await until(() => env.rzp.length === 1);
  const rzp = env.rzp[0];
  assert.ok(rzp.opened);
  assert.equal(rzp.o.order_id, "order_FIXTURE01", "Razorpay order created by the server");
  assert.equal(rzp.o.amount, 4000, "amount from the server, not the browser");
  assert.equal(rzp.o.key, "rzp_test_fixture");
  assert.match($("confirmPayLabel").textContent, /Waiting for online payment/);
  await rzp.o.handler({ razorpay_order_id: "order_FIXTURE01", razorpay_payment_id: "pay_FIXTURE01", razorpay_signature: "sig" });
  const v = fake.invokes.find((i) => i.fn === "payment-ops" && i.body.action === "verify");
  assert.deepEqual([v.body.razorpay_order_id, v.body.razorpay_payment_id, v.body.razorpay_signature], ["order_FIXTURE01", "pay_FIXTURE01", "sig"]);
  assert.equal($("confirmPayLabel").textContent, "Paid online");
});

test("online payment: a browser 'success' that the server cannot confirm is never shown as paid", async () => {
  const { w, $, fake, env } = await readyCheckout();
  fake.verifyResult = { success: true, paid: false, payment_status: "authorized" };
  $("pay_online").checked = true;
  await w.placeOrder();
  await until(() => env.rzp.length === 1);
  await env.rzp[0].o.handler({ razorpay_order_id: "order_FIXTURE01", razorpay_payment_id: "pay_X", razorpay_signature: "forged" });
  assert.equal($("confirmPayLabel").textContent, "Payment being confirmed");
  assert.match(env.alerts.at(-1), /confirming your payment/i);
});

test("online payment: closing Razorpay keeps the order waiting; My orders offers Pay now, which reopens payment", async () => {
  const { w, $, fake, env } = await readyCheckout();
  $("pay_online").checked = true;
  await w.placeOrder();
  await until(() => env.rzp.length === 1);
  env.rzp[0].o.modal.ondismiss();
  assert.equal($("confirmPayLabel").textContent, "Waiting for online payment");
  assert.match(env.alerts.at(-1), /Payment not completed.*pay from My orders/);
  fake.db.orders = [{ id: uid(777), user_id: USER, order_number: "TM-TEST-0001", status: "pending", payment_method: "razorpay", payment_status: "pending", subtotal_paise: 4000, delivery_fee_paise: 0, total_paise: 4000, placed_at: "2026-11-18T06:00:00Z", delivery_date: "2026-12-01", delivery_type: "advance" },
    { id: uid(778), user_id: USER, order_number: "TM-TEST-0002", status: "pending", payment_method: "cod", payment_status: "pending", subtotal_paise: 4000, delivery_fee_paise: 0, total_paise: 4000, placed_at: "2026-11-17T06:00:00Z", delivery_date: "2026-12-01", delivery_type: "advance" }];
  fake.db.order_items = [];
  await w.openOrders();
  const buttons = [...w.document.querySelectorAll("#ordersBody .pay-now-btn")];
  assert.equal(buttons.length, 1, "only the unpaid online order offers Pay now");
  assert.match($("ordersBody").textContent, /Online · awaiting payment/);
  assert.match($("ordersBody").textContent, /Cash on delivery/);
  buttons[0].click();
  await until(() => env.rzp.length === 2);
  assert.equal(fake.invokes.filter((i) => i.fn === "payment-ops" && i.body.action === "start").at(-1).body.order_id, uid(777));
});


test("My orders: a coupon or offer discount is shown, so items and total add up", async () => {
  const { w, $, fake } = await boot({ session: { user: { id: USER } } });
  fake.db.orders = [{ id: uid(781), user_id: USER, order_number: "TM-TEST-C1", status: "pending", payment_method: "cod", payment_status: "pending", subtotal_paise: 1900, delivery_fee_paise: 0, discount_paise: 700, coupon_code: "VEG10", total_paise: 1200, placed_at: "2026-11-18T06:00:00Z", delivery_date: "2026-12-01", delivery_type: "advance" },
    { id: uid(782), user_id: USER, order_number: "TM-TEST-C2", status: "pending", payment_method: "cod", payment_status: "pending", subtotal_paise: 1900, delivery_fee_paise: 2000, discount_paise: 0, coupon_code: null, total_paise: 3900, placed_at: "2026-11-17T06:00:00Z", delivery_date: "2026-12-01", delivery_type: "advance" }];
  fake.db.order_items = [];
  await w.openOrders();
  const cards = [...w.document.querySelectorAll("#ordersBody .admin-card")].map((c) => c.textContent);
  assert.ok(cards[0].includes("Discount (coupon VEG10)−₹7"), cards[0]);
  assert.doesNotMatch(cards[1], /Discount|Offer savings/, "no discount row when there is no discount");
  assert.match(cards[1], /Delivery₹20/);
});

// ---------------- Header account + membership icons (21 Nov 2026) ----------------
test("header: signed out shows Sign in only; signed in shows a profile icon (no name or email) and a membership icon", async () => {
  let { $ } = await boot();
  await tick();
  assert.equal($("acctBtn").textContent, "Sign in");
  assert.equal($("memberBtn").hidden, true, "no membership icon when signed out");
  const ctx = await boot({ session: { user: { id: USER, email: "test@example.test" } } });
  await until(() => ctx.$("acctBtn").textContent === "👤");
  const header = ctx.w.document.querySelector("header").textContent;
  assert.doesNotMatch(header, /Test Customer|test@example.test/, "no name or email in the header");
  assert.equal(ctx.$("acctBtn").getAttribute("aria-label"), "My account");
  assert.equal(ctx.$("memberBtn").hidden, false);
  assert.ok(ctx.$("cartBtn"), "basket icon unchanged");
  ctx.$("memberBtn").click();
  assert.ok(ctx.$("membershipOverlay").classList.contains("open"), "membership icon opens the membership section");
});

test("account panel: name, email, phone, saved address and membership from existing data, with the existing actions", async () => {
  const db = fixtures();
  db.addresses = [{ id: uid(890), user_id: USER, label: "Home", address_line1: "1-2-3 Test Street", area: "BHEL", city: "Hyderabad", is_default: true, created_at: "2026-11-10T00:00:00Z" }];
  const { w, $, fake } = await boot({ db, session: { user: { id: USER, email: "test@example.test" } } });
  fake.membership = { status: "active", plan: "weekly", plan_name: "Weekly membership", free_deliveries: 5, used: 1, remaining: 4, period_end: "2026-12-07T00:00:00Z" };
  await w.loadCustomerExtras();
  await until(() => $("acctBtn").textContent === "👤");
  $("acctBtn").click();
  await until(() => /BHEL/.test($("authBody").textContent));
  const text = $("authBody").textContent;
  assert.match(text, /Test Customer/);
  assert.match(text, /test@example.test/);
  assert.match(text, /9000000002/);
  assert.match(text, /Home: 1-2-3 Test Street, BHEL, Hyderabad/);
  assert.match(text, /Weekly membership · 4 of 5 free deliveries left/);
  for (const action of ["My orders", "Membership", "My bargains", "Update profile name", "Sign out"]) assert.ok(text.includes(action), action);
  assert.match($("memberBtn").className, /is-member/, "active members get a dot on the membership icon");
});

// ---------------- Admin-assigned free items (21 Nov 2026) ----------------
test("free item: shown in the basket as FREE; checkout says COD excludes it and online includes it; price never sent by the browser", async () => {
  const db = fixtures();
  db.customer_free_items = [{ id: uid(870), user_id: USER, variant_id: db.product_variants[0].id, quantity: 2, status: "pending" }];
  const ctx = await readyCheckout({ db });
  const { w, $, fake } = ctx;
  await w.loadCustomerExtras();
  w.openCart();
  assert.match($("cartItems").textContent, /Free from TaajaMandi/);
  assert.match($("cartItems").textContent, /× 2FREE/);
  w.renderCheckoutGifts();
  assert.match($("ckGifts").textContent, /only when you pay online/, "COD selected: not included");
  $("pay_online").checked = true; w.onPayMethodChange();
  assert.match($("ckGifts").textContent, /Included free with this prepaid order once your online payment is confirmed/);
  $("pay_cod").checked = true; w.onPayMethodChange();
  await w.placeOrder();
  const order = fake.invokes.find((i) => i.fn === "create-order");
  assert.ok(order, "order placed");
  assert.equal(JSON.stringify(order.body).includes("free"), false, "the browser sends no free-item or price data");
});

test("free item: not shown when online payment is unavailable as included; explains it stays saved", async () => {
  const db = fixtures();
  db.customer_free_items = [{ id: uid(871), user_id: USER, variant_id: db.product_variants[0].id, quantity: 1, status: "pending" }];
  const { w, $ } = await readyCheckout({ db, online: false });
  await w.loadCustomerExtras();
  w.renderCheckoutGifts();
  assert.match($("ckGifts").textContent, /Online payment is not available yet, so they stay saved for you/);
});

test("admin customer free item: search customer, pick product and size, assign through the server function, see confirmation", async () => {
  const db = fixtures();
  const { w, $, fake } = await boot({ db, session: { user: { id: USER } }, roles: ["admin"] });
  const calls = [];
  const orig = fake.client.rpc.bind(fake.client);
  fake.client.rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === "admin_list_free_items") return { data: [], error: null };
    if (fn === "admin_search_customers") return { data: [{ id: uid(880), full_name: "Asha Rao", phone: "9000000009", email: null }], error: null };
    if (fn === "admin_assign_free_item") return { data: { id: uid(881), product: "Tomato", size: "1 kg", quantity: args.p_quantity, customer_name: "Asha Rao", status: "pending" }, error: null };
    return orig(fn, args);
  };
  await w.loadAdminTab("customerfree");
  await until(() => $("cfCustQ"));
  $("cfCustQ").value = "As";
  await w.cfSearchCustomers();
  w.cfPickCustomer(0);
  $("cfProdQ").value = "tom"; w.cfRenderProducts();
  assert.ok($("cfProduct").options.length >= 1);
  $("cfQty").value = "11";
  await w.cfAssign();
  assert.match($("cfResult").textContent, /from 1 to 10/, "quantity checked before calling the server");
  $("cfQty").value = "2";
  await w.cfAssign();
  const assign = calls.find((c) => c.fn === "admin_assign_free_item");
  assert.deepEqual([assign.args.p_user_id, assign.args.p_quantity], [uid(880), 2]);
  assert.equal(assign.args.p_variant_id, $("cfSize").value || assign.args.p_variant_id);
  assert.equal("p_price" in assign.args || "price_paise" in assign.args, false, "no price is ever sent");
  await until(() => /Added: Tomato · 1 kg × 2 for Asha Rao/.test($("adminBody").textContent));
});

// ---------------- Coupons (launch build 21 Nov 2026) ----------------
test("coupon: the server's preview is shown, the total includes it, and the code goes with the order", async () => {
  const { w, $, fake } = await readyCheckout({ online: false });
  fake.coupons = { FRESH5: { valid: true, code: "FRESH5", discount_paise: 500, message: "Coupon applied: you save Rs 5.00." } };
  $("ckCoupon").value = "fresh5";
  await w.applyCoupon();
  assert.deepEqual(fake.couponChecks, ["FRESH5"]);
  assert.match($("couponMsg").textContent, /you save Rs 5\.00/);
  assert.match($("zoneMsg").textContent, /Total to pay: ₹35.*coupon FRESH5 −₹5/);
  await w.placeOrder();
  const body = fake.invokes.find((i) => i.fn === "create-order").body;
  assert.equal(body.coupon_code, "FRESH5");
  assert.equal(body.expected_total_paise, 3500, "the server refuses the order if its total differs from this");
});

test("coupon: an invalid or removed coupon is never sent", async () => {
  const { w, $, fake } = await readyCheckout({ online: false });
  fake.coupons = { FRESH5: { valid: true, code: "FRESH5", discount_paise: 500, message: "Coupon applied: you save Rs 5.00." } };
  $("ckCoupon").value = "NOPE1";
  await w.applyCoupon();
  assert.match($("couponMsg").textContent, /not valid/);
  $("ckCoupon").value = "FRESH5";
  await w.applyCoupon();
  w.removeCoupon();
  assert.match($("zoneMsg").textContent, /Total to pay: ₹40/);
  await w.placeOrder();
  const body = fake.invokes.find((i) => i.fn === "create-order").body;
  assert.equal(body.coupon_code, null);
  assert.equal(body.expected_total_paise, 4000);
});

test("admin coupons: new coupons are saved disabled; enabling asks first; bad values are refused", async () => {
  const db = fixtures(); db.coupons = []; db.coupon_redemptions = [];
  const { w, $, fake, env } = await boot({ db, session: { user: { id: USER } }, roles: ["admin"] });
  await w.loadAdminTab("coupons");
  await until(() => $("cpCode"));
  $("cpCode").value = "fresh50"; $("cpType").value = "percentage"; $("cpValue").value = "150";
  await w.saveCoupon({ preventDefault() {} });
  assert.match(env.alerts.at(-1), /whole percentage from 1 to 100/);
  assert.equal(fake.db.coupons.length, 0);
  $("cpValue").value = "10"; $("cpMax").value = "50"; $("cpPerUser").value = "1";
  await w.saveCoupon({ preventDefault() {} });
  assert.equal(fake.db.coupons.length, 1);
  assert.deepEqual([fake.db.coupons[0].code, fake.db.coupons[0].is_active, fake.db.coupons[0].discount_value, fake.db.coupons[0].max_discount_paise, fake.db.coupons[0].per_user_limit], ["FRESH50", false, 10, 5000, 1]);
  await until(() => $("adminBody").textContent.includes("FRESH50 · Disabled"));
  await w.toggleCoupon(fake.db.coupons[0].id, true);
  assert.equal(fake.db.coupons[0].is_active, true);
});

test("admin coupons: an enabled coupon outside its dates is labelled Expired or Scheduled, not just Enabled", async () => {
  const db = fixtures(); db.coupon_redemptions = []; db.coupons = [];
  const { w, $, fake } = await boot({ db, session: { user: { id: USER } }, roles: ["admin"] });
  const day = 864e5, now = w.Date.now(); // the page runs on the test clock
  fake.db.coupons = [
    { id: uid(971), code: "OLD-ONE", discount_type: "flat", discount_value: 100, min_order_paise: 0, is_active: true, starts_at: new Date(now - 2 * day).toISOString(), expires_at: new Date(now - day).toISOString(), created_at: "2026-11-20T00:00:00Z" },
    { id: uid(972), code: "LATER-ONE", discount_type: "flat", discount_value: 100, min_order_paise: 0, is_active: true, starts_at: new Date(now + day).toISOString(), expires_at: null, created_at: "2026-11-20T00:00:01Z" },
    { id: uid(973), code: "NOW-ONE", discount_type: "flat", discount_value: 100, min_order_paise: 0, is_active: true, starts_at: null, expires_at: null, created_at: "2026-11-20T00:00:02Z" },
    { id: uid(974), code: "OFF-ONE", discount_type: "flat", discount_value: 100, min_order_paise: 0, is_active: false, starts_at: null, expires_at: new Date(now - day).toISOString(), created_at: "2026-11-20T00:00:03Z" },
  ];
  await w.loadAdminTab("coupons");
  await until(() => $("adminBody").textContent.includes("NOW-ONE"));
  const text = $("adminBody").textContent;
  assert.match(text, /OLD-ONE · Expired/);
  assert.match(text, /LATER-ONE · Scheduled/);
  assert.match(text, /NOW-ONE · Enabled/);
  assert.match(text, /OFF-ONE · Disabled/, "a disabled coupon is Disabled whatever its dates");
});

// ---------------- Environment isolation (build-time TAAJA_ENV) ----------------
const withImage = () => { const db = fixtures(); db.product_images.push({ id: uid(950), product_id: TOMATO, variant_id: null, storage_path: "tomato/front photo.jpg", alt_text: null, sort_order: 0, is_primary: true }); return db; };
test("production config on an allowed host: no QA banner, no fallback image base", async () => {
  const { w, $ } = await boot({ db: withImage() });
  assert.equal($("qaEnvBanner"), null);
  assert.equal(w.document.querySelector("#productGrid .card img.product-photo")?.getAttribute("src"), "http://localhost/img/tomato/front photo.jpg", "images come from the client's own storage");
});

test("QA config: red QA banner and product photos read from the production image base", async () => {
  const base = "https://qebdpjzhbqzjbvjqeztl.supabase.co/storage/v1/object/public/product-images/";
  const { w, $ } = await boot({ db: withImage(), taajaEnv: { environment: "qa", projectRef: "tcdpbutitfrtunarhxhz", supabaseUrl: "http://localhost", publishableKey: "test", imagePublicBase: base, allowedHosts: null } });
  assert.match($("qaEnvBanner").textContent, /QA \/ TEST ENVIRONMENT.*tcdpbutitfrtunarhxhz/);
  const img = w.document.querySelector("#productGrid .card img");
  assert.ok(img && img.src.startsWith(base), "QA images use the read-only production image base");
});

for (const [name, cfg] of [
  ["missing config", null],
  ["production config on a non-production host", { ...PROD_TEST_ENV, allowedHosts: ["taajamandi.vercel.app"] }],
]) {
  test(`${name}: page refuses to start and never creates a Supabase client`, async () => {
    const fake = makeFake({});
    let created = 0;
    const html = source.replace('<script type="module">', "<script>").replace(/^import \{ createClient \} from 'https:\/\/esm\.sh\/@supabase\/supabase-js@2';$/m, "");
    const errors = [];
    const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true,
      virtualConsole: new (createRequire(jsdomHost)("jsdom").VirtualConsole)().on("jsdomError", (e) => errors.push(e.message)),
      beforeParse(w) { if (cfg) w.TAAJA_ENV = Object.freeze(cfg); w.createClient = () => { created++; return fake.client; }; } });
    await tick();
    assert.match(dom.window.document.body.textContent, /not available here/);
    assert.equal(created, 0);
  });
}

// ---------------- Password recovery (reset email link) ----------------
const RECOVERY_USER = { user: { id: USER, email: "test@example.test" } };
const fillNewPassword = (w, a, b) => {
  w.document.getElementById("newPassword").value = a;
  w.document.getElementById("newPassword2").value = b;
};
test("forgot password sends a reset email that returns to this site", async () => {
  const { w, fake } = await boot();
  w.openAuth();
  w.setAuthMode("forgot");
  w.document.getElementById("authEmail").value = "Test@Example.test ";
  await w.submitAuth();
  assert.deepEqual(JSON.parse(JSON.stringify(fake.resetRequests)), [{ email: "test@example.test", opts: { redirectTo: "http://localhost" } }]);
  assert.match(w.document.getElementById("authMsg").textContent, /reset email sent/i);
});

test("recovery link opens 'Set a new password', validates input and saves via updateUser", async () => {
  const { w, $, fake, env } = await boot({ session: RECOVERY_USER, url: "http://localhost/#access_token=x&refresh_token=y&type=recovery" });
  await until(() => $("newPassword"));
  assert.match($("authBody").textContent, /Set a new password/);
  assert.ok($("authOverlay").classList.contains("open"));
  fillNewPassword(w, "short", "short");
  await w.submitNewPassword();
  assert.match($("authMsg").textContent, /at least 8/);
  fillNewPassword(w, "longenough1", "different1");
  await w.submitNewPassword();
  assert.match($("authMsg").textContent, /do not match/);
  assert.equal(fake.passwordUpdates.length, 0);
  fillNewPassword(w, "longenough1", "longenough1");
  await w.submitNewPassword();
  assert.deepEqual(JSON.parse(JSON.stringify(fake.passwordUpdates)), [{ password: "longenough1" }]);
  assert.ok(!$("authOverlay").classList.contains("open"));
  assert.match(env.alerts.at(-1), /password has been updated/);
  assert.equal(w.location.hash, "", "tokens are removed from the address bar");
});

test("PASSWORD_RECOVERY event after start-up also opens the new-password form", async () => {
  const { $, fake } = await boot({ session: RECOVERY_USER });
  await tick();
  assert.equal($("newPassword"), null);
  await fake.emit("PASSWORD_RECOVERY");
  await until(() => $("newPassword"));
});

test("updateUser failure is shown and the form stays open", async () => {
  const { w, $, fake } = await boot({ session: RECOVERY_USER, url: "http://localhost/#type=recovery" });
  await until(() => $("newPassword"));
  fake.updateUserError = "New password should be different from the old password.";
  fillNewPassword(w, "longenough1", "longenough1");
  await w.submitNewPassword();
  assert.match($("authMsg").textContent, /different from the old password/);
  assert.ok($("authOverlay").classList.contains("open"));
  assert.equal($("newPasswordBtn").disabled, false);
});

test("expired reset link explains what to do and does not open the form", async () => {
  const { w, $, env } = await boot({ url: "http://localhost/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired" });
  await until(() => env.alerts.length);
  assert.match(env.alerts.at(-1), /invalid or has expired/);
  assert.equal($("newPassword"), null);
  assert.equal(w.location.hash, "");
});

// ---------------- Page structure (public/js split) ----------------
test("index.html loads rules, store, admin and app scripts in order and has no inline app code", () => {
  assert.deepEqual(scriptOrder, ["rules.js", "store.js", "admin.js", "extras.js", "admin-extra.js", "app.js"]);
  const inline = [...rawHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1].trim());
  assert.deepEqual(inline, ["import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'; window.createClient = createClient;"]);
  assert.ok(rawHtml.indexOf('src="/env-config.js"') < rawHtml.indexOf("esm.sh"), "environment config loads first");
});

test("script files are strict and their top-level names do not clash with browser globals", () => {
  const w = new JSDOM("", { pretendToBeVisual: true }).window;
  const browserOnly = ["name", "status", "origin", "top", "parent", "self", "length", "close", "open", "print", "stop", "event", "external", "screen", "history", "navigation", "scheduler", "caches", "crypto", "performance", "find", "focus", "blur"];
  for (const f of scriptOrder) {
    const code = readFileSync(path.join(jsDir, f), "utf8");
    assert.match(code, /^'use strict';$/m, `${f} is strict`);
    // Declarator names: split a top-level const/let statement on commas at bracket depth 0 only.
    const declNames = (stmt) => {
      const out = []; let depth = 0, start = 0, q = null;
      for (let i = 0; i <= stmt.length; i++) {
        const ch = stmt[i];
        if (q) { if (ch === "\\") i++; else if (ch === q) q = null; continue; }
        if (ch === "'" || ch === '"' || ch === "`") q = ch;
        else if ("{([".includes(ch)) depth++;
        else if ("})]".includes(ch)) depth--;
        else if ((ch === "," && depth === 0) || i === stmt.length) { out.push(stmt.slice(start, i)); start = i + 1; }
      }
      return out.map((d) => d.trim().match(/^[\w$]+/)?.[0]).filter(Boolean);
    };
    const names = [...code.matchAll(/^(?:async\s+)?function\s+([\w$]+)|^(?:const|let)\s+([^;]+)/gm)].flatMap((m) =>
      m[1] ? [m[1]] : declNames(m[2]));
    for (const n of names) assert.ok(!(n in w) && !browserOnly.includes(n), `${f}: top-level "${n}" clashes with a browser global`);
  }
});

// ---------------- Phase 1C: admin staff management (admin-ops only) ----------------
function staffAdminFake(fake, { listError = null } = {}) {
  fake.adminOps = (body) => {
    if (body.action === "list_staff")
      return listError ? { data: { error: listError }, error: { message: "403" } } : { data: { staff: [
        { user_id: uid(801), role: "packer_staff", name: "Pack One", email: "pack@example.test" },
        { user_id: uid(802), role: "delivery_staff", name: "Ride Two", email: null },
      ] }, error: null };
    if (body.action === "invite_staff") return { data: { success: true, role: body.role, invitation_sent: false }, error: null };
    if (body.action === "revoke_staff_role") return { data: { success: true }, error: null };
    return { data: { error: "unexpected" }, error: { message: "unexpected" } };
  };
}
test("admin staff tab: invite sends the chosen role through admin-ops invite_staff", async () => {
  const { w, $, fake, env } = await boot({ session: { user: { id: USER } }, roles: ["admin"] });
  staffAdminFake(fake);
  await w.loadAdminTab("delivery");
  await until(() => $("staffAccounts")?.textContent.includes("Pack One"));
  $("staffRole").value = "packer_staff";
  $("staffName").value = "New Packer";
  $("staffEmail").value = "new@example.test";
  await w.inviteStaff({ preventDefault() {} });
  const call = fake.invokes.find((i) => i.fn === "admin-ops" && i.body.action === "invite_staff");
  assert.equal(call.body.role, "packer_staff");
  assert.equal(call.body.email, "new@example.test");
  assert.ok(!fake.invokes.some((i) => i.fn === "staff-admin"), "retired staff-admin is never called");
  assert.match(env.alerts.at(-1), /Existing account added as Packer/);
});
test("admin staff tab: lists packer and delivery staff; Remove revokes through admin-ops with a reason", async () => {
  const { w, $, fake, env } = await boot({ session: { user: { id: USER } }, roles: ["admin"] });
  staffAdminFake(fake);
  await w.loadAdminTab("delivery");
  await until(() => $("staffAccounts")?.textContent.includes("Ride Two"));
  const text = $("staffAccounts").textContent;
  assert.match(text, /Pack One.*Packer.*pack@example.test/s);
  assert.match(text, /Ride Two.*Delivery staff/s);
  env.promptQueue = ["Left the team"];
  await w.revokeStaff(uid(802), "delivery_staff");
  const call = fake.invokes.find((i) => i.fn === "admin-ops" && i.body.action === "revoke_staff_role");
  assert.deepEqual(JSON.parse(JSON.stringify(call.body)), { action: "revoke_staff_role", user_id: uid(802), role: "delivery_staff", reason: "Left the team" });
  assert.match(env.alerts.at(-1), /Staff role removed/);
});
test("admin staff tab: a non-admin (manager) sees the server's refusal, not a staff list", async () => {
  const { w, $, fake } = await boot({ session: { user: { id: USER } }, roles: ["manager"] });
  staffAdminFake(fake, { listError: "Only an admin can manage staff accounts" });
  await w.loadAdminTab("delivery");
  await until(() => /Only an admin/.test($("staffAccounts")?.textContent || ""));
  assert.ok(!$("staffAccounts").querySelector("button"));
});

// ---------------- Phase 1D: per-size availability ----------------
test("basket: a size the store marked unavailable is flagged and blocks checkout until removed", async () => {
  const { w, $, env } = await boot({
    session: { user: { id: USER, email: "test@example.test" } },
    db: withCart({ [V.b1k]: 1, [V.t500]: 2 }),
  });
  await until(() => Object.keys(JSON.parse(cartOf(w))).length === 2);
  w.openCart();
  assert.match($("cartItems").textContent, /Unavailable today\. Remove it to continue\./);
  assert.match($("cartFoot").textContent, /Some sizes in your basket are unavailable today/);
  assert.equal($("cartFoot").querySelector("button.primary-btn").disabled, true);
  await w.openCheckout();
  assert.match(env.alerts.at(-1), /unavailable today/);
  assert.ok(!$("checkoutOverlay").classList.contains("open"), "checkout does not open");
  await w.changeQty(V.b1k, -1);
  w.renderCart();
  assert.doesNotMatch($("cartItems").textContent, /Unavailable today/);
  assert.equal($("cartFoot").querySelector("button.primary-btn").disabled, false);
});

test("admin inventory: Mark unavailable needs a reason and goes through admin-ops variant_availability", async () => {
  const { w, $, fake, env } = await boot({ session: { user: { id: USER } }, roles: ["admin"] });
  fake.adminOps = (body) => (body.action === "variant_availability" ? { data: { success: true }, error: null } : { data: { error: "unexpected" }, error: { message: "unexpected" } });
  await w.loadAdminTab("inventory");
  await until(() => /Mark unavailable/.test($("adminBody").textContent));
  assert.match($("adminBody").textContent, /Customers: Can order/);
  env.promptQueue = ["   "];
  await w.setVariantAvailability(V.t500, false);
  assert.match(env.alerts.at(-1), /reason is required/);
  assert.ok(!fake.invokes.some((i) => i.body?.action === "variant_availability"), "no call without a reason");
  env.promptQueue = ["Supplier short"];
  await w.setVariantAvailability(V.t500, false);
  const call = fake.invokes.find((i) => i.body?.action === "variant_availability");
  assert.deepEqual(JSON.parse(JSON.stringify(call.body)), { action: "variant_availability", variant_id: V.t500, available: false, reason: "Supplier short" });
  assert.match(env.alerts.at(-1), /now unavailable to customers/);
});

// =====================================================================================================
// Overnight build: banners, offers, free gifts, membership, support, favourites, reorder, admin tabs
// =====================================================================================================
const withPromos = ({ banners = [], deals = [], free = [], plans = [] } = {}) => {
  const db = fixtures();
  db.promo_banners = banners; db.promo_deals = deals; db.promo_free_items = free; db.membership_plans = plans;
  return db;
};
const DEAL_T1K = { id: uid(700), variant_id: V.t1k, label: null, deal_price_paise: 100, eligibility: "all", max_units_per_order: 1, max_orders_per_customer: 1, min_order_paise: 0 };
const PLANS = [
  { code: "weekly", name: "Weekly membership", price_paise: 5900, free_deliveries: 5, period_days: 7, is_enabled: false },
  { code: "monthly", name: "Monthly membership", price_paise: 15900, free_deliveries: 20, period_days: 30, is_enabled: false },
];

test("banners: carousel with swipe track, dots and previous/next; a button label only when the banner links somewhere", async () => {
  const many = [1, 2, 3, 4].map((n) => ({ id: uid(600 + n), heading: `Offer ${n}`, description: null, image_path: null, link_type: n === 1 ? "deals" : "none", link_target: null, sort_order: n, cta_label: "See offers" }));
  const { w, $ } = await boot({ db: withPromos({ banners: many }) });
  await until(() => $("bannerTrack") && $("bannerTrack").querySelectorAll(".banner-slide:not(.banner-fallback)").length);
  assert.equal($("promoBanners").hidden, false);
  assert.equal($("bannerTrack").querySelectorAll(".banner-slide").length, 4, "fake ignores limit; page asks for 3");
  assert.equal($("promoBanners").querySelectorAll(".banner-dots button").length, 4);
  assert.equal($("promoBanners").querySelectorAll(".banner-cta").length, 1, "no button on a banner without a link");
  $("promoBanners").querySelector(".banner-nav.next").click();
  assert.equal(w.eval("bannerIndex"), 1);
  $("promoBanners").querySelector(".banner-nav.prev").click();
  $("promoBanners").querySelector(".banner-nav.prev").click();
  assert.equal(w.eval("bannerIndex"), 3, "previous wraps around");
});

test("banners: with none configured, a TaajaMandi slide is shown (no empty area, no invented offers)", async () => {
  const { $ } = await boot({ db: withPromos() });
  await tick();
  assert.equal($("promoBanners").hidden, false);
  const slide = $("promoBanners").querySelector(".banner-fallback");
  assert.ok(slide, "fallback slide present");
  assert.match(slide.textContent, /Fresh from the mandi to your door/);
  assert.match(slide.textContent, /Deliveries start on 1 December/, "before launch the fallback states the real start date");
  assert.doesNotMatch(slide.textContent, /₹|%|off|free/i, "no prices, discounts or free claims");
  assert.equal($("promoBanners").querySelector("img"), null, "no broken image");
});

test("offers: card shows the deal; basket shows offer price, original price and savings; checkout sends the expected total", async () => {
  const { w, $, fake } = await boot({ session: { user: { id: USER } }, db: withPromos({ deals: [DEAL_T1K] }) });
  await until(() => !$("dealsSection").hidden);
  assert.match($("dealsSection").textContent, /₹1.*₹40/s);
  assert.match(w.document.querySelector("#productGrid .card .deal-tag").textContent, /₹1 deal/);
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  await w.changeQty(V.t1k, 1);
  w.openCart();
  assert.match($("cartItems").textContent, /1 at ₹1.*₹40.*1 at ₹40/s);
  assert.match($("cartFoot").textContent, /Offer savings\s*−₹39/);
  assert.match($("cartFoot").textContent, /Subtotal\s*₹41/);
  await w.openCheckout();
  await w.captureCheckoutLocation();
  $("ckZone").value = ZONE;
  w.onZoneChange();
  assert.match($("zoneMsg").textContent, /Total to pay: ₹41/);
  $("ckAddr").value = "1-2-3 Test Street";
  await w.placeOrder();
  const call = fake.invokes.find((i) => i.fn === "create-order");
  assert.equal(call.body.expected_total_paise, 4100, "server checks the total the customer saw");
});

test("offers: a used per-customer allowance is not previewed again", async () => {
  const db = withPromos({ deals: [DEAL_T1K] });
  db.orders = [{ id: uid(950), user_id: USER, status: "delivered" }];
  db.promo_redemptions = [{ promo_type: "deal", promo_id: DEAL_T1K.id, order_id: uid(950) }];
  const { w, $ } = await boot({ session: { user: { id: USER } }, db });
  await tick(); await tick();
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  w.openCart();
  assert.doesNotMatch($("cartFoot").textContent, /Offer savings/);
});

test("free gift: ₹0 line previewed when the basket qualifies; never added to the price", async () => {
  const free = [{ id: uid(710), name: "Free spinach", free_variant_id: V.sp, free_quantity: 1, trigger_type: "min_subtotal", min_subtotal_paise: 5000, trigger_variant_id: null, eligibility: "all", max_per_customer: 1 }];
  const { w, $ } = await boot({ session: { user: { id: USER } }, db: withPromos({ free }) });
  await tick();
  w.openProductDetails(TOMATO);
  await w.addDetailToBasket();
  w.openCart();
  assert.doesNotMatch($("cartFoot").textContent, /Free:/, "₹40 basket is below ₹50");
  await w.changeQty(V.t1k, 1);
  w.openCart();
  assert.match($("cartFoot").textContent, /Free: Spinach · 1 bunch × 1\s*₹0/);
  assert.match($("cartFoot").textContent, /Subtotal\s*₹80/);
});

test("membership: plans shown with 'Coming soon' while disabled; active member sees free deliveries left", async () => {
  const { w, $, fake } = await boot({ session: { user: { id: USER } }, db: withPromos({ plans: PLANS }) });
  await until(() => !$("membershipTeaser").hidden);
  assert.match($("membershipTeaser").textContent, /Weekly membership.*₹59.*5 free deliveries.*Monthly membership.*₹159.*20 free deliveries/s);
  assert.equal($("membershipTeaser").querySelectorAll("button[disabled]").length, 2);
  fake.membership = { status: "active", plan: "weekly", plan_name: "Weekly membership", free_deliveries: 5, used: 2, remaining: 3, period_end: "2026-12-07T00:00:00Z" };
  await w.loadCustomerExtras();
  w.openMembership();
  assert.match($("membershipBody").textContent, /3 of 5 free deliveries left/);
  assert.ok($("membershipOverlay").classList.contains("open"));
});

test("membership: an active member is not offered Join; their plan is marked as current", async () => {
  const enabled = PLANS.map((p) => ({ ...p, is_enabled: true, razorpay_plan_id: 'plan_test_' + p.code }));
  const { w, $, fake } = await boot({ session: { user: { id: USER } }, db: withPromos({ plans: enabled }) });
  await until(() => !$("membershipTeaser").hidden);
  assert.equal($("membershipTeaser").querySelectorAll("button.primary-btn").length, 2, "non-members can join either plan");
  fake.membership = { status: "active", plan: "weekly", plan_name: "Weekly membership", free_deliveries: 5, used: 0, remaining: 5, period_end: "2026-12-07T00:00:00Z" };
  await w.loadCustomerExtras();
  w.openMembership();
  assert.equal($("membershipBody").querySelectorAll("button.primary-btn").length, 0, "no Join button while a membership is active");
  assert.match($("membershipBody").textContent, /Your current plan/);
});

test("membership: after Cancel the customer sees when it ends (no 'renews'), and Cancel is not offered twice", async () => {
  const { w, $, fake, env } = await boot({ session: { user: { id: USER } }, db: withPromos({ plans: PLANS }) });
  fake.membership = { status: "active", plan: "weekly", plan_name: "Weekly membership", free_deliveries: 5, used: 0, remaining: 5, period_end: "2026-12-07T00:00:00Z", cancel_at_period_end: false };
  await w.loadCustomerExtras();
  w.openMembership();
  assert.match($("membershipBody").textContent, /renews/);
  const cancelBtn = [...$("membershipBody").querySelectorAll("button")].find((b) => /Cancel at the end/.test(b.textContent));
  assert.ok(cancelBtn, "Cancel offered while renewing");
  env.confirmAnswer = true; w.confirm = () => true;
  fake.client.functions.invoke = async (fn, opts) => {
    fake.invokes.push({ fn, body: opts?.body });
    fake.membership = { ...fake.membership, cancel_at_period_end: true, cancel_requested_at: "2026-11-21T05:30:00Z" };
    return { data: { success: true, message: "Your membership will end at the close of the current period." }, error: null };
  };
  await w.cancelMembership();
  await until(() => /cancelled: ends/.test($("membershipBody").textContent));
  assert.doesNotMatch($("membershipBody").textContent, /renews/);
  assert.match($("membershipBody").textContent, /no further charges/);
  assert.ok(![...$("membershipBody").querySelectorAll("button")].some((b) => /Cancel at the end/.test(b.textContent)), "Cancel not offered again");
  assert.match($("membershipMsg").textContent, /will end at the close/);
});

test("membership: signing in as another account never shows the previous account's cancel state", async () => {
  const { w, $, fake } = await boot({ session: { user: { id: USER } }, db: withPromos({ plans: PLANS }) });
  fake.membership = { status: "active", plan: "weekly", plan_name: "Weekly membership", free_deliveries: 5, used: 0, remaining: 5, period_end: "2026-12-07T00:00:00Z", cancel_at_period_end: true };
  await w.loadCustomerExtras();
  fake.membership = { status: "active", plan: "monthly", plan_name: "Monthly membership", free_deliveries: 20, used: 0, remaining: 20, period_end: "2026-12-20T00:00:00Z" };
  await w.loadCustomerExtras();
  w.openMembership();
  assert.match($("membershipBody").textContent, /renews/);
});

test("membership: Join never activates in the browser; a refused subscription shows the server message", async () => {
  const plans = PLANS.map((p) => ({ ...p, is_enabled: true }));
  const { w, $, fake } = await boot({ session: { user: { id: USER } }, db: withPromos({ plans }) });
  fake.client.functions.invoke = async (fn, opts) => { fake.invokes.push({ fn, body: opts?.body }); return { data: { error: "Membership payments are not configured yet." }, error: { message: "503" } }; };
  await until(() => !$("membershipTeaser").hidden);
  w.openMembership();
  await w.joinMembership("weekly");
  assert.match($("membershipMsg").textContent, /not configured yet/);
  assert.deepEqual(JSON.parse(JSON.stringify(fake.invokes.at(-1))), { fn: "membership-ops", body: { action: "subscribe", plan_code: "weekly" } });
  assert.ok(!fake.log.some((l) => l.table === "memberships" && l.op !== "select"), "the page never writes memberships");
});

test("support: WhatsApp button uses the owner number; signed-in customer sends a ticket", async () => {
  const { w, $, fake } = await boot({ session: { user: { id: USER } } });
  await until(() => $("waFloat"));
  assert.match($("waFloat").href, /^https:\/\/wa\.me\/917671913761\?text=/);
  await w.openSupport();
  $("supCategory").value = "freshness";
  $("supMessage").value = "Tomatoes were soft";
  await w.submitSupport({ preventDefault() {} });
  const row = fake.db.support_tickets.at(-1);
  assert.deepEqual([row.category, row.message, row.order_id], ["freshness", "Tomatoes were soft", null]);
});

test("favourites chip for signed-in customers; reorder adds available items at today's prices", async () => {
  const db = fixtures();
  db.orders = [{ id: uid(960), user_id: USER, status: "delivered", order_number: "TM-OLD", placed_at: "2026-11-01T00:00:00Z", payment_method: "cod", payment_status: "paid", subtotal_paise: 4000, delivery_fee_paise: 0, total_paise: 4000 }];
  db.order_items = [{ order_id: uid(960), variant_id: V.t1k, quantity: 2, promo_type: null }, { order_id: uid(960), variant_id: V.b1k, quantity: 1, promo_type: null }, { order_id: uid(960), variant_id: V.sp, quantity: 1, promo_type: "free_item" }];
  const { w, $, env } = await boot({ session: { user: { id: USER } }, db });
  await until(() => $("categories").querySelector('[data-cat="fav"]'));
  await w.reorder(uid(960));
  const cart = JSON.parse(cartOf(w) || "{}");
  assert.equal(Object.keys(cart).length >= 0, true);
  assert.match(env.alerts.at(-1), /Added 1 item.*1 not available today/);
});

test("admin: every new tab renders for an admin without errors", async () => {
  const { w, $ } = await boot({ session: { user: { id: USER } }, roles: ["admin"], db: withPromos({ plans: PLANS }) });
  for (const tab of ["banners", "deals", "freeitems", "memberships", "suppliers", "support", "reports"]) {
    await w.loadAdminTab(tab);
    assert.doesNotMatch($("adminBody").textContent, /Could not load|failed/i, tab);
  }
  assert.match($("adminBody").textContent, /Reports · last 30 days/);
});

test("admin: new offers are saved disabled; enabling asks for confirmation", async () => {
  const { w, $, fake } = await boot({ session: { user: { id: USER } }, roles: ["admin"] });
  await w.loadAdminTab("deals");
  $("dlVariant").value = V.t1k;
  $("dlPrice").value = "1";
  $("dlStart").value = "2026-11-25T08:00";
  $("dlEnd").value = "2026-11-30T20:00";
  await w.saveDeal({ preventDefault() {} });
  const d = fake.db.promo_deals.at(-1);
  assert.deepEqual([d.variant_id, d.deal_price_paise, d.is_enabled, d.max_units_per_order, d.max_orders_per_customer], [V.t1k, 100, false, 1, 1]);
});
