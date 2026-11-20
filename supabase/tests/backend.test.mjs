// Backend migration tests — run locally against PGlite (Postgres 17 in WASM). Never touches Supabase.
//   SCHEMA_JSON=<schema export>  PGLITE_DIR=<folder containing node_modules/@electric-sql/pglite>  node --test supabase/tests/backend.test.mjs
// SCHEMA_JSON is a schema-only export of the live project (tables, constraints, functions, triggers,
// RLS, policies — no data). Auth is stubbed: auth.uid() reads the request.jwt.claim.sub setting.
// For date rules the trigger's now() is redirected to an optional `test.now` setting (test copy only).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { PGlite } = await import(
  pathToFileURL(
    createRequire(path.join(process.env.PGLITE_DIR, "package.json")).resolve(
      "@electric-sql/pglite",
    ),
  ).href
);
const schema = JSON.parse(readFileSync(process.env.SCHEMA_JSON, "utf8"));
const migDir = path.join(here, "..", "migrations");
const migrations = readdirSync(migDir)
  .filter((f) => f >= "20261118130000")
  .sort()
  .filter((f) => !(process.env.SKIP_MIGRATIONS || "").split(",").includes(f))
  .map((f) => [f, readFileSync(path.join(migDir, f), "utf8")]);
const clock = (sql) =>
  sql.replaceAll(
    "now()",
    "coalesce(nullif(current_setting('test.now', true), '')::timestamptz, now())",
  );

const db = new PGlite();
const U = {
  admin: "a0000000-0000-4000-8000-000000000001",
  cust: "c0000000-0000-4000-8000-000000000001",
  other: "c0000000-0000-4000-8000-000000000002",
  packer: "b0000000-0000-4000-8000-000000000001",
  rider: "d0000000-0000-4000-8000-000000000001",
};
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { tomato: id(10), banana: id(11) },
  V = { t1k: id(101), t250: id(102), banana: id(111) };
const ZONE = id(200),
  SLOT = id(300),
  ADDR = id(400),
  ADDR2 = id(401),
  STAFF = id(500);

async function as(uid, fn, { role = null, now = "" } = {}) {
  await db.exec(
    `select set_config('request.jwt.claim.sub', '${uid ?? ""}', false); select set_config('test.now', '${now}', false);`,
  );
  if (role) await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    if (role) await db.exec("reset role");
  }
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rejects = (p, re) =>
  assert.rejects(p, (e) => {
    assert.match(e.message, re);
    return true;
  });

async function order({ date = "2026-12-01", type = "advance", slot = SLOT, now = "" } = {}) {
  await db.exec(`insert into public.carts(user_id) values ('${U.cust}') on conflict do nothing;`);
  const cart = await one(`select id from public.carts where user_id=$1`, [U.cust]);
  await db.query(`delete from public.cart_items where cart_id=$1`, [cart.id]);
  await db.query(`insert into public.cart_items(cart_id, variant_id, quantity) values ($1,$2,2)`, [
    cart.id,
    V.t1k,
  ]);
  return as(
    null,
    async () =>
      (
        await one(`select public.create_order_from_cart($1,$2,$3,$4,'cod',null,$5::date,$6) r`, [
          U.cust,
          ADDR,
          ZONE,
          slot,
          date,
          type,
        ])
      ).r,
    { now },
  );
}
const status = async (oid) =>
  (await one(`select status from public.orders where id=$1`, [oid])).status;
const admin = (oid, s, reason = null, now = "") =>
  as(
    null,
    () => one(`select public.admin_update_order_status($1,$2,$3,$4) r`, [U.admin, oid, s, reason]),
    { now },
  );
const checkItem = (itemId, s, qty = null, note = null) =>
  as(
    U.packer,
    () => one(`select public.packer_check_item($1,$2,$3,$4) r`, [itemId, s, qty, note]),
    {
      role: "authenticated",
    },
  );
const itemsOf = async (oid) =>
  (await db.query(`select id from public.order_items where order_id=$1 order by id`, [oid])).rows;
// "packed" mirrors the staff app: every item is checked as packed first, then the order is packed.
const packer = async (oid, s) => {
  if (s === "packed") for (const it of await itemsOf(oid)) await checkItem(it.id, "packed");
  return one(`select public.packer_update_order_status($1,$2,$3) r`, [U.packer, oid, s]);
};
const rider = (aid, s, note = null) =>
  one(`select public.delivery_update_assignment($1,$2,$3,$4) r`, [U.rider, aid, s, note]);
const assign = (oid) =>
  one(
    `insert into public.delivery_assignments(order_id, delivery_staff_id, status, assigned_by) values ($1,$2,'assigned',$3)
  on conflict (order_id) do update set delivery_staff_id=excluded.delivery_staff_id, status='assigned' returning id`,
    [oid, STAFF, U.admin],
  );

