-- Launch build (21 Nov 2026): coupons, validated and applied ONLY on the server, on the existing coupons /
-- coupon_redemptions tables (both empty on QA and production when this was written).
--  * New coupons start DISABLED (is_active default false). No coupon is created here.
--  * One coupon per order (unique redemption per order). By default a coupon cannot be combined with ₹1 deals
--    (allow_with_offers = false); the admin can allow it per coupon.
--  * Limits (total, per customer) count only redemptions on orders that are not cancelled/refunded, so a cancelled
--    order gives its use back. The coupon row is locked while an order is placed, so concurrent checkouts cannot
--    exceed a limit.
--  * The discount never exceeds the eligible goods value, so totals can never go negative; delivery is not
--    discounted. Validation failures abort the whole order (the basket is kept).
--  * create_order_from_cart_v3 = v2 + coupon; v2 and the 8-argument wrapper are unchanged.
-- Rollback: supabase/rollback/20261121120000_coupons_rollback.sql

alter table public.coupons alter column is_active set default false;
alter table public.coupons add column if not exists first_order_only boolean not null default false;
alter table public.coupons add column if not exists allow_with_offers boolean not null default false;
alter table public.coupons add column if not exists eligible_product_ids uuid[];
alter table public.coupons add column if not exists eligible_category_ids uuid[];
alter table public.coupons add constraint coupons_code_format check (code ~ '^[A-Z0-9-]{3,30}$');
alter table public.coupons add constraint coupons_percentage_range check (discount_type <> 'percentage' or discount_value between 1 and 100);
alter table public.coupons add constraint coupons_max_discount_positive check (max_discount_paise is null or max_discount_paise > 0);
alter table public.coupons add constraint coupons_min_order_nonnegative check (min_order_paise >= 0);
alter table public.coupons add constraint coupons_limits_positive check ((usage_limit is null or usage_limit > 0) and (per_user_limit is null or per_user_limit > 0));
alter table public.coupons add constraint coupons_window check (starts_at is null or expires_at is null or expires_at > starts_at);
create unique index if not exists coupon_redemptions_one_per_order on public.coupon_redemptions (order_id) where order_id is not null;
create index if not exists coupon_redemptions_coupon_user_idx on public.coupon_redemptions (coupon_id, user_id);
drop trigger if exists coupons_audit on public.coupons;
create trigger coupons_audit after insert or update or delete on public.coupons
  for each row execute function private.audit_admin_change();

-- Rules shared by the preview and the order. p_payable = goods value after ₹1-deal savings; p_eligible = regular-price
-- lines this coupon applies to. Returns the discount or the customer-facing reason it cannot be used.
create or replace function private.coupon_evaluate(c public.coupons, p_user uuid, p_payable integer, p_eligible integer,
  p_has_offer boolean, p_exclude_order uuid, out discount integer, out reason text)
language plpgsql stable security definer set search_path to '' as $function$
declare v_used integer;
begin
  discount := 0; reason := null;
  if not c.is_active then reason := 'This coupon is not active.'; return; end if;
  if c.starts_at is not null and now() < c.starts_at then reason := 'This coupon is not active yet.'; return; end if;
  if c.expires_at is not null and now() >= c.expires_at then reason := 'This coupon has expired.'; return; end if;
  if p_has_offer and not c.allow_with_offers then reason := 'This coupon cannot be combined with today''s offers.'; return; end if;
  if p_payable < c.min_order_paise then
    reason := 'Add items worth Rs ' || to_char((c.min_order_paise - p_payable)::numeric / 100, 'FM999999990.00') || ' more to use this coupon.'; return;
  end if;
  if c.first_order_only and exists (select 1 from public.orders o where o.user_id = p_user and o.status not in ('cancelled','refunded')
                                     and (p_exclude_order is null or o.id <> p_exclude_order)) then
    reason := 'This coupon is for your first order only.'; return;
  end if;
  if c.usage_limit is not null then
    select count(*) into v_used from public.coupon_redemptions r join public.orders o on o.id = r.order_id
    where r.coupon_id = c.id and o.status not in ('cancelled','refunded') and (p_exclude_order is null or o.id <> p_exclude_order);
    if v_used >= c.usage_limit then reason := 'This coupon has been fully used.'; return; end if;
  end if;
  if c.per_user_limit is not null then
    select count(*) into v_used from public.coupon_redemptions r join public.orders o on o.id = r.order_id
    where r.coupon_id = c.id and r.user_id = p_user and o.status not in ('cancelled','refunded') and (p_exclude_order is null or o.id <> p_exclude_order);
    if v_used >= c.per_user_limit then reason := 'You have already used this coupon.'; return; end if;
  end if;
  if p_eligible <= 0 then reason := 'This coupon does not apply to the items in your basket.'; return; end if;
  if c.discount_type = 'flat' then discount := least(c.discount_value, p_eligible);
  else discount := floor(p_eligible::numeric * c.discount_value / 100)::integer; end if;
  if c.max_discount_paise is not null then discount := least(discount, c.max_discount_paise); end if;
  discount := greatest(least(discount, p_payable), 0);
  if discount <= 0 then reason := 'This coupon does not apply to the items in your basket.'; end if;
end;
$function$;
revoke all on function private.coupon_evaluate(public.coupons, uuid, integer, integer, boolean, uuid) from public, anon, authenticated;

-- Preview for the signed-in customer's own basket (auth.uid()). Informational only: the order applies the coupon
-- again on the server, and create_order_from_cart_v3 refuses the order if the total differs from what was shown.
create or replace function public.check_coupon(p_code text)
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare
  v_user uuid := auth.uid(); v_code text := upper(btrim(coalesce(p_code, ''))); c public.coupons%rowtype;
  v_payable integer; v_eligible integer; v_offer boolean; r record;
begin
  if v_user is null then raise exception 'Sign in to use a coupon' using errcode = '42501'; end if;
  if v_code !~ '^[A-Z0-9-]{3,30}$' then return jsonb_build_object('valid', false, 'message', 'Enter a valid coupon code.'); end if;
  select * into c from public.coupons where code = v_code;
  if not found then return jsonb_build_object('valid', false, 'message', 'This coupon code is not valid.'); end if;
  select coalesce(sum((pv.price_paise * ci.quantity)::integer), 0),
         coalesce(sum((pv.price_paise * ci.quantity)::integer) filter (where
           (c.eligible_product_ids is null or p.id = any(c.eligible_product_ids)) and
           (c.eligible_category_ids is null or p.category_id = any(c.eligible_category_ids))), 0),
         coalesce(bool_or(exists (select 1 from public.promo_deals d where d.variant_id = ci.variant_id and d.is_enabled
                                  and now() >= d.starts_at and now() < d.ends_at)), false)
    into v_payable, v_eligible, v_offer
  from public.cart_items ci join public.carts ca on ca.id = ci.cart_id
  join public.product_variants pv on pv.id = ci.variant_id join public.products p on p.id = pv.product_id
  where ca.user_id = v_user and ci.quantity between 1 and 50;
  select * into r from private.coupon_evaluate(c, v_user, v_payable, v_eligible, v_offer, null);
  if r.reason is not null then return jsonb_build_object('valid', false, 'code', v_code, 'message', r.reason); end if;
  return jsonb_build_object('valid', true, 'code', v_code, 'discount_paise', r.discount, 'description', c.description,
                            'message', 'Coupon applied: you save Rs ' || to_char(r.discount::numeric / 100, 'FM999999990.00') || '.');
end;
$function$;
revoke all on function public.check_coupon(text) from public, anon;
grant execute on function public.check_coupon(text) to authenticated;

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
