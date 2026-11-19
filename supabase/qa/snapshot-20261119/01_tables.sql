-- part: 01_tables
-- Generated from production qebdpjzhbqzjbvjqeztl structure on 2026-11-19 (no data).

create table public.addresses (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  label text default 'Home'::text,
  recipient_name text not null,
  phone text not null,
  address_line1 text not null,
  address_line2 text,
  landmark text,
  area text,
  city text default 'Hyderabad'::text not null,
  state text default 'Telangana'::text not null,
  pincode text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  delivery_instructions text,
  is_default boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.audit_logs (
  id uuid default gen_random_uuid() not null,
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);

create table public.bargain_offer_history (
  id uuid default gen_random_uuid() not null,
  bargain_request_id uuid not null,
  actor_id uuid,
  actor_role text not null,
  action text not null,
  amount_paise integer,
  note text,
  created_at timestamp with time zone default now() not null
);

create table public.bargain_requests (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  product_id uuid not null,
  variant_id uuid not null,
  product_name text not null,
  variant_name text not null,
  quantity_kg numeric(5,1) not null,
  rate_per_kg_paise integer not null,
  regular_estimate_paise integer not null,
  offer_total_paise integer not null,
  counter_total_paise integer,
  agreed_total_paise integer,
  status text default 'pending'::text not null,
  customer_note text,
  admin_reason text,
  expires_at timestamp with time zone,
  responded_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.cart_items (
  id uuid default gen_random_uuid() not null,
  cart_id uuid not null,
  variant_id uuid not null,
  quantity numeric(12,3) not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.carts (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  coupon_id uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.categories (
  id uuid default gen_random_uuid() not null,
  name text not null,
  slug text not null,
  description text,
  image_url text,
  sort_order integer default 0 not null,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.coupon_redemptions (
  id uuid default gen_random_uuid() not null,
  coupon_id uuid not null,
  user_id uuid not null,
  order_id uuid,
  discount_paise integer not null,
  redeemed_at timestamp with time zone default now() not null
);

create table public.coupons (
  id uuid default gen_random_uuid() not null,
  code text not null,
  description text,
  discount_type text not null,
  discount_value integer not null,
  max_discount_paise integer,
  min_order_paise integer default 0 not null,
  usage_limit integer,
  per_user_limit integer,
  starts_at timestamp with time zone,
  expires_at timestamp with time zone,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.delivery_assignments (
  id uuid default gen_random_uuid() not null,
  order_id uuid not null,
  delivery_staff_id uuid,
  assigned_by uuid,
  status text default 'assigned'::text not null,
  assigned_at timestamp with time zone default now() not null,
  accepted_at timestamp with time zone,
  picked_up_at timestamp with time zone,
  delivered_at timestamp with time zone,
  proof_image_path text,
  delivery_note text,
  updated_at timestamp with time zone default now() not null
);

create table public.delivery_slots (
  id uuid default gen_random_uuid() not null,
  zone_id uuid,
  label text not null,
  starts_at time without time zone not null,
  ends_at time without time zone not null,
  max_orders integer default 20 not null,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null
);

create table public.delivery_staff (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  display_name text not null,
  phone text,
  vehicle_type text,
  vehicle_number text,
  is_available boolean default true not null,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.delivery_zones (
  id uuid default gen_random_uuid() not null,
  name text not null,
  pincode text,
  areas text[] default '{}'::text[] not null,
  delivery_fee_paise integer default 0 not null,
  free_delivery_min_paise integer,
  minimum_order_paise integer default 0 not null,
  estimated_minutes integer,
  is_active boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.inventory (
  variant_id uuid not null,
  quantity_on_hand numeric(12,3) default 0 not null,
  quantity_reserved numeric(12,3) default 0 not null,
  reorder_level numeric(12,3) default 0 not null,
  updated_at timestamp with time zone default now() not null
);

create table public.inventory_transactions (
  id uuid default gen_random_uuid() not null,
  variant_id uuid not null,
  transaction_type text not null,
  quantity_delta numeric(12,3) not null,
  reference_type text,
  reference_id uuid,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null
);

create table public.order_item_checks (
  order_item_id uuid not null,
  order_id uuid not null,
  status text not null,
  weighed_quantity numeric(10,3),
  note text,
  checked_by uuid,
  checked_at timestamp with time zone default now() not null
);

create table public.order_items (
  id uuid default gen_random_uuid() not null,
  order_id uuid not null,
  variant_id uuid,
  product_name text not null,
  variant_name text not null,
  sku text,
  quantity numeric(12,3) not null,
  unit_price_paise integer not null,
  line_total_paise integer not null,
  created_at timestamp with time zone default now() not null
);

create table public.orders (
  id uuid default gen_random_uuid() not null,
  order_number text not null,
  user_id uuid not null,
  address_id uuid,
  delivery_zone_id uuid,
  delivery_slot_id uuid,
  status text default 'pending'::text not null,
  payment_status text default 'pending'::text not null,
  payment_method text default 'cod'::text not null,
  subtotal_paise integer not null,
  discount_paise integer default 0 not null,
  delivery_fee_paise integer default 0 not null,
  tax_paise integer default 0 not null,
  total_paise integer not null,
  coupon_code text,
  delivery_address_snapshot jsonb not null,
  customer_note text,
  cancellation_reason text,
  placed_at timestamp with time zone default now() not null,
  confirmed_at timestamp with time zone,
  delivered_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  delivery_date date,
  delivery_type text default 'advance'::text
);

create table public.payments (
  id uuid default gen_random_uuid() not null,
  order_id uuid not null,
  provider text default 'razorpay'::text not null,
  provider_order_id text,
  provider_payment_id text,
  provider_signature text,
  amount_paise integer not null,
  currency text default 'INR'::text not null,
  status text default 'created'::text not null,
  raw_response jsonb,
  paid_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.product_images (
  id uuid default gen_random_uuid() not null,
  product_id uuid not null,
  variant_id uuid,
  storage_path text not null,
  alt_text text,
  sort_order integer default 0 not null,
  is_primary boolean default false not null,
  created_at timestamp with time zone default now() not null
);

create table public.product_variants (
  id uuid default gen_random_uuid() not null,
  product_id uuid not null,
  name text not null,
  sku text,
  quantity numeric(12,3) not null,
  unit text default 'kg'::text not null,
  price_paise integer not null,
  compare_at_price_paise integer,
  is_default boolean default false not null,
  is_active boolean default true not null,
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.products (
  id uuid default gen_random_uuid() not null,
  category_id uuid,
  name text not null,
  slug text not null,
  description text,
  telugu_name text,
  unit_type text default 'weight'::text not null,
  is_active boolean default true not null,
  is_featured boolean default false not null,
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.profiles (
  id uuid not null,
  full_name text,
  phone text,
  email text,
  avatar_url text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.purchase_order_items (
  id uuid default gen_random_uuid() not null,
  purchase_order_id uuid not null,
  variant_id uuid not null,
  quantity_ordered numeric(12,3) not null,
  quantity_received numeric(12,3) default 0 not null,
  unit_cost_paise integer not null
);

create table public.purchase_orders (
  id uuid default gen_random_uuid() not null,
  supplier_id uuid,
  po_number text not null,
  status text default 'draft'::text not null,
  ordered_at timestamp with time zone,
  expected_at timestamp with time zone,
  received_at timestamp with time zone,
  subtotal_paise integer default 0 not null,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.store_settings (
  key text not null,
  value jsonb not null,
  is_public boolean default false not null,
  updated_at timestamp with time zone default now() not null
);

create table public.suppliers (
  id uuid default gen_random_uuid() not null,
  name text not null,
  contact_person text,
  phone text,
  email text,
  address text,
  notes text,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.user_roles (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  role text not null,
  created_at timestamp with time zone default now() not null
);
