# Production rollout package — Phase 1 + overnight build (prepared 20 Nov 2026)

**Status: APPLIED on 20 Nov 2026 with owner approval ("Approve full rollout").** Outcome:
- Preflight 32/32. All six migrations were applied, and the SQL stored for each one is byte-identical to its file. Postflight 38/38: production is structurally identical to QA.
- Edge Functions deployed: catalogue-availability v3, create-order v6, admin-ops v3, membership-ops v1, razorpay-webhook v1, then staff-admin v2 (retired) after the website. Bundle hashes equal QA.
- `main` was fast-forwarded c4dcf4f → 770354d; Vercel production deployment dpl_6kJPHHKgfU9CgxkKiqVovB4KqHZT. Live checks: env production, commit 770354d, 134 products, no QA banner, plans disabled, no console errors.
- Not verified by Claude: a backup in the Supabase dashboard (not visible to Claude's tools), and a signed-in admin or checkout test on production (the owner should do these).
- Website rollback target: dpl_221KCyweqc2FSwg8vnMuAWs2hsJB (c4dcf4f).
Target: production Supabase `qebdpjzhbqzjbvjqeztl`, Vercel project `taajamandi`, branch `overnight/launch-build`.

## What gets applied

Six migrations, unchanged, from `supabase/migrations/`, each applied as its own migration (one transaction each),
in this order, with the same names QA recorded:

| # | Migration name | File | md5 (first 12) | Lines |
| --- | --- | --- | --- | --- |
| 1 | `staff_role_functions` | `20261120090000_staff_role_functions.sql` | `da4eae0e37fd` | 98 |
| 2 | `variant_availability` | `20261120100000_variant_availability.sql` | `6d89c9b4bb53` | 278 |
| 3 | `banners_support_favourites` | `20261120110000_banners_support_favourites.sql` | `3b40ef94b6c8` | 83 |
| 4 | `memberships` | `20261120120000_memberships.sql` | `30c114b3322e` | 211 |
| 5 | `promotions_checkout` | `20261120130000_promotions_checkout.sql` | `532ff8e01389` | 437 |
| 6 | `supplier_purchasing` | `20261120140000_supplier_purchasing.sql` | `f30ec5acbc74` | 119 |

What they do to existing production objects (everything else is new):
- `product_variants` gets `is_available boolean not null default true`. This is a metadata-only change: every size
  stays available.
- `order_items` gets two nullable columns, `promo_type` and `promo_id`. Existing order lines are unchanged.
- `create_order_from_cart` (the 6-argument checkout core) is replaced twice. Migration 2 adds the availability
  re-check; migration 5 makes it promotion-aware. Its signature, the 8-argument wrapper and all grants stay as they
  are. With no promotions configured, totals are the same as today.
- New triggers on existing tables:
  - `product_variants`: availability history.
  - `orders`: gives a membership delivery back on cancel/refund; does nothing while there are no memberships.
  - `suppliers` and `purchase_orders`: audit rows.
- No existing data is updated or deleted. No existing policy, grant or function signature is weakened.

## Evidence that it is safe to apply

| Check | Result |
| --- | --- |
| Production structure today vs the state QA was copied from (19 Nov) | **Identical**: all 10 fingerprints match (columns, constraints, indexes, functions, triggers, RLS, policies, table grants, function grants, storage) |
| Files applied to QA vs these files | **Byte-identical**: QA's stored migration SQL md5 equals each file's md5 |
| QA applied the six files with nothing else in between | Yes: QA migration history goes from the 19 Nov rebuild directly to these six |
| Preflight on production (read-only, 20 Nov) | **32 / 32 pass** |
| Postflight on QA (the target state) | 36 / 38 pass. The 2 misses are only the production-specific order counts (QA has 1 order, production 2), as designed |
| Production data size | 2 orders, 5 order lines, 281 sizes, 0 suppliers, 1 admin, 1 delivery staff. Locks last milliseconds |
| Automated tests on the branch | 149 pass (backend 33, including rollback guards for migrations 2–6, storefront 59, staff 10, env 8, Razorpay 6, PWA 3, vitest 30); build passes |
| Real-database end-to-end on QA (rolled back) | Deal, free gift, totals, price-mismatch refusal, duplicate webhook and stock receiving all correct |

## Step-by-step (each step only after the previous one passes)

1. **Owner approval** of this package (the exact wording to give is at the bottom).
2. Confirm in the Supabase dashboard that a recent backup exists for production.
3. **Preflight** — run `20261120_rollout_preflight.sql` (read-only). Every row must be `ok = true`. Any `false`: stop.
4. **Migrations 1–6** — apply each file in the order above with its migration name. If one fails, Postgres rolls
   that migration back by itself. Stop there. The earlier migrations are additive and the live site keeps
   working with them (see "Live site during the rollout").
5. **Postflight** — run `20261120_rollout_postflight.sql` (read-only). Every row must be `ok = true`. If orders
   arrived in the meantime, counts can only grow; that is fine.
6. **Edge Functions**, in this order, from `supabase/functions/` at commit `04f51c3` (verify_jwt as in `supabase/config.toml`):

   | Function | Production now | Deploy | verify_jwt |
   | --- | --- | --- | --- |
   | `catalogue-availability` | v2 | Phase 1D version (reads `is_available`) | false |
   | `create-order` | v5 | v6 (calls `create_order_from_cart_v2`) | true |
   | `admin-ops` | v2 | staff roles, availability, purchase receiving | true |
   | `membership-ops` | — | new; replies "not configured" until Razorpay secrets exist | true |
   | `razorpay-webhook` | — | new; replies 503 until `RAZORPAY_WEBHOOK_SECRET` exists | **false** (checks HMAC itself) |

   Read each one back after deploying and compare it with the repo file.
7. **Website** — fast-forward `main` from `c4dcf4f` to the reviewed branch tip, the commit that added this README
   (`git log -1 --format=%h -- supabase/production/README.md`). No force-push; Lovable syncs `main`. Wait for
   the Vercel production build. Then check:
   - `/env-config.js` shows `production` and that commit.
   - 134 products load, with no QA banner.
   - The admin can open Banners, Offers, Free gifts, Memberships, Suppliers, Support and Reports.
   - A Cash on Delivery checkout still works (the owner places the order).
8. **Retire `staff-admin`** (deploy the 410 version) only after step 7, because the current admin page still calls it.

No secrets are set in this rollout. Razorpay stays off (no keys, plans disabled). No auth or security setting changes.

## Live site during the rollout

| Moment | Website (c4dcf4f) | Effect |
| --- | --- | --- |
| After migrations, before functions | old site, `create-order` v5 → 8-argument wrapper → new core | Works. Same prices (no promotions exist); every size is available |
| After functions, before website | old site, `create-order` v6 | Works. v6 compares totals only when the site sends one; the old site doesn't |
| After website | new site | New features visible but switched off (no banners, offers or gifts; memberships say "Coming soon") |

## Rollback

| What | How | Data loss |
| --- | --- | --- |
| Website | Vercel → promote the previous production deployment, or `git revert` on `main` | none |
| Edge Functions | Redeploy the previous source from git at `c4dcf4f` (`git show c4dcf4f:supabase/functions/<name>/index.ts`). `membership-ops` and `razorpay-webhook` can be left unconfigured, which keeps them inert | none |
| Migrations | `supabase/rollback/` scripts, newest first, each as one transaction. Migrations 2–6 have data guards: a script refuses to run while its tables hold data or any size is marked unavailable. Migration 1 only adds two functions (drop statements at the bottom of its file) | none: a guard refuses instead |

Migration 2 has a rollback that restores the previous checkout definition exactly; migration 5's rollback does the same.

## What I will not do without a new instruction

Set Razorpay keys or `TAAJA_ALLOW_LIVE_PAYMENTS`; enable plans, banners, offers or gifts; change Auth or security
settings; change delivery fees; touch the Supabase–Vercel integration; run any rollback.

## Approval wording

To go ahead, reply with: **"Approved: apply the six migrations, deploy the five Edge Functions, fast-forward main to
the reviewed branch tip, then retire staff-admin — as in supabase/production/README.md."** You can also approve only part of it
(for example "migrations only"). Each step stops at the first failed check.
