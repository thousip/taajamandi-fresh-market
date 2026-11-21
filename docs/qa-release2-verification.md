# Release 2: QA verification results (20–21 Nov 2026, QA only)

These are exact results from the QA project `tcdpbutitfrtunarhxhz`. The build tested is branch `launch/final-completion`
(639c39b), served on `localhost:4173` against QA. The owner signed in; Claude never saw or entered a password.
Production was not touched.

| # | Check | Result |
| --- | --- | --- |
| 1 | Razorpay test-mode payment for a normal order | **PASS** (update of 21 Nov, below) |
| 2 | Successful, failed and abandoned payments | Success **PASS**; failed **PASS**; abandoned **PASS** (see "Abandoned" for the 30-minute expiry result) |
| 3 | Webhook signature validation and duplicate events | **PASS** (21 Nov 04:10–04:20 UTC, after the owner added the Razorpay test webhook and `RAZORPAY_WEBHOOK_SECRET`; details below) |
| 4 | ₹59 weekly / ₹159 monthly membership payments | **PASS** (second round, below) |
| 5 | Membership activates only after a verified payment | **PASS**: pending until the signed webhook, duplicates ignored. Gap: cancel-requested state not recorded (below) |
| 6 | Basket bug fix, signed in on the QA build | **PASS** (details below) |
| 7 | Delivery-staff workflow test | **PASS** (second round, below): full lifecycle, failed delivery and reassignment, permissions |
| 8 | Coupons: server validation and admin controls | **PASS** (second round, below) |
| 9 | Payment retry after a failure | **NOT RUN** (the owner's retry didn't reach QA) |

## 1–2. Online payments, live on QA (update of 20–21 Nov)

Setup:
- the owner put a `rzp_test_` key ID and its matching secret in QA secrets (after one wrong name and one mismatched pair were corrected);
- `payment-ops` was redeployed with identical code so it picked up the secrets; `config` now returns `online_enabled: true`;
- QA build on `localhost:4173`, signed in as the QA admin test account (`…2a27cc`), Razorpay **test mode** only;
- the owner made the choices inside Razorpay's window (the pane does not accept automated input there and blocks its bank popup).

**Success: PASS.** Order `TM-20261120-32DE7DB7`, ₹19.
- Razorpay order `order_U2P3SgeOpUDE7u`, payment `pay_U2P5K2Bmv1bN33`, captured.
- The server verified the signature and fetched the payment from Razorpay before marking it paid. The audit log records `order_payment_paid`, source `verify`.
- The customer saw "Paid online".
- Starting payment again returned `already_paid`, and there was still one payment row (duplicate handling on the verify path).
- Admin confirm then succeeded. Reconcile checked 0 orders, because nothing was unpaid.

**Failed: PASS.** Order `TM-20261121-A2AD74E5`, ₹6, Razorpay order `order_U2g92pg3C7Gnfq`. The owner chose Razorpay's test **Failure** option.
- The order stayed `pending` / `payment_status = pending`, and the payment row stayed `created` with no payment ID. It was never marked paid.
- The customer saw "Payment failed. You can try again from My orders."
- My orders showed "Online · awaiting payment" with a **Pay now** button.
- Admin confirm was **refused**: "This order is waiting for its online payment; confirm it after the payment is received".
- A forged verify call (made-up payment ID, all-zero signature) was refused with "Payment could not be verified." Nothing changed.
- Nothing was written to the audit log, as expected.
- Note: the payment row shows `failed` only once Razorpay's `payment.failed` webhook can reach QA (blocked, see 3).

