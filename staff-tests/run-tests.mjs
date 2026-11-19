// Offline tests for public/staff.html — jsdom + an in-memory FAKE Supabase client. No network.
//   node --test staff-tests/run-tests.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "..", "public", "staff.html"), "utf8");
const host = process.env.JSDOM_HOST || path.join(here, "..", "package.json");
if (!existsSync(path.join(path.dirname(host), "node_modules", "jsdom")))
  throw new Error("jsdom not installed");
const { JSDOM } = createRequire(host)("jsdom");

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORDER = { pending: uid(1), confirmed: uid(2), processing: uid(3) };
const ITEM = { a: uid(11), b: uid(12) };
const ASG = { assigned: uid(21), picked: uid(22) };

function queue() {
  const base = {
    delivery_date: "2026-12-01",
    delivery_type: "advance",
    slot_label: "Morning",
    area: "Lingampally",
    customer_note: null,
    placed_at: "2026-11-18T05:00:00Z",
    updated_at: "2026-11-18T05:00:00Z",
  };
  return [
    {
      ...base,
      id: ORDER.pending,
      order_number: "TM-1",
      status: "pending",
      items: [
        {
          id: uid(10),
          product_name: "Onion",
          variant_name: "1 kg",
          quantity: 1,
          unit: "kg",
          check: null,
        },
      ],
    },
    {
      ...base,
      id: ORDER.confirmed,
      order_number: "TM-2",
      status: "confirmed",
      items: [
        {
          id: uid(13),
          product_name: "Potato",
          variant_name: "500 g",
          quantity: 2,
          unit: "kg",
          check: null,
        },
      ],
    },
    {
      ...base,
      id: ORDER.processing,
      order_number: "TM-3",
      status: "processing",
      customer_note: "Ring bell",
      items: [
        {
          id: ITEM.a,
          product_name: "Tomato",
          variant_name: "1 kg",
          quantity: 2,
          unit: "kg",
          check: null,
        },
        {
          id: ITEM.b,
          product_name: "Banana",
          variant_name: "1 dozen",
          quantity: 1,
          unit: "pack",
          check: null,
        },
      ],
    },
  ];
}
function deliveries() {
  const order = (n, extra = {}) => ({
    id: uid(30 + n),
    order_number: `TM-D${n}`,
    status: "packed",
    payment_method: "cod",
    payment_status: "pending",
    total_paise: 45050,
    delivery_date: "2026-12-01",
    delivery_type: "advance",
    customer_note: null,
    delivery_address_snapshot: {
      recipient_name: "Test Customer",
      phone: "9000000002",
      address_line1: "1 Test St",
      landmark: "Temple",
      area: "BHEL",
      city: "Hyderabad",
      pincode: "",
    },
    ...extra,
  });
  return [
    {
      assignment: { id: ASG.assigned, order_id: uid(31), status: "assigned" },
      order: order(1),
      items: [{ product_name: "Tomato", variant_name: "1 kg", quantity: 2 }],
    },
    {
      assignment: { id: ASG.picked, order_id: uid(32), status: "picked_up" },
      order: order(2, { status: "out_for_delivery" }),
      items: [],
    },
  ];
}

