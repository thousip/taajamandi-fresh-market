import { createClient } from "npm:@supabase/supabase-js@2";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function reply(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
function getKey(jsonName: string, legacyName: string): string {
  const raw = Deno.env.get(jsonName);
  if (raw) { try { const p = JSON.parse(raw); if (p.default) return p.default; } catch {} }
  const value = Deno.env.get(legacyName); if (!value) throw new Error("Server configuration is incomplete"); return value;
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return reply({ error: "Sign in required" }, 401);
  try {
    const url = Deno.env.get("SUPABASE_URL"); if (!url) throw new Error("Missing project URL");
    const pub = getKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
    const secret = getKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
    const userClient = createClient(url, pub, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return reply({ error: "Invalid session" }, 401);
    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: roles, error: roleError } = await admin.from("user_roles").select("role").eq("user_id", user.id);
    if (roleError) throw roleError;
    if (!(roles || []).some((r: { role: string }) => ["admin", "manager"].includes(r.role))) return reply({ error: "Admin access required" }, 403);
    const body = await req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.display_name === "string" ? body.display_name.trim().slice(0, 120) : "";
    const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 20) : null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) return reply({ error: "Enter a valid email and staff name" }, 400);
    const { data: existingProfile, error: profileError } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
    if (profileError) throw profileError;
    let staffUserId: string;
    let invitationSent = false;
    if (existingProfile?.id) {
      staffUserId = existingProfile.id;
    } else {
      const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: name } });
      if (inviteError || !invited.user) return reply({ error: inviteError?.message || "Invitation could not be sent. Check email settings." }, 409);
      staffUserId = invited.user.id;
      invitationSent = true;
    }
    const { data: existingRole, error: lookupError } = await admin.from("user_roles").select("id").eq("user_id", staffUserId).eq("role", "packer_staff").maybeSingle();
    if (lookupError) throw lookupError;
    if (!existingRole) {
      const { error: insertError } = await admin.from("user_roles").insert({ user_id: staffUserId, role: "packer_staff" });
      if (insertError) throw insertError;
    }
    const { error: updateProfileError } = await admin.from("profiles").update({ full_name: name, phone, email }).eq("id", staffUserId);
    if (updateProfileError) throw updateProfileError;
    await admin.from("audit_logs").insert({ actor_id: user.id, action: "packer_staff_invited", entity_type: "user", entity_id: staffUserId, metadata: { email } });
    return reply({ success: true, invitation_sent: invitationSent, staff: { user_id: staffUserId, email, display_name: name, phone, role: "packer_staff" } });
  } catch (error) {
    console.error("staff-admin failed", error);
    return reply({ error: "The staff invitation could not be completed" }, 500);
  }
});