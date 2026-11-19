// razorpay-webhook: receives Razorpay subscription webhooks (configure in the Razorpay dashboard, TEST MODE for QA).
// No JWT (Razorpay cannot send one): authenticity comes ONLY from the HMAC signature over the raw body.
// Each event id (X-Razorpay-Event-Id) is applied once by apply_razorpay_subscription_event (idempotent).
// Required secret (Supabase Edge Function secrets, never in the repo): RAZORPAY_WEBHOOK_SECRET.
import { createClient } from "npm:@supabase/supabase-js@2";
import { describeEvent, verifyRazorpaySignature } from "./razorpay.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function key(a: string, b: string) {
  const raw = Deno.env.get(a);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p.default) return p.default;
    } catch {
      /* fall through */
    }
  }
  const v = Deno.env.get(b);
  if (!v) throw new Error("Server configuration is incomplete");
  return v;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const webhookSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
  if (!webhookSecret) return json({ error: "Webhook is not configured" }, 503);
  const raw = await req.text();
  if (!(await verifyRazorpaySignature(raw, req.headers.get("x-razorpay-signature"), webhookSecret))) {
    return json({ error: "Invalid signature" }, 401);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const info = describeEvent(body);
  const eventId = req.headers.get("x-razorpay-event-id") ?? "";
  if (!info || !eventId) return json({ error: "Missing event details" }, 400);
  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, key("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await db.rpc("apply_razorpay_subscription_event", {
      p_event_id: eventId,
      p_event_type: info.event,
      p_payload: body,
    });
    if (error) {
      console.error("razorpay-webhook apply failed", error.code, error.message);
      return json({ error: "Event could not be applied" }, 500); // Razorpay retries non-2xx responses
    }
    return json({ ok: true, result: data });
  } catch (e) {
    console.error("razorpay-webhook failed", e);
    return json({ error: "Event could not be applied" }, 500);
  }
});
