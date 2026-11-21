-- Admin-assigned free items for one customer (21 Nov 2026). Prepaid (verified online payment) orders only.
-- Design (no second cart): cart_items keeps one line per size, always priced from the catalogue, so a free line
-- cannot live there safely. A free item is an ASSIGNMENT in customer_free_items. At checkout the server adds each
-- pending assignment to an ONLINE order as a Rs 0 order line (promo_type 'free_item', promo_id = assignment id) and
-- reserves it; Cash on Delivery orders never receive it. The assignment becomes 'redeemed' only when the order's
-- payment_status turns 'paid' (set only by the verified payment path); a cancelled order returns it to 'pending'.
-- Unpaid online orders cannot be confirmed for packing, so nothing free is packed before a verified payment.
-- Browsers cannot write this table (no write policies); admins assign/cancel only through the functions below,
-- which check the role on the server and write audit_logs. Catalogue prices are never changed.
-- Rollback: supabase/rollback/20261121150000_customer_free_items_rollback.sql

create table if not exists public.customer_free_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id),
  quantity integer not null check (quantity between 1 and 10),
  status text not null default 'pending' check (status in ('pending', 'reserved', 'redeemed', 'cancelled')),
  order_id uuid references public.orders(id),
  note text check (note is null or char_length(note) <= 200),
  assigned_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  redeemed_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  check ((status in ('reserved', 'redeemed')) = (order_id is not null))
);
-- One open assignment per customer and size (no duplicates).
create unique index if not exists customer_free_items_one_open on public.customer_free_items (user_id, variant_id)
  where status in ('pending', 'reserved');
create index if not exists customer_free_items_order_idx on public.customer_free_items (order_id) where order_id is not null;
alter table public.customer_free_items enable row level security;
revoke all on public.customer_free_items from anon, authenticated;
grant select on public.customer_free_items to authenticated;
drop policy if exists "customers read own free items" on public.customer_free_items;
create policy "customers read own free items" on public.customer_free_items for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "admin read free items" on public.customer_free_items;
create policy "admin read free items" on public.customer_free_items for select to authenticated
  using ((select private.has_any_role(array['admin'::text, 'manager'::text])));

create or replace function private.require_admin()
returns uuid language plpgsql stable security definer set search_path to '' as $function$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not exists (select 1 from public.user_roles where user_id = v_actor and role in ('admin', 'manager')) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  return v_actor;
end;
$function$;
revoke all on function private.require_admin() from public, anon, authenticated;

-- Admin: find customers by name, email or phone (at least 2 characters).
create or replace function public.admin_search_customers(p_query text)
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_q text := btrim(coalesce(p_query, '')); v_rows jsonb;
begin
  perform private.require_admin();
  if char_length(v_q) < 2 then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(x order by x ->> 'full_name'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email, 'phone', p.phone) x
    from public.profiles p
    where p.full_name ilike '%' || v_q || '%' or p.email ilike '%' || v_q || '%' or p.phone ilike '%' || v_q || '%'
    order by p.full_name nulls last limit 20) s;
  return v_rows;
end;
$function$;
revoke all on function public.admin_search_customers(text) from public, anon;
grant execute on function public.admin_search_customers(text) to authenticated;

-- Admin: assign a free item to one customer. Server-side role check, catalogue checks, duplicate guard, audit.
create or replace function public.admin_assign_free_item(p_user_id uuid, p_variant_id uuid, p_quantity integer, p_note text default null)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_actor uuid := private.require_admin(); v_item public.customer_free_items%rowtype; v_v record; v_customer record;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 10 then
    raise exception 'Quantity must be between 1 and 10' using errcode = '22023';
  end if;
  select id, full_name into v_customer from public.profiles where id = p_user_id;
  if not found then raise exception 'Customer not found' using errcode = 'P0002'; end if;
  select pv.id, pv.name variant_name, p.name product_name into v_v
  from public.product_variants pv join public.products p on p.id = pv.product_id
  where pv.id = p_variant_id and pv.is_active and p.is_active and pv.is_available;
  if not found then raise exception 'That product size is not available' using errcode = '22023'; end if;
  begin
    insert into public.customer_free_items (user_id, variant_id, quantity, note, assigned_by)
    values (p_user_id, p_variant_id, p_quantity, nullif(left(btrim(coalesce(p_note, '')), 200), ''), v_actor)
    returning * into v_item;
  exception when unique_violation then
    raise exception 'This customer already has this free item waiting. Cancel it first to change it.' using errcode = '23505';
  end;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'free_item_assigned', 'customer_free_item', v_item.id,
          jsonb_build_object('customer_id', p_user_id, 'customer_name', v_customer.full_name, 'variant_id', p_variant_id,
                             'product', v_v.product_name, 'size', v_v.variant_name, 'quantity', p_quantity, 'note', v_item.note));
  return jsonb_build_object('id', v_item.id, 'customer_id', p_user_id, 'customer_name', v_customer.full_name,
    'product', v_v.product_name, 'size', v_v.variant_name, 'quantity', p_quantity, 'status', v_item.status, 'created_at', v_item.created_at);
