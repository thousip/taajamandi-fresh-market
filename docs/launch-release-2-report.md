# TaajaMandi release 2: basket fix, online payments, coupons, homepage (QA only)

Branch `launch/final-completion`, built from production `main` 770354d (+ the rollout record 7d1fe50).
QA preview: https://taajamandi-gwfby6un9-toxic-6dab.vercel.app (commit fa9baf5, QA database; Vercel login needed).
**Production is unchanged.** Nothing here is merged, migrated or deployed to production; that needs your approval.

## 1. The basket bug: cause and fix

The report was: "a random item with quantity 50 appears after a customer logs in." There were two causes, both
reproduced in automated tests before fixing:

1. **Corrupted lines became a real 50.** The earlier cart fix made the website take any oversized line and **clamp
   it to 50, then save it**. The old doubling bug had left a corrupted line (Brinjal 250 g × 303,872). On the next
   sign-in it silently became "Brinjal × 50", a chargeable quantity the customer never chose.
2. **The guest basket could be added twice.** The basket a customer builds before signing in was merged by the
   browser (read, add, write). A second open tab could hear the same sign-in after the first tab had already saved,
   and add it again. The test reproduced 2 → 4 and 1 → 2. Repeated logins compound this, which is how the giant
   quantities arose.

The fix:

- **Merged once, on the server.** The merge now runs in `merge_guest_cart`, inside one transaction with the
  basket locked. Each guest basket carries a merge ID that can be applied only once, so extra tabs, repeated
  sign-ins and reloads can't add it twice.
- **Nothing lost on failure.** The guest basket stays on the device until the server confirms the merge.
- **Corrupted lines are never clamped and never saved.** They are set aside and shown to the customer:
  "Needs your attention: … saved quantity 3,03,872". The customer can remove the line or choose a real quantity.
  Checkout is blocked meanwhile, and the server already refuses any line above 50.
- **Token refreshes and repeated sign-in events change nothing.** They never re-read or rewrite the basket.
- **Invalid quantities on the device are not restored**, and the customer is told.

## 2–3. Files

New:
- **Migrations:** `supabase/migrations/20261121100000_cart_guest_merge.sql`, `…110000_online_payments.sql`,
  `…120000_coupons.sql`, `…130000_banner_cta.sql`.
- **Rollback scripts:** `supabase/rollback/20261121100000_…`, `…110000_…`, `…120000_…`.
- **Server function:** `supabase/functions/payment-ops/` (`index.ts`, `razorpay.ts`).
- **Production checks:** `supabase/production/20261121_release2_preflight.sql`, `…_release2_postflight.sql`.
- **Docs:** `docs/qa-screenshots/*`, this report.

Changed:
- **Storefront:** `public/js/store.js`, `app.js`, `extras.js`, `admin.js`, `admin-extra.js`, `index.html`.
- **Server functions:** `supabase/functions/create-order/index.ts` (v8), `razorpay-webhook/index.ts` and
  `razorpay.ts`.
- **Config and tests:** `supabase/config.toml`, `supabase/tests/backend.test.mjs`, `supabase/tests/razorpay.test.mjs`,
  `storefront-tests/run-tests.mjs`.

## 4. Database migrations (all applied to QA; each stored copy is byte-identical to its file)

| File | What it adds | Existing data touched |
| --- | --- | --- |
| `20261121100000_cart_guest_merge` | `cart_merges` (no direct access for anyone) and `merge_guest_cart` (signed-in users, own basket only) | none |
| `20261121110000_online_payments` | `attach_razorpay_order`, `apply_order_payment`, `expire_unpaid_online_order` (server only); a unique Razorpay order per order; order-status rule: online orders are confirmed only after payment, and cancelling a paid one is flagged as needing a refund | none (function replaced; rollback restores it byte-for-byte) |
| `20261121120000_coupons` | Coupon rules on the existing (empty) coupons tables: new coupons default to disabled, first-order and category options, one coupon per order, `check_coupon` preview, `create_order_from_cart_v3` | none (tables empty) |
| `20261121130000_banner_cta` | Optional banner button label | none |

## 5. Server functions (deployed to QA only)

| Function | QA version | Change |
| --- | --- | --- |
| `create-order` | v4 (code v8) | Coupon code (via v3); online payment accepted only when Razorpay is configured |
| `payment-ops` | v1 (new) | config / start / verify / reconcile |
| `razorpay-webhook` | v2 | Order payment and refund events, in addition to membership events |

