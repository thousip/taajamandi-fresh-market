# Phase 1 + overnight implementation report (19–20 Nov 2026)

Starting point: `a5a5cd6` (Phase 1E, branch `phase1/ops-reliability`). Work branch: `overnight/launch-build`.
Production (`main` = `c4dcf4f`, Supabase `qebdpjzhbqzjbvjqeztl`) was **not changed**. See `docs/qa-test-report.md`
for the test evidence and `docs/deployment.md` for the rollout order.

## Built

| Area | What customers / staff get | Where |
| --- | --- | --- |
| Promotional banners | Up to 3 swipeable banners (auto-advance off for reduced-motion users); admin creates, schedules, links them to a category, product, offers or membership; saved disabled | `promo_banners`, Admin → Banners, `extras.js` |
| ₹1 deals | Deal price for a capped number of units per order; per-customer, total-unit, minimum-order and eligibility limits (all / new customers / members); extra units at the normal price | `promo_deals`, `promo_redemptions`, checkout |
| Free gifts | A free size (₹0 line) for a minimum basket, a qualifying size, or a campaign; per-customer and total limits; never given when the size is unavailable | `promo_free_items`, checkout |
| Price safety | The server computes every price. `create_order_from_cart_v2` refuses the order (and keeps the basket) if the total differs from what the customer saw, instead of silently changing it | `create-order` v6 |
| Memberships | Weekly ₹59 = 5 free deliveries, monthly ₹159 = 20, no minimum order for the free delivery. Razorpay subscriptions (test mode); active only after a signature-verified webhook; each webhook applied once; free delivery recorded in a ledger, one use per order, given back once if the order is cancelled or refunded | `membership_*`, `memberships`, `payment_webhook_events`, `membership-ops`, `razorpay-webhook` |
| Support | Floating WhatsApp help button (+91 76719 13761 unless changed in Settings); support tickets with an optional order; admin replies and closes them | `support_tickets`, Admin → Support |
| Customer extras | Favourites, recently viewed, "you may also like", reorder at today's prices, membership and help links in the account panel | `favourites`, `extras.js` |
| Suppliers and purchasing | Supplier products with price history; purchase orders received partially or in full in one audited transaction that adds stock (`inventory_transactions` type `purchase`) | `supplier_products`, `supplier_price_history`, `admin_receive_purchase_order`, Admin → Suppliers |
| Reports | Last 30 days: orders and sales, offer savings, deal and gift use, and memberships by status | Admin → Reports |
| Audit | Every admin change to banners, offers, gifts, plans, suppliers and purchase orders writes `audit_logs` in the same transaction; if the audit write fails, the change fails | `private.audit_admin_change()` |
| PWA foundations | Manifest, placeholder icons, network-first service worker for page loads only, offline page | `public/manifest.webmanifest`, `public/sw.js`, `public/offline.html` |
| Phase 1 (earlier) | Admin-only audited staff roles; per-size availability with history and checkout re-check | migrations `20261120090000`, `20261120100000` |

Everything new starts switched off: no banners, deals or gifts exist and both plans are disabled with no Razorpay plan.

## Security notes

- New tables have RLS: public reads only enabled, in-window promotions and banners; customers read and write only
  their own tickets, favourites and memberships (memberships are read-only for them); admin/manager manage
  configuration; only admins change membership plans.
- New server functions (`create_order_from_cart_v2`, `apply_razorpay_subscription_event`,
  `admin_receive_purchase_order`) are executable only by `service_role` and are called only from Edge Functions that
  verify the signed-in user (or, for the webhook, the HMAC signature).
- Razorpay secrets live only in Supabase function secrets. Live keys are refused unless
  `TAAJA_ALLOW_LIVE_PAYMENTS=true`. The service worker caches no data.
- Rollback scripts refuse to run while their tables hold data, so no rollback can delete customer, order or payment
  data.

## Not built / decisions needed

- "Priority booking when stock is limited": not defined, so not built and not advertised.
- Bulk orders: no separate bulk flow was built. Customers can already order up to 50 of each size, and bargain
  requests cover large quantities. A dedicated bulk-order process needs business rules (minimums, pricing, lead time).
- Delivery fees are ₹0 in every zone, so free deliveries have no value yet.
- Brand icons, TWA package name and signing fingerprint, Razorpay account set-up.

## Production deployment

**Not deployed.** The new website depends on database objects that exist only after the six migrations, and the
mission rules forbid applying production migrations without owner approval. Deploying the website alone would break
the admin panel and checkout, so the safety conditions for a production deploy were not met. QA preview:
`https://taajamandi-ccmdgac4v-toxic-6dab.vercel.app` (commit `bb5bbcf`, Vercel login required).