end;
$function$;
revoke all on function public.admin_assign_free_item(uuid, uuid, integer, text) from public, anon;
grant execute on function public.admin_assign_free_item(uuid, uuid, integer, text) to authenticated;

-- Admin: cancel an assignment that has not been used (pending only). Audited.
create or replace function public.admin_cancel_free_item(p_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_actor uuid := private.require_admin(); v_item public.customer_free_items%rowtype;
begin
  update public.customer_free_items set status = 'cancelled', cancelled_by = v_actor, cancelled_at = now(), updated_at = now()
  where id = p_id and status = 'pending' returning * into v_item;
  if not found then raise exception 'Only a free item that is still waiting can be cancelled' using errcode = '22023'; end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'free_item_cancelled', 'customer_free_item', p_id, jsonb_build_object('customer_id', v_item.user_id, 'variant_id', v_item.variant_id, 'quantity', v_item.quantity));
  return jsonb_build_object('id', p_id, 'status', 'cancelled');
end;
$function$;
revoke all on function public.admin_cancel_free_item(uuid) from public, anon;
grant execute on function public.admin_cancel_free_item(uuid) to authenticated;

-- Admin: recent assignments with names (for the dashboard list).
create or replace function public.admin_list_free_items(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_rows jsonb;
begin
  perform private.require_admin();
  select coalesce(jsonb_agg(x order by (x ->> 'created_at') desc), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('id', f.id, 'status', f.status, 'quantity', f.quantity, 'note', f.note, 'created_at', f.created_at,
      'redeemed_at', f.redeemed_at, 'customer_name', c.full_name, 'customer_contact', coalesce(c.phone, c.email),
      'product', p.name, 'size', pv.name, 'order_number', o.order_number, 'assigned_by', a.full_name) x
    from public.customer_free_items f
    join public.profiles c on c.id = f.user_id
    join public.product_variants pv on pv.id = f.variant_id join public.products p on p.id = pv.product_id
    left join public.orders o on o.id = f.order_id
    left join public.profiles a on a.id = f.assigned_by
    order by f.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) s;
  return v_rows;
end;
$function$;
revoke all on function public.admin_list_free_items(integer) from public, anon;
grant execute on function public.admin_list_free_items(integer) to authenticated;

-- Payment / cancellation follow-up: redeemed only when the order is verified paid; a cancelled order gives it back.
create or replace function private.customer_free_items_follow_order()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if new.payment_status = 'paid' and old.payment_status is distinct from 'paid' then
    update public.customer_free_items set status = 'redeemed', redeemed_at = now(), updated_at = now()
    where order_id = new.id and status = 'reserved';
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    with released as (
      update public.customer_free_items set status = 'pending', order_id = null, redeemed_at = null, updated_at = now()
      where order_id = new.id and status in ('reserved', 'redeemed') returning id
    )
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
    select null, 'free_item_released', 'customer_free_item', released.id, jsonb_build_object('order_id', new.id) from released;
  end if;
  return new;
end;
$function$;
revoke all on function private.customer_free_items_follow_order() from public, anon, authenticated;
drop trigger if exists orders_customer_free_items on public.orders;
create trigger orders_customer_free_items after update of payment_status, status on public.orders
  for each row execute function private.customer_free_items_follow_order();

-- Checkout: create_order_from_cart_v3 as in 20261121120000_coupons.sql, plus the free-item block before the return.
create or replace function public.create_order_from_cart_v3(
  p_user_id uuid, p_address_id uuid, p_delivery_zone_id uuid, p_delivery_slot_id uuid, p_payment_method text,
  p_customer_note text, p_requested_delivery_date date, p_delivery_type text, p_expected_total_paise integer,
  p_coupon_code text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_result jsonb; v_code text := upper(btrim(coalesce(p_coupon_code, ''))); c public.coupons%rowtype;
  v_order public.orders%rowtype; v_eligible integer; v_offer boolean; r record; v_goods integer;
  v_gift record; v_gifts jsonb := '[]'::jsonb;
begin
  if v_code <> '' then
    -- Lock first: concurrent checkouts with the same coupon run one at a time, so limits cannot be exceeded.
    select * into c from public.coupons where code = v_code for update;
    if not found then raise exception 'This coupon code is not valid.' using errcode = '22023'; end if;
  end if;
  v_result := public.create_order_from_cart(p_user_id, p_address_id, p_delivery_zone_id, p_delivery_slot_id,
                                            p_payment_method, p_customer_note, p_requested_delivery_date, p_delivery_type);
  if v_code <> '' then
    select * into v_order from public.orders where id = (v_result ->> 'order_id')::uuid for update;
    -- Eligible value = regular-price lines only (₹1-deal units and free gifts are never discounted again).
    select coalesce(sum(oi.line_total_paise) filter (where
             (c.eligible_product_ids is null or p.id = any(c.eligible_product_ids)) and
             (c.eligible_category_ids is null or p.category_id = any(c.eligible_category_ids))), 0)
      into v_eligible
    from public.order_items oi left join public.product_variants pv on pv.id = oi.variant_id
    left join public.products p on p.id = pv.product_id
    where oi.order_id = v_order.id and oi.promo_type is null;
    v_offer := exists (select 1 from public.order_items where order_id = v_order.id and promo_type = 'deal');
    v_goods := v_order.subtotal_paise - v_order.discount_paise;
    select * into r from private.coupon_evaluate(c, p_user_id, v_goods, v_eligible, v_offer, v_order.id);
    if r.reason is not null then raise exception 'Coupon %: %', v_code, r.reason using errcode = '22023'; end if;
    update public.orders set discount_paise = discount_paise + r.discount, total_paise = total_paise - r.discount,
      coupon_code = v_code, updated_at = now() where id = v_order.id;
    update public.payments set amount_paise = amount_paise - r.discount, updated_at = now() where order_id = v_order.id;
    insert into public.coupon_redemptions (coupon_id, user_id, order_id, discount_paise) values (c.id, p_user_id, v_order.id, r.discount);
    v_result := v_result || jsonb_build_object('coupon_code', v_code, 'coupon_discount_paise', r.discount,
      'discount_paise', coalesce((v_result ->> 'discount_paise')::integer, 0) + r.discount,
      'total_paise', (v_result ->> 'total_paise')::integer - r.discount);
  end if;
  if p_expected_total_paise is not null and (v_result ->> 'total_paise')::integer <> p_expected_total_paise then
    raise exception 'Prices or offers changed while you were checking out: the total is now Rs %. Please review your basket and try again.',
      to_char((v_result ->> 'total_paise')::numeric / 100, 'FM999999990.00') using errcode = '22023';
  end if;
  -- Admin-assigned free items: added only to ONLINE (prepaid) orders, at Rs 0, and only reserved here; they become
  -- 'redeemed' when the payment is verified as paid. Totals are unchanged. COD orders leave them waiting.
  if p_payment_method = 'razorpay' then
    for v_gift in
      select f.id, f.variant_id, f.quantity, pv.name variant_name, pv.sku, p.name product_name
      from public.customer_free_items f
      join public.product_variants pv on pv.id = f.variant_id and pv.is_active and pv.is_available
      join public.products p on p.id = pv.product_id and p.is_active
      where f.user_id = p_user_id and f.status = 'pending'
      order by f.created_at, f.id
      for update of f
    loop
      insert into public.order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_paise,
                                      line_total_paise, promo_type, promo_id)
      values ((v_result ->> 'order_id')::uuid, v_gift.variant_id, v_gift.product_name, v_gift.variant_name, v_gift.sku,
              v_gift.quantity, 0, 0, 'free_item', v_gift.id);
      update public.customer_free_items set status = 'reserved', order_id = (v_result ->> 'order_id')::uuid, updated_at = now()
      where id = v_gift.id;
      v_gifts := v_gifts || jsonb_build_array(jsonb_build_object('id', v_gift.id, 'product', v_gift.product_name,
        'size', v_gift.variant_name, 'quantity', v_gift.quantity));
    end loop;
  end if;
  return v_result || jsonb_build_object('assigned_free_items', v_gifts);
end;
$function$;
revoke all on function public.create_order_from_cart_v3(uuid, uuid, uuid, uuid, text, text, date, text, integer, text) from public, anon, authenticated;
grant execute on function public.create_order_from_cart_v3(uuid, uuid, uuid, uuid, text, text, date, text, integer, text) to service_role;
