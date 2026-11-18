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
const htmlPath = path.join(here, "..", "index.html");
const source = readFileSync(htmlPath, "utf8");
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
  const fake = { db, log: [], invokes: [], admin: roles.includes("admin"), seq: 1000 };
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
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signOut() {
        return {};
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

async function boot({
  now = "2026-11-18T06:00:00Z",
  session = null,
  roles = [],
  gps = { mode: "inside" },
  perm = "prompt",
  guestCart = null,
  db,
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
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
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
