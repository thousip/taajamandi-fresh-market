-- part: 07_rls_policies

alter table public.addresses enable row level security;
alter table public.audit_logs enable row level security;
alter table public.bargain_offer_history enable row level security;
alter table public.bargain_requests enable row level security;
alter table public.cart_items enable row level security;
alter table public.carts enable row level security;
alter table public.categories enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.coupons enable row level security;
alter table public.delivery_assignments enable row level security;
alter table public.delivery_slots enable row level security;
alter table public.delivery_staff enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.inventory enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.order_item_checks enable row level security;
alter table public.order_items enable row level security;
alter table public.orders enable row level security;
alter table public.payments enable row level security;
alter table public.product_images enable row level security;
alter table public.product_variants enable row level security;
alter table public.products enable row level security;
alter table public.profiles enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.store_settings enable row level security;
alter table public.suppliers enable row level security;
alter table public.user_roles enable row level security;

create policy "addresses own all" on public.addresses as permissive for all to authenticated
  using ((( SELECT auth.uid() AS uid) = user_id))
  with check ((( SELECT auth.uid() AS uid) = user_id));
create policy "admin read audit logs" on public.audit_logs as permissive for select to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "bargain history admin read" on public.bargain_offer_history as permissive for select to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "bargain history read own" on public.bargain_offer_history as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM bargain_requests br
  WHERE ((br.id = bargain_offer_history.bargain_request_id) AND (br.user_id = ( SELECT auth.uid() AS uid))))));
create policy "bargains admin read" on public.bargain_requests as permissive for select to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "bargains read own" on public.bargain_requests as permissive for select to authenticated
  using ((user_id = ( SELECT auth.uid() AS uid)));
create policy "cart items own delete" on public.cart_items as permissive for delete to authenticated
  using ((EXISTS ( SELECT 1
   FROM carts c
  WHERE ((c.id = cart_items.cart_id) AND (c.user_id = ( SELECT auth.uid() AS uid))))));
create policy "cart items own insert" on public.cart_items as permissive for insert to authenticated
  with check ((EXISTS ( SELECT 1
   FROM carts c
  WHERE ((c.id = cart_items.cart_id) AND (c.user_id = ( SELECT auth.uid() AS uid))))));
create policy "cart items own select" on public.cart_items as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM carts c
  WHERE ((c.id = cart_items.cart_id) AND (c.user_id = ( SELECT auth.uid() AS uid))))));
create policy "cart items own update" on public.cart_items as permissive for update to authenticated
  using ((EXISTS ( SELECT 1
   FROM carts c
  WHERE ((c.id = cart_items.cart_id) AND (c.user_id = ( SELECT auth.uid() AS uid))))))
  with check ((EXISTS ( SELECT 1
   FROM carts c
  WHERE ((c.id = cart_items.cart_id) AND (c.user_id = ( SELECT auth.uid() AS uid))))));
create policy "carts own delete" on public.carts as permissive for delete to authenticated
  using ((( SELECT auth.uid() AS uid) = user_id));
create policy "carts own insert" on public.carts as permissive for insert to authenticated
  with check ((( SELECT auth.uid() AS uid) = user_id));
create policy "carts own select" on public.carts as permissive for select to authenticated
  using ((( SELECT auth.uid() AS uid) = user_id));
create policy "carts own update" on public.carts as permissive for update to authenticated
  using ((( SELECT auth.uid() AS uid) = user_id))
  with check ((( SELECT auth.uid() AS uid) = user_id));
create policy "admin manager all categories" on public.categories as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "public read active categories" on public.categories as permissive for select to anon, authenticated
  using ((is_active = true));
create policy "admin manage redemptions" on public.coupon_redemptions as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "customers read own coupon redemptions" on public.coupon_redemptions as permissive for select to authenticated
  using ((( SELECT auth.uid() AS uid) = user_id));
