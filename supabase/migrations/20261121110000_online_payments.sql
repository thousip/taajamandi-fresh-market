-- Launch build (21 Nov 2026): Razorpay online payment for regular orders (memberships already use subscriptions).
-- Flow: create-order creates the order with payment_method 'razorpay' (payment_status 'pending'); payment-ops
-- creates a Razorpay order for the server-calculated total and records its id here; the browser opens Razorpay
-- Checkout; payment-ops verifies the signature AND fetches the payment from Razorpay before calling
-- apply_order_payment; the signed webhook calls the same function. A browser callback alone never marks an order
-- paid. Every webhook event id is applied once (payment_webhook_events primary key). Unpaid online orders cannot
-- be confirmed for packing; an unpaid online order that expires is cancelled and its items go back to the basket.
-- Uses the existing payments columns (provider_order_id, provider_payment_id, raw_response, paid_at).
-- Rollback: supabase/rollback/20261121110000_online_payments_rollback.sql

-- One Razorpay order per TaajaMandi order (provider_payment_id is already unique).
create unique index if not exists payments_provider_order_id_key on public.payments (provider_order_id) where provider_order_id is not null;

-- Record the Razorpay order created for a customer's own unpaid online order (called by payment-ops only).
create or replace function public.attach_razorpay_order(p_user_id uuid, p_order_id uuid, p_razorpay_order_id text, p_amount_paise integer)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_order public.orders%rowtype; v_pay public.payments%rowtype;
begin
  if p_razorpay_order_id is null or p_razorpay_order_id !~ '^order_[A-Za-z0-9]{6,40}$' then
    raise exception 'Invalid Razorpay order id' using errcode = '22023';
  end if;
  select * into v_order from public.orders where id = p_order_id and user_id = p_user_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if v_order.payment_method <> 'razorpay' or v_order.status <> 'pending' or v_order.payment_status not in ('pending', 'failed') then
    raise exception 'This order is not waiting for an online payment' using errcode = '22023';
  end if;
  if p_amount_paise <> v_order.total_paise then raise exception 'Payment amount does not match the order total' using errcode = '22023'; end if;
  select * into v_pay from public.payments where order_id = p_order_id and provider = 'razorpay' for update;
  if not found then raise exception 'Payment record missing for this order' using errcode = 'P0002'; end if;
  if v_pay.provider_order_id is not null and v_pay.provider_order_id <> p_razorpay_order_id then
    return jsonb_build_object('razorpay_order_id', v_pay.provider_order_id, 'reused', true);
  end if;
  update public.payments set provider_order_id = p_razorpay_order_id, updated_at = now() where id = v_pay.id;
  return jsonb_build_object('razorpay_order_id', p_razorpay_order_id, 'reused', v_pay.provider_order_id is not null);
