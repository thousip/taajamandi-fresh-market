-- Phase 1D: per-size availability (approved plan, 19 Nov 2026; owner decision: availability flag only).
--
--  1. product_variants.is_available (default true): existing sizes stay orderable; separate from is_active,
--     which hides a product entirely.
--  2. variant_availability_log: one row per change, written ONLY by a trigger (also catches direct table edits
--     by admins), readable only by admin/manager. Customers never see reasons or history.
--  3. admin_set_variant_availability(actor, variant, available, reason): admin/manager only, reason required,
--     also writes audit_logs; executable by service_role only (called from admin-ops).
--  4. create_order_from_cart (6-argument; the 8-argument wrapper calls it): refuses unavailable sizes inside the
--     order transaction. Only two lines differ from the current definition (md5 ac5a34bd574f756114c04b223e71731d,
--     identical on QA and production); signature, grants and everything else unchanged.
-- Backward compatible: until a size is marked unavailable nothing behaves differently.
-- Rollback: supabase/rollback/20261120100000_variant_availability_rollback.sql

alter table public.product_variants add column if not exists is_available boolean not null default true;

create table if not exists public.variant_availability_log (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  is_available boolean not null,
  reason text,
  changed_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists variant_availability_log_variant_idx on public.variant_availability_log (variant_id, created_at desc);
alter table public.variant_availability_log enable row level security;
create policy "admin manager read availability log" on public.variant_availability_log
  for select to authenticated using ((select private.has_any_role(array['admin','manager'])));
revoke all on public.variant_availability_log from anon;
revoke insert, update, delete, truncate on public.variant_availability_log from authenticated;

create or replace function private.log_variant_availability()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.variant_availability_log (variant_id, is_available, reason, changed_by)
  values (new.id, new.is_available,
          nullif(current_setting('taajamandi.availability_reason', true), ''),
          coalesce(nullif(current_setting('taajamandi.availability_actor', true), '')::uuid, auth.uid()));
  return new;
end;
$function$;
revoke all on function private.log_variant_availability() from public, anon, authenticated;

drop trigger if exists variant_availability_logged on public.product_variants;
create trigger variant_availability_logged
  after update of is_available on public.product_variants
  for each row when (old.is_available is distinct from new.is_available)
  execute function private.log_variant_availability();

create or replace function public.admin_set_variant_availability(p_actor_id uuid, p_variant_id uuid, p_available boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_before boolean; v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
begin
  if p_actor_id is null or p_variant_id is null or p_available is null then
    raise exception 'Missing availability details' using errcode = '22023';
  end if;
  if not exists (select 1 from public.user_roles where user_id = p_actor_id and role in ('admin', 'manager')) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'Give a reason for this availability change' using errcode = '22023';
  end if;
  select is_available into v_before from public.product_variants where id = p_variant_id for update;
  if not found then raise exception 'Size not found' using errcode = 'P0002'; end if;
  if v_before = p_available then
    return jsonb_build_object('variant_id', p_variant_id, 'is_available', p_available, 'unchanged', true);
  end if;
  perform set_config('taajamandi.availability_reason', v_reason, true);
  perform set_config('taajamandi.availability_actor', p_actor_id::text, true);
  update public.product_variants set is_available = p_available, updated_at = now() where id = p_variant_id;
  perform set_config('taajamandi.availability_reason', '', true);
  perform set_config('taajamandi.availability_actor', '', true);
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'variant_availability_changed', 'product_variant', p_variant_id,
          jsonb_build_object('is_available', p_available, 'previous', v_before, 'reason', v_reason));
  return jsonb_build_object('variant_id', p_variant_id, 'is_available', p_available, 'unchanged', false);
end;
$function$;
revoke all on function public.admin_set_variant_availability(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_set_variant_availability(uuid, uuid, boolean, text) to service_role;

-- Checkout re-check (see header). Generated from the current definition with two exact replacements.
CREATE OR REPLACE FUNCTION public.create_order_from_cart(p_user_id uuid, p_address_id uuid, p_delivery_zone_id uuid, p_delivery_slot_id uuid DEFAULT NULL::uuid, p_payment_method text DEFAULT 'cod'::text, p_customer_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cart_id uuid;
  v_address public.addresses%rowtype;
  v_zone public.delivery_zones%rowtype;
  v_slot public.delivery_slots%rowtype;
  v_item record;
  v_inventory public.inventory%rowtype;
  v_order_id uuid;
  v_order_number text;
  v_subtotal integer := 0;
  v_delivery_fee integer := 0;
  v_total integer := 0;
  v_item_count integer := 0;
  v_processed integer := 0;
begin
  if p_user_id is null or p_address_id is null or p_delivery_zone_id is null then
    raise exception 'Missing required checkout details' using errcode = '22023';
  end if;

  if p_payment_method not in ('cod','razorpay') then
    raise exception 'Unsupported payment method' using errcode = '22023';
  end if;

  select * into v_address
  from public.addresses
  where id = p_address_id and user_id = p_user_id
  for share;

  if not found then
    raise exception 'Delivery address not found' using errcode = 'P0002';
  end if;

  select * into v_zone
  from public.delivery_zones
  where id = p_delivery_zone_id and is_active = true
    
  for share;

  if not found then
    raise exception 'Delivery is not available for this pincode' using errcode = '22023';
  end if;

  if p_delivery_slot_id is not null then
    select * into v_slot
    from public.delivery_slots
    where id = p_delivery_slot_id and is_active = true
      and (zone_id is null or zone_id = p_delivery_zone_id)
    for share;
    if not found then
      raise exception 'Selected delivery slot is unavailable' using errcode = '22023';
    end if;
  end if;

  select id into v_cart_id
  from public.carts
  where user_id = p_user_id
  for update;

  if v_cart_id is null then
    raise exception 'Your cart is empty' using errcode = 'P0002';
  end if;

  select count(*) into v_item_count
  from public.cart_items
  where cart_id = v_cart_id;

  if v_item_count = 0 then
    raise exception 'Your cart is empty' using errcode = 'P0002';
  end if;

  for v_item in
    select ci.id as cart_item_id, ci.variant_id, ci.quantity,
           pv.name as variant_name, pv.sku, pv.price_paise,
           p.name as product_name, pv.is_active as variant_active,
           p.is_active as product_active, pv.is_available as variant_available
    from public.cart_items ci
    join public.product_variants pv on pv.id = ci.variant_id
    join public.products p on p.id = pv.product_id
    where ci.cart_id = v_cart_id
    order by ci.variant_id
    for update of ci, pv
  loop
    if not v_item.variant_active or not v_item.product_active then
      raise exception 'A product in your cart is no longer available' using errcode = '22023';
    end if;
    -- Phase 1D: a size marked unavailable by the store cannot be ordered (checked inside the order transaction).
    if not v_item.variant_available then
      raise exception '% (%) is no longer available today. Remove it from your basket to continue.', v_item.product_name, v_item.variant_name using errcode = '22023';
    end if;

    -- Supplier-backed next-day fulfilment: checkout is not limited by warehouse stock.
    insert into public.inventory (variant_id, quantity_on_hand, quantity_reserved)
    values (v_item.variant_id, 0, 0)
    on conflict (variant_id) do nothing;

    v_subtotal := v_subtotal + round(v_item.price_paise * v_item.quantity)::integer;
    v_processed := v_processed + 1;
  end loop;

  if v_processed <> v_item_count then
    raise exception 'One or more cart items are invalid' using errcode = '22023';
  end if;

  if v_subtotal < v_zone.minimum_order_paise then
    raise exception 'Order is below the minimum order value' using errcode = '22023';
  end if;

  v_delivery_fee := case
    when v_zone.free_delivery_min_paise is not null
      and v_subtotal >= v_zone.free_delivery_min_paise then 0
    else v_zone.delivery_fee_paise
  end;
  v_total := v_subtotal + v_delivery_fee;

  v_order_id := gen_random_uuid();
  v_order_number := 'TM-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYYMMDD')
                    || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.orders (
    id, order_number, user_id, address_id, delivery_zone_id, delivery_slot_id,
    status, payment_status, payment_method, subtotal_paise, discount_paise,
    delivery_fee_paise, tax_paise, total_paise, delivery_address_snapshot, customer_note
  ) values (
    v_order_id, v_order_number, p_user_id, p_address_id, p_delivery_zone_id, p_delivery_slot_id,
    'pending', 'pending', p_payment_method, v_subtotal, 0,
    v_delivery_fee, 0, v_total,
    jsonb_build_object(
      'recipient_name', v_address.recipient_name,
      'phone', v_address.phone,
      'address_line1', v_address.address_line1,
      'address_line2', v_address.address_line2,
      'landmark', v_address.landmark,
      'area', v_address.area,
      'city', v_address.city,
      'state', v_address.state,
      'pincode', v_address.pincode
    ),
    p_customer_note
  );

  for v_item in
    select ci.variant_id, ci.quantity, pv.name as variant_name, pv.sku,
           pv.price_paise, p.name as product_name
    from public.cart_items ci
    join public.product_variants pv on pv.id = ci.variant_id
    join public.products p on p.id = pv.product_id
    where ci.cart_id = v_cart_id
    order by ci.variant_id
  loop
    insert into public.order_items (
      order_id, variant_id, product_name, variant_name, sku,
      quantity, unit_price_paise, line_total_paise
    ) values (
      v_order_id, v_item.variant_id, v_item.product_name, v_item.variant_name, v_item.sku,
      v_item.quantity, v_item.price_paise,
      round(v_item.price_paise * v_item.quantity)::integer
    );


  end loop;

  insert into public.payments (
    order_id, provider, amount_paise, currency, status
  ) values (
    v_order_id, p_payment_method, v_total, 'INR', 'created'
  );

  delete from public.cart_items where cart_id = v_cart_id;

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'subtotal_paise', v_subtotal,
    'delivery_fee_paise', v_delivery_fee,
    'total_paise', v_total,
    'currency', 'INR',
    'payment_method', p_payment_method,
    'status', 'pending'
  );
end;
$function$
;
