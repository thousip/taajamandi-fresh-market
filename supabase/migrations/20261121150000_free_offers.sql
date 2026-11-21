-- Optional free-item offers for ALL customers (21 Nov 2026). Prepaid (verified online payment) orders only.
--  * Admin manages offers (free_offers): product size, quantity, title, description, image, enabled. New offers start
--    disabled. Customers see only enabled offers whose size is active and available.
--  * Nothing is added automatically. A signed-in customer may choose ONE offer for their basket
--    (carts.free_offer_id, set through set_cart_free_offer, which validates it) and remove or replace it.
--  * Checkout (create_order_from_cart_v3) re-validates the chosen offer on the server, refuses Cash on Delivery while
--    one is chosen, and adds it as a single Rs 0 order line (promo_type 'free_item', promo_id = offer id). Totals,
--    catalogue prices and coupon calculations are unchanged (coupons only count lines without a promo_type).
--  * Online orders are packed only after a verified payment (unpaid online orders cannot be confirmed), so a failed
--    or abandoned payment never produces a fulfilled order.
-- Rollback: supabase/rollback/20261121150000_free_offers_rollback.sql

create table if not exists public.free_offers (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 60),
  description text check (description is null or char_length(description) <= 160),
  variant_id uuid not null references public.product_variants(id),
  quantity integer not null default 1 check (quantity between 1 and 10),
  image_path text check (image_path is null or char_length(image_path) between 1 and 300),
  is_enabled boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.free_offers enable row level security;
drop policy if exists "public read enabled free offers" on public.free_offers;
create policy "public read enabled free offers" on public.free_offers for select to anon, authenticated using (is_enabled);
drop policy if exists "admin manage free offers" on public.free_offers;
create policy "admin manage free offers" on public.free_offers for all to authenticated
  using ((select private.has_any_role(array['admin'::text, 'manager'::text])))
  with check ((select private.has_any_role(array['admin'::text, 'manager'::text])));
drop trigger if exists free_offers_audit on public.free_offers;
create trigger free_offers_audit after insert or update or delete on public.free_offers
  for each row execute function private.audit_admin_change();

-- The customer's chosen offer (at most one per basket, therefore at most one per order).
alter table public.carts add column if not exists free_offer_id uuid references public.free_offers(id) on delete set null;

-- Choose (or, with null, remove) the free offer for the signed-in customer's own basket. Validated on the server.
create or replace function public.set_cart_free_offer(p_offer_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_user uuid := auth.uid(); v_offer record;
begin
  if v_user is null then raise exception 'Sign in to choose a free item' using errcode = '42501'; end if;
  if p_offer_id is not null then
    select o.id, o.title, o.quantity, pv.name size, p.name product into v_offer
    from public.free_offers o join public.product_variants pv on pv.id = o.variant_id join public.products p on p.id = pv.product_id
    where o.id = p_offer_id and o.is_enabled and pv.is_active and pv.is_available and p.is_active;
    if not found then raise exception 'This free item is no longer available' using errcode = '22023'; end if;
  end if;
  insert into public.carts (user_id) values (v_user) on conflict (user_id) do nothing;
  update public.carts set free_offer_id = p_offer_id, updated_at = now() where user_id = v_user;
  if p_offer_id is null then return jsonb_build_object('free_offer_id', null); end if;
  return jsonb_build_object('free_offer_id', v_offer.id, 'title', v_offer.title, 'product', v_offer.product, 'size', v_offer.size, 'quantity', v_offer.quantity);
end;
$function$;
revoke all on function public.set_cart_free_offer(uuid) from public, anon;
grant execute on function public.set_cart_free_offer(uuid) to authenticated;

-- Checkout: create_order_from_cart_v3 as in 20261121120000_coupons.sql, plus the chosen free offer
-- (validated first; Cash on Delivery refused while one is chosen; added as one Rs 0 line before the return).
create or replace function public.create_order_from_cart_v3(
  p_user_id uuid, p_address_id uuid, p_delivery_zone_id uuid, p_delivery_slot_id uuid, p_payment_method text,
  p_customer_note text, p_requested_delivery_date date, p_delivery_type text, p_expected_total_paise integer,
  p_coupon_code text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_result jsonb; v_code text := upper(btrim(coalesce(p_coupon_code, ''))); c public.coupons%rowtype;
  v_order public.orders%rowtype; v_eligible integer; v_offer boolean; r record; v_goods integer;
  v_free_offer_id uuid; v_fo record;
begin
  select ca.free_offer_id into v_free_offer_id from public.carts ca where ca.user_id = p_user_id for update;
  if v_free_offer_id is not null then
    if p_payment_method <> 'razorpay' then
      raise exception 'Cash on Delivery is not available with a free item. Remove the free item or pay online.' using errcode = '22023';
    end if;
    select o.id, o.quantity, pv.id variant_id, pv.name variant_name, pv.sku, p.name product_name into v_fo
    from public.free_offers o join public.product_variants pv on pv.id = o.variant_id join public.products p on p.id = pv.product_id
    where o.id = v_free_offer_id and o.is_enabled and pv.is_active and pv.is_available and p.is_active
    for share of o;
    if not found then
      raise exception 'The free item you chose is no longer available. Remove it or choose another to continue.' using errcode = '22023';
    end if;
  end if;
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
  if v_free_offer_id is not null then
    insert into public.order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_paise,
                                    line_total_paise, promo_type, promo_id)
    values ((v_result ->> 'order_id')::uuid, v_fo.variant_id, v_fo.product_name, v_fo.variant_name, v_fo.sku,
            v_fo.quantity, 0, 0, 'free_item', v_fo.id);
    update public.carts set free_offer_id = null, updated_at = now() where user_id = p_user_id;
    v_result := v_result || jsonb_build_object('free_offer', jsonb_build_object('id', v_fo.id, 'product', v_fo.product_name,
      'size', v_fo.variant_name, 'quantity', v_fo.quantity));
  end if;
  return v_result;
end;
$function$;
revoke all on function public.create_order_from_cart_v3(uuid, uuid, uuid, uuid, text, text, date, text, integer, text) from public, anon, authenticated;
grant execute on function public.create_order_from_cart_v3(uuid, uuid, uuid, uuid, text, text, date, text, integer, text) to service_role;