const plain = (v) => JSON.parse(JSON.stringify(v));
async function boot({
  session = { user: { id: uid(99), email: "staff@example.test" } },
  roles = ["packer_staff"],
  failNext = null,
} = {}) {
  const calls = { rpc: [], invoke: [], signIn: [] };
  const state = { failNext };
  const client = {
    auth: {
      async getSession() {
        return { data: { session } };
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signInWithPassword(c) {
        calls.signIn.push(c);
        return { error: { message: "Invalid login credentials" } };
      },
      async signOut() {
        return {};
      },
      async resetPasswordForEmail() {
        return { error: null };
      },
    },
    storage: {
      from: () => ({ getPublicUrl: (p) => ({ data: { publicUrl: "https://img.test/" + p } }) }),
    },
    async rpc(fn, args) {
      calls.rpc.push(JSON.parse(JSON.stringify({ fn, args })));
      if (state.failNext === fn) {
        state.failNext = null;
        return { data: null, error: { message: "Failed to fetch" } };
      }
      if (fn === "packer_queue") return { data: queue(), error: null };
      if (fn === "delivery_my_history")
        return {
          data: [
            {
              assignment_id: uid(40),
              status: "delivered",
              order_number: "TM-H1",
              total_paise: 7200,
              payment_method: "cod",
              delivery_date: "2026-12-01",
              delivered_at: "2026-12-01T05:00:00Z",
              area: "BHEL",
            },
          ],
          error: null,
        };
      return { data: { ok: true }, error: null };
    },
    functions: {
      async invoke(fn, opts = {}) {
        calls.invoke.push(JSON.parse(JSON.stringify({ fn, body: opts.body ?? null })));
        await new Promise((r) => setTimeout(r, 5));
        if (state.failNext === fn) {
          state.failNext = null;
          return { data: null, error: { message: "network", context: { status: 0 } } };
        }
        if (fn === "get-my-role")
          return { data: { roles, profile: { full_name: "Staff Person" } }, error: null };
        if (fn === "my-deliveries")
          return {
            data: { staff: { display_name: "Ravi" }, deliveries: deliveries() },
            error: null,
          };
        return { data: { success: true }, error: null };
      },
    },
  };
  const env = { alerts: [], prompts: [], confirms: true };
  const html = source
    .replace('<script type="module">', "<script>")
    .replace(
      /^import \{ createClient \} from 'https:\/\/esm\.sh\/@supabase\/supabase-js@2';$/m,
      "",
    );
  const dom = new JSDOM(html, {
    url: "https://taajamandi.test/staff.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.TAAJA_ENV = Object.freeze({ environment: "production", projectRef: "test-prod", supabaseUrl: "http://localhost", publishableKey: "test", imagePublicBase: null, allowedHosts: ["taajamandi.test"] });
      w.createClient = () => client;
      w.prompt = () => (env.prompts.length ? env.prompts.shift() : null);
      w.confirm = () => env.confirms;
      w.alert = (m) => env.alerts.push(m);
    },
  });
  const w = dom.window,
    $ = (s) => w.document.querySelector(s);
  await until(() => !$("#app").textContent.includes("Loading"));
  return { w, $, calls, env, state, $$: (s) => [...w.document.querySelectorAll(s)] };
}
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    try {
      if (fn()) return;
    } catch {
      /* retry */
    }
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const click = async (el) => {
  el.click();
  await new Promise((r) => setTimeout(r, 30));
};

