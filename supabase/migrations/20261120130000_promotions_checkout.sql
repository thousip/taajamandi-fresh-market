-- Overnight build (20 Nov 2026): Rs 1 / promotional deals and free-item campaigns, enforced at checkout on the
-- server; membership free deliveries applied at checkout. Everything is DISABLED until an admin creates and enables
-- a campaign (no default deals, gifts, limits or prices are invented).
--  * promo_deals: one size at a deal price inside a time window, with per-order unit, per-customer order and
--    optional total-unit limits, minimum order and eligibility (all / new customers / members).
--  * promo_free_items: a free size (zero-price order line) for a minimum subtotal, a qualifying size, or during a
--    campaign; per-customer and optional total limits; only if the free size is active and available.
--  * promo_redemptions: one row per promotion per order; cancelled/refunded orders stop counting toward limits.
--  * order_items.promo_type / promo_id: mark deal and free lines (nullable; existing rows unaffected).
--  * create_order_from_cart (6-arg core): generated from the post-1D definition with anchored edits: applies deals
--    and free items, stores orders.subtotal_paise = regular price and orders.discount_paise = deal savings, waives
--    the delivery fee for members with deliveries left (ledger row, row lock), returns discount/free items.
--  * create_order_from_cart_v2 (9 args): same as the 8-arg wrapper plus p_expected_total_paise; refuses the order
--    when the server total differs from what the customer saw, so a final price is never changed silently.
--    The existing 8-arg wrapper is unchanged (production create-order v5 keeps working).
-- Rollback: supabase/rollback/20261120130000_promotions_checkout_rollback.sql

