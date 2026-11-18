-- Staff apps (staff.html): persistent packing checklist, rider decline and rider history.
-- All client entry points are SECURITY DEFINER functions that identify the caller with auth.uid()
-- and check the role in user_roles; tables are read-only to clients through RLS.

-- 1. Item-level packing checklist ----------------------------------------------------------------
create table if not exists public.order_item_checks (
  order_item_id uuid primary key references public.order_items(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  status text not null check (status in ('picked','packed','unavailable')),
  weighed_quantity numeric(10,3) check (weighed_quantity is null or weighed_quantity > 0),
  note text check (char_length(note) <= 500),
  checked_by uuid references auth.users(id) on delete set null,
  checked_at timestamptz not null default now()
);
create index if not exists order_item_checks_order_idx on public.order_item_checks (order_id);
alter table public.order_item_checks enable row level security;
revoke all on public.order_item_checks from anon, authenticated;
grant select on public.order_item_checks to authenticated;
grant all on public.order_item_checks to service_role;
drop policy if exists "item checks staff read" on public.order_item_checks;
create policy "item checks staff read" on public.order_item_checks
  for select to authenticated using ((select private.has_any_role(array['admin','manager','packer_staff'])));

-- Packer queue with item ids, images and saved checks. No customer contact details are returned:
-- packers see the order number, schedule, area and note only.
create or replace function public.packer_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not private.has_any_role(array['packer_staff']) then
    raise exception 'Packer access required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(o_json order by o_sort_date, o_placed)
    from (
      select o.delivery_date as o_sort_date, o.placed_at as o_placed,
        jsonb_build_object(
          'id', o.id, 'order_number', o.order_number, 'status', o.status,
          'delivery_date', o.delivery_date, 'delivery_type', o.delivery_type,
          'slot_label', s.label, 'area', o.delivery_address_snapshot->>'area',
          'customer_note', o.customer_note, 'placed_at', o.placed_at, 'updated_at', o.updated_at,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', oi.id, 'product_name', oi.product_name, 'variant_name', oi.variant_name,
              'quantity', oi.quantity, 'unit', pv.unit, 'unit_quantity', pv.quantity,
              'image_path', (select pi.storage_path from public.product_images pi
                             where pi.product_id = pv.product_id order by pi.is_primary desc, pi.sort_order limit 1),
              'check', (select jsonb_build_object('status', c.status, 'weighed_quantity', c.weighed_quantity,
                                                  'note', c.note, 'checked_at', c.checked_at)
                        from public.order_item_checks c where c.order_item_id = oi.id)
            ) order by oi.product_name)
            from public.order_items oi left join public.product_variants pv on pv.id = oi.variant_id
            where oi.order_id = o.id), '[]'::jsonb)
        ) as o_json
      from public.orders o
      left join public.delivery_slots s on s.id = o.delivery_slot_id
      where o.status in ('pending','confirmed','processing')
         or (o.status = 'packed' and o.updated_at > now() - interval '24 hours')
      limit 200
    ) q), '[]'::jsonb);
end;
$function$;

