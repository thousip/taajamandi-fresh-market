-- Launch build (21 Nov 2026): optional call-to-action label on promotional banners (e.g. "Shop fruit").
-- Additive only; existing banners keep working (null = no button). Rollback:
--   alter table public.promo_banners drop column if exists cta_label;
alter table public.promo_banners add column if not exists cta_label text
  check (cta_label is null or char_length(btrim(cta_label)) between 1 and 24);
