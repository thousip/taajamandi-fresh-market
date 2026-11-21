// TaajaMandi storefront — environment guard, Supabase client, catalogue, basket, auth, checkout and orders.
// Plain script (not a module): top-level names are shared with admin.js and app.js. Loaded after rules.js.
'use strict';

// Supabase project is chosen at build time (scripts/write-env-config.mjs): production builds only on production hosts; previews and local use QA.
const TAAJA_ENV = window.TAAJA_ENV;
if (!TAAJA_ENV || !TAAJA_ENV.supabaseUrl || !TAAJA_ENV.publishableKey
    || (TAAJA_ENV.environment === 'production' && !(TAAJA_ENV.allowedHosts || []).includes(location.hostname))) {
  document.body.innerHTML = '<main style="font-family:system-ui;padding:2rem;max-width:36rem;margin:auto"><h1>TaajaMandi is not available here</h1><p>This copy of the site has no valid environment configuration, so it will not connect to any database.</p></main>';
  throw new Error('TAAJA_ENV missing or not allowed on ' + location.hostname);
}
if (TAAJA_ENV.environment !== 'production') {
  const qaBanner = document.createElement('div');
  qaBanner.id = 'qaEnvBanner';
  qaBanner.setAttribute('role', 'status');
  qaBanner.textContent = 'QA / TEST ENVIRONMENT — not the live store. Orders here are test data (' + TAAJA_ENV.projectRef + ').';
  qaBanner.style.cssText = 'position:sticky;top:0;z-index:9999;background:#b91c1c;color:#fff;font:600 13px/1.4 system-ui;padding:6px 12px;text-align:center';
  document.body.prepend(qaBanner);
}
const productImageUrl = (client, path) => TAAJA_ENV.imagePublicBase
  ? TAAJA_ENV.imagePublicBase + String(path).split('/').map(encodeURIComponent).join('/')
  : client.storage.from('product-images').getPublicUrl(path).data.publicUrl;