before(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create schema private;`);
  await db.exec(schema.tables);
  const cons = schema.constraints.split("\n");
  await db.exec(cons.filter((l) => !l.includes("FOREIGN KEY")).join("\n"));
  await db.exec(cons.filter((l) => l.includes("FOREIGN KEY")).join("\n"));
  await db.exec(clock(schema.functions));
  await db.exec(schema.triggers);
  await db.exec(schema.rls);
  await db.exec(schema.policies);
  await db.exec(`grant usage on schema public, private, auth to anon, authenticated, service_role;
    grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
    grant execute on all functions in schema private to authenticated;
    -- like Supabase: tables created later by migrations get the same default grants (RLS still applies)
    alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;`);
  for (const [name, sql] of migrations) {
    try {
      await db.exec(clock(sql));
    } catch (e) {
      throw new Error(`${name}: ${e.message}`);
    }
  }
  await db.exec(`
    insert into auth.users(id) values ('${U.admin}'),('${U.cust}'),('${U.other}'),('${U.packer}'),('${U.rider}');
    insert into public.profiles(id, full_name) select id, 'Test ' || left(id::text, 4) from auth.users;
    insert into public.user_roles(user_id, role) values ('${U.admin}','admin'),('${U.packer}','packer_staff'),('${U.rider}','delivery_staff'),('${U.cust}','customer');
    insert into public.categories(id, name, slug) values ('${id(1)}','Veg','veg');
    insert into public.products(id, category_id, name, slug, unit_type) values ('${P.tomato}','${id(1)}','Tomato','tomato','weight'),('${P.banana}','${id(1)}','Banana','banana','piece');
    insert into public.product_variants(id, product_id, name, quantity, unit, price_paise, is_default) values
      ('${V.t1k}','${P.tomato}','1 kg',1,'kg',4000,true),('${V.t250}','${P.tomato}','250 g',250,'g',1000,false),('${V.banana}','${P.banana}','1 dozen',1,'pack',6000,true);
    insert into public.delivery_zones(id, name, areas, delivery_fee_paise, minimum_order_paise, is_active) values ('${ZONE}','Lingampally',array['Lingampally'],0,0,true);
    insert into public.delivery_slots(id, zone_id, label, starts_at, ends_at, max_orders, is_active) values ('${SLOT}','${ZONE}','Morning','06:00','10:00',2,true);
    insert into public.addresses(id, user_id, recipient_name, phone, address_line1, area, city, state, pincode, latitude, longitude)
      values ('${ADDR}','${U.cust}','Test','9000000002','1 Test St','Lingampally','Hyderabad','Telangana','',17.53,78.3056),
             ('${ADDR2}','${U.other}','Other','9000000003','2 Test St','BHEL','Hyderabad','Telangana','',17.53,78.3056);
    insert into public.delivery_staff(id, user_id, display_name, is_active, is_available) values ('${STAFF}','${U.rider}','Rider',true,true);`);
});

test("booking before 1 Dec: advance only, 1 Dec or later", async () => {
  const pre = "2026-11-18 10:00+05:30";
  const ok = await order({ date: "2026-12-01", now: pre });
  assert.equal(ok.delivery_date, "2026-12-01");
  const later = await order({ date: "2026-12-09", slot: null, now: pre });
  assert.equal(later.delivery_type, "advance");
  await rejects(order({ date: "2026-11-25", slot: null, now: pre }), /1 December/);
  await rejects(
    order({ date: "2026-11-18", type: "same_day", slot: null, now: pre }),
    /1 December/,
  );
  await db.exec(`delete from public.cart_items`);
});

test("booking from 1 Dec: same-day today, advance future; IST midnight boundary", async () => {
  const dec1 = "2026-12-01 08:00+05:30";
  assert.equal(
    (await order({ date: "2026-12-01", type: "same_day", slot: null, now: dec1 })).delivery_type,
    "same_day",
  );
  await rejects(order({ date: "2026-12-01", type: "advance", slot: null, now: dec1 }), /future/);
  await rejects(order({ date: "2026-12-02", type: "same_day", slot: null, now: dec1 }), /today/);
  await db.exec(`delete from public.cart_items`);
  // 23:59 IST on 30 Nov is still pre-launch even though UTC is already 18:29 on 30 Nov
  await rejects(
    order({ date: "2026-11-30", type: "same_day", slot: null, now: "2026-11-30 23:59+05:30" }),
    /1 December/,
  );
  await db.exec(`delete from public.cart_items`);
  // year rollover
  assert.equal(
    (await order({ date: "2027-01-01", slot: null, now: "2026-12-31 22:00+05:30" })).delivery_date,
    "2027-01-01",
  );
});

test("slot capacity and expired same-day slot", async () => {
  const pre = "2026-11-18 10:00+05:30";
  await order({ date: "2026-12-03", now: pre });
  const second = await order({ date: "2026-12-03", now: pre });
  await rejects(order({ date: "2026-12-03", now: pre }), /slot is full/);
  await db.exec(`delete from public.cart_items`);
  assert.ok(await order({ date: "2026-12-04", now: pre }), "other date has space");
  await admin(second.order_id, "cancelled", "customer request", pre);
  assert.ok(await order({ date: "2026-12-03", now: pre }), "cancellation frees the place");
  await rejects(
    order({ date: "2026-12-05", type: "same_day", now: "2026-12-05 11:00+05:30" }),
    /already ended/,
  );
  await db.exec(`delete from public.cart_items`);
});

test("status update is not blocked after the delivery date has passed (old trigger bug)", async () => {
  const o = await order({ date: "2026-12-01", slot: null, now: "2026-11-18 10:00+05:30" });
  assert.equal(
    (await admin(o.order_id, "confirmed", null, "2026-12-10 10:00+05:30")).r.status,
    "confirmed",
  );
});

test("full lifecycle: confirm → pack → assign → accept → pickup → fail → reassign → deliver (supplier-fulfilled)", async () => {
  const o = await order({ date: "2026-12-02", slot: null, now: "2026-11-18 10:00+05:30" });
  const oid = o.order_id;
  await rejects(packer(oid, "processing"), /until the store confirms/);
  await rejects(assign(oid), /Only packed orders/);
  await admin(oid, "confirmed");
  await rejects(packer(oid, "packed"), /Start packing/);
  await packer(oid, "processing");
  assert.equal((await packer(oid, "processing")).r.unchanged, true, "duplicate start is a no-op");
  await rejects(admin(oid, "out_for_delivery"), /packed before dispatch/);
  await packer(oid, "packed");
  const a = await assign(oid);
  await rejects(rider(a.id, "picked_up"), /Accept the assignment/);
  await rider(a.id, "accepted");
  await rider(a.id, "picked_up");
  assert.equal(await status(oid), "out_for_delivery");
  await rejects(rider(a.id, "failed"), /reason is required/);
  await rider(a.id, "failed", "Customer not reachable");
  assert.equal(await status(oid), "packed", "failed delivery returns order for reassignment");
  const a2 = await assign(oid);
  assert.equal(a2.id, a.id, "one assignment row per order (no duplicates)");
  await rider(a.id, "accepted");
  await rider(a.id, "picked_up");
  await rejects(admin(oid, "delivered"), /Give a reason/);
  const before = await one(
    `select quantity_on_hand, quantity_reserved from public.inventory where variant_id=$1`,
    [V.t1k],
  );
  await rider(a.id, "delivered", "Handed over");
  assert.equal(await status(oid), "delivered");
  assert.deepEqual(
    await one(
      `select quantity_on_hand, quantity_reserved from public.inventory where variant_id=$1`,
      [V.t1k],
    ),
    before,
    "supplier line: no stock change",
  );
  assert.equal(
    (
      await one(
        `select count(*)::int n from public.inventory_transactions where reference_id=$1 and transaction_type='sale' and quantity_delta=0`,
        [oid],
      )
    ).n,
    1,
  );
  const pay = await one(
    `select o.payment_status, p.status from public.orders o join public.payments p on p.order_id=o.id where o.id=$1`,
    [oid],
  );
  assert.deepEqual(pay, { payment_status: "paid", status: "captured" });
  assert.equal((await rider(a.id, "delivered")).r.unchanged, true, "repeat delivered is a no-op");
  assert.equal(
    (
      await one(
        `select count(*)::int n from public.inventory_transactions where reference_id=$1 and transaction_type='sale'`,
        [oid],
      )
    ).n,
    1,
    "no double deduction",
  );
  await rejects(admin(oid, "cancelled"), /already closed/);
  assert.ok(
    (await one(`select count(*)::int n from public.audit_logs where entity_id=$1`, [oid])).n >= 8,
    "audit trail written",
  );
});

test("warehouse-reserved stock is deducted exactly once and never goes negative", async () => {
  const o = await order({ date: "2026-12-02", slot: null, now: "2026-11-18 10:00+05:30" });
  await db.query(
    `update public.inventory set quantity_on_hand=5, quantity_reserved=2 where variant_id=$1`,
    [V.t1k],
  );
  await admin(o.order_id, "confirmed");
  await packer(o.order_id, "processing");
  await packer(o.order_id, "packed");
  const a = await assign(o.order_id);
  await rider(a.id, "accepted");
  await rider(a.id, "picked_up");
  await rider(a.id, "delivered");
  assert.deepEqual(
    await one(
      `select quantity_on_hand::int h, quantity_reserved::int r from public.inventory where variant_id=$1`,
      [V.t1k],
    ),
    { h: 3, r: 0 },
  );
});

test("another rider cannot update someone else's assignment", async () => {
  await db.exec(`insert into auth.users(id) values ('${id(600)}'); insert into public.user_roles(user_id, role) values ('${id(600)}','delivery_staff');
    insert into public.delivery_staff(id, user_id, display_name, is_active) values ('${id(601)}','${id(600)}','Other rider',true);`);
  const o = await order({ date: "2026-12-02", slot: null, now: "2026-11-18 10:00+05:30" });
  await admin(o.order_id, "confirmed");
  await packer(o.order_id, "processing");
  await packer(o.order_id, "packed");
  const a = await assign(o.order_id);
  await rejects(
    one(`select public.delivery_update_assignment($1,$2,'accepted',null)`, [id(600), a.id]),
    /not found/,
  );
});

test("bargain: validation, counter-offer acceptance, admin decisions, no side effects", async () => {
  const counts = async () =>
    one(
      `select (select count(*) from public.orders)::int o, (select count(*) from public.inventory_transactions)::int t, (select price_paise from public.product_variants where id='${V.t1k}') p`,
    );
  const start = await counts();
  const submit = (v, kg, paise) =>
    as(
      U.cust,
      () => one(`select public.submit_bargain_request($1,$2,$3,'bulk for shop') r`, [v, kg, paise]),
      { role: "authenticated" },
    );
  await rejects(submit(V.t1k, 4.5, 15000), /5–50 kg/);
  await rejects(submit(V.t1k, 50.5, 15000), /5–50 kg/);
  await rejects(submit(V.t1k, 5.25, 15000), /0\.5 kg steps/);
  await rejects(submit(V.banana, 10, 15000), /sold by weight/);
  const r = (await submit(V.t250, 12.5, 45000)).r;
  assert.equal(r.regular_estimate_paise, 50000, "250 g at ₹10 → ₹40/kg × 12.5 kg");
  await rejects(
    as(U.cust, () => one(`select public.admin_respond_bargain($1,'approve')`, [r.id]), {
      role: "authenticated",
    }),
    /Admin access/,
  );
  const adminAct = (...a) =>
    as(
      U.admin,
      () => one(`select public.admin_respond_bargain($1,$2,$3,$4,$5::timestamptz) r`, a),
      { role: "authenticated" },
    );
  await rejects(adminAct(r.id, "counter", 47000, null, null), /future expiry/);
  await rejects(adminAct(r.id, "reject", null, null, null), /reason/);
  await adminAct(r.id, "counter", 47000, "Best we can do", "2099-01-01T00:00:00Z");
  const accept = await as(
    U.cust,
    () => one(`select public.respond_bargain_request($1,'accept') r`, [r.id]),
    { role: "authenticated" },
  );
  assert.equal(accept.r.status, "accepted");
  const row = await one(
    `select agreed_total_paise, status from public.bargain_requests where id=$1`,
    [r.id],
  );
  assert.deepEqual(row, { agreed_total_paise: 47000, status: "accepted" });
  const hist = (
    await db.query(
      `select action from public.bargain_offer_history where bargain_request_id=$1 order by created_at, action`,
      [r.id],
    )
  ).rows.map((x) => x.action);
  assert.deepEqual(hist.sort(), ["accepted", "countered", "submitted"]);
  const r2 = (await submit(V.t1k, 5, 18000)).r;
  await adminAct(r2.id, "reject", null, "Too low", null);
  await rejects(
    as(U.cust, () => one(`select public.respond_bargain_request($1,'accept')`, [r2.id]), {
      role: "authenticated",
    }),
    /no counter-offer/,
  );
  // expired counter-offer cannot be accepted
  const r3 = (await submit(V.t1k, 6, 20000)).r;
  await db.query(
    `update public.bargain_requests set status='countered', counter_total_paise=22000, expires_at=now() - interval '1 minute' where id=$1`,
    [r3.id],
  );
  assert.equal(
    (
      await as(U.cust, () => one(`select public.respond_bargain_request($1,'accept') r`, [r3.id]), {
        role: "authenticated",
      })
    ).r.status,
    "expired",
  );
  assert.deepEqual(
    await counts(),
    start,
    "no orders, stock movements or price changes from bargaining",
  );
});

test("RLS: customers see only their own bargains and roles; anon cannot submit", async () => {
  const theirs = await as(U.other, () => db.query(`select id from public.bargain_requests`), {
    role: "authenticated",
  });
  assert.equal(theirs.rows.length, 0);
  const mine = await as(U.cust, () => db.query(`select id from public.bargain_requests`), {
    role: "authenticated",
  });
  assert.ok(mine.rows.length >= 3);
  const adminSees = await as(U.admin, () => db.query(`select id from public.bargain_requests`), {
    role: "authenticated",
  });
  assert.equal(adminSees.rows.length, mine.rows.length);
  const roles = await as(U.cust, () => db.query(`select user_id, role from public.user_roles`), {
    role: "authenticated",
  });
  assert.deepEqual(roles.rows, [{ user_id: U.cust, role: "customer" }]);
  await rejects(
    as(
      U.cust,
      () => db.query(`insert into public.user_roles(user_id, role) values ('${U.cust}','admin')`),
      { role: "authenticated" },
    ),
    /row-level security/,
  );
  await rejects(
    as(null, () => db.query(`select public.submit_bargain_request('${V.t1k}', 5, 100)`), {
      role: "anon",
    }),
    /permission denied/,
  );
  await rejects(
    as(
      U.cust,
      () =>
        db.query(`insert into public.bargain_requests(user_id, product_id, variant_id, product_name, variant_name, quantity_kg, rate_per_kg_paise, regular_estimate_paise, offer_total_paise)
    values ('${U.cust}','${P.tomato}','${V.t1k}','x','x',5,1,1,1)`),
      { role: "authenticated" },
    ),
    /permission denied|row-level security/,
  );
});

// ---------------------------------------------------------------- staff apps (20261118150000)
async function twoItemOrder() {
  const cart = await one(`select id from public.carts where user_id=$1`, [U.cust]);
  await db.query(`delete from public.cart_items where cart_id=$1`, [cart.id]);
  await db.query(
    `insert into public.cart_items(cart_id, variant_id, quantity) values ($1,$2,1),($1,$3,4)`,
    [cart.id, V.t1k, V.t250],
  );
  const r = await as(
    null,
    async () =>
      (
        await one(
          `select public.create_order_from_cart($1,$2,$3,null,'cod',null,'2026-12-02'::date,'advance') r`,
          [U.cust, ADDR, ZONE],
        )
      ).r,
    { now: "2026-11-18 10:00+05:30" },
  );
  return r.order_id;
}

test("packing checklist: every item must be checked; shortages need a reason; all-unavailable blocked", async () => {
  const oid = await twoItemOrder();
  const [a, b] = await itemsOf(oid);
  await admin(oid, "confirmed");
  await rejects(checkItem(a.id, "packed"), /Start packing/);
  await one(`select public.packer_update_order_status($1,$2,'processing')`, [U.packer, oid]);
  await checkItem(a.id, "packed", 0.98, "weighed light");
  await rejects(
    one(`select public.packer_update_order_status($1,$2,'packed')`, [U.packer, oid]),
    /Check every item/,
  );
  await rejects(checkItem(b.id, "unavailable"), /Say why/);
  await rejects(checkItem(b.id, "packed", -1), /weighed quantity/);
  await checkItem(b.id, "unavailable", null, "Supplier short");
  const done = await one(`select public.packer_update_order_status($1,$2,'packed') r`, [
    U.packer,
    oid,
  ]);
  assert.equal(done.r.unavailable_items, 1);
  assert.equal(
    (
      await one(
        `select count(*)::int n from public.audit_logs where entity_id=$1 and action='packing_item_unavailable'`,
        [oid],
      )
    ).n,
    1,
  );
  assert.deepEqual(
    await one(
      `select status, weighed_quantity::float w from public.order_item_checks where order_item_id=$1`,
      [a.id],
    ),
    { status: "packed", w: 0.98 },
  );
  await rejects(checkItem(a.id, "clear"), /Start packing/, "checks are frozen once packed");

  const oid2 = await twoItemOrder();
  await admin(oid2, "confirmed");
  await one(`select public.packer_update_order_status($1,$2,'processing')`, [U.packer, oid2]);
  for (const it of await itemsOf(oid2)) await checkItem(it.id, "unavailable", null, "Out of stock");
  await rejects(
    one(`select public.packer_update_order_status($1,$2,'packed')`, [U.packer, oid2]),
    /No items could be packed/,
  );
});

test("packer queue: packers only, item ids and checks included, no customer contact details", async () => {
  const q = (
    await as(U.packer, () => one(`select public.packer_queue() q`), { role: "authenticated" })
  ).q;
  assert.ok(Array.isArray(q) && q.length > 0);
  const json = JSON.stringify(q);
  assert.ok(
    !/9000000002|recipient_name|1 Test St|"phone"/.test(json),
    "no phone, name or street address",
  );
  assert.ok(q.every((o) => ["pending", "confirmed", "processing", "packed"].includes(o.status)));
  assert.ok(q.some((o) => o.items.some((i) => i.id && "check" in i)));
  await rejects(
    as(U.cust, () => one(`select public.packer_queue()`), { role: "authenticated" }),
    /Packer access required/,
  );
  await rejects(
    as(U.rider, () => one(`select public.packer_queue()`), { role: "authenticated" }),
    /Packer access required/,
  );
  const custChecks = await as(U.cust, () => db.query(`select * from public.order_item_checks`), {
    role: "authenticated",
  });
  assert.equal(custChecks.rows.length, 0, "customers cannot read packing checks");
  await rejects(
    as(
      U.packer,
      () =>
        db.query(
          `insert into public.order_item_checks(order_item_id, order_id, status) select id, order_id, 'packed' from public.order_items limit 1`,
        ),
      { role: "authenticated" },
    ),
    /permission denied/,
  );
});

test("rider: decline needs a reason and only before accepting; history lists own completed work", async () => {
  const oid = await twoItemOrder();
  await admin(oid, "confirmed");
  await packer(oid, "processing");
  await packer(oid, "packed");
  const a = await assign(oid);
  const decline = (reason) =>
    as(U.rider, () => one(`select public.delivery_decline_assignment($1,$2) r`, [a.id, reason]), {
      role: "authenticated",
    });
  await rejects(decline("  "), /reason/);
  assert.equal((await decline("Bike puncture")).r.status, "reassigned");
  assert.equal(await status(oid), "packed", "order stays packed for reassignment");
  await rejects(decline("again"), /Only new assignments/);
  await assign(oid); // admin reassigns (same row, status back to assigned)
  await rider(a.id, "accepted");
  await rejects(decline("too late"), /Only new assignments/);
  await rider(a.id, "picked_up");
  await rider(a.id, "delivered");
  const h = (
    await as(U.rider, () => one(`select public.delivery_my_history() h`), { role: "authenticated" })
  ).h;
  assert.ok(h.some((x) => x.status === "delivered" && x.order_number && x.total_paise > 0));
  assert.ok(
    !/9000000002|recipient_name|1 Test St/.test(JSON.stringify(h)),
    "history has no customer contact details",
  );
  await rejects(
    as(U.packer, () => one(`select public.delivery_my_history()`), { role: "authenticated" }),
    /Delivery staff access/,
  );
});

test("cart quantity limit: new lines over 50 refused; an old oversized line blocks checkout until fixed", async () => {
  await db.exec(`insert into public.carts(user_id) values ('${U.cust}') on conflict do nothing;`);
  const cart = await one(`select id from public.carts where user_id=$1`, [U.cust]);
  await db.query(`delete from public.cart_items where cart_id=$1`, [cart.id]);
  await rejects(
    db.query(`insert into public.cart_items(cart_id, variant_id, quantity) values ($1,$2,51)`, [cart.id, V.t250]),
    /cart_items_quantity_max/,
  );
  // Recreate the production situation: a row written before the limit existed (constraint is NOT VALID).
  await db.exec(`alter table public.cart_items drop constraint cart_items_quantity_max;`);
  await db.query(`insert into public.cart_items(cart_id, variant_id, quantity) values ($1,$2,303872)`, [cart.id, V.t250]);
  await db.exec(`alter table public.cart_items add constraint cart_items_quantity_max check (quantity <= 50) not valid;`);
  const before = (await one(`select count(*)::int n from public.orders`)).n;
  await rejects(
    one(`select public.create_order_from_cart($1,$2,$3,null,'cod',null,'2026-12-01'::date,'advance') r`, [U.cust, ADDR, ZONE]),
    /above the limit of 50/,
  );
  assert.equal((await one(`select count(*)::int n from public.orders`)).n, before, "no order created");
  await rejects(
    db.query(`update public.cart_items set quantity = 303873 where cart_id=$1`, [cart.id]),
    /cart_items_quantity_max/,
  );
  await db.query(`update public.cart_items set quantity = 50 where cart_id=$1`, [cart.id]);
  const r = (await one(
    `select public.create_order_from_cart($1,$2,$3,null,'cod',null,'2026-12-01'::date,'advance') r`,
    [U.cust, ADDR, ZONE],
  )).r;
  assert.equal(r.status, "pending");
  assert.equal(r.total_paise, 50 * 1000);
});

// The schema export carries no grants, so only the 8-argument version (whose grants the migrations
// set explicitly) can be checked here. The 6-argument version was verified live: service_role only.
test("create_order_from_cart (8 args): only service_role may execute", async () => {
  for (const sig of ["public.create_order_from_cart(uuid,uuid,uuid,uuid,text,text,date,text)"]) {
    const p = await one(
      `select has_function_privilege('anon',$1,'execute') a, has_function_privilege('authenticated',$1,'execute') u, has_function_privilege('service_role',$1,'execute') s`,
      [sig],
    );
    assert.deepEqual(p, { a: false, u: false, s: true }, sig);
  }
});

// ---------------- Phase 1C: audited staff-role functions ----------------
const MANAGER = "e0000000-0000-4000-8000-000000000001";
const grant = (actor, user, role) =>
  one(`select public.admin_grant_staff_role($1,$2,$3) r`, [actor, user, role]).then((x) => x.r);
const revoke = (actor, user, role, reason = null) =>
  one(`select public.admin_revoke_staff_role($1,$2,$3,$4) r`, [actor, user, role, reason]).then((x) => x.r);
const rolesOf = async (uid) =>
  (await db.query(`select role from public.user_roles where user_id=$1 order by role`, [uid])).rows.map((r) => r.role);
const auditFor = async (uid, action) =>
  (await db.query(`select actor_id, metadata from public.audit_logs where entity_id=$1 and action=$2 order by created_at`, [uid, action])).rows;

test("staff roles: only admins grant packer/delivery roles, each grant audited in the same transaction", async () => {
  await db.exec(`insert into auth.users(id) values ('${MANAGER}') on conflict do nothing;
    insert into public.user_roles(user_id, role) values ('${MANAGER}','manager') on conflict do nothing;`);
  const r = await grant(U.admin, U.other, "packer_staff");
  assert.deepEqual(r, { user_id: U.other, role: "packer_staff", granted: true });
  assert.ok((await rolesOf(U.other)).includes("packer_staff"));
  let audit = await auditFor(U.other, "staff_role_granted");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_id, U.admin);
  assert.deepEqual(audit[0].metadata, { role: "packer_staff", already_had_role: false });
  // repeat grant: no duplicate role, still audited
  assert.equal((await grant(U.admin, U.other, "packer_staff")).granted, false);
  assert.equal((await rolesOf(U.other)).filter((x) => x === "packer_staff").length, 1);
  assert.equal((await auditFor(U.other, "staff_role_granted")).length, 2);
  // managers, packers, riders and customers cannot grant
  for (const actor of [MANAGER, U.packer, U.rider, U.cust])
    await rejects(grant(actor, U.other, "delivery_staff"), /Admin access required/);
  // nobody can grant privileged roles through the function
  for (const role of ["admin", "manager", "inventory_staff", "customer", "superuser"])
    await rejects(grant(U.admin, U.other, role), /Only packer or delivery staff/);
  await rejects(grant(U.admin, "f0000000-0000-4000-8000-000000000009", "packer_staff"), /Account not found/);
  assert.deepEqual(await rolesOf(U.other), ["packer_staff"]);
});

test("staff roles: revoke is admin-only, audited, and blocked while a rider has open deliveries", async () => {
  await rejects(revoke(MANAGER, U.other, "packer_staff"), /Admin access required/);
  const r = await revoke(U.admin, U.other, "packer_staff", "Left the team");
  assert.deepEqual(r, { user_id: U.other, role: "packer_staff", revoked: true });
  assert.deepEqual(await rolesOf(U.other), []);
  const audit = await auditFor(U.other, "staff_role_revoked");
  assert.deepEqual(audit.at(-1).metadata, { role: "packer_staff", had_role: true, reason: "Left the team" });
  await rejects(revoke(U.admin, U.admin, "admin"), /Only packer or delivery staff/);
  // rider with an open assignment cannot be removed
  const o = await order({ date: "2026-12-03", slot: null, now: "2026-11-18 10:00+05:30" });
  await admin(o.order_id, "confirmed");
  await packer(o.order_id, "processing");
  await packer(o.order_id, "packed");
  await assign(o.order_id);
  await rejects(revoke(U.admin, U.rider, "delivery_staff"), /Reassign this person's \d+ open deliveries/);
  assert.ok((await rolesOf(U.rider)).includes("delivery_staff"));
  await db.query(`update public.delivery_assignments set status='reassigned' where delivery_staff_id=$1 and status in ('assigned','accepted','picked_up')`, [STAFF]);
  assert.equal((await revoke(U.admin, U.rider, "delivery_staff", "test")).revoked, true);
  assert.equal((await one(`select is_active from public.delivery_staff where user_id=$1`, [U.rider])).is_active, false);
  // restore the rider for any later tests
  await grant(U.admin, U.rider, "delivery_staff");
  await db.query(`update public.delivery_staff set is_active=true, is_available=true where user_id=$1`, [U.rider]);
});

test("staff role functions: only service_role may execute (no client can call them)", async () => {
  for (const sig of [
    "public.admin_grant_staff_role(uuid,uuid,text)",
    "public.admin_revoke_staff_role(uuid,uuid,text,text)",
  ]) {
    const p = await one(
      `select has_function_privilege('anon',$1,'execute') a, has_function_privilege('authenticated',$1,'execute') u, has_function_privilege('service_role',$1,'execute') s`,
      [sig],
    );
    assert.deepEqual(p, { a: false, u: false, s: true }, sig);
  }
  // and signed-in users still cannot write user_roles directly (RLS)
  await rejects(
    as(U.cust, () => db.query(`insert into public.user_roles(user_id, role) values ($1,'packer_staff')`, [U.cust]), { role: "authenticated" }),
    /row-level security|permission denied/,
  );
});

// ---------------- Phase 1D: per-size availability ----------------
const setAvail = (actor, variant, available, reason = "test") =>
  one(`select public.admin_set_variant_availability($1,$2,$3,$4) r`, [actor, variant, available, reason]).then((x) => x.r);
const logFor = async (variant) =>
  (await db.query(`select is_available, reason, changed_by from public.variant_availability_log where variant_id=$1 order by created_at, id`, [variant])).rows;

test("availability: sizes default to available; admin/manager change it with a reason; history + audit written", async () => {
  const d = await one(`select bool_and(is_available) all_available, count(*) n from public.product_variants`);
  assert.equal(d.all_available, true);
  await db.exec(`insert into auth.users(id) values ('${MANAGER}') on conflict do nothing;
    insert into public.user_roles(user_id, role) values ('${MANAGER}','manager') on conflict do nothing;`);
  const r = await setAvail(U.admin, V.t250, false, "Supplier short");
  assert.deepEqual(r, { variant_id: V.t250, is_available: false, unchanged: false });
  assert.deepEqual(await logFor(V.t250), [{ is_available: false, reason: "Supplier short", changed_by: U.admin }]);
  const audit = await one(`select actor_id, metadata from public.audit_logs where action='variant_availability_changed' and entity_id=$1`, [V.t250]);
  assert.equal(audit.actor_id, U.admin);
  assert.deepEqual(audit.metadata, { is_available: false, previous: true, reason: "Supplier short" });
  // same state again: no new history row
  assert.equal((await setAvail(U.admin, V.t250, false, "again")).unchanged, true);
  assert.equal((await logFor(V.t250)).length, 1);
  // manager may change it back
  assert.equal((await setAvail(MANAGER, V.t250, true, "Back in stock")).is_available, true);
  assert.equal((await logFor(V.t250)).length, 2);
  // refusals
  for (const actor of [U.packer, U.rider, U.cust]) await rejects(setAvail(actor, V.t250, false), /Admin access required/);
  await rejects(setAvail(U.admin, V.t250, false, "  "), /Give a reason/);
  await rejects(setAvail(U.admin, id(999), false), /Size not found/);
});

test("availability: a direct table edit by an admin is still logged (trigger), with the admin as author", async () => {
  await as(U.admin, () => db.query(`update public.product_variants set is_available=false where id=$1`, [V.banana]), { role: "authenticated" });
  const rows = await logFor(V.banana);
  assert.deepEqual(rows, [{ is_available: false, reason: null, changed_by: U.admin }]);
  // a customer cannot change availability directly (RLS: admin/manager only)
  const res = await as(U.cust, () => db.query(`update public.product_variants set is_available=true where id=$1 returning id`, [V.banana]), { role: "authenticated" });
  assert.equal(res.rows.length, 0);
  assert.equal((await one(`select is_available from public.product_variants where id=$1`, [V.banana])).is_available, false);
  await setAvail(U.admin, V.banana, true, "restore");
});

test("availability: checkout refuses a size marked unavailable after it was put in the basket", async () => {
  await setAvail(U.admin, V.t1k, false, "Supplier short");
  await rejects(order({ date: "2026-12-04", slot: null, now: "2026-11-18 10:00+05:30" }), /Tomato \(1 kg\) is no longer available today/);
  // basket kept so the customer can remove the line
  const left = await one(`select count(*)::int n from public.cart_items ci join public.carts c on c.id=ci.cart_id where c.user_id=$1`, [U.cust]);
  assert.equal(left.n, 1);
  await setAvail(U.admin, V.t1k, true, "Back");
  const ok = await order({ date: "2026-12-04", slot: null, now: "2026-11-18 10:00+05:30" });
  assert.ok(ok.order_id);
});

test("availability: history is admin/manager-only; nobody writes it directly; the function is server-only", async () => {
  const count = (uid, role) => as(uid, async () => Number((await one(`select count(*) n from public.variant_availability_log`)).n), { role });
  assert.ok((await count(U.admin, "authenticated")) > 0);
  assert.ok((await count(MANAGER, "authenticated")) > 0);
  assert.equal(await count(U.cust, "authenticated"), 0);
  assert.equal(await count(U.packer, "authenticated"), 0);
  await rejects(as(null, () => db.query(`select count(*) from public.variant_availability_log`), { role: "anon" }), /permission denied/);
  await rejects(
    as(U.admin, () => db.query(`insert into public.variant_availability_log(variant_id, is_available) values ($1,false)`, [V.t1k]), { role: "authenticated" }),
    /permission denied|row-level security/,
  );
  const p = await one(
    `select has_function_privilege('anon',$1,'execute') a, has_function_privilege('authenticated',$1,'execute') u, has_function_privilege('service_role',$1,'execute') s`,
    ["public.admin_set_variant_availability(uuid,uuid,boolean,text)"],
  );
  assert.deepEqual(p, { a: false, u: false, s: true });
});

// =====================================================================================================
// Overnight build: banners, support, favourites, promotions, memberships, purchasing, audit guarantees
// =====================================================================================================
const NOW = "2026-11-18 10:00+05:30"; // before 1 Dec: advance orders on/after 1 Dec are valid
const ZONE_FEE = id(201);
const NEWBIE = "f0000000-0000-4000-8000-000000000011", ADDR_NEW = id(402);
async function cartOf(user, lines) {
  await db.query(`insert into public.carts(user_id) values ($1) on conflict do nothing`, [user]);
  const c = await one(`select id from public.carts where user_id=$1`, [user]);
  await db.query(`delete from public.cart_items where cart_id=$1`, [c.id]);
  for (const [variant, qty] of Object.entries(lines))
    await db.query(`insert into public.cart_items(cart_id, variant_id, quantity) values ($1,$2,$3)`, [c.id, variant, qty]);
  return c.id;
}
async function place(user, addr, lines, { zone = ZONE, date = "2026-12-03", expected = null, v2 = false, now = NOW } = {}) {
  await cartOf(user, lines);
  return as(null, async () => {
    const sql = v2
      ? `select public.create_order_from_cart_v2($1,$2,$3,null,'cod',null,$4::date,'advance',$5) r`
      : `select public.create_order_from_cart($1,$2,$3,null,'cod',null,$4::date,'advance') r`;
    return (await one(sql, v2 ? [user, addr, zone, date, expected] : [user, addr, zone, date])).r;
  }, { now });
}
const itemsOfOrder = async (oid) =>
  (await db.query(`select variant_id, quantity::int q, unit_price_paise p, line_total_paise t, promo_type from public.order_items where order_id=$1 order by promo_type nulls last, unit_price_paise`, [oid])).rows;
const asUser = (uid, sql, params = []) => as(uid, () => db.query(sql, params), { role: "authenticated", now: NOW });
const mustAffect = (p) => p.then((r) => { if (!r.rows.length) throw new Error("row-level security: no rows changed"); return r; });

test("overnight setup: fee-charging zone and a brand-new customer for promotion tests", async () => {
  await db.exec(`
    insert into public.delivery_zones(id, name, areas, delivery_fee_paise, minimum_order_paise, is_active) values ('${ZONE_FEE}','Paid zone',array['Paid'],3000,0,true);
    insert into auth.users(id) values ('${NEWBIE}');
    insert into public.profiles(id, full_name) values ('${NEWBIE}','New Customer');
    insert into public.addresses(id, user_id, recipient_name, phone, address_line1, area, city, state, pincode, latitude, longitude)
      values ('${ADDR_NEW}','${NEWBIE}','New','9000000009','9 Test St','Lingampally','Hyderabad','Telangana','',17.53,78.3056);`);
  assert.equal((await one(`select count(*)::int n from public.delivery_zones where id=$1`, [ZONE_FEE])).n, 1);
});

test("banners: only enabled, in-window banners are public; customers cannot manage; every change audited", async () => {
  await db.exec(`insert into public.promo_banners(heading, is_enabled, starts_at, ends_at, sort_order) values
    ('Live', true, '2026-11-01', '2026-12-31', 1), ('Disabled', false, null, null, 2), ('Expired', true, '2026-10-01', '2026-11-01', 3), ('Future', true, '2027-01-01', null, 4);`);
  const anonSees = await as(null, async () => (await db.query(`select heading from public.promo_banners order by sort_order`)).rows.map((r) => r.heading), { role: "anon", now: NOW });
  assert.deepEqual(anonSees, ["Live"]);
  await rejects(asUser(U.cust, `insert into public.promo_banners(heading, is_enabled) values ('Hack', true)`), /row-level security/);
  await asUser(U.admin, `insert into public.promo_banners(heading) values ('Admin banner')`);
  const audit = await one(`select action from public.audit_logs where action='insert_promo_banners' and actor_id=$1`, [U.admin]);
  assert.equal(audit.action, "insert_promo_banners");
  await rejects(asUser(U.admin, `insert into public.promo_banners(heading, image_path) values ('Bad path', '../secret.jpg')`), /check constraint/);
});

test("support tickets and favourites: customers see and create only their own", async () => {
  await asUser(U.cust, `insert into public.support_tickets(category, message) values ('freshness','Tomatoes were soft')`);
  await rejects(asUser(U.cust, `insert into public.support_tickets(category, message, status) values ('other','Close it myself','resolved')`), /row-level security/);
  const otherOrder = await one(`select id from public.orders where user_id<>$1 limit 1`, [U.cust]);
  if (otherOrder) await rejects(asUser(U.cust, `insert into public.support_tickets(category, message, order_id) values ('delivery','Not mine', $1)`, [otherOrder.id]), /row-level security/);
  assert.equal((await asUser(U.other, `select * from public.support_tickets`)).rows.length, 0);
  assert.ok((await asUser(U.admin, `select * from public.support_tickets`)).rows.length >= 1);
  await asUser(U.cust, `insert into public.favourites(product_id) values ($1)`, [P.tomato]);
  assert.equal((await asUser(U.other, `select * from public.favourites`)).rows.length, 0);
  await rejects(asUser(U.other, `insert into public.favourites(user_id, product_id) values ($1,$2)`, [U.cust, P.banana]), /row-level security/);
});

test("deals: disabled deals do nothing; enabled deal sells capped units at the deal price, rest at normal price", async () => {
  await db.query(`insert into public.promo_deals(id, variant_id, deal_price_paise, starts_at, ends_at, is_enabled, max_units_per_order, max_orders_per_customer)
                  values ($1,$2,100,'2026-11-01','2026-12-31',false,1,1)`, [id(700), V.t250]);
  let r = await place(U.cust, ADDR, { [V.t250]: 3 });
  assert.equal(r.total_paise, 3000, "disabled deal ignored");
  await db.query(`update public.promo_deals set is_enabled=true where id=$1`, [id(700)]);
  r = await place(U.cust, ADDR, { [V.t250]: 3 });
  assert.equal(r.discount_paise, 900);
  assert.equal(r.total_paise, 2100); // 1 x Rs1 + 2 x Rs10
  const lines = await itemsOfOrder(r.order_id);
  assert.deepEqual(lines.map((l) => [l.q, l.p, l.t, l.promo_type]), [[1, 100, 100, "deal"], [2, 1000, 2000, null]]);
  const o = await one(`select subtotal_paise, discount_paise, total_paise from public.orders where id=$1`, [r.order_id]);
  assert.deepEqual(o, { subtotal_paise: 3000, discount_paise: 900, total_paise: 2100 });
  r = await place(U.cust, ADDR, { [V.t250]: 1 });
  assert.equal(r.total_paise, 1000, "per-customer limit: second order pays full price");
});

test("deals: cancelled orders stop counting; total-unit cap and new-customer eligibility hold", async () => {
  const first = await one(`select r.order_id from public.promo_redemptions r where r.promo_id=$1 and r.user_id=$2`, [id(700), U.cust]);
  await admin(first.order_id, "cancelled", "test");
  let r = await place(U.cust, ADDR, { [V.t250]: 1 });
  assert.equal(r.total_paise, 100, "allowance returns after cancellation");
  await db.query(`update public.promo_deals set max_total_units=1 where id=$1`, [id(700)]);
  r = await place(U.other, ADDR2, { [V.t250]: 1 });
  assert.equal(r.total_paise, 1000, "total cap reached: normal price");
  await db.query(`insert into public.promo_deals(variant_id, deal_price_paise, starts_at, ends_at, is_enabled, eligibility) values ($1,100,'2026-11-01','2026-12-31',true,'new_customers')`, [V.banana]);
  r = await place(U.cust, ADDR, { [V.banana]: 1 });
  assert.equal(r.total_paise, 6000, "existing customer not eligible");
  r = await place(NEWBIE, ADDR_NEW, { [V.banana]: 1 });
  assert.equal(r.total_paise, 100, "new customer eligible");
});

test("customers cannot change prices or promotions: v2 refuses a total the server did not compute; no client writes", async () => {
  await rejects(place(U.other, ADDR2, { [V.t1k]: 1 }, { v2: true, expected: 100 }), /Prices or offers changed.*Rs 40\.00/);
  const left = await one(`select count(*)::int n from public.cart_items ci join public.carts c on c.id=ci.cart_id where c.user_id=$1`, [U.other]);
  assert.equal(left.n, 1, "refused order rolls back completely; basket kept");
  const ok = await place(U.other, ADDR2, { [V.t1k]: 1 }, { v2: true, expected: 4000 });
  assert.equal(ok.total_paise, 4000);
  await rejects(asUser(U.cust, `insert into public.promo_deals(variant_id, deal_price_paise, starts_at, ends_at, is_enabled) values ($1,0,'2026-11-01','2026-12-31',true)`, [V.t1k]), /row-level security/);
  await rejects(mustAffect(asUser(U.cust, `update public.product_variants set price_paise=1 where id=$1 returning id`, [V.t1k])), /row-level security/);
  await rejects(asUser(U.cust, `insert into public.promo_redemptions(promo_type, promo_id, user_id, order_id, quantity) select 'deal', $1, $2, id, 1 from public.orders limit 1`, [id(700), U.cust]), /permission denied/);
  const p = await one(`select has_function_privilege('authenticated',$1,'execute') u, has_function_privilege('anon',$1,'execute') a`, ["public.create_order_from_cart_v2(uuid,uuid,uuid,uuid,text,text,date,text,integer)"]);
  assert.deepEqual(p, { u: false, a: false });
});

test("free items: zero-price line when the rule matches; limits, unavailable free size and client tampering", async () => {
  await db.query(`insert into public.promo_free_items(id, name, free_variant_id, free_quantity, trigger_type, min_subtotal_paise, starts_at, ends_at, is_enabled, max_per_customer)
                  values ($1,'Free banana',$2,1,'min_subtotal',5000,'2026-11-01','2026-12-31',true,1)`, [id(710), V.banana]);
  let r = await place(U.other, ADDR2, { [V.t1k]: 1 });
  assert.equal(r.free_items.length, 0, "below minimum: no gift");
  r = await place(U.other, ADDR2, { [V.t1k]: 2 });
  assert.equal(r.total_paise, 8000, "free item is never charged");
  assert.equal(r.free_items.length, 1);
  const free = (await itemsOfOrder(r.order_id)).find((l) => l.promo_type === "free_item");
  assert.deepEqual([free.variant_id, free.q, free.p, free.t], [V.banana, 1, 0, 0]);
  r = await place(U.other, ADDR2, { [V.t1k]: 2 });
  assert.equal(r.free_items.length, 0, "one per customer");
  await db.query(`update public.product_variants set is_available=false where id=$1`, [V.banana]);
  r = await place(U.cust, ADDR, { [V.t1k]: 2 });
  assert.equal(r.free_items.length, 0, "unavailable free size is not given");
  await db.query(`update public.product_variants set is_available=true where id=$1`, [V.banana]);
  await rejects(mustAffect(asUser(U.cust, `update public.promo_free_items set max_per_customer=99 where id=$1 returning id`, [id(710)])), /row-level security/);
  await db.query(`update public.promo_free_items set is_enabled=false where id=$1`, [id(710)]);
  await db.query(`update public.promo_deals set is_enabled=false`);
});

// ---- memberships
const SUB = (sid, plan, user, start, end) => ({ payload: { subscription: { entity: { id: sid, plan_id: plan, notes: { user_id: user }, current_start: start, current_end: end } } } });
const applyEvent = (eventId, type, payload) =>
  one(`select public.apply_razorpay_subscription_event($1,$2,$3::jsonb) r`, [eventId, type, JSON.stringify(payload)]).then((x) => x.r);
const epoch = (s) => Math.floor(Date.parse(s) / 1000);

test("membership: only a webhook activates it; duplicate webhooks never duplicate memberships", async () => {
  await db.query(`update public.membership_plans set razorpay_plan_id='plan_test_weekly', free_deliveries=2 where code='weekly'`);
  const payload = SUB("sub_test_1", "plan_test_weekly", U.cust, epoch("2026-11-15T00:00:00Z"), epoch("2026-11-22T00:00:00Z"));
  const r1 = await applyEvent("evt_1", "subscription.activated", payload);
  assert.equal(r1.status, "active");
  const r2 = await applyEvent("evt_1", "subscription.activated", payload);
  assert.deepEqual(r2, { duplicate: true });
  assert.equal((await one(`select count(*)::int n from public.memberships where user_id=$1`, [U.cust])).n, 1);
  assert.equal((await one(`select count(*)::int n from public.payment_webhook_events where event_id='evt_1'`)).n, 1);
  await rejects(applyEvent("evt_2", "subscription.activated", SUB("sub_x", "plan_unknown", U.cust, null, null)), /unknown membership plan/);
  await rejects(asUser(U.other, `insert into public.memberships(user_id, plan_code, status, current_period_start, current_period_end) values ($1,'weekly','active',now(),now()+interval '7 days')`, [U.other]), /permission denied/);
  const p = await one(`select has_function_privilege('authenticated','public.apply_razorpay_subscription_event(text,text,jsonb)','execute') u`);
  assert.equal(p.u, false);
  const mine = await as(U.cust, async () => (await one(`select public.my_membership() m`)).m, { role: "authenticated", now: NOW });
  assert.deepEqual([mine.status, mine.plan, mine.free_deliveries, mine.remaining], ["active", "weekly", 2, 2]);
});

test("membership: free delivery consumed once per order, never beyond the allowance; cancellation restores it once", async () => {
  const a = await place(U.cust, ADDR, { [V.t1k]: 1 }, { zone: ZONE_FEE });
  assert.equal(a.delivery_fee_waived, true);
  assert.equal(a.total_paise, 4000);
  const b = await place(U.cust, ADDR, { [V.t1k]: 1 }, { zone: ZONE_FEE });
  assert.equal(b.delivery_fee_waived, true);
  const c = await place(U.cust, ADDR, { [V.t1k]: 1 }, { zone: ZONE_FEE });
  assert.equal(c.delivery_fee_waived, false, "allowance of 2 used up");
  assert.equal(c.total_paise, 7000);
  await rejects(db.query(`insert into public.membership_ledger(membership_id, order_id, entry, period_start) select membership_id, order_id, 'consume', period_start from public.membership_ledger where order_id=$1`, [a.order_id]), /duplicate key/);
  await admin(a.order_id, "cancelled", "customer request");
  await db.query(`update public.orders set status='refunded' where id=$1`, [a.order_id]);
  const restores = await one(`select count(*)::int n from public.membership_ledger where order_id=$1 and entry='restore'`, [a.order_id]);
  assert.equal(restores.n, 1, "restored exactly once");
  const mine = await as(U.cust, async () => (await one(`select public.my_membership() m`)).m, { role: "authenticated", now: NOW });
  assert.equal(mine.remaining, 1);
  const d = await place(U.other, ADDR2, { [V.t1k]: 1 }, { zone: ZONE_FEE });
  assert.equal(d.delivery_fee_waived, false, "non-member pays the delivery fee");
  assert.equal(d.total_paise, 7000);
  await applyEvent("evt_3", "subscription.cancelled", SUB("sub_test_1", "plan_test_weekly", U.cust, null, null));
  const e = await place(U.cust, ADDR, { [V.t1k]: 1 }, { zone: ZONE_FEE });
  assert.equal(e.delivery_fee_waived, false, "cancelled membership gives no benefit");
  assert.equal((await asUser(U.other, `select * from public.memberships`)).rows.length, 0, "members cannot see each other");
});

// ---- purchasing
test("purchasing: partial and full receiving update stock, prices and status; over-receiving and non-admins refused", async () => {
  const SUP = id(800), PO = id(801), ITEM = id(802);
  await db.exec(`insert into public.suppliers(id, name) values ('${SUP}','QA test supplier');
    insert into public.purchase_orders(id, supplier_id, po_number, status) values ('${PO}','${SUP}','PO-TEST-1','draft');
    insert into public.purchase_order_items(id, purchase_order_id, variant_id, quantity_ordered, unit_cost_paise) values ('${ITEM}','${PO}','${V.t1k}',10,2500);`);
  const receive = (actor, lines) => one(`select public.admin_receive_purchase_order($1,$2,$3::jsonb) r`, [actor, PO, JSON.stringify(lines)]).then((x) => x.r);
  await rejects(receive(U.admin, [{ item_id: ITEM, quantity: 1 }]), /Only placed purchase orders/);
  await db.query(`update public.purchase_orders set status='placed' where id=$1`, [PO]);
  await rejects(receive(U.packer, [{ item_id: ITEM, quantity: 1 }]), /Admin access required/);
  const before = Number((await one(`select coalesce((select quantity_on_hand from public.inventory where variant_id=$1),0) q`, [V.t1k])).q);
  assert.equal((await receive(U.admin, [{ item_id: ITEM, quantity: 4 }])).status, "partially_received");
  await rejects(receive(U.admin, [{ item_id: ITEM, quantity: 7 }]), /Cannot receive more than ordered/);
  assert.equal((await receive(U.admin, [{ item_id: ITEM, quantity: 6 }])).status, "received");
  const after = Number((await one(`select quantity_on_hand q from public.inventory where variant_id=$1`, [V.t1k])).q);
  assert.equal(after - before, 10);
  assert.equal((await one(`select count(*)::int n from public.inventory_transactions where reference_id=$1 and transaction_type='purchase'`, [PO])).n, 2);
  assert.equal((await one(`select last_price_paise p from public.supplier_products where supplier_id=$1 and variant_id=$2`, [SUP, V.t1k])).p, 2500);
  assert.ok((await one(`select count(*)::int n from public.supplier_price_history where supplier_id=$1 and source='purchase_receipt'`, [SUP])).n >= 1);
  for (const tbl of ["suppliers", "supplier_products", "purchase_orders", "supplier_price_history"])
    assert.equal((await asUser(U.cust, `select * from public.${tbl}`)).rows.length, 0, `customer cannot read ${tbl}`);
});

// ---- audit guarantee (required test 10)
test("a failed audit write blocks the change itself (role grant and admin config are never silently unaudited)", async () => {
  await db.exec(`alter table public.audit_logs add constraint test_block_role_audit check (action <> 'staff_role_granted') not valid;`);
  try {
    await rejects(grant(U.admin, NEWBIE, "packer_staff"), /test_block_role_audit/);
    assert.deepEqual(await rolesOf(NEWBIE), [], "role was not granted when its audit row failed");
  } finally {
    await db.exec(`alter table public.audit_logs drop constraint test_block_role_audit;`);
  }
  await db.exec(`alter table public.audit_logs add constraint test_block_banner_audit check (action <> 'insert_promo_banners') not valid;`);
  try {
    await rejects(asUser(U.admin, `insert into public.promo_banners(heading) values ('Unaudited?')`), /test_block_banner_audit/);
    assert.equal((await one(`select count(*)::int n from public.promo_banners where heading='Unaudited?'`)).n, 0);
  } finally {
    await db.exec(`alter table public.audit_logs drop constraint test_block_banner_audit;`);
  }
});

// ---- rollback scripts never delete data (runs last; everything happens inside a transaction that is rolled back)
test("rollback scripts refuse while their tables hold data, and run cleanly once empty", async () => {
  const rb = (f) => readFileSync(path.join(here, "..", "rollback", f), "utf8");
  const files = [
    "20261120140000_supplier_purchasing_rollback.sql",
    "20261120130000_promotions_checkout_rollback.sql",
    "20261120120000_memberships_rollback.sql",
    "20261120110000_banners_support_favourites_rollback.sql",
  ];
  for (const f of files) {
    await db.exec("begin");
    try {
      await rejects(db.exec(rb(f)), /Rollback refused/);
    } finally {
      await db.exec("rollback");
    }
  }
  const before = await one(`select (select count(*)::int from public.orders) o, (select count(*)::int from public.order_items) i`);
  await db.exec("begin");
  try {
    await db.exec(`delete from public.supplier_price_history; delete from public.supplier_products;
      delete from public.promo_redemptions; update public.order_items set promo_type = null, promo_id = null where promo_type is not null;
      delete from public.promo_deals; delete from public.promo_free_items;
      delete from public.membership_ledger; delete from public.memberships; delete from public.payment_webhook_events;
      delete from public.favourites; delete from public.support_tickets; delete from public.promo_banners;`);
    for (const f of files) await db.exec(rb(f));
    assert.equal((await one(`select to_regclass('public.promo_deals') t`)).t, null);
    assert.equal((await one(`select to_regclass('public.memberships') t`)).t, null);
    const after = await one(`select (select count(*)::int from public.orders) o, (select count(*)::int from public.order_items) i`);
    assert.deepEqual(after, before, "orders and order lines are never touched by a rollback");
    assert.ok((await one(`select count(*)::int n from pg_proc where proname = 'create_order_from_cart' and pronargs = 6`)).n === 1);
  } finally {
    await db.exec("rollback");
  }
  assert.ok((await one(`select to_regclass('public.promo_deals') t`)).t, "test transaction rolled back");
});
