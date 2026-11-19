// TaajaMandi storefront — pure, browser-safe business rules (delivery boundary, booking dates, weights, bargains).
// Loaded first by index.html. No DOM or network access here; unit-tested by storefront-tests/run-tests.mjs.
'use strict';

// BEGIN TAAJA_RULES — pure, browser-safe business rules. Unit-tested by storefront-tests/run-tests.mjs.
// Approved delivery boundary: 7.4 km around this centre, identical to the check in the existing create-order Edge Function.
const TAAJA_CENTER={lat:17.5299559,lng:78.3055903},TAAJA_RADIUS_M=7400;
const TAAJA_DELIVERY_START='2026-12-01';
const BARGAIN_MIN_KG=5,BARGAIN_MAX_KG=50,BARGAIN_STEP_KG=0.5,MAX_PACKS=20;
const PUBLIC_SETTING_KEYS=['store_name','support_phone','whatsapp_number'];
function taajaDistanceM(lat,lng){const R=6371000,rad=x=>x*Math.PI/180,dLat=rad(lat-TAAJA_CENTER.lat),dLng=rad(lng-TAAJA_CENTER.lng),a=Math.sin(dLat/2)**2+Math.cos(rad(TAAJA_CENTER.lat))*Math.cos(rad(lat))*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.sqrt(a));}
function taajaInsideBoundary(lat,lng){if(lat===null||lng===null||lat===''||lng==='')return false;lat=Number(lat);lng=Number(lng);return Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180&&taajaDistanceM(lat,lng)<=TAAJA_RADIUS_M;}
function parseLatLng(raw){const m=String(raw||'').trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);if(!m)return null;const lat=Number(m[1]),lng=Number(m[2]);if(Math.abs(lat)>90||Math.abs(lng)>180)return null;return {lat,lng};}
function taajaTodayIndia(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
function taajaAddDays(ymd,days){const d=new Date(ymd+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function taajaIsDate(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v||''))return false;const d=new Date(v+'T12:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;}
// Booking rules (owner spec, 18 Nov 2026; must match the DB trigger and create-order):
// before 1 Dec: advance only, delivery on 1 Dec or any later date (default 1 Dec);
// from 1 Dec: same-day for today (2–3 h, capacity permitting) or advance for a future date.
function taajaBookingRules(today){
 if(today<TAAJA_DELIVERY_START)return {types:['advance'],defaultType:'advance',defaultDate:TAAJA_DELIVERY_START,minAdvance:TAAJA_DELIVERY_START,fixedDate:null,hint:'Deliveries start on 1 December. Book now for 1 December or any later date.'};
 return {types:['same_day','advance'],defaultType:'same_day',defaultDate:today,minAdvance:taajaAddDays(today,1),fixedDate:null,hint:'Same-day delivery is for today (2–3 hours, subject to capacity). Choose advance delivery for a future date.'};
}
function taajaBookingError(today,type,date){
 if(!['same_day','advance'].includes(type)||!taajaIsDate(date))return 'Choose a valid delivery type and date.';
 if(today<TAAJA_DELIVERY_START)return type!=='advance'||date<TAAJA_DELIVERY_START?'Deliveries start on 1 December. Choose 1 December or a later date.':null;
 if(type==='same_day'&&date!==today)return 'Same-day delivery must be scheduled for today.';
 if(type==='advance'&&date<=today)return 'Advance delivery must be scheduled for a future date.';
 return null;
}
function taajaFormatDate(ymd){if(!taajaIsDate(ymd))return '';return new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date(ymd+'T06:30:00Z'));}
function taajaDeliveryTypeLabel(t){return t==='same_day'?'Same-day delivery':t==='advance'?'Advance delivery':'Delivery';}
function variantKg(v){const unit=String(v?.unit||'').trim().toLowerCase(),q=Number(v?.quantity);if(Number.isFinite(q)&&q>0){if(/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/.test(unit))return q;if(/^(g|gm|gms|gram|grams)$/.test(unit))return q/1000;}const label=String(v?.name||'').toLowerCase().replace(/,/g,' ');const g=label.match(/(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\b/);if(g)return Number(g[1])/1000;const kg=label.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilo|kilos|kilogram|kilograms)\b/);if(kg)return Number(kg[1]);return null;}
// The one variant both the product card and the detail screen show first: in-stock default, else first in-stock, else default.
function defaultVariant(variants){const vs=variants||[],stocked=vs.filter(v=>v.in_stock);return stocked.find(v=>v.is_default)||stocked[0]||vs.find(v=>v.is_default)||vs[0]||null;}
function sortVariantsForDisplay(variants){const vs=[...(variants||[])];if(vs.length&&vs.every(v=>variantKg(v)!==null))return vs.sort((a,b)=>variantKg(a)-variantKg(b));return vs.sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));}
function formatKg(kg){if(!Number.isFinite(kg))return '';if(kg<1)return Math.round(kg*1000)+' g';return String(Math.round(kg*1000)/1000)+' kg';}
function perKgPaise(v){const kg=variantKg(v),p=Number(v?.price_paise);return kg&&Number.isInteger(p)&&p>0?Math.round(p/kg):null;}
// Bargain rate comes from an existing weight variant's own price: the default one if it is weight-based, else the largest weight.
function bargainRateVariant(p){const ws=(p?.variants||[]).filter(v=>perKgPaise(v)!==null);if(!ws.length)return null;const d=defaultVariant(ws);return ws.find(v=>v.is_default)||[...ws].sort((a,b)=>variantKg(b)-variantKg(a))[0]||d;}
function bargainEstimatePaise(ratePaise,kg){return Math.round(ratePaise*kg);}
function bargainError(kg,offerRupees){kg=Number(kg);if(!Number.isFinite(kg)||kg<BARGAIN_MIN_KG)return `Bargain requests start at ${BARGAIN_MIN_KG} kg.`;if(kg>BARGAIN_MAX_KG)return `For more than ${BARGAIN_MAX_KG} kg, please contact the store directly.`;if(Math.abs(kg/BARGAIN_STEP_KG-Math.round(kg/BARGAIN_STEP_KG))>1e-9)return `Choose a quantity in steps of ${BARGAIN_STEP_KG} kg.`;const raw=String(offerRupees??'').trim();if(!/^\d+(\.\d{1,2})?$/.test(raw)||Number(raw)<=0)return 'Enter the total price you are offering, in rupees.';return null;}
function rupeesToPaise(raw){const s=String(raw??'').trim();if(!/^\d+(\.\d{1,2})?$/.test(s))return null;const [w,f='']=s.split('.');const p=Number(w)*100+Number(f.padEnd(2,'0'));return Number.isSafeInteger(p)&&p>0?p:null;}
const BARGAIN_STATUS={pending:'Waiting for TaajaMandi',countered:'Counter-offer received',approved:'Offer approved',accepted:'You accepted the counter-offer',rejected:'Offer rejected',declined:'You declined the counter-offer',cancelled:'Cancelled',expired:'Counter-offer expired'};
function bargainIsOpen(r,now=Date.now()){return r.status==='pending'||(r.status==='countered'&&!(r.expires_at&&Date.parse(r.expires_at)<=now));}
function normalizeWhatsAppNumber(raw){let d=String(raw||'').replace(/\D/g,'');if(d.length===11&&d.startsWith('0'))d=d.slice(1);if(d.length===10&&/^[6-9]/.test(d))return '91'+d;if(d.length===12&&d.startsWith('91')&&/^[6-9]/.test(d.slice(2)))return d;return '';}
// END TAAJA_RULES
