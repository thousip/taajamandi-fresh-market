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
const scriptOrder = [...rawHtml.matchAll(/<script defer src="\/js\/([a-z]+\.js)"><\/script>/g)].map((m) => m[1]);
const source = rawHtml
  .replace(/<script type="module">import \{ createClient \}[^<]*<\/script>/, "")
  .replace(/<script defer src="\/js\/([a-z]+\.js)"><\/script>/g, (_, f) => `<script>\n${readFileSync(path.join(jsDir, f), "utf8")}\n</script>`);
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
        if (fn === "create-order")
          return {
            data: {
              success: true,
              order: {
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
  db,
  url = "http://localhost/",
} = {}) {
  const fake = makeFake({ session, roles, db });
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
      w.alert = (m) => env.alerts.push(String(m));
      w.prompt = () =>
        env.promptQueue && env.promptQueue.length ? env.promptQueue.shift() : env.promptAnswer;
      w.confirm = () => true;
      w.open = (u) => {
        env.opened.push(u);
        return {};
      };
      if (guestCart) w.localStorage.setItem("taajamandi_guest_cart_v1", JSON.stringify(guestCart));
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

test("homepage GPS: serviceable, coming soon, denied, and auto-check when already granted", async () => {
  const { w, $, env } = await boot();
  $("detectLocationBtn").click();
  await until(() => $("serviceCheck").dataset.state === "ok");
  assert.equal($("serviceTitle").textContent, "✓ Serviceable");
  env.gps.mode = "outside";
  $("detectLocationBtn").click();
  await until(() => $("serviceCheck").dataset.state === "outside");
  assert.equal($("serviceTitle").textContent, "Coming soon");
  env.gps.mode = "denied";
  $("detectLocationBtn").click();
  await until(() => $("serviceCheck").dataset.state === "denied");
  assert.match($("serviceMsg").textContent, /Ordering needs your GPS location/);
  const granted = await boot({ perm: "granted" });
  await until(() => granted.$("serviceCheck").dataset.state === "ok");
});

test("homepage location is reused in checkout", async () => {
  const { w, $ } = await boot({ session: { user: { id: USER } } });
  $("detectLocationBtn").click();
  await until(() => $("serviceCheck").dataset.state === "ok");
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

// Regression: production cart lines doubled on every page load / auth event (Brinjal 250 g x 303,872).
const CART_ID = uid(900);
const withCart = (lines) => {
  const db = fixtures();
  db.carts.push({ id: CART_ID, user_id: USER });
  for (const [variant_id, quantity] of Object.entries(lines))
    db.cart_items.push({ id: uid(901 + db.cart_items.length), cart_id: CART_ID, variant_id, quantity });
  return db;
};
const serverRows = (fake) =>
  Object.fromEntries(fake.db.cart_items.map((r) => [r.variant_id, Number(r.quantity)]));

test("signed-in cart does not grow on reload, token refresh or repeated sign-in events", async () => {
  const { w, fake } = await boot({
    session: { user: { id: USER, email: "test@example.test" } },
    db: withCart({ [V.t500]: 3, [V.t250]: 1 }),
  });
  await tick();
  for (const ev of ["TOKEN_REFRESHED", "SIGNED_IN", "SIGNED_IN", "TOKEN_REFRESHED"]) await fake.emit(ev);
  await tick();
  assert.deepEqual(serverRows(fake), { [V.t500]: 3, [V.t250]: 1 });
  assert.deepEqual(
    Object.fromEntries(Object.entries(JSON.parse(cartOf(w))).map(([k, x]) => [k, x.qty])),
    { [V.t500]: 3, [V.t250]: 1 },
  );
});

test("guest cart is merged into the account cart exactly once (boot and INITIAL_SESSION race)", async () => {
  const { fake } = await boot({
    session: { user: { id: USER, email: "test@example.test" } },
    db: withCart({ [V.t500]: 1 }),
    guestCart: { [V.t500]: { qty: 2 }, [V.t250]: { qty: 1 } },
  });
  await tick();
  await fake.emit("SIGNED_IN");
  await tick();
  assert.deepEqual(serverRows(fake), { [V.t500]: 3, [V.t250]: 1 });
});

test("oversized cart lines are capped at 50 and saved back; adding beyond 50 is refused", async () => {
  const { w, fake, env } = await boot({
    session: { user: { id: USER, email: "test@example.test" } },
    db: withCart({ [V.t250]: 303872, [V.t500]: 50 }),
  });
  await until(() => serverRows(fake)[V.t250] === 50);
  assert.deepEqual(serverRows(fake), { [V.t250]: 50, [V.t500]: 50 });
  await w.changeQty(V.t500, 1);
  assert.equal(serverRows(fake)[V.t500], 50);
  assert.match(env.alerts.at(-1), /up to 50/);
  await w.changeQty(V.t500, -1);
  assert.equal(serverRows(fake)[V.t500], 49);
});

test("guest cart restored from storage is capped at 50 per line", async () => {
  const { w } = await boot({ guestCart: { [V.t500]: { qty: 9999 }, [V.t250]: { qty: -4 } } });
  assert.deepEqual(
    Object.fromEntries(Object.entries(JSON.parse(cartOf(w))).map(([k, x]) => [k, x.qty])),
    { [V.t500]: 50 },
  );
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
  assert.deepEqual(scriptOrder, ["rules.js", "store.js", "admin.js", "app.js"]);
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
    const names = [...code.matchAll(/^(?:async\s+)?function\s+([\w$]+)|^(?:const|let)\s+([^;]+)/gm)].flatMap((m) =>
      m[1] ? [m[1]] : m[2].split(/,(?![^{([]*[})\]])/).map((d) => d.trim().match(/^[\w$]+/)?.[0]).filter(Boolean));
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
