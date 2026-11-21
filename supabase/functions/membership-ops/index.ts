// membership-ops: start or cancel a membership subscription for the signed-in customer.
// The browser NEVER activates a membership: this function only creates a Razorpay subscription (status stays
// 'pending'); it becomes 'active' only when the signature-verified webhook reports it.
// Secrets (Supabase Edge Function secrets, never in the repo): RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET.
// Live keys (rzp_live_...) are refused unless TAAJA_ALLOW_LIVE_PAYMENTS=true is set deliberately for production.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
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
const TOTAL_CYCLES: Record<string, number> = { weekly: 52, monthly: 12 };

async function razorpay(path: string, body: unknown, keyId: string, keySecret: string) {
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${keyId}:${keySecret}`) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return reply({ error: "Sign in required" }, 401);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const uc = createClient(url, key("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"), {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: ae } = await uc.auth.getUser();
    if (ae || !user) return reply({ error: "Invalid session" }, 401);
    const db = createClient(url, key("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const body = await req.json().catch(() => ({}));
    const keyId = Deno.env.get("RAZORPAY_KEY_ID") ?? "";
    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET") ?? "";
    const configured = Boolean(keyId && keySecret) &&
      (!keyId.startsWith("rzp_live_") || Deno.env.get("TAAJA_ALLOW_LIVE_PAYMENTS") === "true");

    if (body.action === "subscribe") {
      const { data: plan } = await db.from("membership_plans").select("code,name,razorpay_plan_id,is_enabled")
        .eq("code", String(body.plan_code ?? "")).maybeSingle();
      if (!plan || !plan.is_enabled || !plan.razorpay_plan_id) return reply({ error: "This membership is not available yet." }, 409);
      if (!configured) return reply({ error: "Membership payments are not configured yet." }, 503);
      const { data: live } = await db.from("memberships").select("id,status,current_period_end")
        .eq("user_id", user.id).in("status", ["pending", "active"]);
      if ((live || []).some((m: { status: string }) => m.status === "active")) return reply({ error: "You already have an active membership." }, 409);
      // An unpaid earlier checkout must not block a new attempt.
      await db.from("memberships").update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("user_id", user.id).eq("status", "pending");
      const r = await razorpay("subscriptions", {
        plan_id: plan.razorpay_plan_id,
        total_count: TOTAL_CYCLES[plan.code] ?? 12,
        customer_notify: 1,
        notes: { user_id: user.id, plan_code: plan.code },
      }, keyId, keySecret);
      if (!r.ok || !r.data?.id) {
        console.error("razorpay subscription create failed", r.data?.error?.code);
        return reply({ error: "Could not start the membership payment. Please try again." }, 502);
      }
      const { error: insErr } = await db.from("memberships").insert({
        user_id: user.id, plan_code: plan.code, status: "pending", razorpay_subscription_id: r.data.id,
      });
      if (insErr) throw insErr;
      return reply({ success: true, subscription_id: r.data.id, key_id: keyId, plan: plan.code, plan_name: plan.name });
    }

    if (body.action === "cancel") {
      const { data: m } = await db.from("memberships").select("id,status,razorpay_subscription_id,cancel_requested_at,current_period_end")
        .eq("user_id", user.id).eq("status", "active").maybeSingle();
      if (!m?.razorpay_subscription_id) return reply({ error: "No active membership to cancel." }, 409);
      if (m.cancel_requested_at) return reply({ success: true, already: true, message: "Your membership is already set to end at the close of the current period." });
      if (!configured) return reply({ error: "Membership payments are not configured yet." }, 503);
      const r = await razorpay(`subscriptions/${m.razorpay_subscription_id}/cancel`, { cancel_at_cycle_end: 1 }, keyId, keySecret);
      if (!r.ok) return reply({ error: "Could not cancel right now. Please try again." }, 502);
      // Record the request only after Razorpay accepted it; the membership stays active until the period ends.
      const now = new Date().toISOString();
      const { error: upErr } = await db.from("memberships").update({ cancel_requested_at: now, updated_at: now }).eq("id", m.id);
      if (upErr) console.error("membership cancel recorded at Razorpay but not saved", upErr.code);
      await db.from("audit_logs").insert({ actor_id: user.id, action: "membership_cancel_requested", entity_type: "membership", entity_id: m.id,
        metadata: { razorpay_subscription_id: m.razorpay_subscription_id, ends_at: m.current_period_end } });
      return reply({ success: true, message: "Your membership will end at the close of the current period." });
    }
    return reply({ error: "Unknown membership action" }, 400);
  } catch (e) {
    console.error("membership-ops failed", e);
    return reply({ error: "The membership request could not be completed" }, 500);
  }
});
