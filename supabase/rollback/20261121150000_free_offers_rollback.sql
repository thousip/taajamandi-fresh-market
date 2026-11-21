-- Rollback for 20261121150000_free_offers.sql (owner approval required). Roll back the website first.
-- Data guard: refuses while any order line refers to a free offer (that history would lose its offer record).
do $guard$
declare n bigint;
begin
  if to_regclass('public.free_offers') is not null then
    select count(*) into n from public.order_items oi join public.free_offers o on o.id = oi.promo_id where oi.promo_type = 'free_item';
    if n > 0 then raise exception 'Rollback refused: % order line(s) refer to free offers. Disable the offers instead.', n; end if;
  end if;
end
$guard$;
drop function if exists public.set_cart_free_offer(uuid);
alter table public.carts drop column if exists free_offer_id;
drop table if exists public.free_offers;

-- create_order_from_cart_v3 exactly as in 20261121120000_coupons.sql:
-- Checkout with an optional coupon (service_role only; called by create-order). Same as v2 when no coupon is given.
create or replace function public.create_order_from_cart_v3(
  p_user_id uuid, p_address_id uuid, p_delivery_zone_id uuid, p_delivery_slot_id uuid, p_payment_method text,
  p_customer_note text, p_requested_delivery_date date, p_delivery_type text, p_expected_total_paise integer,
  p_coupon_code text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_result jsonb; v_code text := upper(btrim(coalesce(p_coupon_code, ''))); c public.coupons%rowtype;
  v_order public.orders%rowtype; v_eligible integer; v_offer boolean; r record; v_goods integer;
begin
  if v_code <> '' then
    -- Lock first: concurrent checkouts with the same coupon run one at a time, so limits cannot be exceeded.
    select * into c from public.coupons where code = v_code for update;
    if not found then raise exception 'This coupon code is not valid.' using errcode = '22023'; end if;
  end if;
  v_result := public.create_order_from_cart(p_user_id, p_address_id, p_delivery_zone_id, p_delivery_slot_id,
                                            p_payment_method, p_customer_note, p_requested_delivery_date, p_delivery_type);
  if v_code <> '' then
    select * into v_order from public.orders where id = (v_result ->> 'order_id')::uuid for update;
    -- Eligible value = regular-price lines only (₹1-deal units and free gifts are never discounted again).
    select coalesce(sum(oi.line_total_paise) filter (where
             (c.eligible_product_ids is null or p.id = any(c.eligible_product_ids)) and
             (c.eligible_category_ids is null or p.category_id = any(c.eligible_category_ids))), 0)
      into v_eligible
    from public.order_items oi left join public.product_variants pv on pv.id = oi.variant_id
    left join public.products p on p.id = pv.product_id
    where oi.order_id = v_order.id and oi.promo_type is null;
    v_offer := exists (select 1 from public.order_items where order_id = v_order.id and promo_type = 'deal');
    v_goods := v_order.subtotal_paise - v_order.discount_paise;
    select * into r from private.coupon_evaluate(c, p_user_id, v_goods, v_eligible, v_offer, v_order.id);
    if r.reason is not null then raise exception 'Coupon %: %', v_code, r.reason using errcode = '22023'; end if;
    update public.orders set discount_paise = discount_paise + r.discount, total_paise = total_paise - r.discount,
      coupon_code = v_code, updated_at = now() where id = v_order.id;
    update public.payments set amount_paise = amount_paise - r.discount, updated_at = now() where order_id = v_order.id;
    insert into public.coupon_redemptions (coupon_id, user_id, order_id, discount_paise) values (c.id, p_user_id, v_order.id, r.discount);
    v_result := v_result || jsonb_build_object('coupon_code', v_code, 'coupon_discount_paise', r.discount,
      'discount_paise', coalesce((v_result ->> 'discount_paise')::integer, 0) + r.discount,
      'total_paise', (v_result ->> 'total_paise')::integer - r.discount);
  end if;
  if p_expected_total_paise is not null and (v_result ->> 'total_paise')::integer <> p_expected_total_paise then
    raise exception 'Prices or offers changed while you were checking out: the total is now Rs %. Please review your basket and try again.',
      to_char((v_result ->> 'total_paise')::numeric / 100, 'FM999999990.00') using errcode = '22023';
  end if;
  return v_result;
end;
$function$;
revoke all on function public.create_order_from_cart_v3(uuid, uuid, uuid, uuid, text, text, date, text, integer, text) from public, anon, authenticated;
grant execute on function public.create_order_from_cart_v3(uuid, uuid, uuid, uuid, text, text, date, text, integer, text) to service_role;
