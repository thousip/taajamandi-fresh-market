-- Rollback for 20261121130000_banner_cta.sql (owner approval required). Roll back the website first
-- (the release-2 storefront reads promo_banners.cta_label).
-- Data guard: refuses while any banner has a button label (clear the labels in Admin first; nothing is deleted here).
do $guard$
declare n bigint;
begin
  select count(*) into n from public.promo_banners where cta_label is not null;
  if n > 0 then raise exception 'Rollback refused: % banner(s) have a button label. Clear them in Admin first.', n; end if;
end
$guard$;
alter table public.promo_banners drop column if exists cta_label;
