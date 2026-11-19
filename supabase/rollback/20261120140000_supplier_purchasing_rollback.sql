-- Rollback for 20261120140000_supplier_purchasing.sql (owner approval required; deletes supplier product and price
-- history data; the original suppliers / purchase_orders / purchase_order_items tables are kept).
drop function if exists public.admin_receive_purchase_order(uuid, uuid, jsonb);
drop trigger if exists purchase_orders_audit on public.purchase_orders;
drop trigger if exists suppliers_audit on public.suppliers;
drop trigger if exists supplier_products_price_history on public.supplier_products;
drop function if exists private.record_supplier_price();
drop table if exists public.supplier_price_history;
drop table if exists public.supplier_products;
