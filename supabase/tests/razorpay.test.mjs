// Razorpay webhook helper tests (offline, fixtures only; no network, no real keys).
// Run: node --test supabase/tests/razorpay.test.mjs   (Node 22.18+ imports the .ts helper directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describeEvent, hmacSha256Hex, isLiveKey, safeEqualHex, verifyRazorpaySignature } from "../functions/razorpay-webhook/razorpay.ts";

const SECRET = "test_webhook_secret_fixture"; // fixture value only
const RAW = '{"entity":"event","event":"subscription.activated","payload":{"subscription":{"entity":{"id":"sub_fixture","plan_id":"plan_fixture","notes":{"user_id":"00000000-0000-4000-8000-000000000001"}}}}}';
const nodeSig = (body, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");

test("HMAC matches Node's implementation (the algorithm Razorpay documents)", async () => {
  assert.equal(await hmacSha256Hex(RAW, SECRET), nodeSig(RAW));
});

test("valid signature over the raw body is accepted (case-insensitive hex)", async () => {
  assert.equal(await verifyRazorpaySignature(RAW, nodeSig(RAW), SECRET), true);
  assert.equal(await verifyRazorpaySignature(RAW, nodeSig(RAW).toUpperCase(), SECRET), true);
});

test("tampered body, re-serialised JSON, wrong secret, missing parts are all rejected", async () => {
  const sig = nodeSig(RAW);
  assert.equal(await verifyRazorpaySignature(RAW.replace("activated", "cancelled"), sig, SECRET), false);
  assert.equal(await verifyRazorpaySignature(JSON.stringify(JSON.parse(RAW), null, 1), sig, SECRET), false, "must use the raw body");
  assert.equal(await verifyRazorpaySignature(RAW, nodeSig(RAW, "other_secret"), SECRET), false);
  assert.equal(await verifyRazorpaySignature(RAW, null, SECRET), false);
  assert.equal(await verifyRazorpaySignature(RAW, sig, undefined), false, "unconfigured secret never verifies");
  assert.equal(await verifyRazorpaySignature(RAW, sig.slice(0, 10), SECRET), false);
});

test("constant-time comparison helper", () => {
  assert.equal(safeEqualHex("abc", "abc"), true);
  assert.equal(safeEqualHex("abc", "abd"), false);
  assert.equal(safeEqualHex("", ""), false);
  assert.equal(safeEqualHex("ab", "abc"), false);
});

test("live keys are recognised so they can be refused outside production", () => {
  assert.equal(isLiveKey("rzp_live_x"), true);
  assert.equal(isLiveKey("rzp_test_x"), false);
  assert.equal(isLiveKey(undefined), false);
});

test("event description: subscription id extracted; malformed bodies rejected", () => {
  assert.deepEqual(describeEvent(JSON.parse(RAW)), { event: "subscription.activated", subscriptionId: "sub_fixture" });
  assert.deepEqual(describeEvent({ event: "payment.captured", payload: {} }), { event: "payment.captured", subscriptionId: null });
  assert.equal(describeEvent(null), null);
  assert.equal(describeEvent({ payload: {} }), null);
});

// ---- order payments (launch build 21 Nov)
import { describePaymentEvent, paymentsConfigured, verifyPaymentSignature } from "../functions/razorpay-webhook/razorpay.ts";
import { readFileSync } from "node:fs";

const KEY_SECRET = "test_key_secret_fixture"; // fixture value only
test("checkout signature: HMAC of 'order_id|payment_id' with the key secret; anything else rejected", async () => {
  const sig = createHmac("sha256", KEY_SECRET).update("order_FIX123|pay_FIX456").digest("hex");
  assert.equal(await verifyPaymentSignature("order_FIX123", "pay_FIX456", sig, KEY_SECRET), true);
  assert.equal(await verifyPaymentSignature("order_FIX123", "pay_OTHER", sig, KEY_SECRET), false, "payment id swapped");
  assert.equal(await verifyPaymentSignature("order_OTHER", "pay_FIX456", sig, KEY_SECRET), false, "order id swapped");
  assert.equal(await verifyPaymentSignature("order_FIX123", "pay_FIX456", sig, "wrong_secret"), false);
  assert.equal(await verifyPaymentSignature("order_FIX123", "pay_FIX456", null, KEY_SECRET), false);
  assert.equal(await verifyPaymentSignature("order_FIX123", "pay_FIX456", sig, undefined), false, "unconfigured secret never verifies");
});

test("payment webhook events map to recorded outcomes; subscription and unknown events are not order payments", () => {
  const p = (event, payment, extra = {}) => ({ event, payload: { payment: { entity: payment }, ...extra } });
  assert.deepEqual(describePaymentEvent(p("payment.captured", { id: "pay_1", order_id: "order_1", amount: 4000 })),
    { outcome: "captured", razorpayOrderId: "order_1", razorpayPaymentId: "pay_1", amount: 4000, refunded: null });
  assert.equal(describePaymentEvent(p("payment.failed", { id: "pay_2", order_id: "order_1", amount: 4000 })).outcome, "failed");
  assert.equal(describePaymentEvent(p("payment.authorized", { id: "pay_3", order_id: "order_1", amount: 4000 })).outcome, "authorized");
  assert.equal(describePaymentEvent({ event: "order.paid", payload: { order: { entity: { id: "order_9" } }, payment: { entity: { id: "pay_9", order_id: "order_9", amount: 100 } } } }).outcome, "captured");
  assert.deepEqual(describePaymentEvent(p("refund.processed", { id: "pay_1", order_id: "order_1", amount: 4000, amount_refunded: 1500 }, { refund: { entity: { amount: 1500 } } })),
    { outcome: "refunded", razorpayOrderId: "order_1", razorpayPaymentId: "pay_1", amount: 4000, refunded: 1500 });
  assert.equal(describePaymentEvent({ event: "subscription.charged", payload: {} }), null);
  assert.equal(describePaymentEvent(p("payment.dispute.created", { id: "pay_1", order_id: "order_1" })), null);
  assert.equal(describePaymentEvent(p("payment.captured", { id: "pay_1" })), null, "no order id: not an order payment");
});

test("online payments stay off without keys, and live keys need the explicit production switch", () => {
  assert.equal(paymentsConfigured("", "", undefined), false);
  assert.equal(paymentsConfigured("rzp_test_x", "", undefined), false);
  assert.equal(paymentsConfigured("rzp_test_x", "secret", undefined), true);
  assert.equal(paymentsConfigured("rzp_live_x", "secret", undefined), false);
  assert.equal(paymentsConfigured("rzp_live_x", "secret", "yes"), false);
  assert.equal(paymentsConfigured("rzp_live_x", "secret", "true"), true);
});

test("payment-ops ships the same Razorpay helper as the webhook (one tested implementation)", () => {
  const a = readFileSync(new URL("../functions/razorpay-webhook/razorpay.ts", import.meta.url));
  const b = readFileSync(new URL("../functions/payment-ops/razorpay.ts", import.meta.url));
  assert.ok(a.equals(b));
});
