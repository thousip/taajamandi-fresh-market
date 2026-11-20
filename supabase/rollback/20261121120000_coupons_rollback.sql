-- Rollback for 20261121120000_coupons.sql (owner approval required). Deploy the previous create-order first.
-- Data guard: refuses while any coupon or redemption exists (switch coupons off instead of deleting them).
do $guard$
declare n bigint;
begin
  select (select count(*) from public.coupons) + (select count(*) from public.coupon_redemptions) into n;
  if n > 0 then raise exception 'Rollback refused: % coupon / redemption row(s) exist. Disable the coupons instead.', n; end if;
end
$guard$;
drop function if exists public.create_order_from_cart_v3(uuid, uuid, uuid, uuid, text, text, date, text, integer, text);
drop function if exists public.check_coupon(text);
drop function if exists private.coupon_evaluate(public.coupons, uuid, integer, integer, boolean, uuid);
drop trigger if exists coupons_audit on public.coupons;
drop index if exists public.coupon_redemptions_coupon_user_idx;
drop index if exists public.coupon_redemptions_one_per_order;
alter table public.coupons drop constraint if exists coupons_window;
alter table public.coupons drop constraint if exists coupons_limits_positive;
alter table public.coupons drop constraint if exists coupons_min_order_nonnegative;
alter table public.coupons drop constraint if exists coupons_max_discount_positive;
alter table public.coupons drop constraint if exists coupons_percentage_range;
alter table public.coupons drop constraint if exists coupons_code_format;
alter table public.coupons drop column if exists eligible_category_ids;
alter table public.coupons drop column if exists eligible_product_ids;
alter table public.coupons drop column if exists allow_with_offers;
alter table public.coupons drop column if exists first_order_only;
alter table public.coupons alter column is_active set default true;
