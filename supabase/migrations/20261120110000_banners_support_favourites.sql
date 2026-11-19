-- Overnight build (20 Nov 2026): promotional banners, customer support tickets, favourites, and an audit trigger
-- for admin-managed configuration tables. Additive only: no existing table, column, policy or function changes.
-- QA first; production needs separate owner approval.
-- Rollback: supabase/rollback/20261120110000_banners_support_favourites_rollback.sql

-- Every insert/update/delete on an admin-managed config table writes an audit row in the same transaction.
-- If the audit insert fails, the change fails too (never silently unaudited).
create or replace function private.audit_admin_change()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), lower(tg_op) || '_' || tg_table_name, tg_table_name,
          case when tg_op = 'DELETE' then old.id else new.id end,
          jsonb_build_object('op', tg_op));
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;
revoke all on function private.audit_admin_change() from public, anon, authenticated;

-- ---------------------------------------------------------------- Promotional banners
create table if not exists public.promo_banners (
  id uuid primary key default gen_random_uuid(),
  heading text not null check (char_length(btrim(heading)) between 1 and 80),
  description text check (description is null or char_length(description) <= 200),
  image_path text check (image_path is null or image_path ~ '^banners/[A-Za-z0-9._/-]+$'),
  link_type text not null default 'none' check (link_type in ('none', 'category', 'product', 'deals', 'membership')),
  link_target text check (link_target is null or char_length(link_target) <= 120),
  starts_at timestamptz,
  ends_at timestamptz,
  is_enabled boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at is null or ends_at is null or ends_at > starts_at)
);
alter table public.promo_banners enable row level security;
create policy "public read live banners" on public.promo_banners for select to anon, authenticated
  using (is_enabled and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));
create policy "admin manager manage banners" on public.promo_banners for all to authenticated
  using ((select private.has_any_role(array['admin','manager'])))
  with check ((select private.has_any_role(array['admin','manager'])));
create trigger promo_banners_audit after insert or update or delete on public.promo_banners
  for each row execute function private.audit_admin_change();

-- ---------------------------------------------------------------- Customer support tickets
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  category text not null check (category in ('freshness', 'missing_item', 'delivery', 'payment', 'other')),
  message text not null check (char_length(btrim(message)) between 5 and 1000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  admin_note text check (admin_note is null or char_length(admin_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists support_tickets_user_idx on public.support_tickets (user_id, created_at desc);
alter table public.support_tickets enable row level security;
create policy "customer create own ticket" on public.support_tickets for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'open' and admin_note is null
              and (order_id is null or exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid()))));
create policy "customer read own tickets" on public.support_tickets for select to authenticated
  using (user_id = (select auth.uid()));
create policy "admin manager manage tickets" on public.support_tickets for all to authenticated
  using ((select private.has_any_role(array['admin','manager'])))
  with check ((select private.has_any_role(array['admin','manager'])));
revoke all on public.support_tickets from anon;

-- ---------------------------------------------------------------- Favourites
create table if not exists public.favourites (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);
alter table public.favourites enable row level security;
create policy "customer manage own favourites" on public.favourites for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.favourites from anon;
