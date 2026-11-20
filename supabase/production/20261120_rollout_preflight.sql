-- PRODUCTION PREFLIGHT, Phase 1 + overnight rollout. READ-ONLY: reads catalog metadata only (no table data).
-- Run on qebdpjzhbqzjbvjqeztl immediately before applying the six migrations. Every row must say ok = true.
-- Any false row: STOP. Production changed since this package was reviewed; apply nothing.
-- Expected fingerprint = production on 19 Nov 2026 (QA was verified identical) and re-checked on 20 Nov 2026.
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
  ('columns', 'a878427878033c9412be520f89bbb2f2'),
  ('constraints', '5cd297ae5c056d6c342d417bb8e5cf2b'),
  ('indexes', 'ef988de0e3e8822778b5289301a20eda'),
  ('functions', 'b9f47f62f22619814d224eee154cc316'),
  ('triggers', '753d6ca63d97170d88d0ab41b5c29453'),
  ('rls_flags', 'fb75038760f4e3ddac6c47692d97249d'),
  ('policies', '7d32e3271cfa349a42883bf82f2c6fdc'),
  ('table_privileges', 'f3338c7f1cca84b9935b0a504cd01c0e'),
  ('function_privileges', 'e4c609afb3e62356446efc4070d98bb8'),
  ('storage_bucket', 'd28bc0f27c56526aabee2399e37d1976')),
checks as (
  select 'fingerprint ' || e.k as check_name, coalesce(f.v = e.v, false) as ok, coalesce(f.v, 'missing') as found
  from expected e left join fp f on f.k = e.k
  union all
  select 'new table absent: ' || t, to_regclass('public.' || t) is null, coalesce(to_regclass('public.' || t)::text, 'absent')
  from unnest(array['variant_availability_log', 'promo_banners', 'support_tickets', 'favourites', 'membership_plans', 'memberships', 'membership_ledger', 'payment_webhook_events', 'promo_deals', 'promo_free_items', 'promo_redemptions', 'supplier_products', 'supplier_price_history']) t
  union all
  select 'new function absent: ' || f, to_regprocedure(f) is null, coalesce(to_regprocedure(f)::text, 'absent')
  from unnest(array['public.admin_grant_staff_role(uuid,uuid,text)', 'public.admin_revoke_staff_role(uuid,uuid,text,text)', 'public.admin_set_variant_availability(uuid,uuid,boolean,text)', 'public.my_membership()', 'public.apply_razorpay_subscription_event(text,text,jsonb)', 'public.create_order_from_cart_v2(uuid,uuid,uuid,uuid,text,text,date,text,integer)', 'public.admin_receive_purchase_order(uuid,uuid,jsonb)', 'private.audit_admin_change()']) f
  union all
  select 'last applied migration is cart_quantity_limit',
    (select name from supabase_migrations.schema_migrations order by version desc limit 1) = 'cart_quantity_limit',
    (select name from supabase_migrations.schema_migrations order by version desc limit 1)
)
select check_name, ok, found from checks
union all
select 'ALL CHECKS PASS', bool_and(ok), count(*)::text || ' checks' from checks
order by 2, 1;