test("signed-out staff see the sign-in form; wrong password shows the error", async () => {
  const { w, $, calls } = await boot({ session: null });
  assert.match($("#app").textContent, /Staff sign in/);
  $("#email").value = "Staff@Example.test";
  $("#password").value = "x";
  $("#signInForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => $("#flash").textContent.includes("Invalid login"));
  assert.equal(calls.signIn[0].email, "staff@example.test");
});

test("accounts without a staff role get no access", async () => {
  const { $ } = await boot({ roles: ["customer"] });
  assert.match($("#app").textContent, /No staff access/);
});

test("tabs follow roles: packer sees Packing only; rider sees Deliveries and History", async () => {
  const p = await boot({ roles: ["packer_staff"] });
  assert.deepEqual(
    p.$$("[data-tab]").map((b) => b.dataset.tab),
    ["packing"],
  );
  const r = await boot({ roles: ["delivery_staff"] });
  assert.deepEqual(
    r.$$("[data-tab]").map((b) => b.dataset.tab),
    ["deliveries", "history"],
  );
});

test("packing: pending waits for store, confirmed can start, start is locked against double taps", async () => {
  const { $, $$, calls } = await boot();
  await click($('[data-filter="pending"]'));
  assert.match(
    $(`[data-order-card="${ORDER.pending}"]`).textContent,
    /Waiting for the store to confirm/,
  );
  assert.equal($(`[data-order-card="${ORDER.pending}"] [data-pack]`), null);
  await click($('[data-filter="confirmed"]'));
  const start = $(`[data-pack="processing"][data-order="${ORDER.confirmed}"]`);
  start.click();
  start.click();
  await until(() => $("#flash").textContent.includes("Packing started"));
  assert.equal(
    calls.invoke.filter((c) => c.fn === "packer-ops").length,
    1,
    "one request despite double tap",
  );
  assert.deepEqual(calls.invoke.find((c) => c.fn === "packer-ops").body, {
    action: "update",
    order_id: ORDER.confirmed,
    status: "processing",
  });
  assert.ok(
    $$("[data-filter]")
      .find((b) => b.classList.contains("on"))
      .textContent.startsWith("Packing"),
  );
});

test("packing checklist: weighed qty saved, unavailable needs a reason, Mark packed only when all checked", async () => {
  const { $, calls, env } = await boot();
  const markPacked = () => $(`[data-pack="packed"][data-order="${ORDER.processing}"]`);
  assert.ok(markPacked().disabled);
  assert.ok($(`#w-${ITEM.a}`), "weight input for kg items");
  assert.equal($(`#w-${ITEM.b}`), null, "no weight input for packs");
  $(`#w-${ITEM.a}`).value = "1.96";
  await click($(`[data-check="packed"][data-item="${ITEM.a}"]`));
  assert.deepEqual(calls.rpc.at(-1), {
    fn: "packer_check_item",
    args: { p_order_item_id: ITEM.a, p_status: "packed", p_weighed_quantity: 1.96, p_note: null },
  });
  assert.ok(markPacked().disabled, "one item still unchecked");
  env.prompts.push("   ");
  await click($(`[data-check="unavailable"][data-item="${ITEM.b}"]`));
  assert.match($("#flash").textContent, /reason is required/);
  env.prompts.push("Supplier short");
  await click($(`[data-check="unavailable"][data-item="${ITEM.b}"]`));
  assert.equal(calls.rpc.at(-1).args.p_note, "Supplier short");
  assert.ok(!markPacked().disabled);
  await click(markPacked());
  await until(() => $("#flash").textContent.includes("ready for delivery"));
  assert.deepEqual(calls.invoke.at(-1).body, {
    action: "update",
    order_id: ORDER.processing,
    status: "packed",
  });
});

test("uncertain failure locks updates until Refresh", async () => {
  const { $, state } = await boot();
  state.failNext = "packer_check_item";
  await click($(`[data-check="packed"][data-item="${ITEM.a}"]`));
  assert.match($("#app").textContent, /may not have saved/);
  assert.ok($(`[data-check="packed"][data-item="${ITEM.b}"]`).disabled);
  await click($("#refreshBtn"));
  await until(
    () =>
      !$("#app").textContent.includes("may not have saved") &&
      $(`[data-check="packed"][data-item="${ITEM.b}"]`),
  );
  assert.ok(!$(`[data-check="packed"][data-item="${ITEM.b}"]`).disabled);
});

test("rider: card shows cash to collect, call and map links; accept and decline flows", async () => {
  const { $, calls, env } = await boot({ roles: ["delivery_staff"] });
  const card = $(`[data-assignment-card="${ASG.assigned}"]`);
  assert.match(card.textContent, /Cash to collect\s*₹450\.50/);
  assert.equal(card.querySelector('a[href^="tel:"]').getAttribute("href"), "tel:9000000002");
  assert.match(card.querySelector('a[href*="google.com/maps"]').href, /1%20Test%20St.*BHEL/);
  env.prompts.push("");
  await click(card.querySelector('[data-ride="decline"]'));
  assert.match($("#flash").textContent, /reason is required/);
  assert.equal(calls.rpc.length, 0);
  await click($(`[data-assignment-card="${ASG.assigned}"] [data-ride="accept"]`));
  await until(() => $("#flash").textContent.includes("accepted"));
  assert.deepEqual(calls.invoke.at(-1).body, {
    assignment_id: ASG.assigned,
    status: "accepted",
    note: null,
  });
  assert.ok(
    $(`[data-assignment-card="${ASG.assigned}"] [data-ride="picked_up"]`),
    "next step is pickup",
  );
});

test("rider: delivered needs confirmation of cash; failed needs a reason", async () => {
  const { $, calls, env } = await boot({ roles: ["delivery_staff"] });
  env.confirms = false;
  await click($(`[data-assignment-card="${ASG.picked}"] [data-ride="delivered"]`));
  assert.equal(
    calls.invoke.filter((c) => c.fn === "delivery-update").length,
    0,
    "nothing sent without confirmation",
  );
  env.prompts.push("Customer not reachable");
  await click($(`[data-assignment-card="${ASG.picked}"] [data-ride="failed"]`));
  await until(() => $("#flash").textContent.includes("Failure reported"));
  assert.deepEqual(calls.invoke.at(-1).body, {
    assignment_id: ASG.picked,
    status: "failed",
    note: "Customer not reachable",
  });
  assert.equal(
    $(`[data-assignment-card="${ASG.picked}"]`),
    null,
    "failed delivery leaves the active list",
  );
});

test("rider history tab lists completed deliveries", async () => {
  const { $ } = await boot({ roles: ["delivery_staff"] });
  await click($('[data-tab="history"]'));
  await until(() => $("#app").textContent.includes("TM-H1"));
  assert.match($("#app").textContent, /delivered.*₹72\.00 COD/s);
});

test("pure helpers", async () => {
  const { w } = await boot();
  const h = w.__staff;
  assert.deepEqual(plain(h.nextRiderActions("assigned")), ["accept", "decline"]);
  assert.deepEqual(plain(h.nextRiderActions("delivered")), []);
  assert.equal(
    h.codToCollect({ payment_method: "cod", payment_status: "paid", total_paise: 100 }),
    0,
  );
  assert.equal(h.telHref("12"), "");
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.packingProgress([{ check: { status: "unavailable" } }]))),
    { total: 1, packed: 0, unavailable: 1, done: false },
  );
});
