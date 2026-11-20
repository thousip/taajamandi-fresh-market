-- Rollback for 20261120110000_banners_support_favourites.sql (owner approval required; refuses to run while the new tables hold data).
-- Data guard: refuses to run while any of these tables holds rows, so no data is ever deleted by a rollback.
-- If it refuses, leave the tables in place and switch the feature off instead (disable the plan, deal, banner...).
do $guard$
declare t text; n bigint;
begin
  foreach t in array array['public.favourites', 'public.support_tickets', 'public.promo_banners'] loop
    if to_regclass(t) is not null then
      execute format('select count(*) from %s', t) into n;
      if n > 0 then
        raise exception 'Rollback refused: % holds % row(s). Switch the feature off instead of deleting data.', t, n;
      end if;
    end if;
  end loop;
end
$guard$;

drop table if exists public.favourites;
drop table if exists public.support_tickets;
drop table if exists public.promo_banners;
-- private.audit_admin_change() is also used by later migrations; drop it only after rolling those back.
-- drop function if exists private.audit_admin_change();
