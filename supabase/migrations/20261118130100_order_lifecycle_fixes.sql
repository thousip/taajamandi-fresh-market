-- Order lifecycle fixes for the supplier-backed fulfilment model.
--
-- 1. Delivery completion: checkout (create_order_from_cart) does not reserve warehouse stock, because
--    produce is bought from suppliers for each order. The old completion code required a reservation
--    and raised "Reserved stock is inconsistent" for EVERY order, so no order could be delivered.
--    New rule (private.complete_order_delivery):
--      * if the variant has a matching reservation AND on-hand stock -> deduct both (warehouse stock);
--      * otherwise the line was supplier-fulfilled -> no stock change, a zero-quantity 'sale'
--        transaction is recorded for traceability. Stock never goes negative; a delivered order
--        is closed, so the deduction cannot run twice.
--      * COD payment is marked captured when delivery is confirmed.
-- 2. Failed delivery returns the order to 'packed' (requires a reason) so admin can reassign it.
-- 3. Packers may only start orders an admin has confirmed.
-- 4. Delivery assignment is only possible for packed orders; dispatch only from packed.
-- 5. Admin can mark delivered only from out_for_delivery, with a reason (delivery-staff path preferred).

create or replace function private.complete_order_delivery(p_order_id uuid, p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare v_item record; v_inv public.inventory%rowtype; v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if v_order.status = 'delivered' then return; end if; -- idempotent: never deduct twice
  if v_order.status <> 'out_for_delivery' then
    raise exception 'Order must be out for delivery before delivery completion' using errcode = '22023';
  end if;

  for v_item in
    select variant_id, quantity from public.order_items
    where order_id = p_order_id and variant_id is not null
    order by variant_id
  loop
    select * into v_inv from public.inventory where variant_id = v_item.variant_id for update;
    if found and v_inv.quantity_reserved >= v_item.quantity and v_inv.quantity_on_hand >= v_item.quantity then
      update public.inventory
        set quantity_on_hand = quantity_on_hand - v_item.quantity,
            quantity_reserved = quantity_reserved - v_item.quantity,
            updated_at = now()
      where variant_id = v_item.variant_id;
      insert into public.inventory_transactions(variant_id, transaction_type, quantity_delta, reference_type, reference_id, notes, created_by)
      values (v_item.variant_id, 'sale', -v_item.quantity, 'order', p_order_id, 'Warehouse stock deducted after delivery', p_actor_id);
    else
      insert into public.inventory_transactions(variant_id, transaction_type, quantity_delta, reference_type, reference_id, notes, created_by)
      values (v_item.variant_id, 'sale', 0, 'order', p_order_id,
              'Supplier-fulfilled line delivered (' || v_item.quantity::text || ' units); no warehouse stock deducted', p_actor_id);
    end if;
  end loop;

  update public.orders
    set status = 'delivered', delivered_at = now(), updated_at = now(),
        payment_status = case when payment_method = 'cod' then 'paid' else payment_status end
  where id = p_order_id;
  update public.payments set status = 'captured', updated_at = now()
  where order_id = p_order_id and provider = 'cod' and status = 'created';
end;
$function$;
revoke all on function private.complete_order_delivery(uuid, uuid) from public, anon, authenticated;

-- Delivery staff status updates ------------------------------------------------------------
create or replace function public.delivery_update_assignment(p_actor_id uuid, p_assignment_id uuid, p_status text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_assignment public.delivery_assignments%rowtype; v_staff_id uuid; v_order_status text;
begin
  if p_actor_id is null or p_assignment_id is null or p_status not in ('accepted','picked_up','delivered','failed') then
    raise exception 'Invalid delivery update' using errcode = '22023';
  end if;
  if not exists (select 1 from public.user_roles where user_id = p_actor_id and role = 'delivery_staff') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select ds.id into v_staff_id from public.delivery_staff ds where ds.user_id = p_actor_id and ds.is_active = true;
  if v_staff_id is null then raise exception 'Delivery staff profile is not active' using errcode = '42501'; end if;

  select * into v_assignment from public.delivery_assignments
  where id = p_assignment_id and delivery_staff_id = v_staff_id for update;
  if not found then raise exception 'Delivery assignment not found' using errcode = 'P0002'; end if;

  if v_assignment.status = p_status then -- duplicate tap / retry: no-op
    return jsonb_build_object('assignment_id', p_assignment_id, 'status', p_status, 'order_id', v_assignment.order_id, 'unchanged', true);
  end if;
  if p_status = 'accepted' and v_assignment.status <> 'assigned' then
    raise exception 'Assignment cannot be accepted in its current state' using errcode = '22023';
  end if;
  if p_status = 'picked_up' and v_assignment.status <> 'accepted' then
    raise exception 'Accept the assignment before pickup' using errcode = '22023';
  end if;
  if p_status in ('delivered','failed') and v_assignment.status <> 'picked_up' then
    raise exception 'Order must be picked up before completing delivery' using errcode = '22023';
  end if;
  if p_status = 'failed' and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'A reason is required for a failed delivery' using errcode = '22023';
  end if;

  select status into v_order_status from public.orders where id = v_assignment.order_id for update;
  if p_status = 'picked_up' and v_order_status <> 'packed' then
    raise exception 'Order must be packed before pickup' using errcode = '22023';
  end if;

  update public.delivery_assignments set status = p_status,
    accepted_at = case when p_status = 'accepted' then now() else accepted_at end,
    picked_up_at = case when p_status = 'picked_up' then now() else picked_up_at end,
    delivered_at = case when p_status = 'delivered' then now() else delivered_at end,
    delivery_note = coalesce(nullif(left(coalesce(p_note, ''), 500), ''), delivery_note),
    updated_at = now()
  where id = p_assignment_id;

  if p_status = 'picked_up' then
    update public.orders set status = 'out_for_delivery', updated_at = now() where id = v_assignment.order_id;
  elsif p_status = 'delivered' then
    perform private.complete_order_delivery(v_assignment.order_id, p_actor_id);
  elsif p_status = 'failed' then
    update public.orders set status = 'packed', updated_at = now()
    where id = v_assignment.order_id and status = 'out_for_delivery';
  end if;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'delivery_' || p_status, 'order', v_assignment.order_id,
          jsonb_build_object('assignment_id', p_assignment_id, 'from', v_assignment.status, 'note', left(coalesce(p_note, ''), 500)));
  return jsonb_build_object('assignment_id', p_assignment_id, 'status', p_status, 'order_id', v_assignment.order_id);
end;
$function$;

-- Packer: only admin-confirmed orders can be started ----------------------------------------
create or replace function public.packer_update_order_status(p_actor_id uuid, p_order_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_order public.orders%rowtype;
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
  elsif p_status = 'packed' and v_order.status <> 'processing' then
    raise exception 'Start packing before marking packed' using errcode = '22023';
  end if;
  update public.orders set status = p_status, updated_at = now() where id = p_order_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'packer_order_status_updated', 'order', p_order_id, jsonb_build_object('from', v_order.status, 'to', p_status));
  return jsonb_build_object('order_id', p_order_id, 'status', p_status);
end;
$function$;

-- Admin status changes ------------------------------------------------------------------------
create or replace function public.admin_update_order_status(p_actor_id uuid, p_order_id uuid, p_status text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_order public.orders%rowtype; v_item record; v_inv public.inventory%rowtype;
begin
  if p_actor_id is null or p_order_id is null or p_status not in ('pending','confirmed','processing','packed','out_for_delivery','delivered','cancelled') then
    raise exception 'Invalid order update' using errcode = '22023';
  end if;
  if not exists (select 1 from public.user_roles where user_id = p_actor_id and role in ('admin','manager')) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if v_order.status = p_status then return jsonb_build_object('order_id', p_order_id, 'status', p_status, 'unchanged', true); end if;
  if v_order.status in ('delivered','cancelled','refunded') then raise exception 'This order is already closed' using errcode = '22023'; end if;

  if p_status = 'cancelled' then
    if v_order.status = 'out_for_delivery' then raise exception 'An out-for-delivery order cannot be cancelled here' using errcode = '22023'; end if;
    for v_item in select variant_id, quantity from public.order_items where order_id = p_order_id and variant_id is not null loop
      select * into v_inv from public.inventory where variant_id = v_item.variant_id for update;
      if found and v_inv.quantity_reserved > 0 then
        update public.inventory set quantity_reserved = greatest(0, quantity_reserved - v_item.quantity), updated_at = now()
        where variant_id = v_item.variant_id;
        insert into public.inventory_transactions(variant_id, transaction_type, quantity_delta, reference_type, reference_id, notes, created_by)
        values (v_item.variant_id, 'release', least(v_item.quantity, v_inv.quantity_reserved), 'order', p_order_id, 'Reservation released after order cancellation', p_actor_id);
      end if;
    end loop;
    update public.orders set status = 'cancelled', cancellation_reason = nullif(left(coalesce(p_reason, ''), 500), ''),
      cancelled_at = now(), updated_at = now() where id = p_order_id;
    update public.payments set status = 'failed', updated_at = now() where order_id = p_order_id and provider = 'cod' and status = 'created';
    update public.delivery_assignments set status = 'reassigned', updated_at = now()
    where order_id = p_order_id and status in ('assigned','accepted');
  elsif p_status = 'delivered' then
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Give a reason when confirming this order''s delivery manually' using errcode = '22023';
    end if;
    perform private.complete_order_delivery(p_order_id, p_actor_id);
    update public.delivery_assignments set status = 'delivered', delivered_at = now(), updated_at = now()
    where order_id = p_order_id and status = 'picked_up';
  else
    if p_status = 'confirmed' and v_order.status <> 'pending' then raise exception 'Only pending orders can be confirmed' using errcode = '22023'; end if;
    if p_status = 'processing' and v_order.status <> 'confirmed' then raise exception 'Confirm the order before packing starts' using errcode = '22023'; end if;
    if p_status = 'packed' and v_order.status <> 'processing' then raise exception 'Order must be processing before it is packed' using errcode = '22023'; end if;
    if p_status = 'out_for_delivery' and v_order.status <> 'packed' then raise exception 'Order must be packed before dispatch' using errcode = '22023'; end if;
    if p_status = 'pending' then raise exception 'Orders cannot be moved back to pending' using errcode = '22023'; end if;
    update public.orders set status = p_status,
      confirmed_at = case when p_status = 'confirmed' then now() else confirmed_at end, updated_at = now()
    where id = p_order_id;
  end if;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'order_status_updated', 'order', p_order_id,
          jsonb_build_object('from', v_order.status, 'to', p_status, 'reason', left(coalesce(p_reason, ''), 500)));
  return jsonb_build_object('order_id', p_order_id, 'status', p_status);
end;
$function$;

-- Assignments only for packed orders (covers admin-ops upsert, which sets status 'assigned') -----
create or replace function private.enforce_assignment_order_packed()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare v_status text;
begin
  if new.status = 'assigned' and (tg_op = 'INSERT' or old.status is distinct from 'assigned' or old.delivery_staff_id is distinct from new.delivery_staff_id) then
    select status into v_status from public.orders where id = new.order_id;
    if v_status is distinct from 'packed' then
      raise exception 'Only packed orders can be assigned for delivery (order is %)', coalesce(v_status, 'missing') using errcode = '22023';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function private.enforce_assignment_order_packed() from public, anon, authenticated;

drop trigger if exists trg_assignment_requires_packed on public.delivery_assignments;
create trigger trg_assignment_requires_packed
  before insert or update on public.delivery_assignments
  for each row execute function private.enforce_assignment_order_packed();
