-- Bulk-purchase bargain negotiation.
-- A bargain is an ENQUIRY only: it never creates an order, reserves inventory, deducts stock or
-- changes catalogue prices. Customers place a normal checkout separately.
-- Rules: weight-based variants only (unit kg or g); 5–50 kg in 0.5 kg steps; offers are TOTAL
-- amounts in integer paise. All writes go through SECURITY DEFINER functions; tables are read-only
-- to clients through RLS (own rows for customers, all rows for admin/manager).

create table if not exists public.bargain_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id),
  variant_id uuid not null references public.product_variants(id),
  product_name text not null,
  variant_name text not null,
  quantity_kg numeric(5,1) not null
    check (quantity_kg >= 5 and quantity_kg <= 50 and (quantity_kg * 2) = trunc(quantity_kg * 2)),
  rate_per_kg_paise integer not null check (rate_per_kg_paise > 0),
  regular_estimate_paise integer not null check (regular_estimate_paise > 0),
  offer_total_paise integer not null check (offer_total_paise > 0),
  counter_total_paise integer check (counter_total_paise > 0),
  agreed_total_paise integer check (agreed_total_paise > 0),
  status text not null default 'pending'
    check (status in ('pending','countered','approved','accepted','rejected','declined','cancelled','expired')),
  customer_note text check (char_length(customer_note) <= 500),
  admin_reason text check (char_length(admin_reason) <= 500),
  expires_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bargain_requests_user_idx on public.bargain_requests (user_id, created_at desc);
create index if not exists bargain_requests_status_idx on public.bargain_requests (status, created_at desc);

create table if not exists public.bargain_offer_history (
  id uuid primary key default gen_random_uuid(),
  bargain_request_id uuid not null references public.bargain_requests(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  actor_role text not null check (actor_role in ('customer','admin','system')),
  action text not null check (action in ('submitted','countered','approved','rejected','accepted','declined','cancelled','expired')),
  amount_paise integer check (amount_paise > 0),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists bargain_offer_history_request_idx on public.bargain_offer_history (bargain_request_id, created_at);

alter table public.bargain_requests enable row level security;
alter table public.bargain_offer_history enable row level security;
-- Explicit privileges (do not rely on project default grants): clients may only read, via RLS.
revoke all on public.bargain_requests, public.bargain_offer_history from anon, authenticated;
grant select on public.bargain_requests, public.bargain_offer_history to authenticated;
grant all on public.bargain_requests, public.bargain_offer_history to service_role;

drop policy if exists "bargains read own" on public.bargain_requests;
create policy "bargains read own" on public.bargain_requests
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "bargains admin read" on public.bargain_requests;
create policy "bargains admin read" on public.bargain_requests
  for select to authenticated using ((select private.has_any_role(array['admin','manager'])));
drop policy if exists "bargain history read own" on public.bargain_offer_history;
create policy "bargain history read own" on public.bargain_offer_history
  for select to authenticated using (exists (
    select 1 from public.bargain_requests br
    where br.id = bargain_request_id and br.user_id = (select auth.uid())));
drop policy if exists "bargain history admin read" on public.bargain_offer_history;
create policy "bargain history admin read" on public.bargain_offer_history
  for select to authenticated using ((select private.has_any_role(array['admin','manager'])));

drop trigger if exists bargain_requests_updated_at on public.bargain_requests;
create trigger bargain_requests_updated_at before update on public.bargain_requests
  for each row execute function public.set_updated_at();

-- Customer: submit -------------------------------------------------------------------------
create or replace function public.submit_bargain_request(p_variant_id uuid, p_quantity_kg numeric, p_offer_total_paise integer, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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
$function$;

-- Customer: accept / decline a counter-offer, or cancel an open request ------------------------
create or replace function public.respond_bargain_request(p_request_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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
$function$;

-- Admin / manager: approve, reject (reason required) or counter (amount + expiry required) ------
create or replace function public.admin_respond_bargain(p_request_id uuid, p_action text, p_counter_total_paise integer default null,
                                                        p_reason text default null, p_expires_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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
$function$;

revoke all on function public.submit_bargain_request(uuid, numeric, integer, text) from public, anon;
revoke all on function public.respond_bargain_request(uuid, text, text) from public, anon;
revoke all on function public.admin_respond_bargain(uuid, text, integer, text, timestamptz) from public, anon;
grant execute on function public.submit_bargain_request(uuid, numeric, integer, text) to authenticated;
grant execute on function public.respond_bargain_request(uuid, text, text) to authenticated;
grant execute on function public.admin_respond_bargain(uuid, text, integer, text, timestamptz) to authenticated;
