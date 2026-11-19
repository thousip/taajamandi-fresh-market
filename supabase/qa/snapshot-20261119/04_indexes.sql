-- part: 04_indexes
-- Indexes not created by constraints.

CREATE INDEX addresses_user_idx ON public.addresses USING btree (user_id);
CREATE INDEX bargain_offer_history_request_idx ON public.bargain_offer_history USING btree (bargain_request_id, created_at);
CREATE INDEX bargain_requests_status_idx ON public.bargain_requests USING btree (status, created_at DESC);
CREATE INDEX bargain_requests_user_idx ON public.bargain_requests USING btree (user_id, created_at DESC);
CREATE INDEX cart_items_cart_idx ON public.cart_items USING btree (cart_id);
CREATE INDEX coupon_redemptions_coupon_user_idx ON public.coupon_redemptions USING btree (coupon_id, user_id);
CREATE INDEX delivery_assignments_staff_status_idx ON public.delivery_assignments USING btree (delivery_staff_id, status);
CREATE INDEX inventory_transactions_variant_date_idx ON public.inventory_transactions USING btree (variant_id, created_at DESC);
CREATE INDEX order_item_checks_order_idx ON public.order_item_checks USING btree (order_id);
CREATE INDEX order_items_order_idx ON public.order_items USING btree (order_id);
CREATE INDEX idx_orders_delivery_date_status ON public.orders USING btree (delivery_date, status);
CREATE INDEX orders_delivery_date_idx ON public.orders USING btree (delivery_date);
CREATE INDEX orders_status_created_idx ON public.orders USING btree (status, created_at DESC);
CREATE INDEX orders_user_created_idx ON public.orders USING btree (user_id, created_at DESC);
CREATE INDEX payments_order_idx ON public.payments USING btree (order_id);
CREATE INDEX variants_product_active_idx ON public.product_variants USING btree (product_id, is_active, sort_order);
CREATE INDEX products_category_active_idx ON public.products USING btree (category_id, is_active, sort_order);
