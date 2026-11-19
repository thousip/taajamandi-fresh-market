import { createClient } from "npm:@supabase/supabase-js@2";
const corsHeaders = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
function getKey(jsonName:string,legacyName:string):string{const raw=Deno.env.get(jsonName);if(raw){try{const p=JSON.parse(raw);if(p.default)return p.default;}catch{}}const v=Deno.env.get(legacyName);if(!v)throw new Error("Server configuration is incomplete");return v;}
function reply(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json"}});}

const uuid=(v:unknown)=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
 if(req.method!=="POST")return reply({error:"Method not allowed"},405);
 const authorization=req.headers.get("Authorization");if(!authorization?.startsWith("Bearer "))return reply({error:"Sign in required"},401);
 try{
  const url=Deno.env.get("SUPABASE_URL");if(!url)throw new Error("Missing URL");
  const pub=getKey("SUPABASE_PUBLISHABLE_KEYS","SUPABASE_ANON_KEY"),secret=getKey("SUPABASE_SECRET_KEYS","SUPABASE_SERVICE_ROLE_KEY");
  const userClient=createClient(url,pub,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await userClient.auth.getUser();if(authError||!user)return reply({error:"Invalid session"},401);
  const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:roleRows,error:roleError}=await admin.from("user_roles").select("role").eq("user_id",user.id);if(roleError)throw roleError;
  const roles=(roleRows||[]).map((r:{role:string})=>r.role),isAdmin=roles.includes("admin")||roles.includes("manager");
  if(!isAdmin)return reply({error:"You do not have permission"},403);
  const body=await req.json();
  if(body.action==="inventory_adjust"){
   if(!roles.some((r:string)=>["admin","manager","inventory_staff"].includes(r)))return reply({error:"Not authorized"},403);
   if(!uuid(body.variant_id)||typeof body.delta!=="number"||!Number.isFinite(body.delta)||body.delta===0||Math.abs(body.delta)>100000)return reply({error:"Enter a valid stock adjustment"},400);
   const {data,error}=await admin.rpc("admin_adjust_inventory",{p_actor_id:user.id,p_variant_id:body.variant_id,p_delta:body.delta,p_notes:typeof body.notes==="string"?body.notes.slice(0,500):null});
   if(error)return reply({error:error.message.includes("reserved")?error.message:"Stock adjustment could not be completed"},409);
   return reply({success:true,inventory:data});
  }
  if(body.action==="order_status"){
   if(!uuid(body.order_id)||typeof body.status!=="string")return reply({error:"Invalid order update"},400);
   const {data,error}=await admin.rpc("admin_update_order_status",{p_actor_id:user.id,p_order_id:body.order_id,p_status:body.status,p_reason:typeof body.reason==="string"?body.reason.slice(0,500):null});
   if(error)return reply({error:error.message.includes("order")||error.message.includes("Order")?error.message:"Order status could not be updated"},409);
   return reply({success:true,result:data});
  }
  if(body.action==="assign_delivery"){
   if(!uuid(body.order_id)||!uuid(body.delivery_staff_id))return reply({error:"Choose an order and delivery staff member"},400);
   const {data:staff,error:staffError}=await admin.from("delivery_staff").select("id,user_id,is_active").eq("id",body.delivery_staff_id).maybeSingle();
   if(staffError||!staff||!staff.is_active)return reply({error:"Delivery staff member is not active"},404);
   const {data:staffRoles}=await admin.from("user_roles").select("role").eq("user_id",staff.user_id);
   if(!(staffRoles||[]).some((r:{role:string})=>r.role==="delivery_staff"))return reply({error:"Account is not registered as delivery staff"},409);
   const {data:order,error:orderError}=await admin.from("orders").select("id,status").eq("id",body.order_id).maybeSingle();
   if(orderError||!order)return reply({error:"Order not found"},404);
   if(["delivered","cancelled","refunded"].includes(order.status))return reply({error:"Closed orders cannot be assigned"},409);
   const {data,error}=await admin.from("delivery_assignments").upsert({order_id:body.order_id,delivery_staff_id:body.delivery_staff_id,assigned_by:user.id,status:"assigned",assigned_at:new Date().toISOString(),accepted_at:null,picked_up_at:null,delivered_at:null,delivery_note:null},{onConflict:"order_id"}).select().single();
   if(error)throw error;
   await admin.from("audit_logs").insert({actor_id:user.id,action:"delivery_assigned",entity_type:"order",entity_id:body.order_id,metadata:{delivery_staff_id:body.delivery_staff_id}});
   return reply({success:true,assignment:data});
  }
  if(body.action==="invite_delivery_staff"){
   const email=typeof body.email==="string"?body.email.trim().toLowerCase():"",name=typeof body.display_name==="string"?body.display_name.trim().slice(0,120):"";
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name)return reply({error:"Enter a valid email and staff name"},400);
   let staffUserId:string|null=null;
   const {data:existing}=await admin.from("profiles").select("id").eq("email",email).maybeSingle();
   if(existing?.id)staffUserId=existing.id;
   else{const {data:invited,error:inviteError}=await admin.auth.admin.inviteUserByEmail(email,{data:{full_name:name}});if(inviteError||!invited.user)return reply({error:inviteError?.message||"Could not send invitation. Check Supabase email settings."},409);staffUserId=invited.user.id;}
   const {data:roleExisting,error:roleLookupError}=await admin.from("user_roles").select("id").eq("user_id",staffUserId).eq("role","delivery_staff").maybeSingle();
   if(roleLookupError)throw roleLookupError;
   if(!roleExisting){const {error:roleInsertError}=await admin.from("user_roles").insert({user_id:staffUserId,role:"delivery_staff"});if(roleInsertError)throw roleInsertError;}
   await admin.from("profiles").update({full_name:name,phone:typeof body.phone==="string"?body.phone.slice(0,20):null}).eq("id",staffUserId);
   const {data:staff,error:staffError}=await admin.from("delivery_staff").upsert({user_id:staffUserId,display_name:name,phone:typeof body.phone==="string"?body.phone.slice(0,20):null,vehicle_type:typeof body.vehicle_type==="string"?body.vehicle_type.slice(0,50):null,vehicle_number:typeof body.vehicle_number==="string"?body.vehicle_number.slice(0,30):null,is_active:true,is_available:true},{onConflict:"user_id"}).select().single();
   if(staffError)throw staffError;
   await admin.from("audit_logs").insert({actor_id:user.id,action:"delivery_staff_invited",entity_type:"delivery_staff",entity_id:staff.id,metadata:{email}});
   return reply({success:true,staff,invitation_sent:!existing?.id});
  }
  return reply({error:"Unknown admin operation"},400);
 }catch(e){console.error("admin-ops failed",e);return reply({error:"The request could not be completed"},500);}
});