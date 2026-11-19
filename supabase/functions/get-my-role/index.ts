import { createClient } from "npm:@supabase/supabase-js@2";
const corsHeaders = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
function getKey(jsonName:string,legacyName:string):string{const raw=Deno.env.get(jsonName);if(raw){try{const p=JSON.parse(raw);if(p.default)return p.default;}catch{}}const v=Deno.env.get(legacyName);if(!v)throw new Error("Server configuration is incomplete");return v;}
function reply(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json"}});}

Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
 if(req.method!=="POST")return reply({error:"Method not allowed"},405);
 const authorization=req.headers.get("Authorization");if(!authorization?.startsWith("Bearer "))return reply({error:"Sign in required"},401);
 try{
  const url=Deno.env.get("SUPABASE_URL");if(!url)throw new Error("Missing URL");
  const pub=getKey("SUPABASE_PUBLISHABLE_KEYS","SUPABASE_ANON_KEY"),secret=getKey("SUPABASE_SECRET_KEYS","SUPABASE_SERVICE_ROLE_KEY");
  const userClient=createClient(url,pub,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error}=await userClient.auth.getUser();if(error||!user)return reply({error:"Invalid session"},401);
  const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:rows,error:roleError}=await admin.from("user_roles").select("role").eq("user_id",user.id);
  if(roleError)throw roleError;
  const {data:profile}=await admin.from("profiles").select("full_name,phone,email").eq("id",user.id).maybeSingle();
  return reply({user:{id:user.id,email:user.email},roles:(rows||[]).map((r:{role:string})=>r.role),profile});
 }catch(e){console.error("get-my-role failed",e);return reply({error:"Could not load account permissions"},500);}
});