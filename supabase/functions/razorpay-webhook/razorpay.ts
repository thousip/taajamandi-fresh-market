// Pure Razorpay helpers (no Deno or network APIs) so they run in Deno and in Node tests.
// Webhook signature = hex(HMAC-SHA256(raw request body, webhook secret)), sent in X-Razorpay-Signature.

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison of two hex strings.
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

// Verifies the signature against the RAW body exactly as received (never a re-serialised JSON object).
export async function verifyRazorpaySignature(rawBody: string, signature: string | null, secret: string | undefined): Promise<boolean> {
  if (!secret || !signature || typeof rawBody !== "string") return false;
  const expected = await hmacSha256Hex(rawBody, secret);
  return safeEqualHex(expected, signature.trim().toLowerCase());
}

// Test-mode guard: live keys are refused unless the deployment explicitly allows live payments.
export function isLiveKey(keyId: string | undefined): boolean {
  return typeof keyId === "string" && keyId.startsWith("rzp_live_");
}

// Minimal shape check of a webhook body; the database function does the authoritative processing.
export function describeEvent(body: unknown): { event: string; subscriptionId: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { event?: unknown; payload?: { subscription?: { entity?: { id?: unknown } } } };
  if (typeof b.event !== "string" || !b.event) return null;
  const sid = b.payload?.subscription?.entity?.id;
  return { event: b.event, subscriptionId: typeof sid === "string" ? sid : null };
}

// Checkout result signature for orders = hex(HMAC-SHA256("<razorpay_order_id>|<razorpay_payment_id>", key secret)).
// A valid signature proves the values came from Razorpay; payment-ops still fetches the payment before trusting it.
export async function verifyPaymentSignature(orderId: string, paymentId: string, signature: string | null, keySecret: string | undefined): Promise<boolean> {
  if (!keySecret || !signature || typeof orderId !== "string" || typeof paymentId !== "string" || !orderId || !paymentId) return false;
  const expected = await hmacSha256Hex(`${orderId}|${paymentId}`, keySecret);
  return safeEqualHex(expected, signature.trim().toLowerCase());
}

export type PaymentOutcome = "captured" | "authorized" | "failed" | "refunded";
export interface PaymentEventInfo { outcome: PaymentOutcome; razorpayOrderId: string; razorpayPaymentId: string | null; amount: number | null; refunded: number | null }

// Order-payment webhook events -> the outcome apply_order_payment records. Anything else returns null.
export function describePaymentEvent(body: unknown): PaymentEventInfo | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { event?: string; payload?: { payment?: { entity?: Record<string, unknown> }; order?: { entity?: Record<string, unknown> }; refund?: { entity?: Record<string, unknown> } } };
  const pay = b.payload?.payment?.entity ?? {};
  const orderId = (pay.order_id ?? b.payload?.order?.entity?.id) as unknown;
  if (typeof orderId !== "string" || !orderId) return null;
  const paymentId = typeof pay.id === "string" ? pay.id : null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  switch (b.event) {
    case "payment.captured":
    case "order.paid":
      return { outcome: "captured", razorpayOrderId: orderId, razorpayPaymentId: paymentId, amount: num(pay.amount), refunded: null };
    case "payment.authorized":
      return { outcome: "authorized", razorpayOrderId: orderId, razorpayPaymentId: paymentId, amount: num(pay.amount), refunded: null };
    case "payment.failed":
      return { outcome: "failed", razorpayOrderId: orderId, razorpayPaymentId: paymentId, amount: num(pay.amount), refunded: null };
    case "refund.processed":
    case "refund.created":
      return { outcome: "refunded", razorpayOrderId: orderId, razorpayPaymentId: paymentId, amount: num(pay.amount),
        refunded: num(pay.amount_refunded) ?? num(b.payload?.refund?.entity?.amount) };
    default:
      return null;
  }
}

// Test mode unless the deployment explicitly allows live payments (owner decision, production only).
export function paymentsConfigured(keyId: string | undefined, keySecret: string | undefined, allowLive: string | undefined): boolean {
  return Boolean(keyId && keySecret) && (!isLiveKey(keyId) || allowLive === "true");
}
