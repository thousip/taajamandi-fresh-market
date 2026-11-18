-- Server-side limit of 50 packs per basket line (matches MAX_LINE_QTY in index.html).
-- Background: a storefront bug doubled signed-in carts on every page load, leaving a production
-- cart with Brinjal 250 g x 303,872. The storefront fix stops the doubling; this makes the database
-- refuse such quantities even if a client misbehaves. Bulk buying goes through bargain requests.

-- 1. New and updated cart lines must be 1..50. NOT VALID: existing oversized rows are left untouched
--    (no customer data is rewritten here); the fixed storefront caps them to 50 when the customer
--    next opens the site, and any update of such a row must bring it within the limit.
alter table public.cart_items drop constraint if exists cart_items_quantity_max;
alter table public.cart_items
  add constraint cart_items_quantity_max check (quantity <= 50) not valid;

-- 2. Checkout refuses any basket line above 50, so an old oversized row can never become an order.
--    Identical to 20261118130200_checkout_slot_capacity.sql apart from the quantity check.
create or replace function public.create_order_from_cart(
  p_user_id uuid, p_address_id uuid, p_delivery_zone_id uuid, p_delivery_slot_id uuid,
  p_payment_method text, p_customer_note text, p_requested_delivery_date date, p_delivery_type text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_result jsonb;
  v_order_id uuid;
  v_slot public.delivery_slots%rowtype;
  v_taken integer;
  v_now_ist timestamp := now() at time zone 'Asia/Kolkata';
begin
  if p_requested_delivery_date is null or p_delivery_type not in ('same_day','advance') then
    raise exception 'A valid delivery type and date are required' using errcode = '22023';
  end if;

  if exists (select 1 from public.cart_items ci join public.carts c on c.id = ci.cart_id
             where c.user_id = p_user_id and ci.quantity > 50) then
    raise exception 'A basket item is above the limit of 50; reduce the quantity or send a bargain request for bulk orders'
      using errcode = '22023';
  end if;

  if p_delivery_slot_id is not null then
    select * into v_slot from public.delivery_slots
    where id = p_delivery_slot_id and is_active = true
      and (zone_id is null or zone_id = p_delivery_zone_id)
    for update;
    if not found then
      raise exception 'Selected delivery slot is unavailable' using errcode = '22023';
    end if;
    if p_requested_delivery_date = v_now_ist::date and v_slot.ends_at <= v_now_ist::time then
      raise exception 'This delivery slot has already ended today; choose a later slot or date' using errcode = '22023';
    end if;
    select count(*) into v_taken from public.orders
    where delivery_slot_id = p_delivery_slot_id
      and delivery_date = p_requested_delivery_date
      and status not in ('cancelled','refunded');
    if v_taken >= v_slot.max_orders then
      raise exception 'Selected delivery slot is full for that date; choose another slot or date' using errcode = '22023';
    end if;
  end if;

  v_result := public.create_order_from_cart(p_user_id, p_address_id, p_delivery_zone_id,
                                            p_delivery_slot_id, p_payment_method, p_customer_note);
  v_order_id := (v_result->>'order_id')::uuid;

  update public.orders
    set delivery_date = p_requested_delivery_date, delivery_type = p_delivery_type
  where id = v_order_id;

  return v_result || jsonb_build_object('delivery_date', p_requested_delivery_date, 'delivery_type', p_delivery_type);
end;
$function$;

-- create or replace keeps existing grants; restate them so this file is safe on its own.
revoke all on function public.create_order_from_cart(uuid, uuid, uuid, uuid, text, text, date, text) from public, anon, authenticated;
grant execute on function public.create_order_from_cart(uuid, uuid, uuid, uuid, text, text, date, text) to service_role;
