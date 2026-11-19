-- part: 05_functions
-- private schema plus every function in private and public, verbatim from production.

create schema if not exists private authorization postgres;

CREATE OR REPLACE FUNCTION private.complete_order_delivery(p_order_id uuid, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION private.enforce_assignment_order_packed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION private.has_any_role(required_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = (select auth.uid())
      and ur.role = any(required_roles)
  );
$function$
;
CREATE OR REPLACE FUNCTION public.admin_adjust_inventory(p_actor_id uuid, p_variant_id uuid, p_delta numeric, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_inventory public.inventory%rowtype;
begin
  if p_actor_id is null or p_variant_id is null or p_delta is null or p_delta = 0 then
    raise exception 'Invalid inventory adjustment' using errcode='22023';
  end if;
  if not exists (select 1 from public.user_roles where user_id=p_actor_id and role in ('admin','manager','inventory_staff')) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  insert into public.inventory(variant_id, quantity_on_hand, quantity_reserved, reorder_level)
  values (p_variant_id,0,0,0) on conflict (variant_id) do nothing;
  select * into v_inventory from public.inventory where variant_id=p_variant_id for update;
  if not found then raise exception 'Variant inventory not found'; end if;
  if v_inventory.quantity_on_hand + p_delta < v_inventory.quantity_reserved then
    raise exception 'Adjustment would reduce stock below reserved quantity' using errcode='22023';
  end if;
  update public.inventory set quantity_on_hand=quantity_on_hand+p_delta, updated_at=now()
  where variant_id=p_variant_id;
  insert into public.inventory_transactions(variant_id,transaction_type,quantity_delta,notes,created_by)
  values(p_variant_id,'adjustment',p_delta,nullif(left(coalesce(p_notes,''),500),''),p_actor_id);
  return jsonb_build_object('variant_id',p_variant_id,'quantity_on_hand',v_inventory.quantity_on_hand+p_delta,'quantity_reserved',v_inventory.quantity_reserved);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.admin_respond_bargain(p_request_id uuid, p_action text, p_counter_total_paise integer DEFAULT NULL::integer, p_reason text DEFAULT NULL::text, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := auth.uid(); v_req public.bargain_requests%rowtype; v_new text; v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
begin
  if v_uid is null or not private.has_any_role(array['admin','manager']) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_action not in ('approve','reject','counter') then raise exception 'Invalid bargain decision' using errcode = '22023'; end if;
  select * into v_req from public.bargain_requests where id = p_request_id for update;
  if not found then raise exception 'Bargain request not found' using errcode = 'P0002'; end if;
  if v_req.status not in ('pending','countered') then raise exception 'This bargain request is already closed' using errcode = '22023'; end if;

  if p_action = 'reject' and v_reason is null then raise exception 'Give a reason for rejecting the offer' using errcode = '22023'; end if;
  if p_action = 'counter' then
    if p_counter_total_paise is null or p_counter_total_paise <= 0 then raise exception 'Enter a counter-offer amount' using errcode = '22023'; end if;
    if p_expires_at is null or p_expires_at <= now() then raise exception 'Set a future expiry for the counter-offer' using errcode = '22023'; end if;
  end if;
  if p_expires_at is not null and p_expires_at <= now() then raise exception 'Expiry must be in the future' using errcode = '22023'; end if;

  v_new := case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'countered' end;
  update public.bargain_requests set status = v_new, admin_reason = coalesce(v_reason, admin_reason), responded_at = now(),
    counter_total_paise = case when p_action = 'counter' then p_counter_total_paise else counter_total_paise end,
    agreed_total_paise = case when p_action = 'approve' then offer_total_paise else agreed_total_paise end,
    expires_at = coalesce(p_expires_at, expires_at)
  where id = p_request_id;
  insert into public.bargain_offer_history(bargain_request_id, actor_id, actor_role, action, amount_paise, note)
  values (p_request_id, v_uid, 'admin', case v_new when 'approved' then 'approved' when 'rejected' then 'rejected' else 'countered' end,
          case p_action when 'counter' then p_counter_total_paise when 'approve' then v_req.offer_total_paise end, v_reason);
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
  values (v_uid, 'bargain_' || v_new, 'bargain_request', p_request_id,
          jsonb_build_object('from', v_req.status, 'counter_total_paise', p_counter_total_paise, 'reason', v_reason));
  return jsonb_build_object('id', p_request_id, 'status', v_new);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.admin_update_order_status(p_actor_id uuid, p_order_id uuid, p_status text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.create_order_from_cart(p_user_id uuid, p_address_id uuid, p_delivery_zone_id uuid, p_delivery_slot_id uuid DEFAULT NULL::uuid, p_payment_method text DEFAULT 'cod'::text, p_customer_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cart_id uuid;
  v_address public.addresses%rowtype;
  v_zone public.delivery_zones%rowtype;
  v_slot public.delivery_slots%rowtype;
  v_item record;
  v_inventory public.inventory%rowtype;
  v_order_id uuid;
  v_order_number text;
  v_subtotal integer := 0;
  v_delivery_fee integer := 0;
  v_total integer := 0;
  v_item_count integer := 0;
  v_processed integer := 0;
begin
  if p_user_id is null or p_address_id is null or p_delivery_zone_id is null then
    raise exception 'Missing required checkout details' using errcode = '22023';
  end if;

  if p_payment_method not in ('cod','razorpay') then
    raise exception 'Unsupported payment method' using errcode = '22023';
  end if;

  select * into v_address
  from public.addresses
  where id = p_address_id and user_id = p_user_id
  for share;

  if not found then
    raise exception 'Delivery address not found' using errcode = 'P0002';
  end if;

  select * into v_zone
  from public.delivery_zones
  where id = p_delivery_zone_id and is_active = true
    
  for share;

  if not found then
    raise exception 'Delivery is not available for this pincode' using errcode = '22023';
  end if;

  if p_delivery_slot_id is not null then
    select * into v_slot
    from public.delivery_slots
    where id = p_delivery_slot_id and is_active = true
      and (zone_id is null or zone_id = p_delivery_zone_id)
    for share;
    if not found then
      raise exception 'Selected delivery slot is unavailable' using errcode = '22023';
    end if;
  end if;

  select id into v_cart_id
  from public.carts
  where user_id = p_user_id
  for update;

  if v_cart_id is null then
    raise exception 'Your cart is empty' using errcode = 'P0002';
  end if;

  select count(*) into v_item_count
  from public.cart_items
  where cart_id = v_cart_id;

  if v_item_count = 0 then
    raise exception 'Your cart is empty' using errcode = 'P0002';
  end if;

  for v_item in
    select ci.id as cart_item_id, ci.variant_id, ci.quantity,
           pv.name as variant_name, pv.sku, pv.price_paise,
           p.name as product_name, pv.is_active as variant_active,
           p.is_active as product_active
    from public.cart_items ci
    join public.product_variants pv on pv.id = ci.variant_id
    join public.products p on p.id = pv.product_id
    where ci.cart_id = v_cart_id
    order by ci.variant_id
    for update of ci, pv
  loop
    if not v_item.variant_active or not v_item.product_active then
      raise exception 'A product in your cart is no longer available' using errcode = '22023';
    end if;

    -- Supplier-backed next-day fulfilment: checkout is not limited by warehouse stock.
    insert into public.inventory (variant_id, quantity_on_hand, quantity_reserved)
    values (v_item.variant_id, 0, 0)
    on conflict (variant_id) do nothing;

    v_subtotal := v_subtotal + round(v_item.price_paise * v_item.quantity)::integer;
    v_processed := v_processed + 1;
  end loop;

  if v_processed <> v_item_count then
    raise exception 'One or more cart items are invalid' using errcode = '22023';
  end if;

  if v_subtotal < v_zone.minimum_order_paise then
    raise exception 'Order is below the minimum order value' using errcode = '22023';
  end if;

  v_delivery_fee := case
    when v_zone.free_delivery_min_paise is not null
      and v_subtotal >= v_zone.free_delivery_min_paise then 0
    else v_zone.delivery_fee_paise
  end;
  v_total := v_subtotal + v_delivery_fee;

  v_order_id := gen_random_uuid();
  v_order_number := 'TM-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYYMMDD')
                    || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.orders (
    id, order_number, user_id, address_id, delivery_zone_id, delivery_slot_id,
    status, payment_status, payment_method, subtotal_paise, discount_paise,
    delivery_fee_paise, tax_paise, total_paise, delivery_address_snapshot, customer_note
  ) values (
    v_order_id, v_order_number, p_user_id, p_address_id, p_delivery_zone_id, p_delivery_slot_id,
    'pending', 'pending', p_payment_method, v_subtotal, 0,
    v_delivery_fee, 0, v_total,
    jsonb_build_object(
      'recipient_name', v_address.recipient_name,
      'phone', v_address.phone,
      'address_line1', v_address.address_line1,
      'address_line2', v_address.address_line2,
      'landmark', v_address.landmark,
      'area', v_address.area,
      'city', v_address.city,
      'state', v_address.state,
      'pincode', v_address.pincode
    ),
    p_customer_note
  );

  for v_item in
    select ci.variant_id, ci.quantity, pv.name as variant_name, pv.sku,
           pv.price_paise, p.name as product_name
    from public.cart_items ci
    join public.product_variants pv on pv.id = ci.variant_id
    join public.products p on p.id = pv.product_id
    where ci.cart_id = v_cart_id
    order by ci.variant_id
  loop
    insert into public.order_items (
      order_id, variant_id, product_name, variant_name, sku,
      quantity, unit_price_paise, line_total_paise
    ) values (
      v_order_id, v_item.variant_id, v_item.product_name, v_item.variant_name, v_item.sku,
      v_item.quantity, v_item.price_paise,
      round(v_item.price_paise * v_item.quantity)::integer
    );


  end loop;

  insert into public.payments (
    order_id, provider, amount_paise, currency, status
  ) values (
    v_order_id, p_payment_method, v_total, 'INR', 'created'
  );

  delete from public.cart_items where cart_id = v_cart_id;

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'subtotal_paise', v_subtotal,
    'delivery_fee_paise', v_delivery_fee,
    'total_paise', v_total,
    'currency', 'INR',
    'payment_method', p_payment_method,
    'status', 'pending'
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.create_order_from_cart(p_user_id uuid, p_address_id uuid, p_delivery_zone_id uuid, p_delivery_slot_id uuid, p_payment_method text, p_customer_note text, p_requested_delivery_date date, p_delivery_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_order_id uuid;
  v_slot public.delivery_slots%rowtype;
  v_taken integer;
  v_now_ist timestamp := now() at time zone 'Asia/Kolkata';
begin
  if p_requested_delivery_date is null or p_delivery_type not in ('same_day','advance') then
    raise exception 'A valid delivery type and date are required' using errcode = '22023';
  end if;

  if exists (select 1 from public.cart_items ci join public.carts c on c.id = ci.cart_id
             where c.user_id = p_user_id and ci.quantity > 50) then
    raise exception 'A basket item is above the limit of 50; reduce the quantity or send a bargain request for bulk orders'
      using errcode = '22023';
  end if;

  if p_delivery_slot_id is not null then
    select * into v_slot from public.delivery_slots
    where id = p_delivery_slot_id and is_active = true
      and (zone_id is null or zone_id = p_delivery_zone_id)
    for update;
    if not found then
      raise exception 'Selected delivery slot is unavailable' using errcode = '22023';
    end if;
    if p_requested_delivery_date = v_now_ist::date and v_slot.ends_at <= v_now_ist::time then
      raise exception 'This delivery slot has already ended today; choose a later slot or date' using errcode = '22023';
    end if;
    select count(*) into v_taken from public.orders
    where delivery_slot_id = p_delivery_slot_id
      and delivery_date = p_requested_delivery_date
      and status not in ('cancelled','refunded');
    if v_taken >= v_slot.max_orders then
      raise exception 'Selected delivery slot is full for that date; choose another slot or date' using errcode = '22023';
    end if;
  end if;

  v_result := public.create_order_from_cart(p_user_id, p_address_id, p_delivery_zone_id,
                                            p_delivery_slot_id, p_payment_method, p_customer_note);
  v_order_id := (v_result->>'order_id')::uuid;

  update public.orders
    set delivery_date = p_requested_delivery_date, delivery_type = p_delivery_type
  where id = v_order_id;

  return v_result || jsonb_build_object('delivery_date', p_requested_delivery_date, 'delivery_type', p_delivery_type);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.delivery_decline_assignment(p_assignment_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.delivery_my_history()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.delivery_update_assignment(p_actor_id uuid, p_assignment_id uuid, p_status text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  if v_assignment.status = p_status then
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
$function$
;
CREATE OR REPLACE FUNCTION public.enforce_taajamandi_delivery_schedule()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_start constant date := date '2026-12-01';
begin
  if tg_op = 'UPDATE'
     and new.delivery_date is not distinct from old.delivery_date
     and new.delivery_type is not distinct from old.delivery_type then
    return new; -- schedule unchanged: never block status/payment updates
  end if;

  if new.delivery_type is null then
    new.delivery_type := case when v_today < v_start then 'advance' else 'same_day' end;
  end if;
  if new.delivery_date is null then
    new.delivery_date := case when v_today < v_start then v_start
                              when new.delivery_type = 'advance' then v_today + 1
                              else v_today end;
  end if;

  if v_today < v_start then
    if new.delivery_type <> 'advance' or new.delivery_date < v_start then
      raise exception 'Deliveries start on 1 December 2026; choose 1 December or a later delivery date'
        using errcode = '22023';
    end if;
  elsif new.delivery_type = 'same_day' and new.delivery_date <> v_today then
    raise exception 'Same-day delivery must be scheduled for today' using errcode = '22023';
  elsif new.delivery_type = 'advance' and new.delivery_date <= v_today then
    raise exception 'Advance delivery must be scheduled for a future date' using errcode = '22023';
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.profiles(id, full_name, phone, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.phone,
    new.email
  )
  on conflict (id) do update
    set phone = excluded.phone, email = excluded.email;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.packer_check_item(p_order_item_id uuid, p_status text, p_weighed_quantity numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.packer_queue()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.packer_update_order_status(p_actor_id uuid, p_order_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.respond_bargain_request(p_request_id uuid, p_action text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := auth.uid(); v_req public.bargain_requests%rowtype; v_new text;
begin
  if v_uid is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if p_action not in ('accept','decline','cancel') then raise exception 'Invalid bargain response' using errcode = '22023'; end if;
  select * into v_req from public.bargain_requests where id = p_request_id and user_id = v_uid for update;
  if not found then raise exception 'Bargain request not found' using errcode = 'P0002'; end if;

  if v_req.status = 'countered' and v_req.expires_at is not null and v_req.expires_at <= now() then
    update public.bargain_requests set status = 'expired' where id = p_request_id;
    insert into public.bargain_offer_history(bargain_request_id, actor_role, action, amount_paise)
    values (p_request_id, 'system', 'expired', v_req.counter_total_paise);
    return jsonb_build_object('id', p_request_id, 'status', 'expired');
  end if;

  if p_action = 'cancel' then
    if v_req.status not in ('pending','countered') then raise exception 'Only open requests can be cancelled' using errcode = '22023'; end if;
    v_new := 'cancelled';
  else
    if v_req.status <> 'countered' then raise exception 'There is no counter-offer to respond to' using errcode = '22023'; end if;
    v_new := case p_action when 'accept' then 'accepted' else 'declined' end;
  end if;

  update public.bargain_requests set status = v_new,
    agreed_total_paise = case when v_new = 'accepted' then counter_total_paise else agreed_total_paise end
  where id = p_request_id;
  insert into public.bargain_offer_history(bargain_request_id, actor_id, actor_role, action, amount_paise, note)
  values (p_request_id, v_uid, 'customer', case v_new when 'accepted' then 'accepted' when 'declined' then 'declined' else 'cancelled' end,
          case when v_new = 'accepted' then v_req.counter_total_paise end, nullif(left(btrim(coalesce(p_note, '')), 500), ''));
  return jsonb_build_object('id', p_request_id, 'status', v_new);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
  tbl name;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
        EXECUTE format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$ begin new.updated_at = now(); return new; end; $function$
;
CREATE OR REPLACE FUNCTION public.submit_bargain_request(p_variant_id uuid, p_quantity_kg numeric, p_offer_total_paise integer, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_variant record;
  v_variant_kg numeric;
  v_rate integer;
  v_estimate integer;
  v_id uuid;
begin
  if v_uid is null then raise exception 'Sign in to send a bargain request' using errcode = '42501'; end if;
  if p_quantity_kg is null or p_quantity_kg < 5 or p_quantity_kg > 50 or (p_quantity_kg * 2) <> trunc(p_quantity_kg * 2) then
    raise exception 'Bargain quantity must be 5–50 kg in 0.5 kg steps' using errcode = '22023';
  end if;
  if p_offer_total_paise is null or p_offer_total_paise <= 0 then
    raise exception 'Enter your total offer price' using errcode = '22023';
  end if;
  if (select count(*) from public.bargain_requests where user_id = v_uid and status in ('pending','countered')) >= 5 then
    raise exception 'You already have 5 open bargain requests; wait for a reply first' using errcode = '22023';
  end if;
  if (select count(*) from public.bargain_requests where user_id = v_uid and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'Too many bargain requests today; please try again tomorrow' using errcode = '22023';
  end if;

  select pv.id, pv.product_id, pv.name, pv.quantity, pv.unit, pv.price_paise, p.name as product_name
    into v_variant
  from public.product_variants pv join public.products p on p.id = pv.product_id
  where pv.id = p_variant_id and pv.is_active and p.is_active;
  if not found then raise exception 'This product is not available for bargaining' using errcode = '22023'; end if;

  v_variant_kg := case v_variant.unit when 'kg' then v_variant.quantity when 'g' then v_variant.quantity / 1000.0 else null end;
  if v_variant_kg is null or v_variant_kg <= 0 or v_variant.price_paise <= 0 then
    raise exception 'Bargaining is only available for products sold by weight' using errcode = '22023';
  end if;
  v_rate := round(v_variant.price_paise / v_variant_kg);
  v_estimate := round(v_rate * p_quantity_kg);

  insert into public.bargain_requests(user_id, product_id, variant_id, product_name, variant_name, quantity_kg,
    rate_per_kg_paise, regular_estimate_paise, offer_total_paise, customer_note)
  values (v_uid, v_variant.product_id, v_variant.id, v_variant.product_name, v_variant.name, p_quantity_kg,
    v_rate, v_estimate, p_offer_total_paise, nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  returning id into v_id;
  insert into public.bargain_offer_history(bargain_request_id, actor_id, actor_role, action, amount_paise, note)
  values (v_id, v_uid, 'customer', 'submitted', p_offer_total_paise, nullif(left(btrim(coalesce(p_note, '')), 500), ''));
  return jsonb_build_object('id', v_id, 'status', 'pending', 'regular_estimate_paise', v_estimate, 'offer_total_paise', p_offer_total_paise);
end;
$function$
;