**Abandoned: PASS.** Order `TM-20261121-3CF7F898`, ₹12, Razorpay order `order_U2gBNK7vuZ2aO0`. The owner closed Razorpay's window without paying.
- The customer saw "Waiting for online payment". The order stayed `pending` / `pending`.
- Reconcile inside the 30-minute window: `checked 2, waiting 2, expired 0, paid 0, errors 0`. Neither unpaid order was cancelled early.
- **After 30 minutes, PASS:** reconcile ran at 04:07:26 UTC (30 min 17 s after order 3) and returned `checked 2, expired 2, waiting 0, paid 0, errors 0`.
  - Orders 2 and 3 are now `cancelled`, and neither was marked paid.
  - Their payment rows are `failed`.
  - Audit log: `order_payment_expired` for each, with "Online payment not completed" and `basket_lines_restored: 1`.
  - The test account's basket now holds Lemon × 3 (1 from order 2 plus 2 from order 3). The items went back to the basket, as designed.

Test note: order 3 held 2 lemons. The test called `create-order` directly and skipped the page's own basket reset, so the page still remembered 1 lemon. On the server, the basket was empty after each order.

## 3. Webhook, live on QA (21 Nov)

The owner created a Razorpay **Test Mode** webhook pointing at the QA URL, and put the same secret in QA as `RAZORPAY_WEBHOOK_SECRET`. Claude never saw the value. Before that, a fresh redeploy of the webhook with identical code (v11, same hash `62702c46…`) still answered 503, which confirmed the secret was missing.

**Signature: PASS.**
- An unsigned request got `401 Invalid signature`.
- A forged `payment.captured` (all-zero signature, real Razorpay order ID of order 2) got `401 Invalid signature`.
- Afterwards there were 0 stored webhook events and 0 new audit entries, and order 2 was unchanged.

**Real signed events: PASS.** Order `TM-20261121-F21717C4`, ₹18, Razorpay order `order_U2gpnlQRGHU6Sc`. The owner paid with a test success method, giving payment `pay_U2gqPfOC2JXo0W`. Razorpay delivered three signed events within a second, each stored once with `processed = true`:

| Event | Event ID | Effect |
| --- | --- | --- |
| `payment.authorized` | `U2gqVVhhoxdXlg` | audit `order_payment_authorized` (not marked paid) |
| `payment.captured` | `U2gqWIbDRbzTNg` | audit `order_payment_paid`, source webhook; `payment_status = paid` |
| `order.paid` | `U2gqWaUriiIHrr` | audit `order_payment_already_paid`, no change |

- The customer's verify call 12 s later was also reported as `order_payment_already_paid`, with no change.
- Result: one payment row (`captured`) and one "paid" transition.

**Same event ID replayed: PASS.** `apply_order_payment` (the function the webhook calls) was run again on QA with the event ID of the `payment.captured` above. It returned `{"duplicate": true}`, and there were still 3 webhook events, 1 payment row and 4 payment audit entries.

**Paid order can be confirmed:** the customer saw "Paid online", and admin confirm then succeeded (`confirmed`, `paid`).

## 3–5. Read-only checks while blocked (21 Nov, about 03:50 UTC)

- **QA memberships** (status at that time): weekly ₹59 / 7 days / 5 free deliveries and monthly ₹159 / 30 days / 20 free deliveries. Both are `is_enabled = false` with `razorpay_plan_id = null`.
- **Joining is refused while disabled:** `membership-ops subscribe` for weekly and monthly both returned `409 "This membership is not available yet."`, and no membership row was created for the test account.
- **Without sign-in, every staff and payment function refuses:** with only the public key, `admin-ops`, `packer-ops`, `delivery-update` and `payment-ops` answered `401 Sign in required`, and `create-order` answered `401 Authentication required`.
- **QA roles:** 1 admin, 1 packer. No delivery staff yet, so the delivery workflow test is still waiting on an owner-created account (section 7).

## 6. Basket fix, live on QA

Setup:
- three browser tabs open as a guest, sharing one guest basket (Lemon × 2, Potato 250 g × 1, merge ID
  `guest-b943bc08…`);
- the owner signed in on one tab, with the QA **admin** test account (`…2a27cc`).

Results:

