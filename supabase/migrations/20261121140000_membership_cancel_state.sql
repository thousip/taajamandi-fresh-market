-- Launch build (21 Nov 2026): record that a member asked to cancel at the end of the current period.
-- Razorpay keeps the subscription active until the period ends and then sends subscription.cancelled; until then the
-- customer must see "ends on …" instead of "renews on …". Additive only: one nullable column, set ONLY by the
-- membership-ops Edge Function (service role) after Razorpay accepted the cancellation. my_membership() also returns it.
-- Rollback: supabase/rollback/20261121140000_membership_cancel_state_rollback.sql

alter table public.memberships add column if not exists cancel_requested_at timestamptz;

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
    'free_deliveries', v_p.free_deliveries, 'used', v_used, 'remaining', greatest(v_p.free_deliveries - v_used, 0),
    'cancel_at_period_end', v_m.cancel_requested_at is not null, 'cancel_requested_at', v_m.cancel_requested_at);
end;
$function$;
revoke all on function public.my_membership() from public, anon;
grant execute on function public.my_membership() to authenticated;
