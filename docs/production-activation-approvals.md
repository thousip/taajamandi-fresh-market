# Production activation: approvals needed (prepared 21 Nov 2026)

Release 2 is live, with Cash on Delivery only. The owner asked to make production ready for online payments,
memberships and coupons, and to **skip the payment retry-after-failure QA test** (recorded as an owner decision;
the retry path is covered by automated tests only). Each item below changes production and runs **only after its
own approval phrase**. They can be approved together or one at a time, in this order.

## 1. Policy pages and the delivery fee ("Approve policy pages and delivery fee")

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
