-- Rollback for 20261120120000_memberships.sql (owner approval required; refuses to run while the new tables hold data).
-- Roll back 20261120130000_promotions_checkout.sql FIRST (its checkout function calls private.has_active_membership).
-- Data guard: refuses to run while any of these tables holds rows, so no data is ever deleted by a rollback.
-- If it refuses, leave the tables in place and switch the feature off instead (disable the plan, deal, banner...).
do $guard$
declare t text; n bigint;
begin
  foreach t in array array['public.memberships', 'public.membership_ledger', 'public.payment_webhook_events'] loop
    if to_regclass(t) is not null then
      execute format('select count(*) from %s', t) into n;
      if n > 0 then
        raise exception 'Rollback refused: % holds % row(s). Switch the feature off instead of deleting data.', t, n;
      end if;
    end if;
  end loop;
end
$guard$;

drop function if exists public.apply_razorpay_subscription_event(text, text, jsonb);
drop trigger if exists order_cancel_restores_membership on public.orders;
drop function if exists private.restore_membership_delivery();
drop function if exists public.my_membership();
drop function if exists private.has_active_membership(uuid);
drop trigger if exists membership_plans_audit on public.membership_plans;
drop function if exists private.audit_plan_change();
drop table if exists public.payment_webhook_events;
drop table if exists public.membership_ledger;
drop table if exists public.memberships;
drop table if exists public.membership_plans;
