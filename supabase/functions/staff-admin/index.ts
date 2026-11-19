// staff-admin: RETIRED in Phase 1C (owner decision, 19 Nov 2026).
// Staff invitations and role changes now go only through admin-ops (invite_staff / revoke_staff_role),
// which calls the audited database functions admin_grant_staff_role / admin_revoke_staff_role (admins only).
// This function stays deployed so old clients get a clear answer, but it can no longer grant any role.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return new Response(
    JSON.stringify({ error: "Staff invitations have moved to the admin panel (Delivery team tab)." }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