create table if not exists public.promo_deals (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  label text check (label is null or char_length(label) <= 60),
  deal_price_paise integer not null check (deal_price_paise >= 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  eligibility text not null default 'all' check (eligibility in ('all', 'new_customers', 'members')),
  max_units_per_order integer not null default 1 check (max_units_per_order between 1 and 50),
  max_orders_per_customer integer not null default 1 check (max_orders_per_customer >= 1),
  max_total_units integer check (max_total_units is null or max_total_units >= 1),
  min_order_paise integer not null default 0 check (min_order_paise >= 0),
  is_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists promo_deals_variant_idx on public.promo_deals (variant_id) where is_enabled;
alter table public.promo_deals enable row level security;
create policy "public read live deals" on public.promo_deals for select to anon, authenticated
  using (is_enabled and now() >= starts_at and now() < ends_at);
create policy "admin manager manage deals" on public.promo_deals for all to authenticated
  using ((select private.has_any_role(array['admin','manager'])))
  with check ((select private.has_any_role(array['admin','manager'])));
create trigger promo_deals_audit after insert or update or delete on public.promo_deals
  for each row execute function private.audit_admin_change();

create table if not exists public.promo_free_items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  free_variant_id uuid not null references public.product_variants(id) on delete cascade,
  free_quantity numeric not null default 1 check (free_quantity > 0 and free_quantity <= 5),
  trigger_type text not null check (trigger_type in ('min_subtotal', 'with_variant', 'campaign')),
  min_subtotal_paise integer check (min_subtotal_paise is null or min_subtotal_paise >= 0),
  trigger_variant_id uuid references public.product_variants(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  eligibility text not null default 'all' check (eligibility in ('all', 'new_customers', 'members')),
  max_per_customer integer not null default 1 check (max_per_customer >= 1),
  max_total integer check (max_total is null or max_total >= 1),
  is_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (trigger_type <> 'min_subtotal' or min_subtotal_paise is not null),
  check (trigger_type <> 'with_variant' or trigger_variant_id is not null)
);
alter table public.promo_free_items enable row level security;
create policy "public read live free items" on public.promo_free_items for select to anon, authenticated
  using (is_enabled and now() >= starts_at and now() < ends_at);
create policy "admin manager manage free items" on public.promo_free_items for all to authenticated
  using ((select private.has_any_role(array['admin','manager'])))
  with check ((select private.has_any_role(array['admin','manager'])));
create trigger promo_free_items_audit after insert or update or delete on public.promo_free_items
  for each row execute function private.audit_admin_change();

create table if not exists public.promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  promo_type text not null check (promo_type in ('deal', 'free_item')),
  promo_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  quantity numeric not null check (quantity > 0),
  created_at timestamptz not null default now(),
  unique (promo_type, promo_id, order_id)
);
create index if not exists promo_redemptions_promo_idx on public.promo_redemptions (promo_type, promo_id, user_id);
alter table public.promo_redemptions enable row level security;
create policy "customer read own redemptions" on public.promo_redemptions for select to authenticated
  using (user_id = (select auth.uid()));
create policy "admin manager read redemptions" on public.promo_redemptions for select to authenticated
  using ((select private.has_any_role(array['admin','manager'])));
revoke all on public.promo_redemptions from anon;
revoke insert, update, delete, truncate on public.promo_redemptions from authenticated;

alter table public.order_items add column if not exists promo_type text check (promo_type is null or promo_type in ('deal', 'free_item'));
alter table public.order_items add column if not exists promo_id uuid;

-- Checkout core (see header). Generated from the post-1D definition with anchored edits.
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
  v_regular_subtotal integer := 0;
  v_discount integer := 0;
  v_deal record;
  v_free record;
  v_units integer;
  v_used integer;
  v_deal_lines jsonb := '[]'::jsonb;
  v_free_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_has_orders boolean;
  v_member record;
  v_member_used integer;
  v_fee_waived boolean := false;
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

  -- Overnight build: promotions are applied here, on the server only (the browser never sets a price).
  v_regular_subtotal := v_subtotal;
  select exists (select 1 from public.orders o where o.user_id = p_user_id and o.status not in ('cancelled','refunded'))
    into v_has_orders;

  -- Promotional (e.g. Rs 1) deals: only enabled deals inside their time window; rows locked so limits hold under
  -- concurrent checkouts.
  for v_item in
    select ci.variant_id, floor(ci.quantity)::integer as qty, pv.price_paise
    from public.cart_items ci join public.product_variants pv on pv.id = ci.variant_id
    where ci.cart_id = v_cart_id order by ci.variant_id
  loop
    select * into v_deal from public.promo_deals d
    where d.variant_id = v_item.variant_id and d.is_enabled and now() >= d.starts_at and now() < d.ends_at
    order by d.deal_price_paise, d.id limit 1
    for update;
    continue when not found;
    continue when v_deal.deal_price_paise >= v_item.price_paise;
    continue when v_deal.eligibility = 'new_customers' and v_has_orders;
    continue when v_deal.eligibility = 'members' and not private.has_active_membership(p_user_id);
    continue when v_regular_subtotal < v_deal.min_order_paise;
    select count(distinct r.order_id) into v_used
    from public.promo_redemptions r join public.orders o on o.id = r.order_id
    where r.promo_type = 'deal' and r.promo_id = v_deal.id and r.user_id = p_user_id and o.status not in ('cancelled','refunded');
    continue when v_used >= v_deal.max_orders_per_customer;
    v_units := least(v_item.qty, v_deal.max_units_per_order);
    if v_deal.max_total_units is not null then
      select coalesce(sum(r.quantity), 0)::integer into v_used
      from public.promo_redemptions r join public.orders o on o.id = r.order_id
      where r.promo_type = 'deal' and r.promo_id = v_deal.id and o.status not in ('cancelled','refunded');
      v_units := least(v_units, greatest(v_deal.max_total_units - v_used, 0));
    end if;
    continue when v_units <= 0;
    v_discount := v_discount + (v_item.price_paise - v_deal.deal_price_paise) * v_units;
    v_deal_lines := v_deal_lines || jsonb_build_array(jsonb_build_object(
      'variant_id', v_item.variant_id, 'deal_id', v_deal.id, 'units', v_units, 'price', v_deal.deal_price_paise));
  end loop;
  v_subtotal := v_regular_subtotal - v_discount;

  -- Free items / gifts: only enabled campaigns inside their window, with an available free size.
  for v_free in
    select fi.* from public.promo_free_items fi
    join public.product_variants fv on fv.id = fi.free_variant_id and fv.is_active and fv.is_available
    join public.products fp on fp.id = fv.product_id and fp.is_active
    where fi.is_enabled and now() >= fi.starts_at and now() < fi.ends_at
    order by fi.created_at, fi.id
    for update of fi
  loop
    continue when v_free.eligibility = 'new_customers' and v_has_orders;
    continue when v_free.eligibility = 'members' and not private.has_active_membership(p_user_id);
    continue when v_free.trigger_type = 'min_subtotal' and v_subtotal < v_free.min_subtotal_paise;
    continue when v_free.trigger_type = 'with_variant' and not exists (
      select 1 from public.cart_items ci where ci.cart_id = v_cart_id and ci.variant_id = v_free.trigger_variant_id);
    select count(distinct r.order_id) into v_used
    from public.promo_redemptions r join public.orders o on o.id = r.order_id
    where r.promo_type = 'free_item' and r.promo_id = v_free.id and r.user_id = p_user_id and o.status not in ('cancelled','refunded');
    continue when v_used >= v_free.max_per_customer;
    if v_free.max_total is not null then
      select count(distinct r.order_id) into v_used
      from public.promo_redemptions r join public.orders o on o.id = r.order_id
      where r.promo_type = 'free_item' and r.promo_id = v_free.id and o.status not in ('cancelled','refunded');
      continue when v_used >= v_free.max_total;
    end if;
    v_free_lines := v_free_lines || jsonb_build_array(jsonb_build_object(
      'free_id', v_free.id, 'variant_id', v_free.free_variant_id, 'quantity', v_free.free_quantity));
  end loop;

  if v_subtotal < v_zone.minimum_order_paise then
    raise exception 'Order is below the minimum order value' using errcode = '22023';
  end if;

  v_delivery_fee := case
    when v_zone.free_delivery_min_paise is not null
      and v_subtotal >= v_zone.free_delivery_min_paise then 0
    else v_zone.delivery_fee_paise
  end;
  -- Membership: free delivery while the member has deliveries left this period (row lock = no double use).
  if v_delivery_fee > 0 then
    select m.* into v_member from public.memberships m
    where m.user_id = p_user_id and m.status = 'active'
      and now() >= m.current_period_start and now() < m.current_period_end
    for update;
    if found then
      select coalesce(sum(case when l.entry = 'consume' then 1 else -1 end), 0)::integer into v_member_used
      from public.membership_ledger l
      where l.membership_id = v_member.id and l.period_start = v_member.current_period_start;
      if v_member_used < (select p.free_deliveries from public.membership_plans p where p.code = v_member.plan_code) then
        v_delivery_fee := 0;
        v_fee_waived := true;
      end if;
    end if;
  end if;
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
    'pending', 'pending', p_payment_method, v_regular_subtotal, v_discount,
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
    v_line := (select x from jsonb_array_elements(v_deal_lines) x where (x ->> 'variant_id')::uuid = v_item.variant_id limit 1);
    v_units := coalesce((v_line ->> 'units')::integer, 0);
    if v_units > 0 then
      insert into public.order_items (
        order_id, variant_id, product_name, variant_name, sku,
        quantity, unit_price_paise, line_total_paise, promo_type, promo_id
      ) values (
        v_order_id, v_item.variant_id, v_item.product_name, v_item.variant_name, v_item.sku,
        v_units, (v_line ->> 'price')::integer, (v_line ->> 'price')::integer * v_units, 'deal', (v_line ->> 'deal_id')::uuid
      );
      insert into public.promo_redemptions (promo_type, promo_id, user_id, order_id, quantity)
      values ('deal', (v_line ->> 'deal_id')::uuid, p_user_id, v_order_id, v_units);
    end if;
    if v_item.quantity - v_units > 0 then
      insert into public.order_items (
        order_id, variant_id, product_name, variant_name, sku,
        quantity, unit_price_paise, line_total_paise
      ) values (
        v_order_id, v_item.variant_id, v_item.product_name, v_item.variant_name, v_item.sku,
        v_item.quantity - v_units, v_item.price_paise,
        round(v_item.price_paise * (v_item.quantity - v_units))::integer
      );
    end if;
  end loop;

  for v_line in select x from jsonb_array_elements(v_free_lines) x
  loop
    insert into public.order_items (
      order_id, variant_id, product_name, variant_name, sku,
      quantity, unit_price_paise, line_total_paise, promo_type, promo_id
    )
    select v_order_id, fv.id, fp.name, fv.name, fv.sku, (v_line ->> 'quantity')::numeric, 0, 0, 'free_item', (v_line ->> 'free_id')::uuid
    from public.product_variants fv join public.products fp on fp.id = fv.product_id
    where fv.id = (v_line ->> 'variant_id')::uuid;
    insert into public.promo_redemptions (promo_type, promo_id, user_id, order_id, quantity)
    values ('free_item', (v_line ->> 'free_id')::uuid, p_user_id, v_order_id, (v_line ->> 'quantity')::numeric);
  end loop;

  if v_fee_waived then
    insert into public.membership_ledger (membership_id, order_id, entry, period_start)
    values (v_member.id, v_order_id, 'consume', v_member.current_period_start);
  end if;

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
    'regular_subtotal_paise', v_regular_subtotal,
    'discount_paise', v_discount,
    'delivery_fee_waived', v_fee_waived,
    'free_items', v_free_lines,
    'currency', 'INR',
    'payment_method', p_payment_method,
    'status', 'pending'
  );
end;
$function$
;

create or replace function public.create_order_from_cart_v2(
  p_user_id uuid, p_address_id uuid, p_delivery_zone_id uuid, p_delivery_slot_id uuid, p_payment_method text,
  p_customer_note text, p_requested_delivery_date date, p_delivery_type text, p_expected_total_paise integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_result jsonb;
begin
  v_result := public.create_order_from_cart(p_user_id, p_address_id, p_delivery_zone_id, p_delivery_slot_id,
                                            p_payment_method, p_customer_note, p_requested_delivery_date, p_delivery_type);
  if p_expected_total_paise is not null and (v_result ->> 'total_paise')::integer <> p_expected_total_paise then
    raise exception 'Prices or offers changed while you were checking out: the total is now Rs %. Please review your basket and try again.',
      to_char((v_result ->> 'total_paise')::numeric / 100, 'FM999999990.00') using errcode = '22023';
  end if;
  return v_result;
end;
$function$;
revoke all on function public.create_order_from_cart_v2(uuid, uuid, uuid, uuid, text, text, date, text, integer) from public, anon, authenticated;
grant execute on function public.create_order_from_cart_v2(uuid, uuid, uuid, uuid, text, text, date, text, integer) to service_role;
