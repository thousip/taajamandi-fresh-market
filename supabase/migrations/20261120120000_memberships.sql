-- Overnight build (20 Nov 2026): memberships with an auditable free-delivery ledger and Razorpay subscription
-- events. Owner-confirmed rules: Weekly Rs 59 = 5 free deliveries per membership week; Monthly Rs 159 = 20 free
-- deliveries per membership month; no minimum order; no one-per-day limit.
-- Safety: plans are seeded DISABLED and without Razorpay plan ids; a membership becomes active ONLY through a
-- signature-verified Razorpay webhook (apply_razorpay_subscription_event, service_role only). The browser can never
-- activate a membership. Each webhook event id is processed once (payment_webhook_events primary key).
-- Benefit use (free delivery) is recorded at checkout in membership_ledger; one 'consume' and at most one
-- 'restore' per order (unique), restored automatically when an order is cancelled or refunded.
-- Rollback: supabase/rollback/20261120120000_memberships_rollback.sql

create table if not exists public.membership_plans (
  code text primary key check (code in ('weekly', 'monthly')),
  name text not null,
  price_paise integer not null check (price_paise > 0),
  free_deliveries integer not null check (free_deliveries > 0),
  period_days integer not null check (period_days > 0),
  razorpay_plan_id text unique,
  is_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.membership_plans (code, name, price_paise, free_deliveries, period_days)
values ('weekly', 'Weekly membership', 5900, 5, 7), ('monthly', 'Monthly membership', 15900, 20, 30)
on conflict (code) do nothing;
alter table public.membership_plans enable row level security;
create policy "public read membership plans" on public.membership_plans for select to anon, authenticated using (true);
create policy "admin update membership plans" on public.membership_plans for update to authenticated
  using ((select private.has_any_role(array['admin']))) with check ((select private.has_any_role(array['admin'])));

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_code text not null references public.membership_plans(code),
  status text not null default 'pending' check (status in ('pending', 'active', 'cancelled', 'halted', 'expired')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  razorpay_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'active' or (current_period_start is not null and current_period_end > current_period_start))
);
create unique index if not exists memberships_one_live_per_user on public.memberships (user_id) where status in ('pending', 'active');
alter table public.memberships enable row level security;
create policy "customer read own memberships" on public.memberships for select to authenticated using (user_id = (select auth.uid()));
create policy "admin manager read memberships" on public.memberships for select to authenticated
  using ((select private.has_any_role(array['admin','manager'])));
revoke all on public.memberships from anon;
revoke insert, update, delete, truncate on public.memberships from authenticated;

create table if not exists public.membership_ledger (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.memberships(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  entry text not null check (entry in ('consume', 'restore')),
  period_start timestamptz not null,
  created_at timestamptz not null default now(),
  unique (order_id, entry)
);
create index if not exists membership_ledger_period_idx on public.membership_ledger (membership_id, period_start);
alter table public.membership_ledger enable row level security;
create policy "customer read own ledger" on public.membership_ledger for select to authenticated
  using (exists (select 1 from public.memberships m where m.id = membership_id and m.user_id = (select auth.uid())));
create policy "admin manager read ledger" on public.membership_ledger for select to authenticated
  using ((select private.has_any_role(array['admin','manager'])));
revoke all on public.membership_ledger from anon;
revoke insert, update, delete, truncate on public.membership_ledger from authenticated;

create table if not exists public.payment_webhook_events (
  event_id text primary key,
  provider text not null default 'razorpay',
  event_type text not null,
  payload jsonb not null,
  processed boolean not null default false,
  received_at timestamptz not null default now()
);
alter table public.payment_webhook_events enable row level security;
create policy "admin read webhook events" on public.payment_webhook_events for select to authenticated
  using ((select private.has_any_role(array['admin'])));
revoke all on public.payment_webhook_events from anon;
revoke insert, update, delete, truncate on public.payment_webhook_events from authenticated;

-- membership_plans has a text key; audit row records the plan code in metadata instead of entity_id.
create or replace function private.audit_plan_change()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'update_membership_plan', 'membership_plans', null,
          jsonb_build_object('code', new.code, 'price_paise', new.price_paise, 'free_deliveries', new.free_deliveries,
                             'is_enabled', new.is_enabled, 'razorpay_plan_id_set', new.razorpay_plan_id is not null));
  return new;
end;
$function$;
revoke all on function private.audit_plan_change() from public, anon, authenticated;
drop trigger if exists membership_plans_audit on public.membership_plans;
create trigger membership_plans_audit after update on public.membership_plans
  for each row execute function private.audit_plan_change();

create or replace function private.has_active_membership(p_user_id uuid)
returns boolean language sql stable security definer set search_path to '' as $function$
  select exists (select 1 from public.memberships m
                 where m.user_id = p_user_id and m.status = 'active'
                   and now() >= m.current_period_start and now() < m.current_period_end);
$function$;
revoke all on function private.has_active_membership(uuid) from public, anon, authenticated;

