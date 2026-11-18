// delivery-update (v4 draft). Same contract as deployed v3; the only change is that validation
// messages raised by delivery_update_assignment (SQLSTATE 22023/P0002/42501) are passed through,
// so staff see e.g. "A reason is required for a failed delivery" instead of a generic error.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const uuid = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
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
const reply = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return reply({ error: "Sign in required" }, 401);
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
      error,
    } = await uc.auth.getUser();
    if (error || !user) return reply({ error: "Invalid session" }, 401);
    const b = await req.json();
    if (
      !uuid(b.assignment_id) ||
      !["accepted", "picked_up", "delivered", "failed"].includes(b.status)
    )
      return reply({ error: "Invalid delivery update" }, 400);
    const db = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: roles, error: re } = await db
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    if (re || !(roles || []).some((r: { role: string }) => r.role === "delivery_staff"))
      return reply({ error: "Delivery staff access required" }, 403);
    const { data, error: rpcError } = await db.rpc("delivery_update_assignment", {
      p_actor_id: user.id,
      p_assignment_id: b.assignment_id,
      p_status: b.status,
      p_note: typeof b.note === "string" ? b.note.slice(0, 500) : null,
    });
    if (rpcError) {
      const known = ["22023", "P0002", "42501"].includes(rpcError.code ?? "");
      return reply(
        { error: known ? rpcError.message : "Delivery status could not be updated" },
        409,
      );
    }
    return reply({ success: true, result: data });
  } catch (e) {
    console.error(e);
    return reply({ error: "The delivery update could not be completed" }, 500);
  }
});
