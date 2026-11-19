-- Rollback for 20261120110000_banners_support_favourites.sql (owner approval required; deletes banner, ticket
-- and favourite data).
drop table if exists public.favourites;
drop table if exists public.support_tickets;
drop table if exists public.promo_banners;
-- private.audit_admin_change() is also used by later migrations; drop it only after rolling those back.
-- drop function if exists private.audit_admin_change();