- **Merged once.** All three tabs showed **Lemon × 2, Potato × 1**. The QA database held the same lines with **one**
  merge record (2 lines applied). Under the old code, the other tabs could add the basket again.
- **Guest storage cleared** on the device after the confirmed merge.
- **Corrupted line set aside.** A corrupted legacy line was placed in this account (Watermelon 250 g × 303,872, the
  same shape as the original bug) and the page reloaded. It was **not** turned into 50:
  - the basket held only the two valid lines (subtotal ₹19);
  - the line appeared under "Needs your attention", with the saved quantity 3,03,872 and the options Remove or
    Keep 1;
  - the customer was told;
  - **checkout was disabled**;
  - the database still held 303,872, unmodified.

  Screenshot: `docs/qa-screenshots/qa-basket-quarantine.jpg`.
- **Remove works.** Clicking Remove deleted only that line; checkout re-enabled; Lemon and Potato stayed.
- **Reloading changes nothing.** After reloading all three tabs (repeated sign-in and initial-session events), the
  basket was unchanged and there was still one merge record.

Test data notes:
- The corrupted line was created by briefly dropping the 50-limit and re-adding it exactly as before, in one
  transaction. It is still "not valid" for old rows, the same as in production.
- The QA customer test account's basket was emptied again after staging.
- The QA admin test account's basket now holds Lemon × 2 and Potato × 1, available for the payment test.

## Open items for owner review (verification stopped here on 21 Nov, as instructed)

1. **Memberships (checks 4 and 5): blocked on the Razorpay account.**
   - The owner found no option to create subscription plans in the Razorpay test dashboard. The ₹59 / ₹159 memberships are built on Razorpay **Subscriptions**, so this probably means Subscriptions isn't enabled on the account.
   - If so, it also blocks memberships in production. The owner should ask Razorpay support to enable Subscriptions (test and live).
   - Once it's enabled:
     1. create a weekly ₹59 plan and a monthly ₹159 plan in Test Mode;
     2. enter the two `plan_…` IDs in QA Admin → Memberships and enable both plans on QA;
     3. join each with a test method; each must stay **pending** until the signed `subscription.activated` / `charged` webhook arrives, then show active with 5 or 20 free deliveries;
     4. cancel one.
   - Until then, both plans stay **disabled** on QA, and the storefront shows "Coming soon". Joining is refused by the server (verified, see "Read-only checks").
2. **Delivery-staff workflow (check 7): needs one QA account from the owner.** The steps are in section 7.
3. **Minor behaviour noted, no change made:** a page left open while an unpaid order expires shows the returned items after the next reload. The basket deliberately doesn't re-read itself in the background (part of the basket-safety fix).
4. **QA state left behind (test data only):**
   - orders 2 and 3 are cancelled;
   - order 4 is paid and confirmed;
   - the Razorpay test webhook stays active on QA;
   - `razorpay-webhook` is at v11 (identical code).

Nothing was merged to `main`, deployed to production, or switched to live payments. No production campaign was activated.


## 7. Delivery-staff workflow test (prepared)

QA has an admin and a packer test account but **no delivery-staff account** yet.

1. **Owner:** create one more QA test account by signing up on the QA build with a new email address you control.
2. **Owner (QA admin) → Admin → Delivery team:** invite that email as delivery staff. The role grant is audited.
3. **Customer (QA):** place a Cash on Delivery test order (advance, 1 December). Then:
   - **Admin:** Confirm.
   - **Packer** (`/staff.html`): Start packing → check each item → Packed.
   - **Admin:** Assign the delivery staff member.
   - **Delivery** (`/staff.html`): Accept → Picked up → Delivered. Also try Failed with a reason on a second order;
     expect a reason to be required, then reassign.
4. **Checks Claude runs afterwards (read-only):**
   - every status change is in `audit_logs`;
   - the delivery person sees only their own deliveries, with no other customers' details;
   - a customer account gets 401/403 from `admin-ops`, `packer-ops` and `delivery-update`;
   - the packer can't call admin actions.
