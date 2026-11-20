-- Rollback for 20261120140000_supplier_purchasing.sql (owner approval required; refuses to run while the new tables hold data).
-- Data guard: refuses to run while any of these tables holds rows, so no data is ever deleted by a rollback.
-- If it refuses, leave the tables in place and switch the feature off instead (disable the plan, deal, banner...).
do $guard$
declare t text; n bigint;
begin
  foreach t in array array['public.supplier_products', 'public.supplier_price_history'] loop
    if to_regclass(t) is not null then
      execute format('select count(*) from %s', t) into n;
      if n > 0 then
        raise exception 'Rollback refused: % holds % row(s). Switch the feature off instead of deleting data.', t, n;
      end if;
    end if;
  end loop;
end
$guard$;

drop function if exists public.admin_receive_purchase_order(uuid, uuid, jsonb);
drop trigger if exists purchase_orders_audit on public.purchase_orders;
drop trigger if exists suppliers_audit on public.suppliers;
drop trigger if exists supplier_products_price_history on public.supplier_products;
drop function if exists private.record_supplier_price();
drop table if exists public.supplier_price_history;
drop table if exists public.supplier_products;
