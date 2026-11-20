-- Rollback for 20261121100000_cart_guest_merge.sql (owner approval required).
-- cart_merges holds only merge bookkeeping (no basket contents), so dropping it loses no customer data; basket
-- lines themselves live in cart_items and are untouched. Deploy the previous storefront first (it does not call
-- merge_guest_cart), then run this.
drop function if exists public.merge_guest_cart(text, jsonb);
drop table if exists public.cart_merges;