5. **Controlled production run (owner, after release approval):** the same steps with the real delivery account
   on one owner order, then cancel or complete it.


## Second QA round (21 Nov 2026, 04:40–05:45 UTC), on the owner's instructions

Build: `launch/final-completion` at 85d6638 → 0b4541f, served locally against QA. Three separate browser sign-ins:
- `localhost`: admin `…2a27cc`, also used as a customer;
- `127.0.0.1`: packer `…c4cd3a`, also a customer;
- `rider.localhost`: delivery staff "QA Rider" `…b2763c`.

The browser pane blocks location access, so for ordering on screen a GPS reading at the delivery-area centre was
injected into the open tab (test only). The server still checks the saved address against the 7.4 km area.

### Razorpay Subscriptions: PASS (it was not disabled)

- **Why it seemed unavailable:** Plans live under **Payment Products → Subscriptions → Plans** in Razorpay. The owner then created two test plans and two dashboard test subscriptions; neither subscription is linked to TaajaMandi, and Razorpay sent QA no event for them.
- **Plans:** weekly `plan_U2hiafDMdE97tg` and monthly `plan_U2hqD36zeS9L1B`. Each was checked on Razorpay's own checkout **before paying**: "₹59 … every week until 16 Nov 2027" (52 charges) and ₹159. Saved and enabled on **QA only**.
- **Razorpay docs:** the card, UPI and e-mandate methods for subscriptions are switched on by Razorpay Support. Card mandates up to ₹15,000 are charged without asking the customer each time (both plans qualify).

| Test | Result |
| --- | --- |
| Weekly ₹59 join (test card 4718 6091 0820 4366) | **PASS**: `sub_U2huHW0vSrzqV9` stayed `pending` until the signed `subscription.activated` arrived (05:20:36 UTC), then became `active`: 21 Nov to the end of 27 Nov, "5 of 5 free deliveries left · renews 28 Nov 2026" |
| Monthly ₹159 join | **PASS**: `sub_U2hxgMHQrwSnzp` went `pending` → `active` on the signed events, from 21 Nov to the end of 20 Dec |
| Unpaid earlier attempt | **PASS**: marked `expired` when a new attempt started |
| Replay of `subscription.activated` (same event ID) | **PASS**: `{"duplicate": true}`, nothing changed |
| The subscription's own `payment.*` / `order.paid` events | **PASS**: ignored for orders (0 orders touched, 0 order-payment audit entries) |
| Cancel (weekly) | Razorpay accepted "cancel at cycle end", and the membership stays active until 27 Nov. **GAP:** TaajaMandi doesn't record that a cancellation was requested (the `memberships` table has no field for it), so the customer still sees "renews 28 Nov" until Razorpay's final event. Fixing it needs a small migration (not made). |
| UI fix | An active member no longer sees "Join" buttons; the current plan is marked (0b4541f) |

### Coupons: PASS

Seven QA coupons were created through the admin account (the same table calls as Admin → Coupons).

- **Defaults and guards:**
  - every coupon was saved **disabled**, and a disabled one is refused;
  - junk and unknown codes are refused, and lowercase codes are accepted;
  - the database refused a percentage over 100, a lowercase code, a negative minimum, a zero limit, an end date before the start date, and a duplicate code.
- **Rules (preview):**
  - flat ₹5 saved ₹5;
  - 50% capped at ₹3 saved ₹3;
  - a vegetables-only coupon discounted only the ₹7 potato line;
  - expired, not-yet-started, first-order-only and minimum-order coupons gave the right message.
- **Orders:**
  - a COD order with QA-FLAT5 came to ₹19 − ₹5 = ₹14;
  - a client total without the discount was refused ("the total is now Rs 14.00") and the basket kept;
  - a second use was refused and the basket kept;
  - after the admin cancelled the first order, the use came back;
  - an online order with QA-VEGONLY (₹19 − ₹7 = ₹12): the payment row and the Razorpay order were both for ₹12.
