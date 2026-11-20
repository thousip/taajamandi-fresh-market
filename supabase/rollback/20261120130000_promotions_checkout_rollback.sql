-- Rollback for 20261120130000_promotions_checkout.sql (owner approval required; refuses to run while the new tables hold data).
-- Restores the post-1D checkout definition exactly, then removes the promotion objects.
-- Data guard: refuses to run while any of these tables holds rows, so no data is ever deleted by a rollback.
-- If it refuses, leave the tables in place and switch the feature off instead (disable the plan, deal, banner...).
do $guard$
declare t text; n bigint;
begin
  foreach t in array array['public.promo_redemptions', 'public.promo_deals', 'public.promo_free_items'] loop
    if to_regclass(t) is not null then
      execute format('select count(*) from %s', t) into n;
      if n > 0 then
        raise exception 'Rollback refused: % holds % row(s). Switch the feature off instead of deleting data.', t, n;
      end if;
    end if;
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'order_items' and column_name = 'promo_type') then
    execute 'select count(*) from public.order_items where promo_type is not null' into n;
    if n > 0 then
      raise exception 'Rollback refused: % order line(s) were sold under a promotion. Switch promotions off instead.', n;
    end if;
  end if;
end
$guard$;

drop function if exists public.create_order_from_cart_v2(uuid, uuid, uuid, uuid, text, text, date, text, integer);
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
drop table if exists public.promo_redemptions;
drop table if exists public.promo_free_items;
drop table if exists public.promo_deals;
alter table public.order_items drop column if exists promo_id;
alter table public.order_items drop column if exists promo_type;
