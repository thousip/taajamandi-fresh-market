# Deployment, migrations, rollback and environment variables

Applies to the Phase 1 and overnight work on branch `overnight/launch-build` (built on `phase1/ops-reliability`).
Production is unchanged until the owner approves each step below.

## Why the order matters

The new storefront and admin call database objects that exist only after the migrations, and `create-order` v6 calls
`create_order_from_cart_v2`. Deploying in the wrong order would break checkout or the admin panel. **Always deploy in
this order: database → Edge Functions → website.** Each step is backward-compatible with the one before it:

- The migrations only add tables, columns and functions. The 6-argument `create_order_from_cart` core and the
  8-argument wrapper keep their signatures, so the current production `create-order` and website keep working.
- `create-order` v6 sends `expected_total_paise` only when the client sends it, so the current website keeps working
  against it.
- The new website needs both of the above.

## Production steps (each needs explicit owner approval)

1. **Back up**: in the Supabase dashboard, confirm a recent backup (or PITR) exists for `qebdpjzhbqzjbvjqeztl`.
2. **Migrations**, in filename order, from `supabase/migrations/`:

   | File | What it adds |
   | --- | --- |
   | `20261120090000_staff_role_functions.sql` | Phase 1C: audited `admin_grant_staff_role` / `admin_revoke_staff_role` (admins only) |
   | `20261120100000_variant_availability.sql` | Phase 1D: per-size `is_available`, history table + trigger, checkout re-check |
   | `20261120110000_banners_support_favourites.sql` | Config audit trigger, `promo_banners`, `support_tickets`, `favourites` |
   | `20261120120000_memberships.sql` | Plans (seeded **disabled**), memberships, ledger, webhook event log, `my_membership()` |
   | `20261120130000_promotions_checkout.sql` | ₹1 deals, free items, redemptions, promotion-aware checkout, `create_order_from_cart_v2` |
   | `20261120140000_supplier_purchasing.sql` | Supplier products/price history, audited purchase-order receiving |

   Before applying the checkout migrations, compare the production `create_order_from_cart` (6-argument) definition
   with the one the generator expects. Production md5 was `ac5a34bd…` (it differs from QA). If it differs from the
   source used to generate the migration, **stop** and regenerate the migration from the production definition.
   Do not apply a guessed definition.
3. **Edge Functions** (`supabase/functions/`): `create-order` (v6), `admin-ops` (Phase 1C/1D + receiving),
   `membership-ops` (new, verify_jwt true), `razorpay-webhook` (new, **verify_jwt false**; it checks the HMAC
   signature itself). `supabase/config.toml` holds the verify_jwt settings.
4. **Website**: merge the branch into `main` (no force-push, no history rewrite; Lovable syncs `main`). Vercel builds
   production from `main`.
5. **Verify**: `https://taajamandi.vercel.app/env-config.js` shows `"environment": "production"` and the new commit;
   the catalogue loads; a signed-in admin opens the new admin tabs; Cash on Delivery checkout still works.

Everything stays switched off after deployment: no banners, deals or free items exist, and both membership plans are
disabled with no Razorpay plan ids.

## Rollback

- **Website**: in Vercel, promote the previous production deployment (current rollback target:
  `dpl_6jNLyabwJb6rgPT3QDQAktjku1Tz`, commit `f140fe8`; after a new release, use the release before it), or revert the
  merge commit on `main` with `git revert` (never force-push).
- **Edge Functions**: redeploy the previous version from git (`git show <old-commit>:supabase/functions/<name>/index.ts`).
- **Database**: `supabase/rollback/<migration>_rollback.sql`, newest first (purchasing → promotions → memberships →
  banners). Run each one as a single transaction, for example in the Supabase SQL editor or with
  `psql --single-transaction -v ON_ERROR_STOP=1`. The scripts drop **only** objects the migrations created. Each one
  starts with a data guard that **refuses to run** while its new tables hold any rows: memberships, ledger, webhook
  events, deals, free items, redemptions, order lines sold under a promotion, supplier prices, banners, tickets or
  favourites. That way no customer, order, payment or inventory data can be lost. If a guard refuses, leave the tables
  in place and switch the feature off (disable the plan, deal, free item or banner) instead. The backend test
  "rollback scripts refuse while their tables hold data" checks this.
- The checkout rollback restores the previous `create_order_from_cart` body exactly as it was before the migration.

## Environment variables and secrets

The browser receives only the Supabase URL and the **publishable** key (see `docs/environments.md`).
Nothing below may appear in frontend code, HTML, `VITE_` variables, Vercel variables or git.

| Name | Where it is set | Used by | Notes |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | Vercel (production → production project; preview/development → QA) | website build | Unchanged. The build refuses secret keys. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEYS` / `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_ANON_KEY` | Supplied automatically by Supabase | all Edge Functions | Never copy them anywhere. |
| `RAZORPAY_KEY_ID` | Supabase → Edge Functions → Secrets | `membership-ops` | Use a **test** key (`rzp_test_…`) in QA. A live key (`rzp_live_…`) is refused unless the next variable is set. |
| `RAZORPAY_KEY_SECRET` | Supabase function secret | `membership-ops` | Never in the browser. |
| `RAZORPAY_WEBHOOK_SECRET` | Supabase function secret (and the same value in the Razorpay webhook settings) | `razorpay-webhook` | Without it the webhook answers 503 and does nothing. |
| `TAAJA_ALLOW_LIVE_PAYMENTS` | Supabase function secret, **production only, owner decision** | `membership-ops` | Must be exactly `true` to allow live keys. Leave unset in QA. |

Razorpay set-up (test mode first, in QA):
1. In the Razorpay dashboard (test mode), create two plans: weekly ₹59 (period weekly, interval 1) and monthly ₹159
   (period monthly, interval 1).
2. Add a webhook pointing at `https://<project>.supabase.co/functions/v1/razorpay-webhook`. Choose the events
   `subscription.activated`, `subscription.charged`, `subscription.cancelled`, `subscription.halted`,
   `subscription.completed` and `subscription.paused`. Set a secret, and store the same value as `RAZORPAY_WEBHOOK_SECRET`.
3. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (test keys) as function secrets.
4. In Admin → Memberships, enter each Razorpay plan id and enable the plan. Every change is audited.
