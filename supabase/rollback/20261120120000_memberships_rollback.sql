-- Rollback for 20261120120000_memberships.sql (owner approval required; deletes membership data).
-- Roll back 20261120130000_promotions_checkout.sql FIRST (its checkout function calls private.has_active_membership).
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