## 6. Tests

All of these ran today and pass: **188 automated tests**.

| Suite | Result | What's new |
| --- | --- | --- |
| Backend (real Postgres, all migrations) | 48 | +15: basket merge, payments, coupons, membership renewal |
| Razorpay helpers | 10 | +4: payment signature, event mapping, live-key guard |
| Storefront and admin | 79 | +20 |
| Staff app | 10 | — |
| Environment selection | 8 | — |
| PWA | 3 | — |
| Vitest | 30 | — |
| Build | passes | — |

The new storefront tests cover:
- **15 basket scenarios:** a new customer; a guest basket merged on sign-in; an existing basket kept on reload and
  token refresh; the same item in both baskets; two tabs, both at once and one after the other; a corrupted line;
  restoring a corrupted line by choosing a quantity; invalid quantities on the device; a failed merge; switching
  accounts; the 50 limit.
- **Online payment:** the Razorpay hand-off, a browser "success" never trusted, Pay now, and the admin refund flag.
- **Coupons:** customer preview and admin coupon management.
- **Homepage:** header location states, the carousel, and the fallback slide.

Also run against the real QA database, inside a transaction that was rolled back (QA is unchanged afterwards):
- **Coupon:** Rs 18 less Rs 1 gave Rs 17; the second use was refused and the basket kept.
- **Online order:** an unpaid order couldn't be confirmed; a wrong amount wasn't treated as paid; a verified payment
  was; a duplicate webhook was ignored; the paid order could then be confirmed.

**Browser checks** (QA build, 360 / 375 / 390 / 430 px and desktop): no sideways scrolling, no header overlaps, no
clipped location text, and no console errors. Screenshots are in `docs/qa-screenshots/`: before and after at 375 px,
plus after at 360 px and desktop.

**Production (read-only):** the release-2 preflight passes 18/18 today.

## 7. Complete (code and tests)

- **Basket fix**, as above.
- **Online payments (Razorpay orders):**
  - the server calculates the amount and creates one Razorpay order per order;
  - an order is marked paid only after the signature check **and** a fetch from Razorpay, or after the signed
    webhook;
  - duplicate webhooks are ignored; a wrong amount never marks an order paid;
  - a second charge for the same order is recorded so it can be refunded;
  - abandoned payments expire (the "Check online payments" button in Admin → Orders cancels online orders still
    unpaid after 30 minutes, and their items go back to the basket);
  - partial and full refunds are tracked from Razorpay;
  - online orders can't be packed until paid;
  - Cash on Delivery is unchanged.
- **Coupons:**
  - the server validates and applies them, holding a lock so limits can't be exceeded;
  - flat or percentage discounts, with a cap, minimum order, total and per-customer limits, first-order-only and
    category options, and start/expiry dates;
  - one coupon per order, not combined with ₹1 offers unless allowed, never below zero;
  - a cancelled order gives its use back;
  - admin tab for creating and editing; new coupons start disabled.
- **Memberships:** activation, renewal (fresh allowance), failed payment (benefit stops), resume, cancellation,
  duplicate-safe webhooks, the allowance ledger, customer status and history, and admin plan management.
- **Homepage:**
  - header location button: "Serviceable at Hyderabad" plus the real GPS result, and "Not serviceable here yet"
    outside the area; the middle-of-page card is removed;
  - banner carousel at the top with swipe, dots, desktop arrows, an optional button label and a fallback slide;
  - admin banner image preview.

## 8. Not complete or not verified

- **No real Razorpay test-mode payment has run yet,** for orders or memberships. QA has no Razorpay test keys,
  plans or webhook secret: the webhook answers "not configured". Everything is tested with fixtures and
  rolled-back database runs, but not against Razorpay itself.
- **No signed-in test on the QA preview** of the new basket, coupon and payment flows. That needs you to sign in.
- **Packer and delivery workflow:** covered by the existing automated tests (staff app 10, backend lifecycle). The
  only change is that unpaid online orders can't be confirmed. No live delivery-staff test has run yet.
- **Choosing a saved address from the header** isn't built. Tapping the header re-checks the location; the
  delivery address is still entered at checkout.
