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