const SUPABASE_URL = TAAJA_ENV.supabaseUrl;
const SUPABASE_PUBLISHABLE_KEY = TAAJA_ENV.publishableKey;
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });
// Password recovery: the reset email link signs the user in with a recovery session. Remember it before
// the client clears the URL, then ask for a new password (Supabase does not prompt for one by itself).
const authUrlParams=new URLSearchParams((location.hash||'').replace(/^#/,'')+'&'+(location.search||'').replace(/^\?/,''));
let passwordRecoveryPending=authUrlParams.get('type')==='recovery';
supabase.auth.onAuthStateChange(event=>{if(event==='PASSWORD_RECOVERY'){passwordRecoveryPending=true;setTimeout(openPasswordRecovery,0);}});

let session=null, profile=null, roles=[], products=[], categories=[], zones=[], slots=[], cart={};
let activeCat='all', searchTerm='', coupon=null, couponMsgText='', authMode='signin', authMethod='email', otpPendingPhone='', adminTab='overview', editingProduct=null, weightPopupState={pid:null,variantId:null};
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>'₹'+(Number(n||0)).toLocaleString('en-IN',{maximumFractionDigits:2});
const rupees=paise=>Number(paise||0)/100;
const slugify=s=>String(s||'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const iconFor=name=>{const n=String(name||'').toLowerCase();for(const [k,v] of Object.entries({tomato:'🍅',onion:'🧅',potato:'🥔',brinjal:'🍆',eggplant:'🍆',capsicum:'🫑',spinach:'🥬',coriander:'🌿',curry:'🍃',banana:'🍌',apple:'🍎',papaya:'🍈',watermelon:'🍉',mango:'🥭',broccoli:'🥦',mushroom:'🍄',lettuce:'🥗',ginger:'🫚',garlic:'🧄',lemon:'🍋',carrot:'🥕',cucumber:'🥒',corn:'🌽',peas:'🫛',grape:'🍇',orange:'🍊',pineapple:'🍍',strawberry:'🍓',kiwi:'🥝',coconut:'🥥'})){if(n.includes(k))return v;}return '🥬';};
const showMsg=(id,msg,ok=false)=>{const el=$(id);if(el)el.innerHTML=`<div class="msg ${ok?'ok':'err'}">${esc(msg)}</div>`;};
const notify=msg=>alert(msg);


function currentProduct(id){return products.find(p=>p.id===id);}
function currentVariant(id){for(const p of products){const v=p.variants.find(x=>x.id===id);if(v)return {...v,product:p};}return null;}
const MAX_LINE_QTY=50; // per basket line (packs); bulk buying goes through bargain requests
function cartCount(){return Object.values(cart).reduce((s,x)=>s+Number(x.qty||0),0);}
function cartSubtotal(){return Object.values(cart).reduce((s,x)=>s+rupees(x.variant.price_paise)*x.qty,0);}
function cartEntries(){return Object.entries(cart);}
function cartKey(variantId){return variantId;}
// ---- Basket safety (launch fix 21 Nov 2026) ----
// A quantity is valid only if it is a whole number from 1 to 50. Invalid values are NEVER converted to 50:
// a corrupted account line is quarantined (shown, excluded from the basket and checkout, removable), and an
// invalid guest entry is not restored. The guest basket carries a merge id, and the server applies each merge
// id at most once (merge_guest_cart), so several tabs or repeated sign-in events cannot add it twice.
const GUEST_CART_KEY='taajamandi_guest_cart_v1',GUEST_MERGE_KEY='taajamandi_guest_merge_id';
function validLineQty(q){q=Number(q);return Number.isInteger(q)&&q>=1&&q<=MAX_LINE_QTY?q:0;}
let cartQuarantine=[],cartLoadedFor=null,cartLoadChain=Promise.resolve();
function newGuestMergeId(){try{if(crypto?.randomUUID)return 'guest-'+crypto.randomUUID();}catch(e){}return 'guest-'+Date.now().toString(36)+Math.random().toString(36).slice(2,12);}
// Older guest baskets have no merge id: derive one from the stored text so every tab computes the same id.
function guestMergeIdFor(raw){try{const id=localStorage.getItem(GUEST_MERGE_KEY);if(id)return id;}catch(e){}let h=0x811c9dc5;for(let i=0;i<raw.length;i++){h^=raw.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return 'v1-'+h.toString(16).padStart(8,'0')+'-'+raw.length;}
function clearGuestCart(){try{localStorage.removeItem(GUEST_CART_KEY);localStorage.removeItem(GUEST_MERGE_KEY);}catch(e){}}
function saveGuestCart(){if(session?.user)return;try{const lines=Object.entries(cart).map(([id,x])=>[id,{qty:x.qty}]);if(!lines.length){clearGuestCart();return;}localStorage.setItem(GUEST_CART_KEY,JSON.stringify(Object.fromEntries(lines)));if(!localStorage.getItem(GUEST_MERGE_KEY))localStorage.setItem(GUEST_MERGE_KEY,newGuestMergeId());}catch(e){console.warn('Guest cart storage unavailable',e);}}
function readGuestCart(){let raw=null;try{raw=localStorage.getItem(GUEST_CART_KEY);}catch(e){}let parsed={};try{parsed=JSON.parse(raw||'{}')||{};}catch(e){parsed={};}const items=[],invalid=[];for(const [id,x] of Object.entries(parsed)){const v=currentVariant(id),q=validLineQty(x?.qty);if(v&&q)items.push({variant_id:id,quantity:q});else invalid.push(id);}return {raw,items,invalid};}
function restoreGuestCart(){const g=readGuestCart();cart={};for(const it of g.items)cart[it.variant_id]={variant:currentVariant(it.variant_id),qty:it.quantity};if(g.invalid.length){notify(`${g.invalid.length===1?'One item':g.invalid.length+' items'} saved on this device could not be restored because the quantity was not valid. Please add ${g.invalid.length===1?'it':'them'} again.`);saveGuestCart();}}

async function loadCatalogue(){
 const [cRes,pRes]=await Promise.all([
  supabase.from('categories').select('id,name,slug,description,image_url,sort_order').eq('is_active',true).order('sort_order'),
  supabase.from('products').select('id,category_id,name,slug,description,telugu_name,unit_type,is_featured,sort_order').eq('is_active',true).order('sort_order')
 ]);
 if(cRes.error)console.warn('Categories:',cRes.error.message); if(pRes.error)console.warn('Products:',pRes.error.message);
 categories=cRes.data||[]; const base=pRes.data||[]; const ids=base.map(p=>p.id);
 let variants=[],images=[];
 if(ids.length){
  const [vRes,iRes,aRes]=await Promise.all([
   supabase.from('product_variants').select('id,product_id,name,sku,quantity,unit,price_paise,compare_at_price_paise,is_default,is_active,sort_order').in('product_id',ids).eq('is_active',true).order('sort_order'),
   supabase.from('product_images').select('id,product_id,storage_path,alt_text,is_primary,sort_order').in('product_id',ids).order('sort_order'),
   supabase.functions.invoke('catalogue-availability')
  ]);
  const availability=new Map((aRes.data?.availability||[]).map(x=>[x.variant_id,!!x.in_stock]));
  if(!vRes.error)variants=(vRes.data||[]).map(v=>({...v,in_stock:availability.get(v.id)===true})); if(!iRes.error)images=iRes.data||[];
 }
 products=base.map(p=>{
  const cat=categories.find(c=>c.id===p.category_id);
  const vs=variants.filter(v=>v.product_id===p.id).sort((a,b)=>(b.is_default?1:0)-(a.is_default?1:0));
  const im=images.filter(i=>i.product_id===p.id).sort((a,b)=>(b.is_primary?1:0)-(a.is_primary?1:0))[0];
  const imageUrl=im?productImageUrl(supabase,im.storage_path):null;
  return {...p,catSlug:cat?.slug||'other',catName:cat?.name||'Other',variants:vs,imageUrl,icon:iconFor(p.name),price:defaultVariant(vs)?rupees(defaultVariant(vs).price_paise):null,mrp:defaultVariant(vs)?.compare_at_price_paise?rupees(defaultVariant(vs).compare_at_price_paise):null,unit:defaultVariant(vs)?.name||defaultVariant(vs)?.unit||''};
 });
 renderCategories();renderGrid();
}
function renderCategories(){
 const el=$('categories'); const chips=[{slug:'all',name:'All'},...categories.map(c=>({slug:c.slug,name:c.name}))];
 el.innerHTML=chips.map(c=>`<button class="chip ${activeCat===c.slug?'active':''}" data-cat="${esc(c.slug)}">${esc(c.name)}</button>`).join('');
}
function renderGrid(){
 const grid=$('productGrid');grid.removeAttribute('aria-busy'); const list=products.filter(p=>(activeCat==='all'||p.catSlug===activeCat||(activeCat==='fav'&&favourites.has(p.id)))&&(`${p.name} ${p.telugu_name||''}`).toLowerCase().includes(searchTerm.toLowerCase()));
 $('resultCount').textContent=list.length+' item'+(list.length===1?'':'s');
 grid.innerHTML=list.map(p=>{
  const v=defaultVariant(p.variants),disc=v&&v.compare_at_price_paise>v.price_paise?Math.round((v.compare_at_price_paise-v.price_paise)/v.compare_at_price_paise*100):0;
  const photo=p.imageUrl?`<img class="product-photo" src="${esc(p.imageUrl)}" alt="${esc(p.name)}" loading="lazy">`:`<div class="icon">${p.icon}</div>`;
  const count=p.variants.reduce((s,x)=>s+(cart[x.id]?.qty||0),0);
  const available=p.variants.filter(x=>x.in_stock);
  const add=available.length===0?`<button class="add-btn" disabled>Out of stock</button>`:`<button class="add-btn" onclick="openProductDetails('${p.id}')">View product</button>`;
  return `<div class="card" onclick="openProductDetails('${p.id}')" style="cursor:pointer">${dealTag(p)||(disc?`<span class="tag">${disc}% off</span>`:'')}${photo}<div class="name">${esc(p.name)}</div>${p.telugu_name?`<div class="local">${esc(p.telugu_name)}</div>`:''}<div class="unit">${esc(v?.name||'Price not configured')}${p.variants.length>1?` · ${p.variants.length} sizes`:''}</div><div class="price-row"><span class="price">${v?fmt(rupees(v.price_paise)):'—'}</span>${v?.compare_at_price_paise?`<span class="mrp">${fmt(rupees(v.compare_at_price_paise))}</span>`:''}</div>${p.variants.length?add:'<div class="muted">Ask us for availability</div>'}${count?`<div class="muted">${count} in basket</div>`:''}</div>`;
 }).join('')||`<div class="empty" style="grid-column:1/-1">${products.length?'Nothing matches that search.':'No products have been added yet. Our store team is preparing the catalogue.'}</div>`;
}

async function getCartId(){
 if(!session?.user)return null;
 let {data,error}=await supabase.from('carts').select('id').eq('user_id',session.user.id).maybeSingle();
 if(error)throw error;
 if(data)return data.id;
 const created=await supabase.from('carts').insert({user_id:session.user.id}).select('id').single();
 if(created.error)throw created.error;return created.data.id;
}
async function persistCartVariant(variantId){
 if(!session?.user)return;
 const cartId=await getCartId(),line=cart[variantId];
 const {data:existing,error}=await supabase.from('cart_items').select('id').eq('cart_id',cartId).eq('variant_id',variantId).maybeSingle();
 if(error)throw error;
 if(!line){if(existing){const r=await supabase.from('cart_items').delete().eq('id',existing.id);if(r.error)throw r.error;}return;}
 if(existing){const r=await supabase.from('cart_items').update({quantity:line.qty,updated_at:new Date().toISOString()}).eq('id',existing.id);if(r.error)throw r.error;}
 else{const r=await supabase.from('cart_items').insert({cart_id:cartId,variant_id:variantId,quantity:line.qty});if(r.error)throw r.error;}
}
// Loads run one at a time in each tab (boot, INITIAL_SESSION and SIGNED_IN can fire together).
function loadCustomerCart(mergeGuest=false){const run=cartLoadChain.then(()=>loadCustomerCartNow(mergeGuest));cartLoadChain=run.catch(()=>{});return run;}
async function loadCustomerCartNow(mergeGuest){
 if(!session?.user)return;
 const uid=session.user.id;let merged=false;
 if(mergeGuest){
  const g=readGuestCart();
  if(g.items.length){
   // The guest basket stays on this device until the server confirms the merge; nothing is lost on failure.
   const {data,error}=await supabase.rpc('merge_guest_cart',{p_merge_id:guestMergeIdFor(g.raw),p_items:g.items});
   if(error){console.warn('Guest basket merge failed',error);notify('We could not add the items you chose before signing in. They are kept on this device; we will try again when you reload.');}
   else{
    merged=true;
    try{if(localStorage.getItem(GUEST_CART_KEY)===g.raw)clearGuestCart();}catch(e){}
    if(data?.capped?.length)notify('Some sizes reached the limit of 50 per item, so they were set to 50. For larger quantities, send a bargain request.');
    if(data?.skipped?.some(s=>s.reason==='not_available'))notify('Some items you added before signing in are no longer sold and were not added.');
   }
  }else if(g.raw)clearGuestCart();
 }
 if(cartLoadedFor===uid&&!merged)return; // same account, nothing new: never re-read or rewrite on token refresh / tab focus
 const cartId=await getCartId();
 const {data:rows,error}=await supabase.from('cart_items').select('id,variant_id,quantity').eq('cart_id',cartId);
 if(error)throw error;
 if(session?.user?.id!==uid)return; // signed out or switched account while loading
 cart={};cartQuarantine=[];
 for(const row of rows||[]){
  const v=currentVariant(row.variant_id),q=validLineQty(row.quantity);
  if(v&&q)cart[row.variant_id]={variant:v,qty:q};
  else cartQuarantine.push({id:row.id,variant_id:row.variant_id,quantity:Number(row.quantity),label:v?`${v.product.name} · ${v.name}`:'An item that is no longer sold',reason:v?'invalid_quantity':'not_sold'});
 }
 const firstLoad=cartLoadedFor!==uid;cartLoadedFor=uid;
 renderGrid();renderCartCount();renderCart();
 if(cartQuarantine.length&&firstLoad)notify('An item in your basket needs your attention: its saved quantity is not valid, so it was left out. Open your basket to remove it or choose a quantity.');
}
function resetCustomerCart(){cart={};cartQuarantine=[];cartLoadedFor=null;}
async function removeQuarantinedLine(rowId){
 const line=cartQuarantine.find(x=>x.id===rowId);if(!line||!session?.user)return;
 const {error}=await supabase.from('cart_items').delete().eq('id',rowId);
 if(error){notify('Could not remove that item. Please try again.');return;}
 cartQuarantine=cartQuarantine.filter(x=>x.id!==rowId);renderCart();renderGrid();
}
async function changeQty(variantId,delta){
 const v=currentVariant(variantId);if(!v)return;
 if(delta>0&&!v.in_stock){notify('This size is currently out of stock.');return;}
 const quarantined=cartQuarantine.some(x=>x.variant_id===variantId);
 if(quarantined&&delta<=0)return; // a quarantined line is resolved only by an explicit new quantity or removal
 const qty=(cart[variantId]?.qty||0)+delta;
 if(delta>0&&qty>MAX_LINE_QTY){notify(`You can add up to ${MAX_LINE_QTY} of one size. For bulk quantities, send a bargain request.`);return;}
 if(qty<=0)delete cart[variantId];else cart[variantId]={variant:v,qty};
 renderGrid();renderCartCount();renderCart();saveGuestCart();
 try{await persistCartVariant(variantId);if(quarantined){cartQuarantine=cartQuarantine.filter(x=>x.variant_id!==variantId);renderCart();}}catch(e){console.error(e);notify('Could not sync your basket. Please check your connection and try again.');}
}
function renderCartCount(){$('cartCount').textContent=cartCount();}
function quarantineHtml(){
 if(!cartQuarantine.length)return '';
 return `<div class="cart-quarantine msg err" role="alert"><b>Needs your attention</b><p>${cartQuarantine.length===1?'This item has':'These items have'} a saved quantity that is not valid, so ${cartQuarantine.length===1?'it is':'they are'} not in your basket and will not be ordered.</p>${cartQuarantine.map(q=>`<div class="sum-row"><span>${esc(q.label)} · saved quantity ${esc(Number(q.quantity).toLocaleString('en-IN'))}</span><span><button class="small-btn" type="button" data-row="${esc(q.id)}" onclick="removeQuarantinedLine('${esc(q.id)}')">Remove</button>${q.reason==='invalid_quantity'?` <button class="small-btn" type="button" onclick="changeQty('${esc(q.variant_id)}',1)">Keep 1</button>`:''}</span></div>`).join('')}</div>`;
}
// Phase 1D: sizes the store marked unavailable stay in the basket, flagged, and block checkout until removed.
function unavailableCartLines(){return cartEntries().filter(([,c])=>!c.variant?.in_stock);}
function renderCart(){
 const items=$('cartItems'),entries=cartEntries();
 if(!entries.length){items.innerHTML=quarantineHtml()+assignedGiftsHtml('basket')+'<div class="empty">Your basket is empty.<br>Add something fresh from the mandi.</div>';$('cartFoot').innerHTML='';return;}
 items.innerHTML=quarantineHtml()+assignedGiftsHtml('basket')+entries.map(([id,c])=>{const p=c.variant.product;const image=p.imageUrl?`<img src="${esc(p.imageUrl)}" alt="" style="width:38px;height:38px;object-fit:cover;border-radius:50%">`:`<div class="icon">${p.icon}</div>`;return `<div class="cart-line">${image}<div class="info"><div class="n">${esc(p.name)}</div><div class="p">${esc(c.variant.name)} · ${c.qty} × ${fmt(rupees(c.variant.price_paise))}</div>${cartLineNote(id)}${c.variant.in_stock?'':'<div class="msg err" role="status">Unavailable today. Remove it to continue.</div>'}</div><div class="stepper" style="width:84px"><button onclick="changeQty('${id}',-1)">−</button><span>${c.qty}</span><button onclick="changeQty('${id}',1)">+</button></div></div>`;}).join('');
 const pr=cartPricing(null),sub=rupees(pr.payable);$('cartFoot').innerHTML=`${cartSummaryRows(pr)}<div class="sum-row"><span>Subtotal</span><span>${fmt(sub)}</span></div><div class="sum-row"><span>Delivery</span><span>Calculated for your area</span></div><div class="inline-note">Delivery fee and minimum order are confirmed using your selected delivery zone.</div><div class="sum-row total"><span>Subtotal</span><span>${fmt(sub)}</span></div>${unavailableCartLines().length?'<div class="msg err" role="alert">Some sizes in your basket are unavailable today. Remove them to continue.</div>':''}<button class="primary-btn" onclick="openCheckout()" ${unavailableCartLines().length||cartQuarantine.length?'disabled':''}>Proceed to checkout</button>`;
}
function openCart(){$('cartOverlay').classList.add('open');renderCart();}
function closeCart(){$('cartOverlay').classList.remove('open');}
function openWeightPopup(pid){const p=currentProduct(pid);if(!p||!p.variants.length)return;weightPopupState={pid,variantId:p.variants.find(v=>v.is_default)?.id||p.variants[0].id};renderWeightPopup();$('weightOverlay').classList.add('open');}
function renderWeightPopup(){const p=currentProduct(weightPopupState.pid);if(!p)return;const selected=p.variants.find(v=>v.id===weightPopupState.variantId);$('weightBody').innerHTML=`<div class="modal-head"><div class="icon">${p.icon}</div><div class="ttl"><div class="n">${esc(p.name)}</div><div class="u">Choose size / weight</div></div><button class="icon-btn" onclick="closeWeightPopup()">✕</button></div><div class="weight-list">${p.variants.map(v=>`<div class="weight-opt ${v.id===weightPopupState.variantId?'sel':''}" ${v.in_stock?`onclick="selectVariant('${v.id}')"`:'style="opacity:.45;cursor:not-allowed"'}><span class="w">${esc(v.name)} ${v.in_stock?'':'· Out of stock'}</span><span class="pr">${fmt(rupees(v.price_paise))}</span></div>`).join('')}</div><button class="primary-btn" onclick="confirmWeightAdd()" ${selected?.in_stock?'':'disabled'}>Add to basket · ${fmt(rupees(selected?.price_paise||0))}</button>`;}
function selectVariant(id){if(!currentVariant(id)?.in_stock){notify('This size is out of stock.');return;}weightPopupState.variantId=id;renderWeightPopup();}
async function confirmWeightAdd(){if(!currentVariant(weightPopupState.variantId)?.in_stock)return;await changeQty(weightPopupState.variantId,1);closeWeightPopup();}
function closeWeightPopup(){$('weightOverlay').classList.remove('open');}

let detailState={pid:null,variantId:null,packs:1};
function openProductDetails(pid){const p=currentProduct(pid);if(!p)return;detailState={pid,variantId:defaultVariant(p.variants)?.id||null,packs:1};renderProductDetails();$('productDetailOverlay').classList.add('open');}
function renderProductDetails(){
 const p=currentProduct(detailState.pid);if(!p)return;
 const list=sortVariantsForDisplay(p.variants),sel=list.find(v=>v.id===detailState.variantId)||null,packs=detailState.packs,kg=sel?variantKg(sel):null,rate=sel?perKgPaise(sel):null;
 const photo=p.imageUrl?`<img class="product-detail-photo" src="${esc(p.imageUrl)}" alt="${esc(p.name)}">`:`<div class="icon" style="font-size:3rem;text-align:center;padding:1.5rem">${p.icon}</div>`;
 const options=list.map(v=>{const on=v.id===detailState.variantId;return `<button type="button" class="weight-opt ${on?'sel':''}" role="radio" aria-checked="${on}" data-variant-id="${esc(v.id)}" ${v.in_stock?`onclick="selectDetailVariant('${v.id}')"`:'disabled'}><span class="w">${esc(v.name)}${v.in_stock?'':' · Out of stock'}</span><span class="pr">${fmt(rupees(v.price_paise))}${v.compare_at_price_paise>v.price_paise?` <s class="mrp">${fmt(rupees(v.compare_at_price_paise))}</s>`:''}</span></button>`;}).join('');
 const inBasket=sel?cart[sel.id]?.qty||0:0;
 const buy=sel&&sel.in_stock?`<div class="qty-row"><span>Quantity</span><div class="stepper" style="width:124px"><button type="button" aria-label="Decrease quantity" onclick="changeDetailPacks(-1)" ${packs<=1?'disabled':''}>−</button><span id="detailPacks" aria-live="polite">${packs}</span><button type="button" aria-label="Increase quantity" onclick="changeDetailPacks(1)" ${packs>=MAX_PACKS?'disabled':''}>+</button></div></div><div class="sum-row total"><span>${packs} × ${esc(sel.name)}${kg&&packs>1?` = ${formatKg(kg*packs)}`:''}</span><b id="detailTotal">${fmt(rupees(sel.price_paise*packs))}</b></div>${inBasket?`<div class="muted">${inBasket} × ${esc(sel.name)} already in your basket</div>`:''}<button class="primary-btn" id="detailAddBtn" onclick="addDetailToBasket()">Add to basket · ${fmt(rupees(sel.price_paise*packs))}</button>`:'<div class="muted">This size is currently unavailable. Please check again later.</div>';
 const bargain=bargainRateVariant(p)?`<div class="detail-panel"><b>Buying ${BARGAIN_MIN_KG} kg or more?</b><p class="muted" style="margin:.3rem 0 0">Send us a bulk price offer on WhatsApp.</p><button class="bargain-btn" id="openBargainBtn" onclick="openBargain('${p.id}')">Bargain for a better price</button></div>`:'';
 $('productDetailBody').innerHTML=`<div class="modal-head"><div class="ttl"><div class="n">${esc(p.name)}</div><div class="u">${esc(p.telugu_name||p.catName||'Fresh produce')}</div></div><button class="icon-btn" aria-label="Close" onclick="closeProductDetails()">✕</button></div>${photo}<div class="detail-price" id="detailPrice">${sel?`${fmt(rupees(sel.price_paise))} <span class="muted" style="font-weight:600">· ${esc(sel.name)}${rate&&kg!==1?` · ${fmt(rupees(rate))}/kg`:''}</span>`:'Price on request'}</div><p class="muted">${esc(p.description||'Fresh quality selected for your home.')}</p><div class="detail-panel"><b>Choose size</b><div class="weight-list" role="radiogroup" aria-label="Size" style="margin:.65rem 0">${options||'<div class="muted">No sizes are configured for this product.</div>'}</div>${buy}</div>${bargain}`;
}
function selectDetailVariant(id){const v=currentVariant(id);if(!v||v.product.id!==detailState.pid)return;if(!v.in_stock){notify('This size is out of stock.');return;}detailState.variantId=id;detailState.packs=1;renderProductDetails();}
function changeDetailPacks(delta){detailState.packs=Math.min(MAX_PACKS,Math.max(1,detailState.packs+delta));renderProductDetails();}
async function addDetailToBasket(){const v=currentVariant(detailState.variantId);if(!v?.in_stock||v.product.id!==detailState.pid)return;await changeQty(v.id,detailState.packs);closeProductDetails();}
function closeProductDetails(){$('productDetailOverlay').classList.remove('open');}

let bargainState={pid:null,kg:BARGAIN_MIN_KG,whatsapp:'',status:'idle',sent:null};
async function loadWhatsAppNumber(){const {data,error}=await supabase.from('store_settings').select('key,value').in('key',['whatsapp_number','support_phone']);if(error)return {number:'',error};const get=k=>(data||[]).find(r=>r.key===k)?.value?.value||'';return {number:normalizeWhatsAppNumber(get('whatsapp_number'))||normalizeWhatsAppNumber(get('support_phone')),error:null};}
async function openBargain(pid){const p=currentProduct(pid);if(!p||!bargainRateVariant(p))return;bargainState={pid,kg:BARGAIN_MIN_KG,whatsapp:'',status:session?.user?'ready':'signin',sent:null};renderBargain();$('bargainOverlay').classList.add('open');$('bargainOverlay').setAttribute('aria-hidden','false');const r=await loadWhatsAppNumber();if(bargainState.pid!==pid)return;bargainState.whatsapp=r.number;renderBargainStatus();}
function closeBargain(){$('bargainOverlay').classList.remove('open');$('bargainOverlay').setAttribute('aria-hidden','true');}
function renderBargain(){
 const p=currentProduct(bargainState.pid),rv=bargainRateVariant(p);if(!p||!rv)return;const rate=perKgPaise(rv),kg=bargainState.kg;
 $('bargainBody').innerHTML=`<div class="sheet-grip" aria-hidden="true"></div><div class="modal-head"><div class="ttl"><div class="n">Bargain · ${esc(p.name)}</div><div class="u">Bulk price request · ${BARGAIN_MIN_KG}–${BARGAIN_MAX_KG} kg</div></div><button class="icon-btn" aria-label="Close bargain panel" onclick="closeBargain()">✕</button></div><div class="form-field"><label for="bargainKg">How much do you need?</label><div class="bargain-kg" id="bargainKgLabel">${formatKg(kg)}</div><input id="bargainKg" class="range-input" type="range" min="${BARGAIN_MIN_KG}" max="${BARGAIN_MAX_KG}" step="${BARGAIN_STEP_KG}" value="${kg}" aria-valuetext="${kg} kg" oninput="onBargainKg(this.value)"><div class="range-ends"><span>${BARGAIN_MIN_KG} kg</span><span>${BARGAIN_MAX_KG} kg</span></div></div><div class="sum-row"><span>Regular rate</span><span>${fmt(rupees(rate))}/kg <span class="muted">(${esc(rv.name)} price)</span></span></div><div class="sum-row total"><span>Regular estimated price</span><b id="bargainEstimate">${fmt(rupees(bargainEstimatePaise(rate,kg)))}</b></div><div class="form-field" style="margin-top:.8rem"><label for="bargainOffer">Your total offer (₹)</label><input id="bargainOffer" type="number" inputmode="decimal" min="1" step="0.01" placeholder="Enter your total price" oninput="updateBargainSummary()"></div><div class="sum-row total"><span>Your total offer</span><b id="bargainOfferTotal">—</b></div><div class="inline-note" id="bargainOfferNote"></div><div class="form-field"><label for="bargainNote">Note for the store (optional)</label><input id="bargainNote" maxlength="500" placeholder="e.g. weekly order for my hotel"></div><div id="bargainMsg"></div><button class="primary-btn" id="bargainSendBtn" onclick="sendBargainRequest()">Send offer to TaajaMandi</button><div id="bargainWhatsApp"></div><p class="inline-note"><b>Disclaimer:</b> A price request is only an enquiry, not an order. It does not reserve stock or change prices. If TaajaMandi accepts, you still confirm your basket and complete checkout separately. No order is placed automatically.</p>`;
 renderBargainStatus();updateBargainSummary();
}
function renderBargainStatus(){const msg=$('bargainMsg'),btn=$('bargainSendBtn');if(!msg||!btn)return;const s=bargainState.status;btn.disabled=s==='sending'||s==='sent';btn.textContent=s==='signin'?'Sign in to send your offer':s==='sending'?'Sending…':s==='sent'?'Offer sent':'Send offer to TaajaMandi';msg.innerHTML=s==='sent'?'<div class="msg ok">Offer sent. We will reply in <b>My bargains</b> (account menu). You must accept any counter-offer yourself.</div><button class="ghost-btn" onclick="closeBargain();closeProductDetails();openMyBargains()">View my bargains</button>':'';const wa=$('bargainWhatsApp');if(wa)wa.innerHTML=bargainState.whatsapp&&s==='sent'?`<a class="ghost-btn" style="display:block;text-align:center" target="_blank" rel="noopener" href="https://wa.me/${esc(bargainState.whatsapp)}">Also chat with us on WhatsApp</a>`:'';}
function onBargainKg(value){const kg=Number(value);if(!Number.isFinite(kg))return;bargainState.kg=kg;const p=currentProduct(bargainState.pid),rv=bargainRateVariant(p);if(!rv)return;$('bargainKgLabel').textContent=formatKg(kg);$('bargainKg').setAttribute('aria-valuetext',kg+' kg');$('bargainEstimate').textContent=fmt(rupees(bargainEstimatePaise(perKgPaise(rv),kg)));updateBargainSummary();}
function updateBargainSummary(){const p=currentProduct(bargainState.pid),rv=bargainRateVariant(p);if(!rv||!$('bargainOffer'))return;const raw=$('bargainOffer').value,kg=bargainState.kg,est=bargainEstimatePaise(perKgPaise(rv),kg);const valid=!bargainError(kg,raw);$('bargainOfferTotal').textContent=valid?`${fmt(Number(raw))} · ${fmt(Number(raw)/kg)}/kg`:'—';const offerPaise=rupeesToPaise(raw);$('bargainOfferNote').textContent=!valid||!offerPaise?'':offerPaise>=est?'Your offer is at or above the regular price — you can simply add this to your basket.':`${Math.round((est-offerPaise)/est*100)}% below the regular estimated price.`;}
async function sendBargainRequest(){const p=currentProduct(bargainState.pid),rv=bargainRateVariant(p);if(!p||!rv)return;if(!session?.user){closeBargain();openAuth();showMsg('authMsg','Sign in to send a bargain offer.');return;}const kg=bargainState.kg,raw=$('bargainOffer')?.value||'';const err=bargainError(kg,raw);if(err){showMsg('bargainMsg',err);return;}const offer=rupeesToPaise(raw);bargainState.status='sending';renderBargainStatus();const {data,error}=await supabase.rpc('submit_bargain_request',{p_variant_id:rv.id,p_quantity_kg:kg,p_offer_total_paise:offer,p_note:$('bargainNote')?.value.trim()||null});if(error){bargainState.status='ready';renderBargainStatus();showMsg('bargainMsg',error.message||'Could not send your offer. Please try again.');return;}bargainState.status='sent';bargainState.sent=data;renderBargainStatus();}

async function openMyBargains(){if(!session?.user){openAuth();return;}$('bargainsBody').innerHTML='<div class="empty">Loading your bargains…</div>';$('bargainsOverlay').classList.add('open');const [{data:reqs,error},{data:hist}]=await Promise.all([supabase.from('bargain_requests').select('*').order('created_at',{ascending:false}).limit(50),supabase.from('bargain_offer_history').select('bargain_request_id,actor_role,action,amount_paise,note,created_at').order('created_at')]);if(error){$('bargainsBody').innerHTML=`<div class="msg err">${esc(error.message)}</div>`;return;}if(!reqs?.length){$('bargainsBody').innerHTML='<div class="empty">No bargain requests yet. Open a product sold by weight and tap “Bargain for a better price”.</div>';return;}$('bargainsBody').innerHTML=reqs.map(r=>{const counterOpen=r.status==='countered'&&bargainIsOpen(r);const h=(hist||[]).filter(x=>x.bargain_request_id===r.id);return `<div class="admin-card" data-bargain-id="${esc(r.id)}"><div class="section-head"><b>${esc(r.product_name)} · ${esc(formatKg(Number(r.quantity_kg)))}</b><span class="badge-status">${esc(r.status==='countered'&&!counterOpen?BARGAIN_STATUS.expired:BARGAIN_STATUS[r.status]||r.status)}</span></div><div class="sum-row"><span>Regular estimate</span><span>${fmt(rupees(r.regular_estimate_paise))}</span></div><div class="sum-row"><span>Your offer</span><span>${fmt(rupees(r.offer_total_paise))}</span></div>${r.counter_total_paise?`<div class="sum-row total"><span>Counter-offer</span><b>${fmt(rupees(r.counter_total_paise))}</b></div>`:''}${r.agreed_total_paise?`<div class="msg ok">Agreed total: ${fmt(rupees(r.agreed_total_paise))}. Contact the store to place this bulk order — it is not placed automatically.</div>`:''}${r.admin_reason?`<div class="inline-note">Store note: ${esc(r.admin_reason)}</div>`:''}${r.expires_at&&r.status==='countered'?`<div class="inline-note">Counter-offer valid until ${esc(new Date(r.expires_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}))}</div>`:''}<div class="admin-actions">${counterOpen?`<button class="small-btn" onclick="respondBargain('${r.id}','accept')">Accept counter-offer</button><button class="small-btn danger" onclick="respondBargain('${r.id}','decline')">Decline</button>`:''}${bargainIsOpen(r)?`<button class="small-btn danger" onclick="respondBargain('${r.id}','cancel')">Cancel request</button>`:''}</div><details><summary class="inline-note">History</summary>${h.map(x=>`<div class="inline-note">${esc(new Date(x.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}))} · ${esc(x.actor_role)} ${esc(x.action)}${x.amount_paise?' · '+fmt(rupees(x.amount_paise)):''}${x.note?' · '+esc(x.note):''}</div>`).join('')}</details></div>`;}).join('');}
function closeMyBargains(){$('bargainsOverlay').classList.remove('open');}
async function respondBargain(id,action){if(action==='accept'&&!confirm('Accept this counter-offer? This does not place an order; you will still confirm the purchase with the store.'))return;if(action!=='accept'&&!confirm(action==='cancel'?'Cancel this bargain request?':'Decline this counter-offer?'))return;const {error}=await supabase.rpc('respond_bargain_request',{p_request_id:id,p_action:action,p_note:null});if(error){notify(error.message);return;}await openMyBargains();}

// Header: signed in = profile icon (no name or email shown) + membership icon beside it; signed out = Sign in.
function renderAcctBtn(){const b=$('acctBtn'),m=$('memberBtn');if(session){b.textContent='👤';b.classList.add('icon-mode');b.setAttribute('aria-label','My account');b.title='My account';}else{b.textContent='Sign in';b.classList.remove('icon-mode');b.removeAttribute('aria-label');b.removeAttribute('title');}if(m){m.hidden=!session;m.onclick=()=>openMembership();m.classList.toggle('is-member',!!session&&typeof membership!=='undefined'&&membership.status==='active');}$('adminBtn').style.display=roles.some(r=>['admin','manager'].includes(r))?'inline-flex':'none';$('deliveryBtn').style.display=roles.includes('delivery_staff')?'inline-flex':'none';$('acctBtn').onclick=session?openAccountPanel:openAuth;}
async function loadIdentity(){
 if(!session?.user){profile=null;roles=[];renderAcctBtn();return;}
 const {data,error}=await supabase.functions.invoke('get-my-role');
 if(error){console.error('Role lookup failed',error);roles=[];profile=null;}else{roles=data.roles||[];profile=data.profile||null;}
 renderAcctBtn();
}
function openAuth(){authMode='signin';authMethod='email';otpPendingPhone='';renderAuth();$('authOverlay').classList.add('open');}
function closeAuth(){$('authOverlay').classList.remove('open');}
function renderAuth(){
 const isSignup=authMode==='signup';
 const isForgot=authMode==='forgot';
 $('authBody').innerHTML=`<div class="modal-head"><div class="ttl"><div class="n">${isForgot?'Reset password':isSignup?'Create your account':'Welcome to TaajaMandi'}</div><div class="u">${isForgot?'We will email you a password reset link':isSignup?'Create an account with either method':'Sign in to order fresh produce'}</div></div><button class="icon-btn" onclick="closeAuth()">✕</button></div>${!isForgot?`<div class="auth-tabs"><button class="${authMethod==='email'?'active':''}" onclick="setAuthMethod('email')">Email & password</button><button class="${authMethod==='phone'?'active':''}" onclick="setAuthMethod('phone')">Mobile OTP</button></div>`:''}${isForgot||authMethod==='email'?`<div class="form-field"><label>Email address</label><input id="authEmail" type="email" autocomplete="email" placeholder="you@example.com"></div>`:`<div class="form-field"><label>Mobile number</label><input id="authPhone" type="tel" autocomplete="tel" inputmode="tel" placeholder="10-digit mobile number" maxlength="16" value="${esc(otpPendingPhone.replace(/^\+91/,''))}"></div>`}${isSignup?`<div class="form-field"><label>Full name</label><input id="authName" autocomplete="name" placeholder="Your name"></div>`:''}${authMethod==='email'&&!isForgot?`<div class="form-field"><label>Password</label><input id="authPassword" type="password" autocomplete="${isSignup?'new-password':'current-password'}" placeholder="${isSignup?'At least 8 characters':'Your password'}"></div>`:''}${authMethod==='phone'&&!isForgot&&otpPendingPhone?`<div class="form-field"><label>6-digit OTP</label><input id="authOtp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Enter OTP"></div>`:''}<div id="authMsg"></div><button class="primary-btn" onclick="submitAuth()">${isForgot?'Send reset link':authMethod==='phone'?(otpPendingPhone?'Verify OTP':'Send OTP'):isSignup?'Create account':'Sign in'}</button><div class="admin-actions">${authMode!=='signin'?'<button class="small-btn" onclick="setAuthMode(\'signin\')">Back to sign in</button>':''}${authMode==='signin'&&authMethod==='email'?'<button class="small-btn" onclick="setAuthMode(\'signup\')">Create account</button><button class="small-btn" onclick="setAuthMode(\'forgot\')">Forgot password?</button>':''}${authMethod==='phone'&&otpPendingPhone?'<button class="small-btn" onclick="resendPhoneOtp()">Resend OTP</button>':''}</div><p class="inline-note">Mobile OTP requires phone authentication and an SMS provider to be enabled in the existing Supabase project.</p>`;
}
function setAuthMethod(method){authMethod=method;otpPendingPhone='';renderAuth();}
function setAuthMode(mode){authMode=mode;otpPendingPhone='';renderAuth();}
function clearAuthUrl(){if(/access_token|type=|error/.test(location.hash))history.replaceState(null,'',location.pathname+location.search);}
function openPasswordRecovery(){authMode='recover';$('authBody').innerHTML=`<div class="modal-head"><div class="ttl"><div class="n">Set a new password</div><div class="u">Choose a new password for your account</div></div><button class="icon-btn" onclick="closeAuth()">✕</button></div><div class="form-field"><label>New password</label><input id="newPassword" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div><div class="form-field"><label>Confirm new password</label><input id="newPassword2" type="password" autocomplete="new-password" placeholder="Repeat the new password"></div><div id="authMsg"></div><button class="primary-btn" id="newPasswordBtn" onclick="submitNewPassword()">Save new password</button>`;$('authOverlay').classList.add('open');}
async function submitNewPassword(){const p=$('newPassword')?.value||'',p2=$('newPassword2')?.value||'';if(p.length<8){showMsg('authMsg','Use at least 8 characters.');return;}if(p!==p2){showMsg('authMsg','The two passwords do not match.');return;}const btn=$('newPasswordBtn');if(btn)btn.disabled=true;try{const {error}=await supabase.auth.updateUser({password:p});if(error)throw error;passwordRecoveryPending=false;clearAuthUrl();closeAuth();notify('Your password has been updated.');}catch(e){showMsg('authMsg',e.message||'Your password could not be updated. Request a new reset link.');}finally{if(btn)btn.disabled=false;}}
function normalizeIndianPhone(value){let digits=String(value||'').replace(/\D/g,'');if(digits.startsWith('91')&&digits.length===12)return '+'+digits;if(digits.length===10)return '+91'+digits;return '';}
async function resendPhoneOtp(){const phone=otpPendingPhone;if(!phone)return;const {error}=await supabase.auth.signInWithOtp({phone});if(error){showMsg('authMsg',error.message);return;}showMsg('authMsg','A new OTP was requested. Check your SMS messages.',true);}
async function submitAuth(){
 const email=$('authEmail')?.value.trim().toLowerCase()||'',password=$('authPassword')?.value||'';
 try{
  if(authMode==='forgot'){if(!email){showMsg('authMsg','Enter your email address.');return;}const {error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:location.origin});if(error)throw error;showMsg('authMsg','Password reset email sent. Check your inbox.',true);return;}
  if(authMethod==='phone'){
   if(!otpPendingPhone){const phone=normalizeIndianPhone($('authPhone')?.value);if(!phone){showMsg('authMsg','Enter a valid 10-digit Indian mobile number.');return;}const otpOptions=authMode==='signup'?{data:{full_name:$('authName')?.value.trim()||''},shouldCreateUser:true}:{};const {error}=await supabase.auth.signInWithOtp({phone,options:otpOptions});if(error)throw error;otpPendingPhone=phone;renderAuth();showMsg('authMsg','OTP sent. Enter the 6-digit code from your SMS.',true);return;}
   const token=$('authOtp')?.value.trim()||'';if(!/^\d{6}$/.test(token)){showMsg('authMsg','Enter the 6-digit OTP.');return;}const {error}=await supabase.auth.verifyOtp({phone:otpPendingPhone,token,type:'sms'});if(error)throw error;otpPendingPhone='';closeAuth();return;
  }
  if(!email){showMsg('authMsg','Enter your email address.');return;}
  if(authMode==='signup'){const name=$('authName').value.trim();if(!name||password.length<8){showMsg('authMsg','Enter your name and a password with at least 8 characters.');return;}const {data,error}=await supabase.auth.signUp({email,password,options:{data:{full_name:name}}});if(error)throw error;if(data.session){closeAuth();notify('Your account has been created.');}else{showMsg('authMsg','Account created. Please confirm your email using the link we sent, then sign in.',true);return;}}
  else{const {error}=await supabase.auth.signInWithPassword({email,password});if(error)throw error;closeAuth();}
 }catch(e){showMsg('authMsg',e.message||'Authentication failed.');}
}
// Account panel: shows only fields that exist (name, email, phone, saved address, membership) and the existing actions.
async function accountAddressText(){if(!session?.user)return '';try{const {data}=await supabase.from('addresses').select('label,address_line1,area,city').eq('user_id',session.user.id).order('is_default',{ascending:false}).order('created_at',{ascending:false}).limit(1);const a=data?.[0];return a?[a.label,[a.address_line1,a.area,a.city].filter(Boolean).join(', ')].filter(Boolean).join(': '):'';}catch(e){return '';}}
function accountMembershipText(){const m=typeof membership==='undefined'?null:membership;if(!m)return '';if(m.status==='active')return `${m.plan_name||'Membership'} · ${Number(m.remaining)} of ${Number(m.free_deliveries)} free deliveries left`;if(m.status==='pending')return 'Waiting for payment confirmation';return 'Not a member';}
function renderAccountPanel(addr){const name=profile?.full_name||'Customer',email=profile?.email||session?.user?.email||'',phone=profile?.phone||session?.user?.phone||'';const row=(k,v)=>v?`<div class="sum-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`:'';$('authBody').innerHTML=`<div class="modal-head"><div class="icon">${esc(name.charAt(0).toUpperCase())}</div><div class="ttl"><div class="n">${esc(name)}</div><div class="u">My account</div></div><button class="icon-btn" onclick="closeAuth()" aria-label="Close">✕</button></div><div class="acct-panel-rows" id="acctPanelRows">${row('Email',email)}${row('Phone',phone)}${row('Saved address',addr)}${row('Membership',accountMembershipText())}</div><button class="primary-btn" onclick="closeAuth();openOrders()">My orders</button><button class="ghost-btn" onclick="closeAuth();openMembership()">Membership</button><button class="ghost-btn" onclick="closeAuth();openMyBargains()">My bargains</button><button class="ghost-btn" onclick="updateMyProfile()">Update profile name</button><button class="ghost-btn" onclick="signOut()">Sign out</button>`;}
async function openAccountPanel(){renderAccountPanel('');$('authOverlay').classList.add('open');const addr=await accountAddressText();if(addr&&$('authOverlay').classList.contains('open')&&$('acctPanelRows'))renderAccountPanel(addr);}
async function updateMyProfile(){const name=prompt('Enter your full name',profile?.full_name||'');if(!name)return;const {error}=await supabase.from('profiles').update({full_name:name.trim(),updated_at:new Date().toISOString()}).eq('id',session.user.id);if(error){notify(error.message);return;}await loadIdentity();openAccountPanel();}
async function signOut(){await supabase.auth.signOut();closeAuth();cart={};renderCart();renderCartCount();}

async function loadZones(){const [z,s]=await Promise.all([supabase.from('delivery_zones').select('id,name,pincode,areas,delivery_fee_paise,free_delivery_min_paise,minimum_order_paise,estimated_minutes').eq('is_active',true).order('name'),supabase.from('delivery_slots').select('id,zone_id,label,starts_at,ends_at').eq('is_active',true).order('starts_at')]);zones=z.data||[];slots=s.data||[];$('zoneList').innerHTML=zones.map(x=>`<span class="zone on">${esc(x.name)}</span>`).join('')||'<span class="muted">Delivery zones are being configured.</span>';}
// Delivery boundary and booking rules live in js/rules.js (TAAJA_RULES) (same 7.4 km circle as create-order; the previous 120-point polygon approximated it).



let checkoutState={zoneOk:false,gpsOk:false,placing:false};
function selectedDeliveryType(){return document.querySelector('input[name="deliveryType"]:checked')?.value||'';}
function onDeliveryTypeChange(){const today=taajaTodayIndia(),rules=taajaBookingRules(today),type=selectedDeliveryType()||rules.defaultType,date=$('ckDeliveryDate');if(!date)return;if(rules.fixedDate){date.value=rules.fixedDate;date.min=rules.fixedDate;date.max=rules.fixedDate;date.disabled=true;}else if(type==='same_day'){date.value=today;date.min=today;date.max=today;date.disabled=true;}else{date.disabled=false;date.min=rules.minAdvance;date.removeAttribute('max');if(!date.value||date.value<rules.minAdvance)date.value=rules.minAdvance;}onDeliveryDateChange();}
function onDeliveryDateChange(){const type=selectedDeliveryType(),date=$('ckDeliveryDate')?.value||'',err=taajaBookingError(taajaTodayIndia(),type,date),out=$('ckDeliveryDateText');if(out)out.innerHTML=err?`<span class="msg err">${esc(err)}</span>`:`Requested delivery date<br><b>${esc(taajaFormatDate(date))}</b> · ${taajaDeliveryTypeLabel(type)}`;updatePlaceOrderState();}
function updatePlaceOrderState(){const btn=$('placeOrderBtn');if(!btn||checkoutState.placing)return;const blockers=[];if(!checkoutState.gpsOk)blockers.push('share a GPS location inside our delivery area');if(!checkoutState.zoneOk)blockers.push('choose your delivery area');if(taajaBookingError(taajaTodayIndia(),selectedDeliveryType(),$('ckDeliveryDate')?.value||''))blockers.push('choose a valid delivery date');btn.disabled=blockers.length>0;const b=$('ckBlockers');if(b)b.textContent=blockers.length?'To place your order: '+blockers.join(', ')+'.':'';}
let lastGps=null;
function requestGps(){return new Promise(resolve=>{if(!navigator.geolocation){resolve({status:'unsupported'});return;}navigator.geolocation.getCurrentPosition(pos=>{const r={status:'ok',lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:pos.coords.accuracy,inside:taajaInsideBoundary(pos.coords.latitude,pos.coords.longitude),at:Date.now()};lastGps=r;resolve(r);},err=>resolve({status:err?.code===1?'denied':err?.code===3?'timeout':'unavailable'}),{enableHighAccuracy:true,timeout:12000,maximumAge:60000});});}
function gpsResultText(r){if(r.status==='ok')return r.inside?{state:'ok',title:'✓ Serviceable',msg:'Your location is inside the TaajaMandi delivery area. You can order for delivery here.'}:{state:'outside',title:'Coming soon',msg:"Your location is outside our delivery area, so we can't take orders here yet. We're expanding — please check again soon."};if(r.status==='denied')return {state:'denied',title:'Location access blocked',msg:'Ordering needs your GPS location. Please allow location access for this site in your browser settings, then check again.'};if(r.status==='unsupported')return {state:'error',title:'GPS not available',msg:"This browser can't share your GPS location, which ordering requires. Please try another browser or phone."};return {state:'error',title:"Couldn't get your location",msg:'Turn on location / GPS on your device and try again.'};}
function validateTaajaGps(){const lat=Number($('ckLatitude')?.value),lng=Number($('ckLongitude')?.value);return Number.isFinite(lat)&&Number.isFinite(lng)&&taajaInsideBoundary(lat,lng);}

async function openCheckout(){
 closeCart();if(!session?.user){openAuth();showMsg('authMsg','Sign in to complete your order.');return;}
 if(!cartEntries().length){notify('Your basket is empty.');return;}
 if(cartQuarantine.length){notify('An item in your basket needs your attention before you can check out. Open your basket to remove it or choose a quantity.');openCart();return;}
 if(unavailableCartLines().length){notify('Some sizes in your basket are unavailable today. Remove them to continue.');openCart();return;}
 await loadZones();const onlineOk=await onlinePaymentsEnabled();couponState={code:null,discount:0};
 const today=taajaTodayIndia(),rules=taajaBookingRules(today);checkoutState={zoneOk:false,gpsOk:false,placing:false};
 const slotOpts=slots.map(s=>`<option value="${s.id}" data-zone="${s.zone_id||''}">${esc(s.label)}</option>`).join('');
 const zoneOpts=zones.map(z=>`<option value="${z.id}">${esc(z.name)}</option>`).join('');
 const typeOpt=(value,label,offLabel)=>{const off=!rules.types.includes(value);return `<div class="pay-option"><input type="radio" id="dt_${value}" name="deliveryType" value="${value}" ${value===rules.defaultType?'checked':''} ${off?'disabled':''} onchange="onDeliveryTypeChange()"><label for="dt_${value}">${label}${off&&offLabel?` <span class="muted">— ${offLabel}</span>`:''}</label></div>`;};
 $('checkoutBody').innerHTML=`<div class="form-field"><label>Recipient name</label><input id="ckName" value="${esc(profile?.full_name||'')}" placeholder="Full name"></div><div class="form-field"><label>Mobile number</label><input id="ckPhone" value="${esc(profile?.phone||'')}" placeholder="10-digit mobile" maxlength="10" inputmode="numeric"></div><div class="form-field"><label>Delivery location (required)</label><div class="gps-row"><button type="button" id="ckGpsBtn" onclick="captureCheckoutLocation()">◎ Use my current location</button><span class="gps-status" id="gpsStatus" aria-live="polite">Your GPS location is required to place an order. We deliver only inside our approved delivery area.</span></div></div><input type="hidden" id="ckLatitude"><input type="hidden" id="ckLongitude"><div class="form-field"><label>House / flat, street</label><input id="ckAddr" placeholder="House number, street"></div><div class="form-field"><label>Landmark (optional)</label><input id="ckLandmark" placeholder="Near…"></div><p class="inline-note">The written address helps our rider find your door. Serviceability is always checked using your GPS location.</p><div class="form-field"><label>Choose your delivery area</label><select id="ckZone" onchange="onZoneChange()"><option value="">Choose an active delivery area</option>${zoneOpts}</select></div><div id="zoneMsg"></div><div class="form-field"><label>Delivery type</label>${typeOpt('same_day','Same-day delivery (today, 2–3 hours)','starts 1 December')}${typeOpt('advance','Advance delivery (choose a date)','')}<label for="ckDeliveryDate" style="margin-top:.6rem">Requested delivery date</label><input id="ckDeliveryDate" type="date" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--surface-alt);color:var(--text)" oninput="onDeliveryDateChange()" onchange="onDeliveryDateChange()"><div class="delivery-date-display" id="ckDeliveryDateText" aria-live="polite"></div><small class="muted" id="deliveryRuleHint">${esc(rules.hint)} Dates use India time (Asia/Kolkata).</small></div><div class="form-field"><label>Delivery slot (optional)</label><select id="ckSlot"><option value="">Any available slot</option>${slotOpts}</select></div><div class="form-field"><label>Delivery instructions (optional)</label><textarea id="ckNote" maxlength="500" placeholder="Gate, floor, directions…"></textarea></div>${paymentOptionsHtml(onlineOk)}<div id="ckGifts"></div>${couponBoxHtml()}<div class="sum-row"><span>Items subtotal</span><b>${fmt(cartSubtotal())}</b></div><div class="inline-note" id="ckBlockers" aria-live="polite"></div><button class="primary-btn" id="placeOrderBtn" onclick="placeOrder()" disabled>Place COD order</button>`;
 renderCheckoutGifts();
 $('checkoutOverlay').classList.add('open');
 const dateEl=$('ckDeliveryDate');dateEl.value=rules.defaultDate;onDeliveryTypeChange();
 if(lastGps&&lastGps.status==='ok'&&Date.now()-lastGps.at<15*60*1000)applyCheckoutGps(lastGps,true);
 updatePlaceOrderState();
}
async function captureCheckoutLocation(){const status=$('gpsStatus'),btn=$('ckGpsBtn');if(!status)return;status.textContent='Requesting location permission…';status.style.color='';if(btn)btn.disabled=true;const r=await requestGps();if(btn)btn.disabled=false;applyCheckoutGps(r,false);}
function applyCheckoutGps(r,fromHome){const status=$('gpsStatus');if(!status)return;const ok=r.status==='ok';$('ckLatitude').value=ok?String(r.lat):'';$('ckLongitude').value=ok?String(r.lng):'';checkoutState.gpsOk=ok&&r.inside&&validateTaajaGps();const t=gpsResultText(r);status.textContent=(fromHome&&ok?'Using the location you checked earlier. ':'')+t.title+' — '+t.msg;status.style.color=t.state==='ok'?'var(--brand-dark)':'var(--tomato)';updatePlaceOrderState();}
function onZoneChange(){const id=$('ckZone').value,z=zones.find(x=>x.id===id);checkoutState.zoneOk=false;if(!z){$('zoneMsg').innerHTML='';}else{const sub=cartSubtotal()*100;if(sub<Number(z.minimum_order_paise||0)){$('zoneMsg').innerHTML=`<div class="msg err">Minimum order for this area is ${fmt(rupees(z.minimum_order_paise))}.</div>`;}else{const pr=cartPricing(z);$('zoneMsg').innerHTML=`<div class="msg ok">Delivery area ${esc(z.name)}. Delivery fee: ${fmt(rupees(pr.fee))}${pr.feeWaived?' · free with your membership':''}${z.free_delivery_min_paise&&!pr.feeWaived&&pr.fee===0?' · Free delivery':''}. Total to pay: <b>${fmt(rupees(couponTotal(pr.total)))}</b>${pr.discount?` (includes ${fmt(rupees(pr.discount))} offer savings)`:''}${couponState.code?` · coupon ${esc(couponState.code)} −${fmt(rupees(couponState.discount))}`:''}</div>${cartSummaryRows(pr)}`;checkoutState.zoneOk=true;}}const slot=$('ckSlot');if(slot){[...slot.options].forEach(o=>{if(o.value)o.hidden=!!(o.dataset.zone&&o.dataset.zone!==id);});}updatePlaceOrderState();}
function closeCheckout(){$('checkoutOverlay').classList.remove('open');}
// ---- Online payment (launch build 21 Nov 2026). The browser never marks an order paid: payment-ops verifies the
// Razorpay signature AND fetches the payment from Razorpay; the signed webhook records it independently.
let onlinePayCache=null;
async function onlinePaymentsEnabled(){if(!session?.user)return false;if(onlinePayCache!==null)return onlinePayCache;try{const {data}=await supabase.functions.invoke('payment-ops',{body:{action:'config'}});onlinePayCache=!!data?.online_enabled;}catch(e){onlinePayCache=false;}return onlinePayCache;}
function paymentOptionsHtml(onlineOk){return '<div class="pay-option"><input type="radio" id="pay_cod" name="pay" value="cod" checked onchange="onPayMethodChange()"><label for="pay_cod">Cash on delivery</label></div>'+(onlineOk?'<div class="pay-option"><input type="radio" id="pay_online" name="pay" value="online" onchange="onPayMethodChange()"><label for="pay_online">Pay online now · UPI, cards, net banking (Razorpay)</label></div><div class="inline-note">Online orders are prepared after Razorpay confirms the payment.</div>':'<div class="inline-note">Online payment is not available yet. Cash on delivery is available.</div>');}
function selectedPayMethod(){return document.querySelector('input[name="pay"]:checked')?.value==='online'?'online':'cod';}
function payButtonLabel(){return selectedPayMethod()==='online'?'Pay online & place order':'Place COD order';}
function onPayMethodChange(){const b=$('placeOrderBtn');if(b&&!checkoutState.placing)b.textContent=payButtonLabel();renderCheckoutGifts();}
function renderCheckoutGifts(){const el=$('ckGifts');if(!el)return;const online=!!document.getElementById('pay_online');el.innerHTML=assignedGiftsHtml(!online?'unavailable':selectedPayMethod()==='online'?'online':'cod');}
function payStatusLabel(st){return ({pending:'awaiting payment',failed:'payment not completed',authorized:'payment being confirmed',paid:'paid',partially_refunded:'partly refunded',refunded:'refunded'})[st]||st;}
async function payOnline(orderId,orderNumber){
 const setStatus=t=>{const el=$('confirmPayLabel');if(el)el.textContent=t;};
 const {data,error}=await supabase.functions.invoke('payment-ops',{body:{action:'start',order_id:orderId}});
 if(error||!data?.success){setStatus('Waiting for online payment');notify(data?.error||'Could not start the online payment. You can pay from My orders.');return;}
 if(data.already_paid){setStatus('Paid online');notify('This order is already paid. Thank you!');return;}
 let Rzp;try{Rzp=await loadRazorpayCheckout();}catch(e){setStatus('Waiting for online payment');notify(e.message+' You can pay from My orders.');return;}
 await new Promise(resolve=>{
  const rzp=new Rzp({key:data.key_id,order_id:data.razorpay_order_id,amount:data.amount,currency:data.currency||'INR',name:'TaajaMandi',description:'Order '+(data.order_number||orderNumber),
   prefill:{name:profile?.full_name||'',contact:profile?.phone||'',email:session?.user?.email||''},theme:{color:'#1B6B3C'},
   handler:async resp=>{setStatus('Confirming payment…');const {data:v,error:ve}=await supabase.functions.invoke('payment-ops',{body:{action:'verify',order_id:orderId,razorpay_order_id:resp.razorpay_order_id,razorpay_payment_id:resp.razorpay_payment_id,razorpay_signature:resp.razorpay_signature}});
    if(!ve&&v?.paid){setStatus('Paid online');notify('Payment received. Thank you!');}else{setStatus('Payment being confirmed');notify(v?.error||'We are confirming your payment with Razorpay. Your order will update automatically.');}resolve();},
   modal:{ondismiss:()=>{setStatus('Waiting for online payment');notify('Payment not completed. Your order is saved but will not be prepared until it is paid. You can pay from My orders.');resolve();}}});
  if(typeof rzp.on==='function')rzp.on('payment.failed',()=>setStatus('Payment failed. You can try again from My orders.'));
  rzp.open();
 });
}
// ---- Coupons (launch build 21 Nov 2026). The preview comes from the server (check_coupon); the order applies the
// coupon again on the server and refuses a total that differs from the one shown here.
let couponState={code:null,discount:0};
function couponTotal(total){return Math.max(0,Number(total||0)-(couponState.code?Number(couponState.discount||0):0));}
function couponBoxHtml(){return '<div class="form-field coupon-box"><label for="ckCoupon">Coupon (optional)</label><div class="coupon-row"><input id="ckCoupon" maxlength="30" autocomplete="off" autocapitalize="characters" placeholder="Enter coupon code"><button class="small-btn" type="button" id="couponApplyBtn" onclick="applyCoupon()">Apply</button></div><div id="couponMsg" aria-live="polite"></div></div>';}
function renderCouponMsg(text,ok){const el=$('couponMsg');if(!el)return;el.innerHTML=text?`<div class="msg ${ok?'ok':'err'}">${esc(text)}${couponState.code?' <button class="small-btn" type="button" onclick="removeCoupon()">Remove</button>':''}</div>`:'';}
async function applyCoupon(){
 const code=($('ckCoupon')?.value||'').trim().toUpperCase();
 if(!code){renderCouponMsg('Enter a coupon code.',false);return;}
 const btn=$('couponApplyBtn');if(btn)btn.disabled=true;
 const {data,error}=await supabase.rpc('check_coupon',{p_code:code});
 if(btn)btn.disabled=false;
 if(error||!data){couponState={code:null,discount:0};renderCouponMsg('Could not check this coupon. Please try again.',false);}
 else if(!data.valid){couponState={code:null,discount:0};renderCouponMsg(data.message||'This coupon cannot be used.',false);}
 else{couponState={code:data.code,discount:Number(data.discount_paise||0)};renderCouponMsg(data.message,true);}
 onZoneChange();
}
function removeCoupon(){couponState={code:null,discount:0};const i=$('ckCoupon');if(i)i.value='';renderCouponMsg('',true);onZoneChange();}
async function placeOrder(){
 const payMethod=selectedPayMethod();
 const name=$('ckName').value.trim(),phone=$('ckPhone').value.trim(),addr=$('ckAddr').value.trim(),zoneId=$('ckZone').value,z=zones.find(x=>x.id===zoneId);
 if(!name||!/^\d{10}$/.test(phone)||!addr||!z){notify('Please enter recipient name, valid 10-digit phone, street address and delivery area.');return;}
 const pricing=cartPricing(z);if(pricing.payable<Number(z.minimum_order_paise||0)){notify('Your basket is below the minimum order for this delivery area.');return;}
 if(!validateTaajaGps()){notify('Please share your GPS location. Orders are available only inside our delivery area.');return;}
 const deliveryType=selectedDeliveryType(),deliveryDate=$('ckDeliveryDate')?.value||'',bookingError=taajaBookingError(taajaTodayIndia(),deliveryType,deliveryDate);if(bookingError){notify(bookingError);return;}
 const btn=$('placeOrderBtn');checkoutState.placing=true;btn.disabled=true;btn.textContent='Placing order…';
 let createdAddressId=null;
 try{
  const {data:profileRow,error:profileError}=await supabase.from('profiles').update({full_name:name,phone,updated_at:new Date().toISOString()}).eq('id',session.user.id).select('id').maybeSingle();if(profileError)throw new Error('Could not save your profile details: '+profileError.message);if(!profileRow)throw new Error('Your profile record was not updated. Please sign out and sign in again or contact support.');
  const lat=$('ckLatitude').value?Number($('ckLatitude').value):null, lng=$('ckLongitude').value?Number($('ckLongitude').value):null;
  const address={user_id:session.user.id,label:'Home',recipient_name:name,phone,address_line1:addr,landmark:$('ckLandmark').value.trim()||null,area:z.name,city:'Hyderabad',state:'Telangana',pincode:'',latitude:lat,longitude:lng,delivery_instructions:$('ckNote').value.trim()||null,is_default:true};
  const {data:addrData,error:addrError}=await supabase.from('addresses').insert(address).select('id').single();if(addrError)throw addrError;createdAddressId=addrData.id;
  const slotId=$('ckSlot').value||null;
  const {data,error}=await supabase.functions.invoke('create-order',{body:{address_id:addrData.id,delivery_zone_id:z.id,delivery_slot_id:slotId,payment_method:payMethod,customer_note:$('ckNote').value.trim()||null,delivery_type:deliveryType,requested_delivery_date:deliveryDate,latitude:lat,longitude:lng,expected_total_paise:couponTotal(pricing.total),coupon_code:couponState.code||null}});
  if(error)throw error;if(!data?.success||!data?.order)throw new Error(data?.error||'Order could not be placed.');
  createdAddressId=null;const order=data.order;cart={};clearGuestCart();closeCheckout();renderCart();renderGrid();renderCartCount();checkoutState.placing=false;showConfirmation(order.order_number||order.order_id,payMethod==='online'?'ONLINE_PENDING':'COD',0,order.total_paise,{date:order.delivery_date||order.requested_delivery_date||deliveryDate,type:order.delivery_type||deliveryType,discount:order.discount_paise,free:order.free_items,feeWaived:order.delivery_fee_waived});if(payMethod==='online')payOnline(order.order_id,order.order_number);loadCustomerExtras().catch(()=>{});
 }catch(e){console.error(e);if(createdAddressId){const {error:cleanupError}=await supabase.from('addresses').delete().eq('id',createdAddressId).eq('user_id',session.user.id);if(cleanupError)console.error('Could not remove unused checkout address',cleanupError);}notify(e.message||'Could not place order. Your basket has been kept.');checkoutState.placing=false;btn.textContent=payButtonLabel();updatePlaceOrderState();}
}
function showConfirmation(orderId,pay,statusIdx,totalPaise,delivery={}){$('confirmBody').innerHTML=`<div style="text-align:center;padding:1.4rem 0 .6rem"><div style="font-size:2.2rem">🧺</div><h2>Order received</h2><p class="muted">Order ${esc(orderId)} · <span id="confirmPayLabel">${pay==='ONLINE_PENDING'?'Waiting for online payment':pay==='ONLINE'?'Paid online':'Cash on delivery'}</span></p><h2>${fmt(rupees(totalPaise))}</h2>${delivery.discount?`<p class="muted">Includes ${fmt(rupees(delivery.discount))} offer savings</p>`:''}${delivery.feeWaived?'<p class="muted">Free delivery with your membership</p>':''}${(delivery.free||[]).length?`<p class="muted">🎁 ${delivery.free.length} free item${delivery.free.length===1?'':'s'} added to your order</p>`:''}</div>${delivery.date?`<div class="delivery-date-display" id="confirmDeliveryDate">Requested delivery date<br><b>${esc(taajaFormatDate(delivery.date)||delivery.date)}</b> · ${taajaDeliveryTypeLabel(delivery.type)}</div>`:''}<p class="muted">Your order has been saved. Our store team will confirm it and prepare your items.</p><button class="primary-btn" onclick="closeConfirmation();openOrders()">View my orders</button><button class="ghost-btn" onclick="closeConfirmation()">Continue shopping</button>`;$('confirmOverlay').classList.add('open');}
function closeConfirmation(){$('confirmOverlay').classList.remove('open');}

async function openOrders(){if(!session?.user){openAuth();return;}$('ordersBody').innerHTML='<div class="empty">Loading your orders…</div>';$('ordersOverlay').classList.add('open');const {data:orders,error}=await supabase.from('orders').select('id,order_number,status,payment_method,payment_status,subtotal_paise,delivery_fee_paise,discount_paise,coupon_code,total_paise,placed_at,delivery_date,delivery_type').eq('user_id',session.user.id).order('placed_at',{ascending:false}).limit(30);if(error){$('ordersBody').innerHTML=`<div class="msg err">${esc(error.message)}</div>`;return;}if(!orders?.length){$('ordersBody').innerHTML='<div class="empty">You have not placed any orders yet.</div>';return;}const ids=orders.map(o=>o.id),{data:items}=await supabase.from('order_items').select('order_id,product_name,variant_name,quantity,line_total_paise').in('order_id',ids);$('ordersBody').innerHTML=orders.map(o=>`<div class="admin-card"><div class="section-head"><b>${esc(o.order_number)}</b><span class="badge-status">${esc(o.status.replaceAll('_',' '))}</span></div><div class="muted">${new Date(o.placed_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} · ${o.payment_method==='razorpay'?'Online · '+esc(payStatusLabel(o.payment_status)):'Cash on delivery'}</div>${o.payment_method==='razorpay'&&o.status==='pending'&&['pending','failed'].includes(o.payment_status)?`<div class="admin-actions"><button class="primary-btn small-btn pay-now-btn" type="button" onclick="closeOrders();payOnline('${esc(o.id)}','${esc(o.order_number)}')">Pay now</button></div>`:''}${o.delivery_date?`<div class="muted">Delivery: <b>${esc(taajaFormatDate(o.delivery_date)||o.delivery_date)}</b> · ${taajaDeliveryTypeLabel(o.delivery_type)}</div>`:''}<div style="margin:.6rem 0">${(items||[]).filter(i=>i.order_id===o.id).map(i=>`<div class="sum-row"><span>${esc(i.product_name)} · ${esc(i.variant_name)} × ${i.quantity}</span><span>${Number(i.line_total_paise)===0?'FREE':fmt(rupees(i.line_total_paise))}</span></div>`).join('')}</div>${orderSummaryRows(o)}<div class="sum-row total"><span>Total</span><b>${fmt(rupees(o.total_paise))}</b></div></div>`).join('');}
// My orders: show how the total was reached (delivery fee, offer savings, coupon) so items and total always add up.
function orderSummaryRows(o){const rows=[];if(Number(o.delivery_fee_paise)>0)rows.push(`<div class="sum-row"><span>Delivery</span><span>${fmt(rupees(o.delivery_fee_paise))}</span></div>`);if(Number(o.discount_paise)>0)rows.push(`<div class="sum-row"><span>${o.coupon_code?'Discount (coupon '+esc(o.coupon_code)+')':'Offer savings'}</span><span>−${fmt(rupees(o.discount_paise))}</span></div>`);return rows.join('');}
function closeOrders(){$('ordersOverlay').classList.remove('open');}

async function openDeliveries(){if(!roles.includes('delivery_staff'))return;$('deliveryBody').innerHTML='<div class="empty">Loading assigned deliveries…</div>';$('deliveryOverlay').classList.add('open');const {data,error}=await supabase.functions.invoke('my-deliveries');if(error||!data){$('deliveryBody').innerHTML='<div class="msg err">Could not load deliveries. Please try again.</div>';return;}if(!data.deliveries?.length){$('deliveryBody').innerHTML='<div class="empty">No active deliveries assigned to you.</div>';return;}$('deliveryBody').innerHTML=data.deliveries.map(d=>{const o=d.order,a=o.delivery_address_snapshot||{};return `<div class="admin-card"><div class="section-head"><b>${esc(o.order_number)}</b><span class="badge-status">${esc(d.assignment.status)}</span></div><p><b>${esc(a.recipient_name||'Customer')}</b><br>${esc(a.phone||'')}<br>${esc([a.address_line1,a.address_line2,a.landmark,a.area,a.city,a.pincode].filter(Boolean).join(', '))}</p><div>${d.items.map(i=>`<div class="sum-row"><span>${esc(i.product_name)} · ${esc(i.variant_name)} × ${i.quantity}</span></div>`).join('')}</div><div class="sum-row total"><span>${o.payment_method==='cod'?'COD collect':'Order total'}</span><b>${fmt(rupees(o.total_paise))}</b></div><div class="admin-actions">${d.assignment.status==='assigned'?`<button class="small-btn" onclick="deliveryAction('${d.assignment.id}','accepted')">Accept</button>`:''}${d.assignment.status==='accepted'?`<button class="small-btn" onclick="deliveryAction('${d.assignment.id}','picked_up')">Picked up</button>`:''}${d.assignment.status==='picked_up'?`<button class="small-btn" onclick="deliveryAction('${d.assignment.id}','delivered')">Mark delivered</button><button class="small-btn danger" onclick="deliveryAction('${d.assignment.id}','failed')">Failed</button>`:''}</div></div>`;}).join('');}
async function deliveryAction(id,status){const note=status==='failed'?prompt('Reason for failed delivery (required):')||'Delivery failed':prompt('Optional delivery note:')||'';if(status==='failed'&&!note.trim())return;const {data,error}=await supabase.functions.invoke('delivery-update',{body:{assignment_id:id,status,note}});if(error||!data?.success){notify(data?.error||error?.message||'Update failed');return;}await openDeliveries();}
function closeDeliveries(){$('deliveryOverlay').classList.remove('open');}

// Header serviceability indicator (launch build 21 Nov 2026). The state comes ONLY from the existing GPS boundary
// check (taajaInsideBoundary via requestGps); a city name never makes a location "serviceable".
let headerAddress=null,homeServiceState={state:'idle'};
function headerLocationText(state){
 const addr=headerAddress?` · ${headerAddress}`:'';
 switch(state){
  case 'ok':return {title:'Serviceable at Hyderabad',sub:'✓ We deliver to your location'+addr};
  case 'outside':return {title:'Not serviceable here yet',sub:'Outside our delivery area · coming soon'};
  case 'checking':return {title:'Serviceable at Hyderabad',sub:'Checking your location…'};
  case 'denied':return {title:'Serviceable at Hyderabad',sub:'Location blocked · allow access to check'};
  case 'error':return {title:'Serviceable at Hyderabad',sub:"Couldn't get your location · tap to retry"};
  default:return {title:'Serviceable at Hyderabad',sub:headerAddress?`${headerAddress} · tap to check delivery`:'Tap to check your location'};
 }
}
function renderHeaderLocation(){const b=$('localityBtn');if(!b)return;const st=homeServiceState.state,t=headerLocationText(st);b.dataset.state=st;$('locTitle').textContent=t.title;$('locSub').textContent=t.sub;b.title=homeServiceState.msg||t.sub;b.setAttribute('aria-label',`Delivery location: ${t.title}. ${t.sub}`);}
async function refreshHeaderAddress(){headerAddress=null;if(session?.user){try{const {data}=await supabase.from('addresses').select('label,address_line1,area').eq('user_id',session.user.id).order('is_default',{ascending:false}).order('created_at',{ascending:false}).limit(1);const a=data?.[0];if(a)headerAddress=[a.label||'Home',a.area||a.address_line1].filter(Boolean).join(': ');}catch(e){/* header keeps the generic text */}}renderHeaderLocation();}
function renderHomeService(r){const t=gpsResultText(r);homeServiceState={state:t.state,msg:t.msg};renderHeaderLocation();}
async function checkHomeServiceability(){const btn=$('localityBtn');if(btn)btn.disabled=true;homeServiceState={state:'checking',msg:'Please allow location access when your browser asks.'};renderHeaderLocation();const r=await requestGps();if(btn)btn.disabled=false;renderHomeService(r);}
async function autoCheckServiceability(){try{if(!navigator.permissions?.query||!navigator.geolocation)return;const p=await navigator.permissions.query({name:'geolocation'});if(p.state==='granted')await checkHomeServiceability();else if(p.state==='denied')renderHomeService({status:'denied'});}catch(e){console.warn('Location permission check unavailable',e);}}

window.TAAJA_STORE_READY = true;
