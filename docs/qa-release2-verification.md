# Release 2: QA verification results (20 Nov 2026, QA only)

These are exact results from the QA project `tcdpbutitfrtunarhxhz`. The build tested is branch `launch/final-completion`
(639c39b), served on `localhost:4173` against QA. The owner signed in; Claude never saw or entered a password.
Production was not touched.

| # | Check | Result |
| --- | --- | --- |
| 1 | Razorpay test-mode payment for a normal order | **PASS** (update of 21 Nov, below) |
| 2 | Successful, failed and abandoned payments | Success **PASS**; failed **PASS**; abandoned **PASS** (see "Abandoned" for the 30-minute expiry result) |
| 3 | Webhook signature validation and duplicate events | **BLOCKED** for real Razorpay events: QA has no `RAZORPAY_WEBHOOK_SECRET` (owner added only the key ID and key secret), and the webhook still answers `503 Webhook is not configured` (re-checked 21 Nov 03:40 UTC). Duplicate handling on the verify path **PASS** (below). Webhook covered by automated tests only. |
| 4 | ₹59 weekly / ₹159 monthly membership payments | **BLOCKED**: needs the webhook secret, plus the two Razorpay test plan IDs entered in QA Admin → Memberships |
| 5 | Membership activates only after a verified payment | Automated tests only (activation only via the signed webhook; duplicates ignored; renewal, halt, resume and cancel). Not yet with Razorpay (same block as 3 and 4). |
| 6 | Basket bug fix, signed in on the QA build | **PASS** (details below) |
| 7 | Delivery-staff workflow test | **Prepared** (below). It needs a QA delivery-staff account; QA has none yet. |

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

## 3–5. Read-only checks while blocked (21 Nov, about 03:50 UTC)

- **QA memberships:** weekly ₹59 / 7 days / 5 free deliveries and monthly ₹159 / 30 days / 20 free deliveries. Both are `is_enabled = false` with `razorpay_plan_id = null`.
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

## What is needed to unblock payments (owner, in the Supabase dashboard; never paste values in chat)

Supabase → project **taajamandi-qa** (`tcdpbutitfrtunarhxhz`; not "Taaja mandi") → Edge Functions → **Secrets**
should list exactly:

| Name | Value |
| --- | --- |
| `RAZORPAY_KEY_ID` | must start with **`rzp_test_`**. A `rzp_live_` key is refused on QA by design, which gives exactly the `online_enabled: false` seen today. |
| `RAZORPAY_KEY_SECRET` | the matching **test** key secret |
| `RAZORPAY_WEBHOOK_SECRET` | the secret entered on the Razorpay **Test Mode** webhook |

Also:
- **Razorpay Test Mode → Webhooks:** URL `https://tcdpbutitfrtunarhxhz.supabase.co/functions/v1/razorpay-webhook`. Events:
  - `payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`, `refund.processed`;
  - `subscription.activated`, `charged`, `cancelled`, `halted`, `paused`, `resumed`, `completed`.
- **Razorpay Test Mode → Subscriptions → Plans:** weekly ₹59 and monthly ₹159. Send the two `plan_…` IDs (not secret),
  or enter them yourself in QA Admin → Memberships.

Two quick checks that need no values will confirm it's fixed:
- the webhook answers `401 Invalid signature` (instead of 503) to an unsigned request;
- `payment-ops config` returns `online_enabled: true`.

## Prepared test plan (runs once the secrets are fixed)

**Order payments** (QA build, a signed-in QA account, Razorpay test mode; Razorpay's own published test methods only):
1. **Success:** pay online and complete with a Razorpay test success method. Expect:
   - "Paid online";
   - the order shows `payment_status = paid` only after the server verifies it;
   - one `payment.captured` webhook event is recorded, and the second application is reported as `already_paid`
     (duplicate handling on real data).
2. **Failure:** choose the test failure method. Expect the order stays unpaid ("payment not completed"), the admin
   can't confirm it, and "Pay now" appears in My orders.
3. **Abandoned:** close the Razorpay window. Expect "Waiting for online payment". After 30 minutes, Admin → Orders →
   "Check online payments" cancels it and the items return to the basket.
4. **Signature:** a forged webhook gets `401` and changes nothing.

**Memberships:**
- join weekly (₹59) and monthly (₹159) with test methods;
- each must stay **pending** until the signed webhook arrives, then show active with 5 or 20 free deliveries;
- cancel one.

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
