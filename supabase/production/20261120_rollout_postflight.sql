-- PRODUCTION POSTFLIGHT, Phase 1 + overnight rollout. READ-ONLY.
-- Run on qebdpjzhbqzjbvjqeztl right after the six migrations. Every row must say ok = true.
-- Expected fingerprint = QA (tcdpbutitfrtunarhxhz) after the same six files were applied there, recorded 20 Nov 2026.
-- "orders untouched" compares with the counts on 20 Nov 2026 (2 orders, 5 order lines); counts may only grow.
with
cols as (select 'columns' k, md5(string_agg(format('%s.%s %s %s %s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
  a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '')), '|' order by c.relname, a.attnum)) v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum where n.nspname = 'public' and c.relkind = 'r'),
cons as (select 'constraints' k, md5(string_agg(format('%s.%s %s', c.relname, x.conname, pg_get_constraintdef(x.oid)), '|' order by c.relname, x.conname)) v
  from pg_constraint x join pg_class c on c.oid = x.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'),
idx as (select 'indexes' k, md5(string_agg(pg_get_indexdef(i.indexrelid), '|' order by pg_get_indexdef(i.indexrelid))) v
  from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'),
fns as (select 'functions' k, md5(string_agg(format('%s %s %s %s %s', p.oid::regprocedure, md5(p.prosrc), p.prosecdef, p.provolatile,
  coalesce(array_to_string(p.proconfig, ','), '')), '|' order by p.oid::regprocedure::text)) v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')),
trg as (select 'triggers' k, md5(string_agg(pg_get_triggerdef(t.oid), '|' order by pg_get_triggerdef(t.oid))) v
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users' and t.tgname = 'on_auth_user_created_taajamandi'))),
rls as (select 'rls_flags' k, md5(string_agg(format('%s %s %s', c.relname, c.relrowsecurity, c.relforcerowsecurity), '|' order by c.relname)) v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'),
pol as (select 'policies' k, md5(string_agg(format('%s.%s %s %s %s %s %s', schemaname, tablename, policyname, permissive, roles, cmd,
  coalesce(qual, '') || '/' || coalesce(with_check, '')), '|' order by schemaname, tablename, policyname)) v
  from pg_policies where schemaname in ('public') or (schemaname = 'storage' and policyname like 'TaajaMandi%')),
tpriv as (select 'table_privileges' k, md5(string_agg(format('%s %s %s', c.relname, r.rolname, p.priv), '|' order by c.relname, r.rolname, p.priv)) v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
  where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege(r.rolname, c.oid, p.priv)),
fpriv as (select 'function_privileges' k, md5(string_agg(format('%s %s', p.oid::regprocedure, r.rolname), '|' order by p.oid::regprocedure::text, r.rolname)) v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
  where n.nspname in ('public','private') and has_function_privilege(r.rolname, p.oid, 'EXECUTE')),
bucket as (select 'storage_bucket' k, md5(coalesce((select format('%s %s %s %s', id, public, file_size_limit, allowed_mime_types) from storage.buckets where id = 'product-images'), 'missing')) v),
fp as (select k, v from cols union all select * from cons union all select * from idx union all select * from fns union all select * from trg
union all select * from rls union all select * from pol union all select * from tpriv union all select * from fpriv union all select * from bucket),
expected(k, v) as (values
  ('columns', '1d2bba986b9961613d05ee481b1d55dc'),
  ('constraints', '0673f1fe16997dd4a55e85b08c5eec77'),
  ('indexes', '9e2177e10b8e33a6ff82c5cd56df666d'),
  ('functions', '3e79a54b7d4e722a1812a6e5ad38ffd7'),
  ('triggers', 'ed31277120f4846f2dd6cc0b5fee9db5'),
  ('rls_flags', 'edf91809265f97b14fd8190a1556a6db'),
  ('policies', 'cb8360f1a3fc4b34bedb6fe1140a49a7'),
  ('table_privileges', '59a704305dc9f2b9a9c72cf672b3dd86'),
  ('function_privileges', 'c85582f845481d38071ac6bbc5960ef3'),
  ('storage_bucket', 'd28bc0f27c56526aabee2399e37d1976')),
before(orders, order_items) as (values (2::bigint, 5::bigint)),
checks as (
  select 'fingerprint ' || e.k as check_name, coalesce(f.v = e.v, false) as ok, coalesce(f.v, 'missing') as found
  from expected e left join fp f on f.k = e.k
  union all
  select 'new table has RLS: ' || t, coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.' || t)), false), coalesce(to_regclass('public.' || t)::text, 'MISSING')
  from unnest(array['variant_availability_log', 'promo_banners', 'support_tickets', 'favourites', 'membership_plans', 'memberships', 'membership_ledger', 'payment_webhook_events', 'promo_deals', 'promo_free_items', 'promo_redemptions', 'supplier_products', 'supplier_price_history']) t
  union all
  select 'server-only function: ' || f,
    case when to_regprocedure(f) is null then false else has_function_privilege('service_role', f, 'execute')
      and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') end,
    coalesce(to_regprocedure(f)::text, 'MISSING')
  from unnest(array['public.admin_grant_staff_role(uuid,uuid,text)', 'public.admin_revoke_staff_role(uuid,uuid,text,text)', 'public.admin_set_variant_availability(uuid,uuid,boolean,text)', 'public.apply_razorpay_subscription_event(text,text,jsonb)', 'public.create_order_from_cart_v2(uuid,uuid,uuid,uuid,text,text,date,text,integer)', 'public.admin_receive_purchase_order(uuid,uuid,jsonb)', 'public.create_order_from_cart(uuid,uuid,uuid,uuid,text,text,date,text)']) f
  union all
  select 'my_membership is for signed-in users only',
    case when to_regprocedure('public.my_membership()') is null then false else has_function_privilege('authenticated', 'public.my_membership()', 'execute') and not has_function_privilege('anon', 'public.my_membership()', 'execute') end, ''
  union all
  select '6-argument checkout core still exists', to_regprocedure('public.create_order_from_cart(uuid,uuid,uuid,uuid,text,text)') is not null, ''
  union all
  select 'membership plans disabled, no Razorpay plan id', not exists (select 1 from public.membership_plans where is_enabled or razorpay_plan_id is not null),
    (select count(*)::text || ' plans' from public.membership_plans)
  union all
  select 'no banners, deals, gifts or memberships yet',
    (select count(*) from public.promo_banners) + (select count(*) from public.promo_deals) + (select count(*) from public.promo_free_items) + (select count(*) from public.memberships) = 0, ''
  union all
  select 'every size still available (new column default)', not exists (select 1 from public.product_variants where not is_available),
    (select count(*)::text || ' sizes' from public.product_variants)
  union all
  select 'orders untouched', (select count(*) from public.orders) >= (select orders from before), (select count(*)::text from public.orders)
  union all
  select 'order lines untouched', (select count(*) from public.order_items) >= (select order_items from before)
    and not exists (select 1 from public.order_items where promo_type is not null), (select count(*)::text from public.order_items)
  union all
  select 'six migrations recorded', (select count(*) from supabase_migrations.schema_migrations where name in ('staff_role_functions', 'variant_availability', 'banners_support_favourites', 'memberships', 'promotions_checkout', 'supplier_purchasing')) = 6, ''
)
select check_name, ok, found from checks
union all
select 'ALL CHECKS PASS', bool_and(ok), count(*)::text || ' checks' from checks
order by 2, 1;