create policy "admin manage coupons" on public.coupons as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "admin manage delivery assignments" on public.delivery_assignments as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "staff read assigned deliveries" on public.delivery_assignments as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM delivery_staff ds
  WHERE ((ds.id = delivery_assignments.delivery_staff_id) AND (ds.user_id = ( SELECT auth.uid() AS uid))))));
create policy "admin manage slots" on public.delivery_slots as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "public read active delivery slots" on public.delivery_slots as permissive for select to anon, authenticated
  using (((is_active = true) AND ((zone_id IS NULL) OR (EXISTS ( SELECT 1
   FROM delivery_zones z
  WHERE ((z.id = delivery_slots.zone_id) AND (z.is_active = true)))))));
create policy "admin manage delivery staff" on public.delivery_staff as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "staff read own delivery profile" on public.delivery_staff as permissive for select to authenticated
  using ((( SELECT auth.uid() AS uid) = user_id));
create policy "admin manage zones" on public.delivery_zones as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "public read active delivery zones" on public.delivery_zones as permissive for select to anon, authenticated
  using ((is_active = true));
create policy "admin manager inventory" on public.inventory as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text, 'inventory_staff'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text, 'inventory_staff'::text]) AS has_any_role));
create policy "admin manager inventory transactions" on public.inventory_transactions as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text, 'inventory_staff'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text, 'inventory_staff'::text]) AS has_any_role));
create policy "item checks staff read" on public.order_item_checks as permissive for select to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text, 'packer_staff'::text]) AS has_any_role));
create policy "admin manage order items" on public.order_items as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "customers read own order items" on public.order_items as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = order_items.order_id) AND (o.user_id = ( SELECT auth.uid() AS uid))))));
create policy "admin manage orders" on public.orders as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "customers read own orders" on public.orders as permissive for select to authenticated
  using ((( SELECT auth.uid() AS uid) = user_id));
create policy "admin manage payments" on public.payments as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "customers read own payments" on public.payments as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = payments.order_id) AND (o.user_id = ( SELECT auth.uid() AS uid))))));
create policy "admin manager all product images" on public.product_images as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "public read product images" on public.product_images as permissive for select to anon, authenticated
  using ((EXISTS ( SELECT 1
   FROM products p
  WHERE ((p.id = product_images.product_id) AND (p.is_active = true)))));
create policy "admin manager all variants" on public.product_variants as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "public read active variants" on public.product_variants as permissive for select to anon, authenticated
  using (((is_active = true) AND (EXISTS ( SELECT 1
   FROM products p
  WHERE ((p.id = product_variants.product_id) AND (p.is_active = true))))));
create policy "admin manager all products" on public.products as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "public read active products" on public.products as permissive for select to anon, authenticated
  using ((is_active = true));
create policy "admin read customer profiles" on public.profiles as permissive for select to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "profile read own" on public.profiles as permissive for select to authenticated
  using ((( SELECT auth.uid() AS uid) = id));
create policy "profile update own" on public.profiles as permissive for update to authenticated
  using ((( SELECT auth.uid() AS uid) = id))
  with check ((( SELECT auth.uid() AS uid) = id));
create policy "admin manager purchase items" on public.purchase_order_items as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text, 'inventory_staff'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text, 'inventory_staff'::text]) AS has_any_role));
create policy "admin manager purchase orders" on public.purchase_orders as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text, 'inventory_staff'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text, 'inventory_staff'::text]) AS has_any_role));
create policy "admin manage store settings" on public.store_settings as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text]) AS has_any_role));
create policy "public read public store settings" on public.store_settings as permissive for select to anon, authenticated
  using ((is_public = true));
create policy "admin manager suppliers" on public.suppliers as permissive for all to authenticated
  using (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role))
  with check (( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role));
create policy "user roles read own" on public.user_roles as permissive for select to authenticated
  using ((user_id = ( SELECT auth.uid() AS uid)));
