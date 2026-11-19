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
