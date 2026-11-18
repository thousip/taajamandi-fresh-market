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
const packer = (oid, s) =>
  one(`select public.packer_update_order_status($1,$2,$3) r`, [U.packer, oid, s]);
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
    grant execute on all functions in schema private to authenticated;`);
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
