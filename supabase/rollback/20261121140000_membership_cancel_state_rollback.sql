-- Rollback for 20261121140000_membership_cancel_state.sql (owner approval required).
-- Deploy the previous membership-ops and website first (they read/write cancel_requested_at).
-- Data guard: refuses while any membership records a pending cancellation (that information would be lost).
do $guard$
declare n bigint;
begin
  select count(*) into n from public.memberships where cancel_requested_at is not null;
  if n > 0 then raise exception 'Rollback refused: % membership(s) record a cancellation request.', n; end if;
end
$guard$;

-- my_membership() exactly as in 20261120120000_memberships.sql.
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

alter table public.memberships drop column if exists cancel_requested_at;
