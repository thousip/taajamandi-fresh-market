// payment-ops: Razorpay online payment for regular orders (launch build, 21 Nov 2026).
// Actions (all need a signed-in user; the gateway also checks the JWT):
//   config     -> { online_enabled } (never returns secrets)
//   start      -> creates (or reuses) the Razorpay order for the customer's own unpaid online order, for the total the
//                 SERVER calculated, and returns only what Razorpay Checkout needs (public key id, order id, amount)
//   verify     -> checks the checkout signature AND fetches the payment from Razorpay; only then records it
//   reconcile  -> admin/manager: applies missed payments from Razorpay and expires unpaid orders after the
//                 payment window (their items go back to the customer's basket)
// The browser can never mark an order paid. Secrets (Supabase function secrets only): RAZORPAY_KEY_ID,
// RAZORPAY_KEY_SECRET; live keys are refused unless TAAJA_ALLOW_LIVE_PAYMENTS=true (owner decision, production).
import { createClient } from "npm:@supabase/supabase-js@2";
import { paymentsConfigured, verifyPaymentSignature } from "./razorpay.ts";

const PAYMENT_WINDOW_MINUTES = 30; // unpaid online orders older than this are expired by reconcile
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
type Rzp = { ok: boolean; status: number; data: Record<string, unknown> };
async function razorpay(method: string, path: string, keyId: string, keySecret: string, body?: unknown): Promise<Rzp> {
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${keyId}:${keySecret}`) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const configured = paymentsConfigured(keyId, keySecret, Deno.env.get("TAAJA_ALLOW_LIVE_PAYMENTS"));

    if (body.action === "config") return reply({ online_enabled: configured });
    if (!configured) return reply({ error: "Online payment is not available yet. Please choose Cash on Delivery." }, 503);

    const apply = (source: string, rzpOrder: string, payment: Record<string, unknown>) => {
      const st = String(payment.status ?? "");
      const outcome = st === "captured" ? "captured" : st === "authorized" ? "authorized" : st === "failed" ? "failed" : null;
      if (!outcome) return Promise.resolve({ data: { result: "not_final", razorpay_status: st }, error: null });
      return db.rpc("apply_order_payment", {
        p_source: source, p_event_id: null, p_event_type: `payment.${st}`, p_razorpay_order_id: rzpOrder,
        p_razorpay_payment_id: String(payment.id ?? ""), p_amount_paise: Number(payment.amount), p_outcome: outcome,
        p_refunded_paise: null, p_payload: payment,
      });
    };
    const ownOrder = async (orderId: unknown) => {
      if (typeof orderId !== "string" || !uuidRe.test(orderId)) return null;
      const { data } = await db.from("orders").select("id,order_number,user_id,status,payment_method,payment_status,total_paise,placed_at")
        .eq("id", orderId).eq("user_id", user.id).maybeSingle();
      return data;
    };
    const paymentRow = async (orderId: string) => {
      const { data } = await db.from("payments").select("id,provider_order_id,provider_payment_id,status")
        .eq("order_id", orderId).eq("provider", "razorpay").order("created_at").limit(1).maybeSingle();
      return data;
    };
    // Applies any captured/authorized payment Razorpay holds for this Razorpay order (missed callback or webhook).
    const syncFromRazorpay = async (rzpOrder: string, source: string) => {
      const r = await razorpay("GET", `orders/${encodeURIComponent(rzpOrder)}/payments`, keyId, keySecret);
      if (!r.ok) return { synced: false };
      const items = (r.data.items as Record<string, unknown>[] | undefined) ?? [];
      const best = items.find((p) => p.status === "captured") ?? items.find((p) => p.status === "authorized");
      if (!best) return { synced: true, paid: false };
      const { data } = await apply(source, rzpOrder, best);
      return { synced: true, paid: best.status === "captured", result: data };
    };

    if (body.action === "start") {
      const order = await ownOrder(body.order_id);
      if (!order) return reply({ error: "Order not found." }, 404);
      if (order.payment_method !== "razorpay") return reply({ error: "This order is Cash on Delivery." }, 409);
      if (order.payment_status === "paid") return reply({ success: true, already_paid: true });
      if (order.status !== "pending" || !["pending", "failed"].includes(order.payment_status)) {
        return reply({ error: order.status === "cancelled" ? "This order was cancelled because the payment was not completed. Your items are back in your basket." : "This order is not waiting for payment." }, 409);
      }
      const pay = await paymentRow(order.id);
      if (!pay) return reply({ error: "Payment record missing. Please contact support." }, 409);
      let rzpOrder = pay.provider_order_id as string | null;
      if (rzpOrder) {
        const s = await syncFromRazorpay(rzpOrder, "reconcile");
        if (s.paid) return reply({ success: true, already_paid: true });
      } else {
        const r = await razorpay("POST", "orders", keyId, keySecret, {
          amount: order.total_paise, currency: "INR", receipt: String(order.order_number).slice(0, 40),
          notes: { order_id: order.id, order_number: order.order_number },
        });
        if (!r.ok || typeof r.data.id !== "string") {
          console.error("razorpay order create failed", r.status, (r.data.error as { code?: string } | undefined)?.code);
          return reply({ error: "Could not start the payment. Please try again." }, 502);
        }
        const { data: att, error: attErr } = await db.rpc("attach_razorpay_order", {
          p_user_id: user.id, p_order_id: order.id, p_razorpay_order_id: r.data.id, p_amount_paise: order.total_paise,
        });
        if (attErr) return reply({ error: ["22023", "P0002"].includes(attErr.code ?? "") ? attErr.message : "Could not start the payment." }, 409);
        rzpOrder = (att as { razorpay_order_id: string }).razorpay_order_id;
      }
      return reply({ success: true, key_id: keyId, razorpay_order_id: rzpOrder, amount: order.total_paise, currency: "INR", order_number: order.order_number });
    }

    if (body.action === "verify") {
      const order = await ownOrder(body.order_id);
      if (!order) return reply({ error: "Order not found." }, 404);
      const pay = await paymentRow(order.id);
      const rzpOrder = String(body.razorpay_order_id ?? ""), rzpPayment = String(body.razorpay_payment_id ?? "");
      if (!pay?.provider_order_id || pay.provider_order_id !== rzpOrder) return reply({ error: "This payment does not belong to this order." }, 409);
      if (!(await verifyPaymentSignature(rzpOrder, rzpPayment, body.razorpay_signature ?? null, keySecret))) {
        return reply({ error: "Payment could not be verified." }, 400);
      }
      const r = await razorpay("GET", `payments/${encodeURIComponent(rzpPayment)}`, keyId, keySecret);
      if (!r.ok || r.data.order_id !== rzpOrder) return reply({ error: "Payment could not be confirmed with Razorpay yet. We will update your order automatically." }, 502);
      const { data, error } = await apply("verify", rzpOrder, r.data);
      if (error) return reply({ error: "Payment received but not yet recorded. We will update your order automatically." }, 500);
      const result = (data as { result?: string; payment_status?: string }) ?? {};
      return reply({ success: true, paid: result.payment_status === "paid", result: result.result, payment_status: result.payment_status });
    }

    if (body.action === "reconcile") {
      const { data: roleRows } = await db.from("user_roles").select("role").eq("user_id", user.id);
      if (!(roleRows || []).some((r: { role: string }) => ["admin", "manager"].includes(r.role))) return reply({ error: "You do not have permission" }, 403);
      const { data: open } = await db.from("orders").select("id,order_number,placed_at,payment_status")
        .eq("payment_method", "razorpay").eq("status", "pending").in("payment_status", ["pending", "failed", "authorized"]).limit(50);
      const summary = { checked: 0, paid: 0, expired: 0, waiting: 0, errors: 0 };
      for (const o of open || []) {
        summary.checked++;
        const pay = await paymentRow(o.id);
        if (pay?.provider_order_id) {
          const s = await syncFromRazorpay(pay.provider_order_id, "reconcile");
          if (!s.synced) { summary.errors++; continue; }
          if (s.paid) { summary.paid++; continue; }
        }
        const ageMin = (Date.now() - new Date(o.placed_at).getTime()) / 60000;
        if (ageMin >= PAYMENT_WINDOW_MINUTES && o.payment_status !== "authorized") {
          const { error } = await db.rpc("expire_unpaid_online_order", { p_order_id: o.id, p_reason: "Online payment not completed" });
          if (error) summary.errors++; else summary.expired++;
        } else summary.waiting++;
      }
      const { data: refunds } = await db.from("orders").select("order_number,total_paise")
        .eq("payment_method", "razorpay").eq("status", "cancelled").eq("payment_status", "paid").limit(50);
      return reply({ success: true, ...summary, refund_needed: refunds || [] });
    }
    return reply({ error: "Unknown payment action" }, 400);
  } catch (e) {
    console.error("payment-ops failed", e);
    return reply({ error: "The payment request could not be completed" }, 500);
  }
});
