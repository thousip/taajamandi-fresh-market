-- Overnight build (20 Nov 2026): supplier management foundations on the EXISTING suppliers, purchase_orders and
-- purchase_order_items tables (unchanged). Adds which sizes each supplier supplies, a supplier price history, audit
-- triggers, and one audited server function to receive goods (partial receiving supported) that updates stock.
-- Supplier data stays admin/manager-only (RLS); nothing reaches customers. No supplier records are created.
-- Rollback: supabase/rollback/20261120140000_supplier_purchasing_rollback.sql

create table if not exists public.supplier_products (
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  supplier_sku text check (supplier_sku is null or char_length(supplier_sku) <= 60),
  last_price_paise integer check (last_price_paise is null or last_price_paise >= 0),
  updated_at timestamptz not null default now(),
  primary key (supplier_id, variant_id)
);
alter table public.supplier_products enable row level security;
create policy "admin manager manage supplier products" on public.supplier_products for all to authenticated
  using ((select private.has_any_role(array['admin','manager'])))
  with check ((select private.has_any_role(array['admin','manager'])));
revoke all on public.supplier_products from anon;

create table if not exists public.supplier_price_history (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  price_paise integer not null check (price_paise >= 0),
  source text not null check (source in ('manual', 'purchase_receipt')),
  recorded_by uuid,
  recorded_at timestamptz not null default now()
);
create index if not exists supplier_price_history_idx on public.supplier_price_history (supplier_id, variant_id, recorded_at desc);
alter table public.supplier_price_history enable row level security;
create policy "admin manager read supplier prices" on public.supplier_price_history for select to authenticated
  using ((select private.has_any_role(array['admin','manager'])));
revoke all on public.supplier_price_history from anon;
revoke insert, update, delete, truncate on public.supplier_price_history from authenticated;

-- Manual price edits on supplier_products are recorded in the history automatically.
create or replace function private.record_supplier_price()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if new.last_price_paise is not null and (tg_op = 'INSERT' or new.last_price_paise is distinct from old.last_price_paise) then
    insert into public.supplier_price_history (supplier_id, variant_id, price_paise, source, recorded_by)
    values (new.supplier_id, new.variant_id, new.last_price_paise,
            coalesce(nullif(current_setting('taajamandi.price_source', true), ''), 'manual'), auth.uid());
  end if;
  return new;
end;
$function$;
revoke all on function private.record_supplier_price() from public, anon, authenticated;
drop trigger if exists supplier_products_price_history on public.supplier_products;
create trigger supplier_products_price_history after insert or update on public.supplier_products
  for each row execute function private.record_supplier_price();

drop trigger if exists suppliers_audit on public.suppliers;
create trigger suppliers_audit after insert or update or delete on public.suppliers
  for each row execute function private.audit_admin_change();
drop trigger if exists purchase_orders_audit on public.purchase_orders;
create trigger purchase_orders_audit after insert or update or delete on public.purchase_orders
  for each row execute function private.audit_admin_change();

-- Receive goods against a placed purchase order. p_lines = [{"item_id": uuid, "quantity": number}, ...].
-- Never receives more than ordered; adds to on-hand stock; records a 'purchase' inventory transaction per line;
-- updates the supplier's last price; sets the PO to partially_received or received; writes audit_logs.
create or replace function public.admin_receive_purchase_order(p_actor_id uuid, p_po_id uuid, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_po public.purchase_orders%rowtype;
  v_line jsonb;
  v_item public.purchase_order_items%rowtype;
  v_qty numeric;
  v_total numeric := 0;
  v_open integer;
begin
  if p_actor_id is null or p_po_id is null or p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Choose the purchase order lines you received' using errcode = '22023';
  end if;
  if not exists (select 1 from public.user_roles where user_id = p_actor_id and role in ('admin', 'manager')) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  select * into v_po from public.purchase_orders where id = p_po_id for update;
  if not found then raise exception 'Purchase order not found' using errcode = 'P0002'; end if;
  if v_po.status not in ('placed', 'partially_received') then
    raise exception 'Only placed purchase orders can be received (this one is %)', v_po.status using errcode = '22023';
  end if;
  perform set_config('taajamandi.price_source', 'purchase_receipt', true);
  for v_line in select x from jsonb_array_elements(p_lines) x
  loop
    v_qty := (v_line ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Received quantities must be more than zero' using errcode = '22023'; end if;
    select * into v_item from public.purchase_order_items
    where id = (v_line ->> 'item_id')::uuid and purchase_order_id = p_po_id for update;
    if not found then raise exception 'A received line is not part of this purchase order' using errcode = '22023'; end if;
    if v_item.quantity_received + v_qty > v_item.quantity_ordered then
      raise exception 'Cannot receive more than ordered (ordered %, already received %)', v_item.quantity_ordered, v_item.quantity_received using errcode = '22023';
    end if;
    update public.purchase_order_items set quantity_received = quantity_received + v_qty where id = v_item.id;
    insert into public.inventory (variant_id, quantity_on_hand, quantity_reserved) values (v_item.variant_id, v_qty, 0)
    on conflict (variant_id) do update set quantity_on_hand = public.inventory.quantity_on_hand + excluded.quantity_on_hand, updated_at = now();
    insert into public.inventory_transactions (variant_id, transaction_type, quantity_delta, reference_type, reference_id, notes, created_by)
    values (v_item.variant_id, 'purchase', v_qty, 'purchase_order', p_po_id, 'Received against ' || v_po.po_number, p_actor_id);
    if v_po.supplier_id is not null then
      insert into public.supplier_products (supplier_id, variant_id, last_price_paise) values (v_po.supplier_id, v_item.variant_id, v_item.unit_cost_paise)
      on conflict (supplier_id, variant_id) do update set last_price_paise = excluded.last_price_paise, updated_at = now();
    end if;
    v_total := v_total + v_qty;
  end loop;
  perform set_config('taajamandi.price_source', '', true);
  select count(*) into v_open from public.purchase_order_items where purchase_order_id = p_po_id and quantity_received < quantity_ordered;
  update public.purchase_orders set status = case when v_open = 0 then 'received' else 'partially_received' end,
    received_at = case when v_open = 0 then now() else received_at end, updated_at = now()
  where id = p_po_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'purchase_order_received', 'purchase_order', p_po_id,
          jsonb_build_object('lines', jsonb_array_length(p_lines), 'quantity', v_total, 'fully_received', v_open = 0));
  return jsonb_build_object('purchase_order_id', p_po_id, 'status', case when v_open = 0 then 'received' else 'partially_received' end, 'open_lines', v_open);
end;
$function$;
revoke all on function public.admin_receive_purchase_order(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_receive_purchase_order(uuid, uuid, jsonb) to service_role;
