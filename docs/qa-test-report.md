# QA test report — overnight build (20 Nov 2026)

Branch `overnight/launch-build`. Every result below was **executed** on this date. Anything that was not executed is
listed as such at the end. No production data or systems were used.

## Automated suites (offline, against the branch)

| Suite | Command | Result |
| --- | --- | --- |
| Backend (PGlite: real Postgres with every migration applied to a QA schema export) | `SCHEMA_JSON=… PGLITE_DIR=… node --test supabase/tests/backend.test.mjs` | **33 / 33 pass** |
| Razorpay signature and webhook helpers | `node --test supabase/tests/razorpay.test.mjs` | **6 / 6 pass** |
| Storefront and admin (jsdom, fake Supabase) | `node --test storefront-tests/run-tests.mjs` | **59 / 59 pass** |
| PWA manifest and service worker | `node --test storefront-tests/pwa.test.mjs` | **3 / 3 pass** |
| Environment selection (production vs QA build) | `node --test scripts/write-env-config.test.mjs` | **8 / 8 pass** |
| Staff app | `node --test staff-tests/run-tests.mjs` | **10 / 10 pass** |
| Vitest | `npx vitest run` | **30 / 30 pass** |
| Build | `npm run build` | **pass** |

Total: 149 automated tests, all passing.

## The 10 minimum checks

| # | Check | Evidence (executed) |
| --- | --- | --- |
| 1–3 | Customers, packers and delivery staff cannot use admin operations | Backend: every admin database function (staff roles, availability, purchase receiving, order status) refuses non-admin actors with "Admin access required", and only `service_role` can execute them; checkout functions are `service_role` only. QA live: `admin-ops`, `membership-ops` and `create-order` return 401 without a session. The `admin-ops` role check (admin/manager from `user_roles`) was verified by reading the deployed source. A signed-in non-admin call to the deployed `admin-ops` was **not** executed tonight (that needs a person to sign in). |
| 4 | Customer cannot change prices | Backend: a direct update of `product_variants.price_paise` and inserts into `promo_deals` / `promo_redemptions` are refused; `create_order_from_cart_v2` refuses a total the server did not compute and keeps the basket. QA rolled-back run: expected ₹1.00 → refused with "the total is now Rs 13.00"; basket kept. |
| 5 | Customer cannot manipulate free gifts | Backend: client update of `promo_free_items` refused by RLS; gifts are added only by the server, at ₹0; limit per customer holds; an unavailable free size is not given. |
| 6 | Customer cannot claim unavailable products | Backend: checkout refuses a size marked unavailable after it was added to the basket; storefront flags it and blocks checkout. |
| 7 | Membership benefits cannot be consumed twice | Backend: one `consume` per order (unique key; a duplicate insert fails); the allowance of 2 is used up and the third order pays the fee; the membership row is locked during checkout. |
| 8 | A cancelled eligible delivery restores the benefit correctly | Backend: cancel then refund of the same order restores exactly once; remaining goes from 0 to 1. |
| 9 | Duplicate webhooks do not duplicate payments or memberships | Backend: the same event id twice → second returns `{duplicate: true}`, one membership, one event row. QA rolled-back run: same result on the real QA database. |
| 10 | A failed audit write does not leave a role change unaudited | Backend: with the audit insert forced to fail, the role grant and the banner insert are both rolled back. |

## QA project (`tcdpbutitfrtunarhxhz`) checks

- Migrations `20261120110000`–`20261120140000` applied; RLS enabled on every new table; both plans disabled; no live
  banners, deals or free items.
- The deployed Edge Functions match the branch source (read back from Supabase): `create-order` v2 (calls
  `create_order_from_cart_v2`), `admin-ops` v4 (includes `receive_purchase_order`), `membership-ops` v1,
  `razorpay-webhook` v1 (verify_jwt off, signature checked in code).
- Without a session: `create-order`, `membership-ops` and `admin-ops` → 401; `razorpay-webhook` → 503 "Webhook is not
  configured", because no `RAZORPAY_WEBHOOK_SECRET` is set in QA.
- End-to-end run on the real QA database inside one transaction, then **rolled back**. Afterwards there were still 1
  order, 0 deals, 0 memberships, 0 webhook events, 0 suppliers, and no plan id. The run covered:
  - ₹1 deal: 3 × ₹6 size → 1 at ₹1 + 2 at ₹6.
  - Free gift line at ₹0.
  - Order totals: subtotal ₹18, discount ₹5, total ₹13; the order row agreed.
  - Price-mismatch refusal.
  - Webhook activation, plus a duplicate ignored.
  - Purchase order received partially and then in full: stock +5, supplier price recorded.
- Vercel preview `https://taajamandi-ccmdgac4v-toxic-6dab.vercel.app` (commit `bb5bbcf`):
  - `env-config.js` reports `qa` / `tcdpbutitfrtunarhxhz`.
  - It serves the new `extras.js` and `manifest.webmanifest`.

## Browser checks (local static build against QA, 375 × 812)

- Catalogue loaded 134 products with the QA banner.
- No horizontal scrolling (page width 375 = viewport).
- No console errors.
- Banners and offers are hidden while none are configured.
- The membership section shows both plans as "Coming soon" (disabled).
- The product view shows Save and "You may also like".
- The WhatsApp Help button is present.

## Not executed (needs a person or external set-up)

- Signed-in customer, packer, delivery and admin sessions against the new QA functions. Earlier signed-in QA tests
  (19 Nov) covered the order lifecycle and RLS 27/27, not the new features.
- Razorpay test-mode payment and a real signed webhook from Razorpay: no test keys, plan ids or webhook secret exist yet.
- Browser checks on the protected Vercel preview itself; the same files were checked locally.
- Lighthouse / installability audit on a real Android device.