end;
$function$;
revoke all on function public.attach_razorpay_order(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.attach_razorpay_order(uuid, uuid, text, integer) to service_role;

-- Apply a verified payment outcome. p_source: 'verify' (server-checked checkout result), 'webhook' or 'reconcile'.
-- p_outcome: 'captured' | 'authorized' | 'failed' | 'refunded'. p_event_id (webhooks) makes the call idempotent.
create or replace function public.apply_order_payment(
  p_source text, p_event_id text, p_event_type text, p_razorpay_order_id text, p_razorpay_payment_id text,
  p_amount_paise integer, p_outcome text, p_refunded_paise integer, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_pay public.payments%rowtype; v_order public.orders%rowtype; v_inserted integer; v_result text;
  v_refund_total integer;
begin
  if p_source not in ('verify', 'webhook', 'reconcile') or p_outcome not in ('captured', 'authorized', 'failed', 'refunded') then
    raise exception 'Invalid payment update' using errcode = '22023';
  end if;
  if p_event_id is not null then
    insert into public.payment_webhook_events (event_id, event_type, payload)
    values (p_event_id, coalesce(p_event_type, 'payment'), coalesce(p_payload, '{}'::jsonb)) on conflict (event_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then return jsonb_build_object('duplicate', true); end if;
  end if;

  select * into v_pay from public.payments where provider = 'razorpay' and provider_order_id = p_razorpay_order_id for update;
  if not found then
    -- Not a TaajaMandi order payment (for example a membership subscription invoice): record and ignore.
    if p_event_id is not null then update public.payment_webhook_events set processed = true where event_id = p_event_id; end if;
    return jsonb_build_object('ignored', true);
  end if;
  select * into v_order from public.orders where id = v_pay.order_id for update;

  if p_outcome = 'captured' then
    if p_amount_paise is distinct from v_order.total_paise then
      v_result := 'amount_mismatch';
    elsif v_order.payment_status in ('paid', 'partially_refunded', 'refunded') then
      if v_pay.provider_payment_id = p_razorpay_payment_id then v_result := 'already_paid';
      else
        -- A second successful payment for the same order: keep a record so the store can refund it.
        insert into public.payments (order_id, provider, provider_order_id, provider_payment_id, amount_paise, currency, status, raw_response, paid_at)
        values (v_order.id, 'razorpay', null, p_razorpay_payment_id, p_amount_paise, 'INR', 'captured', p_payload, now())
        on conflict (provider_payment_id) do nothing;
        v_result := 'duplicate_payment_refund_required';
      end if;
    else
      update public.payments set status = 'captured', provider_payment_id = p_razorpay_payment_id, raw_response = p_payload,
        paid_at = coalesce(paid_at, now()), updated_at = now() where id = v_pay.id;
      update public.orders set payment_status = 'paid', updated_at = now() where id = v_order.id;
      v_result := case when v_order.status = 'cancelled' then 'paid_after_cancellation_refund_required' else 'paid' end;
    end if;
  elsif p_outcome = 'authorized' then
    if v_order.payment_status in ('pending', 'failed') then
      update public.payments set status = 'authorized', provider_payment_id = p_razorpay_payment_id, raw_response = p_payload, updated_at = now() where id = v_pay.id;
      update public.orders set payment_status = 'authorized', updated_at = now() where id = v_order.id;
      v_result := 'authorized';
    else v_result := 'ignored_' || v_order.payment_status; end if;
  elsif p_outcome = 'failed' then
    if v_order.payment_status in ('pending', 'authorized', 'failed') then
      update public.payments set status = 'failed', raw_response = p_payload, updated_at = now() where id = v_pay.id;
      update public.orders set payment_status = 'failed', updated_at = now() where id = v_order.id;
      v_result := 'failed';
    else v_result := 'ignored_' || v_order.payment_status; end if; -- an earlier failed attempt never undoes a payment
  else -- refunded (full or partial), from the refund webhook or reconciliation
    v_refund_total := greatest(coalesce(p_refunded_paise, 0), 0);
    if v_order.payment_status not in ('paid', 'partially_refunded', 'refunded') then v_result := 'ignored_not_paid';
    else
      update public.payments set status = case when v_refund_total >= v_pay.amount_paise then 'refunded' else status end,
        raw_response = p_payload, updated_at = now() where id = v_pay.id;
      update public.orders set payment_status = case when v_refund_total >= v_order.total_paise then 'refunded' else 'partially_refunded' end,
        updated_at = now() where id = v_order.id;
      v_result := case when v_refund_total >= v_order.total_paise then 'refunded' else 'partially_refunded' end;
    end if;
  end if;

  if p_event_id is not null then update public.payment_webhook_events set processed = true where event_id = p_event_id; end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (null, 'order_payment_' || v_result, 'order', v_order.id,
          jsonb_build_object('source', p_source, 'event_id', p_event_id, 'razorpay_order_id', p_razorpay_order_id,
                             'razorpay_payment_id', p_razorpay_payment_id, 'amount_paise', p_amount_paise));
  return jsonb_build_object('order_id', v_order.id, 'result', v_result, 'payment_status',
                            (select payment_status from public.orders where id = v_order.id));
end;
$function$;
revoke all on function public.apply_order_payment(text, text, text, text, text, integer, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.apply_order_payment(text, text, text, text, text, integer, text, integer, jsonb) to service_role;

-- An unpaid online order that Razorpay confirms was never paid is cancelled; its items go back to the customer's
-- basket (deal and free lines are not re-added; each line respects the 50 limit). Called by payment-ops reconcile.
create or replace function public.expire_unpaid_online_order(p_order_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_order public.orders%rowtype; v_cart uuid; v_item record; v_restored integer := 0;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if v_order.payment_method <> 'razorpay' or v_order.status <> 'pending' or v_order.payment_status not in ('pending', 'failed') then
    return jsonb_build_object('order_id', p_order_id, 'expired', false, 'reason', 'not an unpaid online order');
  end if;
  update public.orders set status = 'cancelled', cancellation_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Online payment not completed'), 500),
    cancelled_at = now(), updated_at = now() where id = p_order_id;
  update public.payments set status = 'failed', updated_at = now() where order_id = p_order_id and provider = 'razorpay' and status in ('created', 'failed');
  insert into public.carts (user_id) values (v_order.user_id) on conflict (user_id) do nothing;
  select id into v_cart from public.carts where user_id = v_order.user_id;
  for v_item in select variant_id, sum(quantity)::integer q from public.order_items
                where order_id = p_order_id and variant_id is not null and promo_type is null group by variant_id loop
    insert into public.cart_items (cart_id, variant_id, quantity) values (v_cart, v_item.variant_id, least(v_item.q, 50))
    on conflict (cart_id, variant_id) do update set quantity = least(public.cart_items.quantity + excluded.quantity, 50), updated_at = now()
    where public.cart_items.quantity <= 50;
    v_restored := v_restored + 1;
  end loop;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (null, 'order_payment_expired', 'order', p_order_id, jsonb_build_object('reason', p_reason, 'basket_lines_restored', v_restored));
  return jsonb_build_object('order_id', p_order_id, 'expired', true, 'basket_lines_restored', v_restored);
end;
$function$;
revoke all on function public.expire_unpaid_online_order(uuid, text) from public, anon, authenticated;
grant execute on function public.expire_unpaid_online_order(uuid, text) to service_role;

-- Order status: an online order can be confirmed for packing only after its payment is received; cancelling a
-- paid online order is recorded as needing a refund. Otherwise identical to the current definition.
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
  if p_status = 'confirmed' and v_order.payment_method = 'razorpay' and v_order.payment_status <> 'paid' then
    raise exception 'This order is waiting for its online payment; confirm it after the payment is received' using errcode = '22023';
  end if;

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
    update public.payments set status = 'failed', updated_at = now() where order_id = p_order_id and provider = 'razorpay' and status in ('created','failed');
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
          jsonb_build_object('from', v_order.status, 'to', p_status, 'reason', left(coalesce(p_reason, ''), 500))
          || case when p_status = 'cancelled' and v_order.payment_status in ('paid','partially_refunded') then jsonb_build_object('refund_required', true) else '{}'::jsonb end);
  return jsonb_build_object('order_id', p_order_id, 'status', p_status)
         || case when p_status = 'cancelled' and v_order.payment_status in ('paid','partially_refunded') then jsonb_build_object('refund_required', true) else '{}'::jsonb end;
end;
$function$;
