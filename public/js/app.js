// TaajaMandi storefront — event wiring and start-up. Loaded last.
// Starts only when store.js ran to the end (it stops at the environment guard on a host that is not allowed).
'use strict';

if (window.TAAJA_STORE_READY !== true) throw new Error('TaajaMandi did not start: store.js stopped or failed to load.');

// Wire the original prototype controls and expose functions to its inline UI actions.
Object.assign(window,{submitNewPassword,revokeStaff,setVariantAvailability,openProductDetails,closeProductDetails,sendBargainRequest,openCart,closeCart,openAuth,closeAuth,openAccountPanel,signOut,setAuthMode,setAuthMethod,submitAuth,resendPhoneOtp,captureCheckoutLocation,changeQty,openWeightPopup,selectVariant,confirmWeightAdd,closeWeightPopup,openCheckout,closeCheckout,onZoneChange,placeOrder,closeConfirmation,openOrders,closeOrders,openAdmin,closeAdmin,loadAdminTab,editProduct,cancelEditProduct,saveProduct,addProductVariant,addCategory,toggleProduct,uploadProductImage,adjustStock,updateOrderStatus,inviteStaff,assignDelivery,openDeliveries,closeDeliveries,deliveryAction,saveStoreSettings,addZone,toggleZone,saveDeliverySlot,editDeliverySlot,resetSlotForm,toggleDeliverySlot,selectDetailVariant,changeDetailPacks,addDetailToBasket,openBargain,closeBargain,onBargainKg,updateBargainSummary,onDeliveryTypeChange,onDeliveryDateChange,checkHomeServiceability,openMyBargains,closeMyBargains,respondBargain,adminBargainAction});
Object.defineProperty(window,'adminBargainFilter',{get:()=>adminBargainFilter,set:v=>{adminBargainFilter=v;}});
$('detectLocationBtn').addEventListener('click',checkHomeServiceability);
$('bargainOverlay').addEventListener('click',e=>{if(e.target.id==='bargainOverlay')closeBargain();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('bargainOverlay').classList.contains('open'))closeBargain();});
$('categories').addEventListener('click',e=>{const b=e.target.closest('.chip');if(!b)return;activeCat=b.dataset.cat;renderCategories();renderGrid();});
$('searchInput').addEventListener('input',e=>{searchTerm=e.target.value;renderGrid();});
$('cartBtn').addEventListener('click',openCart);$('closeCart').addEventListener('click',closeCart);$('closeCheckout').addEventListener('click',closeCheckout);$('browseBtn').addEventListener('click',()=>$('catalogue').scrollIntoView({behavior:'smooth'}));
$('weightOverlay').addEventListener('click',e=>{if(e.target.id==='weightOverlay')closeWeightPopup();});$('productDetailOverlay').addEventListener('click',e=>{if(e.target.id==='productDetailOverlay')closeProductDetails();});$('authOverlay').addEventListener('click',e=>{if(e.target.id==='authOverlay')closeAuth();});
$('acctBtn').addEventListener('click',()=>session?openAccountPanel():openAuth());
document.querySelectorAll('.overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('open');}));

async function boot(){
 setTimeout(()=>{const l=$('catalogueLoading');if(l&&$('productGrid').getAttribute('aria-busy')==='true')l.textContent='Still loading — the store connection is slow right now. Please wait a moment…';},6000);
 autoCheckServiceability();
 await loadCatalogue();await loadZones();restoreGuestCart();
 const {data:{session:initialSession}}=await supabase.auth.getSession();session=initialSession;
 if(session){await loadIdentity();try{await loadCustomerCart(true);}catch(e){console.warn('Cart load',e);}}
 renderAcctBtn();renderCart();renderCartCount();
 if(authUrlParams.get('error_code')||authUrlParams.get('error_description')){clearAuthUrl();notify(authUrlParams.get('error_code')==='otp_expired'?'This email link is invalid or has expired. Request a new one from Sign in > Forgot password?':'This email link could not be used. Please request a new one.');}
 else if(passwordRecoveryPending&&session)openPasswordRecovery();
 supabase.auth.onAuthStateChange(async(_event,newSession)=>{session=newSession;if(session){await loadIdentity();try{await loadCustomerCart(true);}catch(e){console.warn(e);}}else if(_event==='SIGNED_OUT'){profile=null;roles=[];renderAcctBtn();cart={};renderGrid();renderCart();renderCartCount();}});
}
boot().catch(e=>{console.error(e);$('productGrid').removeAttribute('aria-busy');$('productGrid').innerHTML='<div class="empty" style="grid-column:1/-1">Could not connect to the store catalogue. Please refresh the page or contact support.</div>';});
