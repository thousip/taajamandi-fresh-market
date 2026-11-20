-- Rollback for 20261121110000_online_payments.sql (owner approval required).
-- Data guard: refuses while any online (razorpay) order exists, because those orders depend on these functions
-- for payment reconciliation and refunds. Deploy the previous create-order and storefront first.
do $guard$
declare n bigint;
begin
  select count(*) into n from public.orders where payment_method = 'razorpay';
  if n > 0 then raise exception 'Rollback refused: % online order(s) exist. Disable online payments instead.', n; end if;
end
$guard$;
drop function if exists public.expire_unpaid_online_order(uuid, text);
drop function if exists public.apply_order_payment(text, text, text, text, text, integer, text, integer, jsonb);
drop function if exists public.attach_razorpay_order(uuid, uuid, text, integer);
drop index if exists public.payments_provider_order_id_key;
-- Restore admin_update_order_status exactly as it was before this migration:
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
$function$;
