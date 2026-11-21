# Release 2: production runbook (prepared 21 Nov 2026; NOTHING APPLIED)

**Status: waiting for the owner's explicit approval.** Every step below changes production and runs only after
that approval. Stop at the first failed check. Nothing in this file has been run on production except the
read-only checks under "Readiness".

- **Targets:** production Supabase `qebdpjzhbqzjbvjqeztl`, Vercel project `taajamandi`, GitHub `thousip/taajamandi-fresh-market`.
- **Release commit:** branch `launch/final-completion`, tip at the time of writing (this file's commit). `main` is at `770354d` and
  fast-forwards to it (checked; no force-push and no history rewrite).

## What the release contains

| Area | Change |
| --- | --- |
| Basket | Guest basket merged once per device on sign-in (server-side, by merge ID); corrupted lines set aside instead of changed; no reloads on token refresh |
| Online payments | Razorpay order payments (start / verify / webhook / 30-minute expiry). **Hidden in production** until live keys are set (separate approval). |
| Coupons | Coupon engine and Admin → Coupons. New coupons are disabled by default; production has none. |
| Homepage | Banner carousel with a TaajaMandi fallback slide, and the header location indicator ("Serviceable at Hyderabad") |
| Memberships | No change to production behaviour: plans stay **disabled** (no Razorpay plan IDs; Subscriptions not yet available on the Razorpay account) |

## Readiness (checked 21 Nov 2026, read-only or QA only)

| Check | Result |
| --- | --- |
| Production preflight `supabase/production/20261121_release2_preflight.sql` | **18/18 pass**: production schema is unchanged since review; none of the new objects exist; the last migration is `supplier_purchasing` |
| QA = postflight target | QA fingerprint matches all 10 expected postflight values after all QA testing |
| Production data the postflight checks | 3 orders, 6 lines, 0 promo lines, 0 banners / deals / gifts / memberships / coupons, plans disabled, 0 online orders, no basket lines above 50 |
| Automated tests on the release commit | 188/188 pass (backend 48 on Postgres 17, Razorpay 10, storefront 79, staff 10, env 8, PWA 3, vitest 30); build passes |
| QA verification with Razorpay test mode | `docs/qa-release2-verification.md`: payments (success, failed, abandoned with expiry), webhook signature, real signed events and duplicates, basket fix: **pass**. Memberships: blocked (Razorpay Subscriptions). Delivery-staff live test: not run (no QA account). |
| Rollback scripts | One per migration in `supabase/rollback/`, newest first. The banner-label rollback was added today and tested on QA inside a transaction that was rolled back. |

## Migrations (in this order; each one is its own transaction, with the same name QA recorded)

| # | Name | File | md5 (first 12) | Lines | Touches existing data? |
| --- | --- | --- | --- | --- | --- |
| 1 | `cart_guest_merge` | `20261121100000_cart_guest_merge.sql` | `dd49903c4660` | 105 | No. New `cart_merges` table (RLS, no direct access) and `merge_guest_cart` |
| 2 | `online_payments` | `20261121110000_online_payments.sql` | `3e5ff798a76b` | 219 | No. New server-only functions; the order-status function is replaced (online orders are confirmed only after payment); the rollback restores it byte-for-byte |
| 3 | `coupons` | `20261121120000_coupons.sql` | `8bba50b9a415` | 148 | No. Rules on the existing, empty coupon tables; `check_coupon`, `create_order_from_cart_v3` |
| 4 | `banner_cta` | `20261121130000_banner_cta.sql` | `9164d3b624b0` | 5 | No. One nullable column on `promo_banners` |

After each migration, check that the SQL stored in `supabase_migrations.schema_migrations` equals the file.

## Steps (after approval)

| Step | Action | Pass condition | Live site meanwhile |
| --- | --- | --- | --- |
| 0 | Owner: take a Supabase backup (Dashboard → Database → Backups). Claude's tools can't see backups. | Owner confirms | unchanged |
| 1 | Re-run the preflight | 18/18 | unchanged |
| 2 | Apply migrations 1–4, checking each stored copy | identical to file | Current site keeps working: it doesn't call the new functions, and `create-order` v7 uses `create_order_from_cart_v2`, which is unchanged |
| 3 | Run `supabase/production/20261121_release2_postflight.sql` | all rows ok (production structurally equal to QA) | unchanged |
| 4 | Deploy functions from the release commit: `payment-ops` (new), then `razorpay-webhook`, then `create-order` | Bundle hash equals QA: `payment-ops` `90a69a78…`, `razorpay-webhook` `62702c46…`, `create-order` `92fb809d…` | `payment-ops` reports `online_enabled: false` (no keys); Cash on Delivery orders still work from the current site |
| 5 | Fast-forward `main` to the release commit and push (Vercel builds production; Lovable syncs) | Vercel deployment READY on the new commit | New site goes live |
| 6 | Live checks | env = production; 134 products load; header location works; fallback banner shows; online payment **not** offered; Coupons tab is empty; no console errors | — |
| 7 | Owner: one signed-in Cash on Delivery test order, then cancel it | order placed and cancelled; basket correct after reload | — |

Unchanged in production: `admin-ops`, `membership-ops`, `packer-ops`, `delivery-update`, `my-deliveries`,
`get-my-role` and `catalogue-availability` (the `admin-ops` and `membership-ops` hashes already equal QA's).

## Kept off by this release (each is a separate owner decision)

- **Live online payments:** set the live `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`, plus
  `TAAJA_ALLOW_LIVE_PAYMENTS=true`, in production secrets; create the live webhook. Until then a live key is refused by design.
- **Memberships:** need Razorpay Subscriptions enabled, two plans, and a QA run first.
- **Coupons and banners:** nothing is created; the owner adds them in Admin when ready.

## Rollback (newest first; production data is never deleted)

| Layer | How | Notes |
| --- | --- | --- |
| Website | Vercel → promote `dpl_6kJPHHKgfU9CgxkKiqVovB4KqHZT` (770354d) | Instant. Do this first if the site misbehaves. `main` itself is never rewound by force. |
| Functions | Redeploy `create-order` and `razorpay-webhook` from `770354d`; `payment-ops` can stay (inert without keys) | Previous production hashes: `create-order` `b75bf43f…` (v7), `razorpay-webhook` `e0e44b18…` (v2) |
| Database | `supabase/rollback/20261121130000_banner_cta_rollback.sql`, then `…120000_coupons…`, `…110000_online_payments…`, `…100000_cart_guest_merge…` | Each refuses to run while its data exists (banner labels, coupons, online orders); no data is deleted |

## Approval wording

To go ahead, the owner replies with exactly: **"Approve release 2 production rollout"**. That approval covers
steps 1–6 only. It does **not** cover live payments, memberships, coupons or banners.
