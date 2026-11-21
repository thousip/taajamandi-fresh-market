# Live payments and memberships: activation checklist (production)

**Separate from the Release 2 code rollout.** Nothing here is done. Each part needs its own explicit owner
approval, and comes only **after** Release 2 is live and checked with Cash on Delivery. Secrets are entered by the
owner in dashboards only: never in chat, git, Vercel, `VITE_*` variables or frontend files.

## A. Owner prerequisites (Razorpay, live mode)

| # | Item | Why | Status |
| --- | --- | --- | --- |
| A1 | Razorpay account **activated for live payments** (KYC, bank account, settlement) | Live keys only work on an activated account | Owner to confirm |
| A2 | **Website policy pages** published and linked from the site: Terms & Conditions, Privacy Policy, Refund & Cancellation Policy, Shipping/Delivery Policy, Contact Us. The site has none today. | Razorpay reviews the website before enabling live payments and subscriptions (confirm the exact list with Razorpay). The owner must supply the wording; it is business and legal policy and won't be invented. | **Missing** |
| A3 | **Subscriptions** available in Live mode, with Card / UPI AutoPay / e-mandate methods switched on | Razorpay docs: subscription methods are switched on through Razorpay Support | Owner to request |
| A4 | Regenerate any live key ever shared outside the Razorpay dashboard (one was pasted in chat on 20 Nov) | The old one must be treated as exposed | Owner to confirm it was regenerated |
| A5 | Production Supabase backup taken just before activation | Recovery point | Owner |

## B. Order payments (live)

1. **Razorpay (Live mode) → Webhooks:** add `https://qebdpjzhbqzjbvjqeztl.supabase.co/functions/v1/razorpay-webhook`. Set a **new** secret, generated locally, and don't reuse the QA one. Select:
   - `payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`, `refund.processed`;
   - for memberships later: `subscription.activated`, `charged`, `cancelled`, `halted`, `paused`, `resumed`, `completed`.
2. **Supabase (production) → Edge Functions → Secrets:**
   - `RAZORPAY_KEY_ID` (`rzp_live_…`);
   - `RAZORPAY_KEY_SECRET`;
   - `RAZORPAY_WEBHOOK_SECRET` (the same value as in step 1);
   - `TAAJA_ALLOW_LIVE_PAYMENTS` = `true`.

   Without the last one, a live key is refused by design.
3. **Claude, read-only checks:**
   - an unsigned webhook request gets `401 Invalid signature` (not 503);
   - `payment-ops config` returns `online_enabled: true`;
   - the functions in use are the Release 2 versions (bundle hashes as in the runbook).
4. **Owner's first live order:** the smallest real basket, paid online with the owner's own card or UPI. Expect:
   - "Paid online";
   - one `payment.captured` event;
   - the order confirmable by the admin.
   Then **cancel and refund** it from the Razorpay dashboard, and expect `refunded` after `refund.processed`.
5. **If anything is wrong,** remove `TAAJA_ALLOW_LIVE_PAYMENTS` (or the key) in production secrets. Online payment disappears from checkout at once, and Cash on Delivery keeps working.
6. **Daily operations:** Admin → Orders → "Check online payments" expires unpaid orders after 30 minutes and lists paid-then-cancelled orders that need a refund. Refunds are issued in the Razorpay dashboard.

## C. Memberships (live): after B, and after these blockers

| # | Blocker | Needed |
| --- | --- | --- |
| C1 | ~~Cancel state not recorded~~ **Fixed and QA-tested 21 Nov** (migration `membership_cancel_state`, ships with Release 2) | — |
| C2 | Delivery fees are ₹0 in every zone, so "free deliveries" save nothing | Owner decision on delivery fees (and whether members skip minimum orders) |
| C3 | Live plans | Create weekly ₹59 and monthly ₹159 plans in **Live** mode; enter the live `plan_…` IDs in production Admin → Memberships; enable the plans only then |
| C4 | Policy pages (A2) must cover subscriptions: renewal, cancellation and refund rules | Owner wording |

Then the owner joins one plan live with their own card, checks that it activates on the webhook, and cancels it.

## D. Coupons (production)

No activation step. Coupons ship with Release 2, start disabled, and are created in Admin → Coupons when the owner
wants them. Recommended: create one, enable it, and test it on an owner COD order, then disable it.