create or replace function public.packer_check_item(p_order_item_id uuid, p_status text, p_weighed_quantity numeric default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_uid uuid := auth.uid(); v_item record; v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  if v_uid is null or not private.has_any_role(array['packer_staff']) then
    raise exception 'Packer access required' using errcode = '42501';
  end if;
  if p_status not in ('picked','packed','unavailable','clear') then
    raise exception 'Invalid item status' using errcode = '22023';
  end if;
  if p_weighed_quantity is not null and (p_weighed_quantity <= 0 or p_weighed_quantity > 1000) then
    raise exception 'Enter a valid weighed quantity' using errcode = '22023';
  end if;
  if p_status = 'unavailable' and v_note is null then
    raise exception 'Say why the item is unavailable (shortage, quality, etc.)' using errcode = '22023';
  end if;
  select oi.id, oi.order_id, o.status into v_item
  from public.order_items oi join public.orders o on o.id = oi.order_id
  where oi.id = p_order_item_id
  for update of o;
  if not found then raise exception 'Order item not found' using errcode = 'P0002'; end if;
  if v_item.status <> 'processing' then
    raise exception 'Start packing the order before checking items' using errcode = '22023';
  end if;

  if p_status = 'clear' then
    delete from public.order_item_checks where order_item_id = p_order_item_id;
  else
    insert into public.order_item_checks(order_item_id, order_id, status, weighed_quantity, note, checked_by, checked_at)
    values (p_order_item_id, v_item.order_id, p_status, p_weighed_quantity, v_note, v_uid, now())
    on conflict (order_item_id) do update set status = excluded.status, weighed_quantity = excluded.weighed_quantity,
      note = excluded.note, checked_by = excluded.checked_by, checked_at = excluded.checked_at;
  end if;
  if p_status = 'unavailable' then
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
    values (v_uid, 'packing_item_unavailable', 'order', v_item.order_id, jsonb_build_object('order_item_id', p_order_item_id, 'note', v_note));
  end if;
  return jsonb_build_object('order_item_id', p_order_item_id, 'status', p_status);
end;
$function$;

-- Packing completion now requires every item to be checked (packed or unavailable) and at least one
-- packed item. Shortages are recorded in the audit log for admin follow-up.
create or replace function public.packer_update_order_status(p_actor_id uuid, p_order_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_order public.orders%rowtype; v_total int; v_packed int; v_unavailable int;
begin
  if p_actor_id is null or p_order_id is null or p_status not in ('processing','packed') then
    raise exception 'Invalid packing update' using errcode = '22023';
  end if;
  if not exists (select 1 from public.user_roles where user_id = p_actor_id and role = 'packer_staff') then
    raise exception 'Packer access required' using errcode = '42501';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if v_order.status = p_status then
    return jsonb_build_object('order_id', p_order_id, 'status', p_status, 'unchanged', true);
  end if;
  if p_status = 'processing' and v_order.status <> 'confirmed' then
    raise exception 'Order cannot be started until the store confirms it' using errcode = '22023';
  elsif p_status = 'packed' then
    if v_order.status <> 'processing' then
      raise exception 'Start packing before marking packed' using errcode = '22023';
    end if;
    select count(*), count(*) filter (where c.status = 'packed'), count(*) filter (where c.status = 'unavailable')
      into v_total, v_packed, v_unavailable
    from public.order_items oi left join public.order_item_checks c on c.order_item_id = oi.id
    where oi.order_id = p_order_id;
    if v_packed + v_unavailable < v_total then
      raise exception 'Check every item (packed or unavailable) before marking the order packed' using errcode = '22023';
    end if;
    if v_packed = 0 then
      raise exception 'No items could be packed; ask the store to contact the customer or cancel' using errcode = '22023';
    end if;
  end if;
  update public.orders set status = p_status, updated_at = now() where id = p_order_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'packer_order_status_updated', 'order', p_order_id,
          jsonb_build_object('from', v_order.status, 'to', p_status, 'unavailable_items', coalesce(v_unavailable, 0)));
  return jsonb_build_object('order_id', p_order_id, 'status', p_status, 'unavailable_items', coalesce(v_unavailable, 0));
end;
$function$;

-- 2. Rider declines an assignment before accepting it (order stays packed for reassignment) -------
create or replace function public.delivery_decline_assignment(p_assignment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_uid uuid := auth.uid(); v_staff uuid; v_a public.delivery_assignments%rowtype; v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
begin
  if v_uid is null or not private.has_any_role(array['delivery_staff']) then
    raise exception 'Delivery staff access required' using errcode = '42501';
  end if;
  select id into v_staff from public.delivery_staff where user_id = v_uid and is_active;
  if v_staff is null then raise exception 'Delivery staff profile is not active' using errcode = '42501'; end if;
  if v_reason is null then raise exception 'Give a reason for declining' using errcode = '22023'; end if;
  select * into v_a from public.delivery_assignments where id = p_assignment_id and delivery_staff_id = v_staff for update;
  if not found then raise exception 'Delivery assignment not found' using errcode = 'P0002'; end if;
  if v_a.status <> 'assigned' then raise exception 'Only new assignments can be declined' using errcode = '22023'; end if;
  update public.delivery_assignments set status = 'reassigned', delivery_note = v_reason, updated_at = now() where id = p_assignment_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
  values (v_uid, 'delivery_declined', 'order', v_a.order_id, jsonb_build_object('assignment_id', p_assignment_id, 'reason', v_reason));
  return jsonb_build_object('assignment_id', p_assignment_id, 'status', 'reassigned');
end;
$function$;

-- 3. Rider's own delivery history (no customer address/phone after completion) ------------------
create or replace function public.delivery_my_history()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare v_staff uuid;
begin
  if auth.uid() is null or not private.has_any_role(array['delivery_staff']) then
    raise exception 'Delivery staff access required' using errcode = '42501';
  end if;
  select id into v_staff from public.delivery_staff where user_id = auth.uid();
  if v_staff is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'assignment_id', a.id, 'status', a.status, 'assigned_at', a.assigned_at, 'picked_up_at', a.picked_up_at,
      'delivered_at', a.delivered_at, 'note', a.delivery_note, 'order_number', o.order_number,
      'total_paise', o.total_paise, 'payment_method', o.payment_method, 'delivery_date', o.delivery_date,
      'area', o.delivery_address_snapshot->>'area') order by a.updated_at desc)
    from (select * from public.delivery_assignments
          where delivery_staff_id = v_staff and status in ('delivered','failed','reassigned')
          order by updated_at desc limit 50) a
    join public.orders o on o.id = a.order_id), '[]'::jsonb);
end;
$function$;

revoke all on function public.packer_queue() from public, anon;
revoke all on function public.packer_check_item(uuid, text, numeric, text) from public, anon;
revoke all on function public.delivery_decline_assignment(uuid, text) from public, anon;
revoke all on function public.delivery_my_history() from public, anon;
grant execute on function public.packer_queue() to authenticated;
grant execute on function public.packer_check_item(uuid, text, numeric, text) to authenticated;
grant execute on function public.delivery_decline_assignment(uuid, text) to authenticated;
grant execute on function public.delivery_my_history() to authenticated;