- **The homepage hero ("Today's harvest…")** is kept below the banner, so "Browse the mandi" appears twice. Remove
  it if you prefer the reference layout exactly.

## 9. Owner decisions needed

1. **Regenerate the live Razorpay key that was pasted in chat** (Razorpay → Live mode → API Keys → Regenerate).
   This is urgent.
2. **Delivery fees per zone.** All are ₹0, so membership free deliveries save nothing.
3. **Members and minimum orders.** Should members skip zone minimum-order values? (All are ₹0 today.)
4. **"Priority booking when stock is limited"** for members. Not defined, not built, not advertised.
5. **Payment window for unpaid online orders.** 30 minutes is a technical default; confirm or change it.
6. **Coupons and ₹1 offers.** Should coupons combine with offers by default? Currently no; each coupon can allow it.
7. **When to enable live online payments in production.** That's a separate approval after the QA test.
8. **Remaining launch items:** leaked-password protection, the password-reset email test, DNS for tajjamandi.in,
   brand icons.

## 10. Secrets (names only; set them in Supabase → Edge Functions → Secrets, never in chat or git)

| Project | Name | Value type |
| --- | --- | --- |
| QA `taajamandi-qa` | `RAZORPAY_KEY_ID` | **test** key id `rzp_test_…` |
| QA | `RAZORPAY_KEY_SECRET` | test key secret |
| QA | `RAZORPAY_WEBHOOK_SECRET` | the secret you set on the QA webhook |
| Production | the same three | live values, only when you approve live payments |
| Production | `TAAJA_ALLOW_LIVE_PAYMENTS` | `true`, only when you approve live payments |

The Razorpay test webhook goes to `https://tcdpbutitfrtunarhxhz.supabase.co/functions/v1/razorpay-webhook`. Events:
- `payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`, `refund.processed`;
- `subscription.activated`, `.charged`, `.cancelled`, `.halted`, `.paused`, `.resumed`, `.completed`.

## 11. QA preview

https://taajamandi-gwfby6un9-toxic-6dab.vercel.app (commit fa9baf5, QA database). Online payment stays hidden there
until the QA Razorpay test keys are set.

## 12. Production release steps (each only after your explicit approval; stop at the first failed check)

1. **Preflight.** Run `supabase/production/20261121_release2_preflight.sql` (read-only); it must pass 18/18. It
   passed today.
2. **Migrations,** in order:
   - `cart_guest_merge`
   - `online_payments`
   - `coupons`
   - `banner_cta`

   After each, check that the stored SQL equals the file, as last time.
3. **Postflight.** Run `…_release2_postflight.sql`; production must then equal QA.
4. **Server functions:** deploy `payment-ops` (new), `razorpay-webhook`, then `create-order` (v8).
5. **Website:** fast-forward `main` to this branch's tip (no force-push). Then verify:
   - the live site serves the new commit;
   - all 134 products load;
   - the header location works;
   - the fallback banner shows;
   - a Cash on Delivery test order works, then cancel it.
6. **Live payments stay off** until you set the live keys and `TAAJA_ALLOW_LIVE_PAYMENTS=true`.

**Live site during the rollout:**
- The current website keeps working after the migrations: it doesn't call the new functions, and `create-order` v6
  still uses `create_order_from_cart_v2`, which is unchanged.
- After the new `create-order`, Cash on Delivery orders still work from the old website too.

## 13. Rollback

- **Website:** in Vercel, promote the previous production deployment (dpl_6kJPHHKgfU9CgxkKiqVovB4KqHZT, 770354d).
- **Server functions:** redeploy from git at 770354d. `payment-ops` can stay; it is inert without keys.
- **Database:** `supabase/rollback/2026112113…`, `…12…`, `…11…`, `…10…`, newest first. Each refuses to run while
  its data exists (online orders, coupons). The online-payments rollback restores the previous order-status
  function byte-for-byte. Production data is never deleted.

## 14. Your time, roughly

| Task | Time |
| --- | --- |
| Regenerate the exposed live key | 5 minutes |
| Razorpay test setup (test key, 2 plans, webhook, 3 QA secrets) | 20 minutes |
| QA test (sign in on the preview, test-card order, membership, coupon, staff flow) | 30–45 minutes |
| Business decisions in section 9 | 15 minutes |
| Approving and watching the production release | about 30 minutes |
