# Release 2: QA verification results (20 Nov 2026, QA only)

These are exact results from the QA project `tcdpbutitfrtunarhxhz`. The build tested is branch `launch/final-completion`
(639c39b), served on `localhost:4173` against QA. The owner signed in; Claude never saw or entered a password.
Production was not touched.

| # | Check | Result |
| --- | --- | --- |
| 1 | Razorpay test-mode payment for a normal order | **BLOCKED**: the QA payment function reports `online_enabled: false` |
| 2 | Successful, failed and abandoned payments | **BLOCKED** (same cause) |
| 3 | Webhook signature validation and duplicate events | **BLOCKED** for real Razorpay events: the QA webhook answers `503 Webhook is not configured` to both unsigned and forged requests, so `RAZORPAY_WEBHOOK_SECRET` isn't visible to it. Covered by automated tests only (10/10 helper tests, backend duplicate-event tests). |
| 4 | ₹59 weekly / ₹159 monthly membership payments | **BLOCKED**: needs working keys, plus the two Razorpay test plan IDs entered in QA Admin → Memberships |
| 5 | Membership activates only after a verified payment | Automated tests only (activation only via the signed webhook; duplicates ignored; renewal, halt, resume and cancel). Not yet with Razorpay. |
| 6 | Basket bug fix, signed in on the QA build | **PASS** (details below) |
| 7 | Delivery-staff workflow test | **Prepared** (below). It needs a QA delivery-staff account; QA has none yet. |

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