-- Own membership summary for the signed-in customer (only ever reads auth.uid()'s rows).
create or replace function public.my_membership()
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_m public.memberships%rowtype; v_p public.membership_plans%rowtype; v_used integer;
begin
  if auth.uid() is null then return jsonb_build_object('status', 'signed_out'); end if;
  select * into v_m from public.memberships where user_id = auth.uid() order by created_at desc limit 1;
  if not found then return jsonb_build_object('status', 'none'); end if;
  select * into v_p from public.membership_plans where code = v_m.plan_code;
  select coalesce(sum(case when entry = 'consume' then 1 else -1 end), 0) into v_used
  from public.membership_ledger where membership_id = v_m.id and period_start = v_m.current_period_start;
  return jsonb_build_object(
    'status', case when v_m.status = 'active' and now() >= v_m.current_period_end then 'expired' else v_m.status end,
    'plan', v_m.plan_code, 'plan_name', v_p.name,
    'period_start', v_m.current_period_start, 'period_end', v_m.current_period_end,
    'free_deliveries', v_p.free_deliveries, 'used', v_used, 'remaining', greatest(v_p.free_deliveries - v_used, 0));
end;
$function$;
revoke all on function public.my_membership() from public, anon;
grant execute on function public.my_membership() to authenticated;

-- Restore a used free delivery when its order is cancelled or refunded (at most once per order).
create or replace function private.restore_membership_delivery()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  insert into public.membership_ledger (membership_id, order_id, entry, period_start)
  select l.membership_id, l.order_id, 'restore', l.period_start
  from public.membership_ledger l where l.order_id = new.id and l.entry = 'consume'
  on conflict (order_id, entry) do nothing;
  return new;
end;
$function$;
revoke all on function private.restore_membership_delivery() from public, anon, authenticated;
drop trigger if exists order_cancel_restores_membership on public.orders;
create trigger order_cancel_restores_membership
  after update of status on public.orders
  for each row when (new.status in ('cancelled', 'refunded') and old.status is distinct from new.status)
  execute function private.restore_membership_delivery();

-- Razorpay subscription events (called only by the razorpay-webhook Edge Function after it has verified the
-- signature over the raw request body). Idempotent per event id.
create or replace function public.apply_razorpay_subscription_event(p_event_id text, p_event_type text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_sub jsonb := p_payload -> 'payload' -> 'subscription' -> 'entity';
  v_sub_id text := v_sub ->> 'id';
  v_plan public.membership_plans%rowtype;
  v_m public.memberships%rowtype;
  v_user uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_status text;
  v_inserted integer;
begin
  if coalesce(btrim(p_event_id), '') = '' or coalesce(btrim(p_event_type), '') = '' then
    raise exception 'Missing webhook event id or type' using errcode = '22023';
  end if;
  insert into public.payment_webhook_events (event_id, event_type, payload) values (p_event_id, p_event_type, p_payload)
  on conflict (event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then return jsonb_build_object('duplicate', true); end if;
  if p_event_type not like 'subscription.%' or v_sub_id is null then
    update public.payment_webhook_events set processed = true where event_id = p_event_id;
    return jsonb_build_object('ignored', true);
  end if;

  select * into v_plan from public.membership_plans where razorpay_plan_id = v_sub ->> 'plan_id';
  if not found then raise exception 'Webhook is for an unknown membership plan' using errcode = '22023'; end if;

  select * into v_m from public.memberships where razorpay_subscription_id = v_sub_id for update;
  if not found then
    v_user := nullif(v_sub -> 'notes' ->> 'user_id', '')::uuid;
    if v_user is null or not exists (select 1 from auth.users where id = v_user) then
      raise exception 'Subscription is not linked to a TaajaMandi account' using errcode = '22023';
    end if;
    update public.memberships set status = 'expired', updated_at = now()
    where user_id = v_user and status = 'pending' and razorpay_subscription_id is distinct from v_sub_id;
    insert into public.memberships (user_id, plan_code, status, razorpay_subscription_id)
    values (v_user, v_plan.code, 'pending', v_sub_id) returning * into v_m;
  end if;

  v_status := case p_event_type
    when 'subscription.activated' then 'active' when 'subscription.charged' then 'active'
    when 'subscription.resumed' then 'active' when 'subscription.cancelled' then 'cancelled'
    when 'subscription.halted' then 'halted' when 'subscription.paused' then 'halted'
    when 'subscription.completed' then 'expired' when 'subscription.expired' then 'expired'
    else v_m.status end;

  if v_status = 'active' then
    v_start := coalesce(to_timestamp(nullif(v_sub ->> 'current_start', '')::bigint), now());
    v_end := coalesce(to_timestamp(nullif(v_sub ->> 'current_end', '')::bigint), v_start + make_interval(days => v_plan.period_days));
    if v_end <= v_start then v_end := v_start + make_interval(days => v_plan.period_days); end if;
    update public.memberships set status = 'active', plan_code = v_plan.code,
      current_period_start = v_start, current_period_end = v_end, updated_at = now() where id = v_m.id;
  else
    update public.memberships set status = v_status, updated_at = now() where id = v_m.id;
  end if;

  update public.payment_webhook_events set processed = true where event_id = p_event_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (null, 'membership_' || v_status, 'membership', v_m.id,
          jsonb_build_object('event_id', p_event_id, 'event_type', p_event_type, 'plan', v_plan.code));
  return jsonb_build_object('membership_id', v_m.id, 'status', v_status);
end;
$function$;
revoke all on function public.apply_razorpay_subscription_event(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_razorpay_subscription_event(text, text, jsonb) to service_role;
