// create-order (v5, deployed 2026-11-18). Based on deployed v4; changes are limited to:
//  * launch booking rules: before 2026-12-01 advance only with delivery on/after 2026-12-01;
//    from 2026-12-01 same-day (today) or advance (future). Mirrors the orders trigger.
//  * slot-capacity / expired-slot errors from create_order_from_cart are shown to the customer.
// Delivery boundary is unchanged: 7,400 m around 17.5299559, 78.3055903 (owner-approved).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const center = { lat: 17.5299559, lng: 78.3055903 },
  radius = 7400;
const DELIVERY_START = "2026-12-01";

function within(lat: number, lng: number) {
  const R = 6371000,
    rad = (x: number) => (x * Math.PI) / 180,
    dLat = rad(lat - center.lat),
    dLng = rad(lng - center.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(center.lat)) * Math.cos(rad(lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a)) <= radius;
}
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
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const validDate = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  new Date(v + "T12:00:00Z").toISOString().slice(0, 10) === v;

function bookingError(d: string, type: unknown, date: unknown): string | null {
  if (!validDate(date) || !["same_day", "advance"].includes(type as string))
    return "Choose a valid delivery type and date.";
  if (d < DELIVERY_START)
    return type !== "advance" || date < DELIVERY_START
      ? "Deliveries start on 1 December 2026. Choose 1 December or a later date."
      : null;
  if (type === "same_day" && date !== d) return "Same-day delivery must be scheduled for today.";
  if (type === "advance" && date <= d)
    return "Advance delivery must be scheduled for a future date.";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return reply({ error: "Authentication required" }, 401);
  try {
    const url = Deno.env.get("SUPABASE_URL")!,
      pub = key("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"),
      secret = key("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
    const uc = createClient(url, pub, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const {
      data: { user },
      error: ae,
    } = await uc.auth.getUser();
    if (ae || !user) return reply({ error: "Invalid session" }, 401);
    const b = await req.json(),
      uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(b.address_id || "") || !uuid.test(b.delivery_zone_id || ""))
      return reply({ error: "A valid address and delivery area are required" }, 400);
    if (b.delivery_slot_id && !uuid.test(b.delivery_slot_id))
      return reply({ error: "Invalid delivery slot" }, 400);
    if ((b.payment_method || "cod") !== "cod")
      return reply({ error: "Cash on Delivery is the only enabled payment method." }, 400);
    const scheduleError = bookingError(today(), b.delivery_type, b.requested_delivery_date);
    if (scheduleError) return reply({ error: scheduleError }, 400);

    const db = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: addr, error: adErr } = await db
      .from("addresses")
      .select("id,user_id,latitude,longitude")
      .eq("id", b.address_id)
      .eq("user_id", user.id)
      .single();
    if (adErr || !addr) return reply({ error: "Delivery address not found." }, 404);
    const lat = Number(addr.latitude),
      lng = Number(addr.longitude);
    if (
      addr.latitude === null ||
      addr.longitude === null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      !within(lat, lng)
    ) {
      return reply(
        { error: "Sorry, this address is outside TaajaMandi delivery area. Coming soon!" },
        400,
      );
    }

    const { data: order, error } = await db.rpc("create_order_from_cart", {
      p_user_id: user.id,
      p_address_id: b.address_id,
      p_delivery_zone_id: b.delivery_zone_id,
      p_delivery_slot_id: b.delivery_slot_id ?? null,
      p_payment_method: "cod",
      p_customer_note: b.customer_note ?? null,
      p_requested_delivery_date: b.requested_delivery_date,
      p_delivery_type: b.delivery_type,
    });
    if (error) {
      console.error(error.code, error.message);
      const m = error.message || "";
      const safe = m.includes("cart is empty")
        ? "Your cart is empty"
        : /delivery|Delivery|slot|minimum order|no longer available/.test(m)
          ? m
          : "Unable to place order. Please review your cart and try again.";
      return reply({ error: safe }, 409);
    }
    return reply({ success: true, order }, 201);
  } catch (e) {
    console.error(e);
    return reply({ error: "Unexpected server error. Please try again." }, 500);
  }
});
