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
   if(!uuid(body.variant_id)||typeof body.delta!=="number"||!Number.isFinite(body.delta)||body.delta===0||Math.abs(body.delta)>100000)return reply({error:"Enter a valid stock adjustment"},400);
   const {data,error}=await admin.rpc("admin_adjust_inventory",{p_actor_id:user.id,p_variant_id:body.variant_id,p_delta:body.delta,p_notes:typeof body.notes==="string"?body.notes.slice(0,500):null});
   if(error)return reply({error:error.message.includes("reserved")?error.message:"Stock adjustment could not be completed"},409);
   return reply({success:true,inventory:data});
  }
  if(body.action==="variant_availability"){
   // Phase 1D: admin/manager; reason required; the history row is written by a database trigger, the audit row by the function.
   if(!uuid(body.variant_id)||typeof body.available!=="boolean")return reply({error:"Choose a size and whether it is available"},400);
   const {data,error}=await admin.rpc("admin_set_variant_availability",{p_actor_id:user.id,p_variant_id:body.variant_id,p_available:body.available,p_reason:typeof body.reason==="string"?body.reason.slice(0,500):null});
   if(error)return reply({error:["22023","42501","P0002"].includes(error.code??"")?error.message:"Availability could not be updated"},error.code==="42501"?403:409);
   return reply({success:true,result:data});
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
  // Staff roles (Phase 1C): admins only; every role change goes through admin_grant_staff_role /
  // admin_revoke_staff_role, which write the role and its audit entry in one transaction.
  const STAFF_ROLES=["packer_staff","delivery_staff"];
  const staffChangeError=(e:{code?:string,message?:string})=>reply({error:["22023","42501","P0002"].includes(e.code??"")?e.message:"The staff change could not be completed"},e.code==="42501"?403:409);
  if(["invite_staff","invite_delivery_staff","revoke_staff_role","list_staff"].includes(body.action)&&!roles.includes("admin"))return reply({error:"Only an admin can manage staff accounts"},403);
  if(body.action==="invite_staff"||body.action==="invite_delivery_staff"){
   const role=body.action==="invite_delivery_staff"?"delivery_staff":body.role;
   if(!STAFF_ROLES.includes(role))return reply({error:"Choose packer or delivery staff"},400);
   const email=typeof body.email==="string"?body.email.trim().toLowerCase():"",name=typeof body.display_name==="string"?body.display_name.trim().slice(0,120):"",phone=typeof body.phone==="string"?body.phone.trim().slice(0,20):null;
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name)return reply({error:"Enter a valid email and staff name"},400);
   let staffUserId:string|null=null;
   const {data:existing,error:lookupError}=await admin.from("profiles").select("id").eq("email",email).maybeSingle();if(lookupError)throw lookupError;
   if(existing?.id)staffUserId=existing.id; // existing account: its own name and phone are left unchanged
   else{const {data:invited,error:inviteError}=await admin.auth.admin.inviteUserByEmail(email,{data:{full_name:name}});if(inviteError||!invited.user)return reply({error:inviteError?.message||"Could not send invitation. Check Supabase email settings."},409);staffUserId=invited.user.id;
    if(phone)await admin.from("profiles").update({phone}).eq("id",staffUserId);}
   const {data:granted,error:grantError}=await admin.rpc("admin_grant_staff_role",{p_actor_id:user.id,p_user_id:staffUserId,p_role:role});
   if(grantError)return staffChangeError(grantError);
   let staff=null;
   if(role==="delivery_staff"){const {data,error:staffError}=await admin.from("delivery_staff").upsert({user_id:staffUserId,display_name:name,phone,vehicle_type:typeof body.vehicle_type==="string"?body.vehicle_type.slice(0,50):null,vehicle_number:typeof body.vehicle_number==="string"?body.vehicle_number.slice(0,30):null,is_active:true,is_available:true},{onConflict:"user_id"}).select().single();if(staffError)throw staffError;staff=data;}
   return reply({success:true,role,user_id:staffUserId,granted:granted?.granted??true,staff,invitation_sent:!existing?.id});
  }
  if(body.action==="revoke_staff_role"){
   if(!uuid(body.user_id)||!STAFF_ROLES.includes(body.role))return reply({error:"Choose a staff member and role"},400);
   const {data,error}=await admin.rpc("admin_revoke_staff_role",{p_actor_id:user.id,p_user_id:body.user_id,p_role:body.role,p_reason:typeof body.reason==="string"?body.reason.slice(0,500):null});
   if(error)return staffChangeError(error);
   return reply({success:true,result:data});
  }
  if(body.action==="list_staff"){
   const {data:rows,error}=await admin.from("user_roles").select("user_id,role").in("role",STAFF_ROLES);if(error)throw error;
   const ids=[...new Set((rows||[]).map((r:{user_id:string})=>r.user_id))];
   const {data:people,error:peopleError}=ids.length?await admin.from("profiles").select("id,full_name,email").in("id",ids):{data:[],error:null};if(peopleError)throw peopleError;
   return reply({staff:(rows||[]).map((r:{user_id:string,role:string})=>{const p=(people||[]).find((x:{id:string})=>x.id===r.user_id);return {user_id:r.user_id,role:r.role,name:p?.full_name||null,email:p?.email||null};})});
  }
  return reply({error:"Unknown admin operation"},400);
 }catch(e){console.error("admin-ops failed",e);return reply({error:"The request could not be completed"},500);}
});