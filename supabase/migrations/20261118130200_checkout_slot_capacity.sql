-- Checkout wrapper: enforce delivery-slot capacity (max_orders per slot per delivery date) and reject
-- same-day orders for a slot that has already ended (Asia/Kolkata). The slot row is locked so two
-- concurrent checkouts cannot both take the last place. Booking-date rules stay in the orders trigger.

create or replace function public.create_order_from_cart(
  p_user_id uuid, p_address_id uuid, p_delivery_zone_id uuid, p_delivery_slot_id uuid,
  p_payment_method text, p_customer_note text, p_requested_delivery_date date, p_delivery_type text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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
$function$;
revoke all on function public.create_order_from_cart(uuid, uuid, uuid, uuid, text, text, date, text) from public, anon, authenticated;
grant execute on function public.create_order_from_cart(uuid, uuid, uuid, uuid, text, text, date, text) to service_role;

-- Customers may read their own role rows (needed for client-side role checks). Nobody can write
-- roles from the client; assignments stay in service-role Edge Functions.
drop policy if exists "user roles read own" on public.user_roles;
create policy "user roles read own" on public.user_roles
  for select to authenticated using (user_id = (select auth.uid()));
