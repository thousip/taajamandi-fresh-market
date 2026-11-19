import { createClient } from "npm:@supabase/supabase-js@2";
const corsHeaders = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
function getKey(jsonName:string,legacyName:string):string{const raw=Deno.env.get(jsonName);if(raw){try{const p=JSON.parse(raw);if(p.default)return p.default;}catch{}}const v=Deno.env.get(legacyName);if(!v)throw new Error("Server configuration is incomplete");return v;}
function reply(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json"}});}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
 if(req.method!=="POST")return reply({error:"Method not allowed"},405);
 try{
  const url=Deno.env.get("SUPABASE_URL");if(!url)throw new Error("Missing URL");
  const secret=getKey("SUPABASE_SECRET_KEYS","SUPABASE_SERVICE_ROLE_KEY");
  const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:products,error:productError}=await admin.from("products").select("id").eq("is_active",true);
  if(productError)throw productError;
  const ids=(products||[]).map((p:{id:string})=>p.id);
  if(!ids.length)return reply({availability:[]});
  // Phase 1D: in_stock follows the per-size availability flag set by the store (no supplier details exposed).
  const {data:variants,error:variantError}=await admin.from("product_variants").select("id,is_available").in("product_id",ids).eq("is_active",true);
  if(variantError)throw variantError;
  return reply({availability:(variants||[]).map((v:{id:string,is_available:boolean})=>({variant_id:v.id,in_stock:v.is_available===true,fulfilment:"next_day_supplier"}))});
 }catch(e){console.error("catalogue-availability failed",e);return reply({error:"Could not load availability"},500);}
});