- **Access:**
  - a signed-out visitor sees 0 coupons, cannot insert one (RLS), and cannot call `check_coupon`;
  - the packer and the rider (signed-in non-admins) read 0 coupons;
  - every admin change is audited (`insert_coupons` / `update_coupons`).
- **Fixes:**
  - Admin labels an enabled coupon outside its dates as Expired or Scheduled (85d6638);
  - My orders shows "Discount (coupon …)" and the delivery fee, so items and total add up (03a3b94).
- **Not built:** limiting a coupon to individual products in the admin form (the server supports it; the form offers categories). Not tested live: two customers using a 1-use coupon at the same instant (a row lock covers it; there's no live concurrency test).

### Order payments, further cases

| Test | Result |
| --- | --- |
| Customer-screen online checkout (packer account as customer) | **PASS**: TM-20261121-7117C53F, ₹40, `pay_U2hoMXAI5cMQnR`; three signed events, paid |
| Razorpay `payment.failed` webhook | **PASS**: TM-20261121-EC188E18 → `payment_status = failed`, audit `order_payment_failed` (source webhook), order still pending with **Pay now** |
| Retry on the same order after a failure | **NOT RUN**: the owner's success attempt didn't reach QA; the order shows "payment not completed" |
| Store cancels a paid order | **PASS**: `refund_required: true`, and "Check online payments" lists it under refunds needed |
| Refund in the Razorpay dashboard | **PASS**: signed `refund.processed` (05:27:05 UTC) → order and payment `refunded` |

### Delivery lifecycle: PASS

The owner's QA account was made delivery staff "QA Rider" through Admin (`invite_staff`; existing account, so no email; role grant audited).

- **Orders:** three COD orders: TM-20261121-B41FB334, TM-20261121-651B668C and TM-20261121-DE515ABF.
- **Normal path:** admin confirm → packer "Start packing" → item check (**Mark packed is disabled until every item is checked**) → packed → admin assign → rider Accept → Picked up → Delivered. Delivered asks the rider to confirm collecting **₹6.00 cash** and takes an optional note. (The rider app's confirm/prompt dialogs were answered by a test stub in the open tab.)
- **Failed path (DE515ABF):** Delivery failed **without a reason was refused** ("A reason is required"). With a reason: "Failure reported; the store will reassign". The order went back to `packed`, the admin reassigned it, and it was then delivered.
- **Audit:** every step is in `audit_logs` (7, 7 and 11 entries, including the failure and reassignment).
- **Rider view:**
  - only their own assignments, showing cash to collect, customer name and phone, address with a map link, and items;
  - History lists each delivery with the cash and note.
- **Customer tracking:** My orders showed `packed`, then `delivered`.
  - **Gap:** no rider name or contact for the customer, and no mention of a failed attempt;
  - the status updates only when My orders is reopened.
- **Permissions:**
  - **Rider:** `admin-ops` 403, `packer-ops` 403, payment reconcile 403. It reads only its own profile, address, own orders and own 3 assignments.
  - **Packer:** `delivery-update` 403, `my-deliveries` 403, `admin-ops` 403. It reads 0 assignments, and cannot mark packed before checking items.
- **Privacy finding (existing code, not release 2):** `packer-ops queue` returns each order's **full delivery address snapshot, including recipient name and phone**, to packers. The packer screen shows only the area. Recommended: return only area and items to packers (a `packer-ops` change and deploy).

### QA state left by this round (test data only)

- Membership plans enabled on QA with the two test plan IDs.
- Two QA memberships are active (weekly, cancelling at period end; monthly).
- Seven `QA-…` coupons are enabled.
- The test orders above.
- Existing QA account `…b2763c` has the delivery_staff role.
