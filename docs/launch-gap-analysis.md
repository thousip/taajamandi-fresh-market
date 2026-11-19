# TaajaMandi launch gap analysis — 18 Nov 2026

> **Status update, 19 Nov 2026 (historical document — kept for the record).** Defects 1–4 below were fixed by the
> 18 Nov migrations (`order_lifecycle_fixes`, `checkout_slot_capacity`, `launch_booking_rules`) and verified on QA:
> supplier-fulfilled orders can be delivered, failed deliveries return to `packed`, packers can only start confirmed
> orders, and slot capacity is enforced. The booking rule in decision 1 was replaced by the owner's final rule:
> before 1 Dec 2026 only advance delivery on 1 Dec or any later date; from 1 Dec same-day (today) or advance (future).
> The storefront described here as "standalone" is now the live root `index.html` + `public/js/`. Current state:
> `README.md` and `roadmap.md`.

Read-only audit of GitHub `thousip/taajamandi-fresh-market`, Vercel project `taajamandi`, Supabase `qebdpjzhbqzjbvjqeztl`
(schema, RLS, RPCs, triggers, all 8 Edge Functions) and the supplied storefront HTML. Nothing was written to production.

## 1. What is actually live

| Item | Finding |
|---|---|
| Public site | `taajamandi.vercel.app` (prod deploy from `main` @ `d0b56be` "Add files via upload"). It serves the **standalone HTML storefront** (root `index.html`), not the React app. |
| Supplied "final HTML" | `Downloads/TaajaMandi-Updated-Product-Bargain (1).html` = an earlier copy of that same storefront (Nov 17). Same design as live. |
| Improved storefront | `Desktop/standalone/index.html` (this session): real 250 g/500 g/1 kg selection, GPS serviceability, booking rules, bargain sheet, `saveStoreSettings` fix, 25 passing tests. **Not deployed.** |
| React app (`src/`) | Storefront/checkout/admin/orders/delivery are disabled placeholders. Only `/packer` is real. Branch `taajamandi-launch-ready` (5 commits ahead) has catalogue/image work and deletes root `index.html`. |
| Local working folder | A zip snapshot, **not a git repo**; several `src/` files differ from `main`. Real work must happen in a fresh clone. |
| Data | 134 active products / 278 variants, 7 active zones, 16 active slots, 281 inventory rows, **2 real pending orders** (no delivery date), 1 admin, 0 delivery staff, 0 packers. |

## 2. Backend contracts (verified)

- `create-order` → `create_order_from_cart(…8 args)`: COD only, checks address ownership + GPS within **7,400 m** of 17.5299559, 78.3055903, booking rules, zone active + minimum order, slot active. Atomic; cart row-locked then emptied (a second submit fails with "cart is empty" — natural idempotency). **No slot capacity check. No stock reservation** (supplier-backed: inserts zero inventory rows only).
- DB trigger `enforce_taajamandi_delivery_schedule` + `create-order` both enforce: before 1 Dec → advance, any future date; on 1 Dec → only 2 Dec; from 2 Dec → same-day today or advance future.
- `admin-ops`: `inventory_adjust`, `order_status`, `assign_delivery`, `invite_delivery_staff` (admin/manager).
- `staff-admin`: invite packer. `packer-ops`: `queue`, `update` (processing/packed). `my-deliveries`, `delivery-update` (accepted → picked_up → delivered/failed) with ownership checks.
- Status lifecycle enforced server-side in `admin_update_order_status`, `packer_update_order_status`, `delivery_update_assignment`, all writing `audit_logs`.

## 3. Launch-blocking defects found

1. **No order can be completed.** `delivery_update_assignment('delivered')` and `admin_update_order_status('delivered')` require `inventory.quantity_reserved ≥ qty`, but checkout never reserves (supplier model). Every delivery completion raises "Reserved stock is inconsistent". Needs a migration that records a supplier-fulfilled sale without requiring a prior reservation (no negative stock, no double deduction).
2. **Failed delivery strands the order**: assignment → `failed`, order stays `out_for_delivery`; no reassign/return path.
3. **Packers can start `pending` (unconfirmed) orders** — spec requires admin confirmation first.
4. **Slot capacity (`max_orders`) is never checked.**
5. **Booking rules disagree** between the spec, the DB trigger/Edge Function, and your last instruction (see decision 1).
6. `user_roles` has RLS with no policies (advisor INFO) — currently safe (deny-all; Edge Functions use service role) but blocks any client-side role read. Leaked-password protection is off (Auth setting, dashboard only).
7. Product-image bucket exists twice (`product-images`, `Product images`); only `product-images` is used.

## 4. Gap list vs the spec

| Area | Status |
|---|---|
| Catalogue, real variants, images, Telugu names | Done in standalone; React placeholder |
| Persistent cart (carts/cart_items) | Works in standalone (guest localStorage → merged to DB on login) |
| Auth (email/password, reset; phone OTP needs SMS provider) | Works in standalone |
| GPS + serviceability | Done in standalone (granted/denied/unsupported/timeout, 7.4 km, matches backend). **Missing:** reverse geocoding (no provider configured), saved-address book (select/edit/delete/default) |
| Checkout + COD + confirmation with date | Done in standalone; slot capacity missing server-side |
| Order history | Basic list; **missing** detail page, timeline, cancellation request |
| Bargain negotiation | **Missing backend** (no tables). Standalone sends WhatsApp enquiry only |
| Admin | Standalone has products/variants/images/inventory/orders/zones/slots/settings/staff; **missing** bargain mgmt, order detail/search, audit view, procurement view |
| Packer | React `/packer` real (queue + processing/packed); **missing** item checklist persistence, weighed qty, shortages, notes |
| Delivery | Standalone drawer only; React `/delivery` placeholder; blocked by defect 1 |
| Tests | 25 standalone + 30 React tests; no live staff acceptance possible (no staff accounts) |

## 5. Recommended sequence

1. Decisions below.
2. Migrations, reviewed locally, then applied (prefer a Supabase dev branch first): fix delivery completion for supplier-backed orders; failed-delivery handling; confirm-before-pack; slot capacity; booking rules; bargain tables + RLS + RPCs; minimal `user_roles` self-read policy.
3. Edge Function updates matching the migrations (`create-order` booking rules + capacity; new `bargain-ops`).
4. Storefront: ship the improved standalone (already tested) so customers get the fixes; then port to React screen-by-screen if still wanted.
5. Staff apps in React (`/packer` extend, `/delivery` build, admin).
6. Feature branch → Vercel preview → live acceptance with real test staff accounts → production.
