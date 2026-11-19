-- part: 00_preflight_and_reset
-- QA PROJECT ONLY: tcdpbutitfrtunarhxhz. Never run against production (qebdpjzhbqzjbvjqeztl).
-- Step 1 (preflight) aborts the whole transaction if ANY row exists in any user-data table of any schema
-- (public, private, auth, storage, vault, realtime, extensions, graphql, ...) other than Supabase's own
-- internal migration-history tables, or if the QA object inventory is not exactly what was audited on
-- 2026-11-19. Step 2 drops only the audited TaajaMandi objects. Supabase-managed schemas are not touched.

do $preflight$
declare
  r record;
  n bigint;
  found_rows text := '';
  -- Supabase-internal bookkeeping tables that legitimately contain rows in an empty project.
  internal constant text[] := array['auth.schema_migrations','storage.migrations','realtime.schema_migrations',
                                    'supabase_migrations.schema_migrations','supabase_migrations.seed_files'];
  expected_tables constant text[] := array['addresses','audit_logs','bargain_offer_history','bargain_requests','cart_items',
    'carts','categories','coupon_redemptions','coupons','delivery_assignments','delivery_slots','delivery_staff',
    'delivery_zones','inventory','inventory_transactions','order_item_checks','order_items','orders','payments',
    'product_images','product_variants','products','profiles','purchase_order_items','purchase_orders',
    'store_settings','suppliers','user_roles'];
begin
  -- 1a. Every table in every non-system schema must be empty (except Supabase's own migration history).
  for r in
    select n.nspname as s, c.relname as t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p')
      and n.nspname not in ('pg_catalog','information_schema','pg_toast')
      and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast_temp%'
  loop
    continue when (r.s || '.' || r.t) = any(internal);
    execute format('select count(*) from %I.%I', r.s, r.t) into n;
    if n > 0 then found_rows := found_rows || format(' %s.%s=%s', r.s, r.t, n); end if;
  end loop;
  if found_rows <> '' then
    raise exception 'ABORT: QA is not empty:%', found_rows;
  end if;

  -- 1b. Production fingerprint guard: production has customers, orders and 135 products.
  if exists (select 1 from auth.users) or exists (select 1 from storage.objects) or exists (select 1 from storage.buckets) then
    raise exception 'ABORT: auth users, storage objects or buckets exist';
  end if;

  -- 1c. The public schema must contain exactly the audited 28 tables, no views/sequences/types, and
  --     public/private must contain only the 18 audited functions.
  if (select array_agg(tablename::text order by tablename) from pg_tables where schemaname = 'public') is distinct from expected_tables then
    raise exception 'ABORT: public tables differ from the audited inventory';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname in ('public','private') and c.relkind in ('v','m','S','f'))
     or exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                where n.nspname in ('public','private') and t.typtype in ('e','d'))
     or exists (select 1 from pg_tables where schemaname = 'private') then
    raise exception 'ABORT: unexpected views, sequences, types or private tables';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')) <> 18 then
    raise exception 'ABORT: function inventory differs from the audited 18 functions';
  end if;
  if exists (select 1 from pg_namespace where nspname in ('cron','net')) then
    raise exception 'ABORT: pg_cron/pg_net schemas exist (not present at audit)';
  end if;
  raise notice 'Preflight passed: QA is empty and matches the audited inventory.';
end
$preflight$;

-- Step 2: remove the audited TaajaMandi objects (tables cascade removes their policies, triggers, indexes and grants).
drop table public.addresses, public.audit_logs, public.bargain_offer_history, public.bargain_requests,
  public.cart_items, public.carts, public.categories, public.coupon_redemptions, public.coupons,
  public.delivery_assignments, public.delivery_slots, public.delivery_staff, public.delivery_zones,
  public.inventory, public.inventory_transactions, public.order_item_checks, public.order_items, public.orders,
  public.payments, public.product_images, public.product_variants, public.products, public.profiles,
  public.purchase_order_items, public.purchase_orders, public.store_settings, public.suppliers,
  public.user_roles cascade;

drop function public.set_updated_at();
drop function public.handle_new_user();
drop function public.enforce_taajamandi_delivery_schedule();
drop function public.delivery_my_history();
drop function public.admin_adjust_inventory(uuid, uuid, numeric, text);
drop function public.admin_respond_bargain(uuid, text, integer, text, timestamp with time zone);
drop function public.admin_update_order_status(uuid, uuid, text, text);
drop function public.create_order_from_cart(uuid, uuid, uuid, uuid, text, text, date, text);
drop function public.delivery_decline_assignment(uuid, text);
drop function public.delivery_update_assignment(uuid, uuid, text, text);
drop function public.packer_check_item(uuid, text, numeric, text);
drop function public.packer_queue();
drop function public.packer_update_order_status(uuid, uuid, text);
drop function public.respond_bargain_request(uuid, text, text);
drop function public.submit_bargain_request(uuid, numeric, integer, text);
drop schema private cascade;  -- complete_order_delivery, has_any_role, enforce_assignment_order_packed

-- Post-check inside the same transaction: nothing of ours is left.
do $post$
begin
  if exists (select 1 from pg_tables where schemaname = 'public')
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public')
     or exists (select 1 from pg_namespace where nspname = 'private') then
    raise exception 'ABORT: reset left objects behind';
  end if;
end
$post$;
