-- Launch fix (21 Nov 2026): guest-basket merge that can apply only once, done atomically on the server.
-- Background: the owner reported "a random item with quantity 50 appears after login". Two causes:
--   1. The storefront clamped any oversized legacy cart row to 50 and SAVED it, turning corrupted data
--      (e.g. Brinjal 250 g x 303,872 from the old doubling bug) into a chargeable quantity of 50.
--   2. The guest basket (browser localStorage) was merged by plain read/add/write from the browser. Two tabs
--      receiving the same sign-in event could both read it before either cleared it, doubling quantities;
--      repeated logins compounded this.
-- This migration makes the merge server-side and idempotent: each guest basket carries a merge id; a merge
-- id is applied at most once per cart (primary key), inside one transaction with the cart row locked.
-- Corrupted existing rows are never modified here (the storefront quarantines them; checkout already refuses
-- lines above 50). Additive only: one new table, one new function. Rollback: supabase/rollback/20261121100000_cart_guest_merge_rollback.sql

create table if not exists public.cart_merges (
  cart_id uuid not null references public.carts(id) on delete cascade,
  merge_id text not null check (char_length(merge_id) between 8 and 80),
  merged_at timestamptz not null default now(),
  lines_applied integer not null default 0,
  primary key (cart_id, merge_id)
);
alter table public.cart_merges enable row level security;
-- No policies: nobody reads or writes this table directly; only merge_guest_cart (security definer) does.
revoke all on public.cart_merges from anon, authenticated;

-- p_items: [{"variant_id": uuid, "quantity": integer 1..50}, ...] from the guest basket. Only the signed-in
-- user's own cart is touched (auth.uid(); no user id parameter). Returns what happened per line so the
-- storefront can tell the customer; nothing is silently invented or silently dropped.
create or replace function public.merge_guest_cart(p_merge_id text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user uuid := auth.uid();
  v_cart_id uuid;
  v_item jsonb;
  v_variant uuid;
  v_qty numeric;
  v_existing public.cart_items%rowtype;
  v_new integer;
  v_applied integer := 0;
  v_capped jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_inserted integer;
begin
  if v_user is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if p_merge_id is null or char_length(p_merge_id) not between 8 and 80 then
    raise exception 'Invalid basket merge id' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then
    raise exception 'Invalid guest basket' using errcode = '22023';
  end if;

  insert into public.carts (user_id) values (v_user) on conflict (user_id) do nothing;
  select id into v_cart_id from public.carts where user_id = v_user for update;

  insert into public.cart_merges (cart_id, merge_id) values (v_cart_id, p_merge_id) on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('merged', false, 'duplicate', true, 'cart_id', v_cart_id);
  end if;

  for v_item in select x from jsonb_array_elements(p_items) x
  loop
    begin
      v_variant := (v_item ->> 'variant_id')::uuid;
      v_qty := (v_item ->> 'quantity')::numeric;
    exception when others then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('variant_id', v_item ->> 'variant_id', 'reason', 'invalid'));
      continue;
    end;
    if v_variant is null or v_qty is null or v_qty <> trunc(v_qty) or v_qty < 1 or v_qty > 50 then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('variant_id', v_variant, 'reason', 'invalid_quantity'));
      continue;
    end if;
    if not exists (select 1 from public.product_variants pv join public.products p on p.id = pv.product_id
                   where pv.id = v_variant and pv.is_active and p.is_active) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('variant_id', v_variant, 'reason', 'not_available'));
      continue;
    end if;
    select * into v_existing from public.cart_items where cart_id = v_cart_id and variant_id = v_variant for update;
    if not found then
      insert into public.cart_items (cart_id, variant_id, quantity) values (v_cart_id, v_variant, v_qty);
      v_applied := v_applied + 1;
    elsif v_existing.quantity <> trunc(v_existing.quantity) or v_existing.quantity < 1 or v_existing.quantity > 50 then
      -- A corrupted account line is never "repaired" by adding to it; the customer resolves it explicitly.
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('variant_id', v_variant, 'reason', 'existing_line_needs_attention'));
    else
      v_new := (v_existing.quantity + v_qty)::integer;
      if v_new > 50 then
        v_capped := v_capped || jsonb_build_array(jsonb_build_object('variant_id', v_variant, 'requested', v_new));
        v_new := 50;
      end if;
      update public.cart_items set quantity = v_new, updated_at = now() where id = v_existing.id;
      v_applied := v_applied + 1;
    end if;
  end loop;

  update public.cart_merges set lines_applied = v_applied where cart_id = v_cart_id and merge_id = p_merge_id;
  return jsonb_build_object('merged', true, 'duplicate', false, 'cart_id', v_cart_id, 'applied', v_applied,
                            'capped', v_capped, 'skipped', v_skipped);
end;
$function$;
revoke all on function public.merge_guest_cart(text, jsonb) from public, anon;
grant execute on function public.merge_guest_cart(text, jsonb) to authenticated;
