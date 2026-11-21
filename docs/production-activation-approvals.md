# Production activation: approvals needed (prepared 21 Nov 2026)

Release 2 is live, with Cash on Delivery only. The owner asked to make production ready for online payments,
memberships and coupons, and to **skip the payment retry-after-failure QA test** (recorded as an owner decision;
the retry path is covered by automated tests only). Each item below changes production and runs **only after its
own approval phrase**. They can be approved together or one at a time, in this order.

## 1. Policy pages and the delivery fee: APPLIED 21 Nov 2026 (owner: "Approve pages and fee")

**Outcome:**
- **Fee:** the 7 active production areas changed from ₹0 / no threshold to ₹30 with free delivery from ₹249,
  updated by ID in one transaction. The 8 inactive areas are unchanged, and there are 7 `delivery_fee_updated`
  audit entries.
- **Website:** `main` fast-forwarded 15cf5c7 → f541f03. Vercel `dpl_6SBjFb1C9tHRABfaeLXyGgDjTT8J` is READY.
- **Live checks:**
  - all five pages return 200 with their own titles, and the footer links all five;
  - the Shipping page states the fee;
  - the storefront reads the fee in all 7 areas (₹248 → ₹30, ₹249 → free);
  - 134 products; environment production.
- **Rollback:**
  - fee: set `delivery_fee_paise = 0` and `free_delivery_min_paise = null` on the same 7 areas;
  - website: promote `dpl_4SojmzzsDkwUCeB6pwtcFZPmVAc4` (15cf5c7).

What was approved:

**What I would do:**
- Fast-forward `main` to the commit with five new pages (Terms, Privacy, Refund & Cancellation, Shipping &
  Delivery, Contact) and footer links.
- Set the 7 active production delivery areas to a **₹30 fee, free from ₹249**. This is a data update on
  `delivery_zones`; no code or schema change.

**Content from the owner's decisions (21 Nov):**
- cancellation is free until packing starts;
- damaged, spoiled or missing items reported on the delivery day with a photo are refunded (online: to the
  original method; COD: not charged);
- online refunds reach the customer in 3–5 working days;
- delivery is ₹30 below ₹249 and free from ₹249;
- contact is WhatsApp +91 76719 13761 only, with no address or email, by the owner's choice. Razorpay may ask for
  more during its review.

**Not included** (not decided): governing law, liability limits, refund rules for membership fees. A lawyer or the
owner should review the pages.

**QA evidence:**
- The fee rule was tested end to end on QA with a non-member: ₹248 → ₹30 fee (₹278); ₹249 → free; ₹254 with a ₹5
  coupon → free (the threshold is checked before the coupon).
- Browser and server totals matched every time.
- A member's fee was waived (5 → 4 free deliveries), and cancelling the order gave the free delivery back (→ 5).
- Pages: 3 automated tests; checked at phone width (no sideways scrolling).

**Rollback:**
- Website: promote the previous Vercel deployment.
- Fee: set `delivery_fee_paise = 0` and `free_delivery_min_paise = null` on the same 7 areas.

## 2. Live online payments ("Approve live online payments")

**Owner first, in dashboards only (never in chat):**
1. Razorpay **Live** account activated (KYC, bank). Razorpay may review the policy pages from step 1.
2. Razorpay **Live → Webhooks:** URL `https://qebdpjzhbqzjbvjqeztl.supabase.co/functions/v1/razorpay-webhook`,
   a new secret generated locally, and the events listed in `docs/live-payment-activation-checklist.md`.
3. Supabase **production** → Edge Functions → Secrets: `RAZORPAY_KEY_ID` (`rzp_live_…`), `RAZORPAY_KEY_SECRET`,
   `RAZORPAY_WEBHOOK_SECRET`, `TAAJA_ALLOW_LIVE_PAYMENTS` = `true`.

**Then I do:**
- Redeploy `payment-ops`, `create-order` and `razorpay-webhook` with identical code, so they pick up the secrets
  (needed on QA too).
- Check that an unsigned webhook gets 401 and that config returns `online_enabled: true`.

**Then the owner:** one small real online order, which is then cancelled and refunded from the Razorpay
dashboard. I verify `paid`, then `refunded`, read-only.

**Off switch:** remove `TAAJA_ALLOW_LIVE_PAYMENTS`. Online payment disappears from checkout at once; COD continues.

## 3. Memberships ("Approve memberships")

**Prerequisites:** steps 1 and 2 are live, and Razorpay Live Subscriptions is available.

**Owner:** in Razorpay **Live → Subscriptions → Plans**, create weekly ₹59 and monthly ₹159, then send the two
live `plan_…` IDs (not secret).

**Then I do:**
- Before enabling, check each plan on Razorpay's checkout: ₹59 every week and ₹159.
- Save the IDs and enable both plans in production.

**Then the owner:** joins one plan with their own card, checks it becomes active only after Razorpay's
confirmation, and cancels it (it then shows "cancelled: ends …, no further charges").

**Off switch:** disable the plans in Admin → Memberships. Existing members keep their period.

## Coupons

These need no approval step. They are live and start disabled; create them in Admin → Coupons when wanted.

## Not covered by these approvals

- `tajjamandi.in` DNS: the registrar still shows a parking page. Point it at Vercel in the domain registrar.

## Final two changes: APPLIED 21 Nov 2026 (owner-authorised release; owner instructed "deploy without backup")

- **Header:** a signed-in customer sees a profile icon (no name or email) and a membership icon beside it. The account panel shows name, email, phone, saved address and membership, with the existing actions. Signed-out view and basket unchanged.
- **Free item offers, for all customers:**
  - Admin → "Free item offers" (new ones start disabled; edit, image, enable/disable).
  - Customers choose ONE offer from a compact section below the basket items; nothing is added automatically.
  - Cash on Delivery is hidden and refused by the server while an offer is chosen; removing it restores Cash on Delivery.
  - The offer is added as one ₹0 `free_item` line; totals, coupons and catalogue prices are unchanged; unpaid online orders still cannot be packed.
  - The section stays hidden while online payment is unavailable, as in production today.
- **Production:**
  - migration `free_offers` applied; stored copy byte-identical (`ff5211820a67`);
  - no backup taken (owner instruction); rollback is `supabase/rollback/20261121150000_free_offers_rollback.sql`, which is guarded and restores `create_order_from_cart_v3` byte-for-byte;
  - no Edge Function changes;
  - `main` fast-forwarded f541f03 → b6d46fc; Vercel `dpl_He17ba3q6ncr7JPYw2JBNr8u7DDv` READY;
  - website rollback target: `dpl_6SBjFb1C9tHRABfaeLXyGgDjTT8J` (f541f03).
- **Checks:**
  - 208/208 automated tests and the build pass;
  - QA run with two customer accounts;
  - production: commit b6d46fc, 134 products, signed-out header correct, anon cannot choose offers, no 5xx or Postgres errors in logs.
- **Still off:** live payments. The production webhook secret is missing (503), so free offers cannot be used until live payments are configured.
- **QA note:** QA's Razorpay test keys stopped being active today (`online_enabled: false`); re-add the `rzp_test_` key and secret in QA secrets.
