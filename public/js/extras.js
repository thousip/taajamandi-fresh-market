// TaajaMandi storefront — customer extras (overnight build, 20 Nov 2026): promotional banners, deals and free
// items (preview only; the server decides), memberships, WhatsApp support and tickets, favourites, recently viewed,
// related products and reorder. Plain script loaded after admin.js and before app.js; uses store.js state.
'use strict';

const SUPPORT_WHATSAPP_DEFAULT = '917671913761'; // +91 76719 13761 (owner-provided); store_settings.whatsapp_number overrides
const RECENT_KEY = 'taajamandi_recent_v1';
let promo = { deals: new Map(), freeItems: [], dealOrders: new Map(), freeOrders: new Map(), hasOrders: false };
let membership = { status: 'signed_out', plans: [], history: [] };
let favourites = new Set();
let banners = [], bannerIndex = 0, bannerTimer = null;
let supportNumber = SUPPORT_WHATSAPP_DEFAULT;

// ------------------------------------------------------------------ loading
async function loadExtras() {
  await Promise.all([loadBanners(), loadPromotions(), loadMembershipPlans(), loadSupportNumber()]);
  renderBanners(); renderDealsSection(); renderRecentlyViewed(); renderSupportButton(); renderMembershipTeaser();
}
async function loadCustomerExtras() {
  if (!session?.user) {
    membership = { ...membership, status: 'signed_out', history: [] }; favourites = new Set();
    promo.dealOrders = new Map(); promo.freeOrders = new Map(); promo.hasOrders = false;
    renderFavouriteChip(); renderMembershipTeaser(); return;
  }
  const uid = session.user.id;
  const [m, f, r, o, h] = await Promise.all([
    supabase.rpc('my_membership', {}),
    supabase.from('favourites').select('product_id'),
    supabase.from('promo_redemptions').select('promo_type,promo_id,order_id'),
    supabase.from('orders').select('id,status').eq('user_id', uid),
    supabase.from('memberships').select('plan_code,status,current_period_start,current_period_end,created_at').order('created_at', { ascending: false }).limit(10),
  ]);
  const md = m.data && typeof m.data === 'object' ? m.data : { status: 'none' };
  membership = { ...membership, ...md, history: h.data || [] };
  favourites = new Set((f.data || []).map(x => x.product_id));
  const live = new Set((o.data || []).filter(x => !['cancelled', 'refunded'].includes(x.status)).map(x => x.id));
  promo.hasOrders = live.size > 0;
  promo.dealOrders = new Map(); promo.freeOrders = new Map();
  for (const x of r.data || []) {
    if (!live.has(x.order_id)) continue;
    const map = x.promo_type === 'deal' ? promo.dealOrders : promo.freeOrders;
    map.set(x.promo_id, (map.get(x.promo_id) || new Set()).add(x.order_id));
  }
  renderFavouriteChip(); renderMembershipTeaser(); renderDealsSection();
  if (typeof renderCart === 'function') renderCart();
}
async function loadBanners() {
  const { data, error } = await supabase.from('promo_banners').select('id,heading,description,image_path,link_type,link_target,sort_order').order('sort_order').limit(3);
  banners = error ? [] : (data || []);
}
async function loadPromotions() {
  const [d, f] = await Promise.all([
    supabase.from('promo_deals').select('id,variant_id,label,deal_price_paise,starts_at,ends_at,eligibility,max_units_per_order,max_orders_per_customer,min_order_paise'),
    supabase.from('promo_free_items').select('id,name,free_variant_id,free_quantity,trigger_type,min_subtotal_paise,trigger_variant_id,eligibility,max_per_customer,ends_at'),
  ]);
  promo.deals = new Map();
  for (const x of (d.error ? [] : d.data || [])) {
    const cur = promo.deals.get(x.variant_id);
    if (!cur || x.deal_price_paise < cur.deal_price_paise) promo.deals.set(x.variant_id, x);
  }
  promo.freeItems = f.error ? [] : (f.data || []);
}
async function loadMembershipPlans() {
  const { data, error } = await supabase.from('membership_plans').select('code,name,price_paise,free_deliveries,period_days,is_enabled').order('price_paise');
  membership.plans = error ? [] : (data || []);
}
async function loadSupportNumber() {
  try { const r = await loadWhatsAppNumber(); if (r.number) supportNumber = r.number; } catch (e) { /* keep default */ }
}

// ------------------------------------------------------------------ pricing preview (server is authoritative)
function promoEligible(eligibility) {
  if (eligibility === 'new_customers') return !promo.hasOrders;
  if (eligibility === 'members') return membership.status === 'active';
  return true;
}
function liveDealFor(variantId) {
  const d = promo.deals.get(variantId);
  if (!d || !promoEligible(d.eligibility)) return null;
  if ((promo.dealOrders.get(d.id)?.size || 0) >= d.max_orders_per_customer) return null;
  return d;
}
// Mirrors create_order_from_cart where the browser can know the inputs. Any difference (e.g. a total cap reached by
// other customers) makes the server refuse the order with a clear message instead of changing the price.
function cartPricing(zone) {
  const lines = {}; let regular = 0, discount = 0;
  for (const [id, c] of cartEntries()) {
    const price = Number(c.variant.price_paise), qty = Math.floor(Number(c.qty) || 0);
    regular += price * qty;
    const d = liveDealFor(id);
    lines[id] = { price, qty, units: d && d.deal_price_paise < price ? Math.min(qty, d.max_units_per_order) : 0, deal: d };
  }
  for (const l of Object.values(lines)) {
    if (l.units && regular < Number(l.deal.min_order_paise || 0)) l.units = 0;
    if (l.units) discount += (l.price - l.deal.deal_price_paise) * l.units;
  }
  const payable = regular - discount;
  const ids = new Set(Object.keys(lines));
  const free = promo.freeItems.filter(f => {
    const v = currentVariant(f.free_variant_id);
    if (!v || !v.in_stock || !promoEligible(f.eligibility)) return false;
    if ((promo.freeOrders.get(f.id)?.size || 0) >= f.max_per_customer) return false;
    if (f.trigger_type === 'min_subtotal') return payable >= Number(f.min_subtotal_paise || 0);
    if (f.trigger_type === 'with_variant') return ids.has(f.trigger_variant_id);
    return ids.size > 0;
  }).map(f => ({ ...f, variant: currentVariant(f.free_variant_id) }));
  let fee = null, feeWaived = false;
  if (zone) {
    fee = zone.free_delivery_min_paise != null && payable >= Number(zone.free_delivery_min_paise) ? 0 : Number(zone.delivery_fee_paise || 0);
    if (fee > 0 && membership.status === 'active' && Number(membership.remaining) > 0) { fee = 0; feeWaived = true; }
  }
  return { lines, regular, discount, payable, free, fee, feeWaived, total: fee == null ? null : payable + fee };
}
function dealTag(p) {
  const d = (p.variants || []).map(v => liveDealFor(v.id) && { v, d: liveDealFor(v.id) }).find(Boolean);
  return d ? `<span class="tag deal-tag">${esc(d.d.label || fmt(rupees(d.d.deal_price_paise)) + ' deal')}</span>` : '';
}
function cartLineNote(id) {
  const l = cartPricing(null).lines[id];
  if (!l?.units) return '';
  return `<div class="deal-note">${l.units} at ${fmt(rupees(l.deal.deal_price_paise))} <s>${fmt(rupees(l.price))}</s> (offer)${l.qty > l.units ? ` · ${l.qty - l.units} at ${fmt(rupees(l.price))}` : ''}</div>`;
}
function cartSummaryRows(pr) {
  return `${pr.discount ? `<div class="sum-row"><span>Items at regular price</span><span>${fmt(rupees(pr.regular))}</span></div><div class="sum-row saving"><span>Offer savings</span><span>−${fmt(rupees(pr.discount))}</span></div>` : ''}`
    + pr.free.map(f => `<div class="sum-row free-line"><span>🎁 Free: ${esc(f.variant.product.name)} · ${esc(f.variant.name)} × ${Number(f.free_quantity)}</span><span>${fmt(0)}</span></div>`).join('')
    + (pr.free.length ? '<div class="inline-note">Free items are confirmed by the store when you place the order.</div>' : '');
}

// ------------------------------------------------------------------ banners
function bannerHref(b) { return b.link_type === 'none' ? null : b; }
function renderBanners() {
  const box = $('promoBanners'); if (!box) return;
  if (!banners.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div class="banner-track" id="bannerTrack" tabindex="0" aria-roledescription="carousel">${banners.map((b, i) => {
    const img = b.image_path ? `<img src="${esc(productImageUrl(supabase, b.image_path))}" alt="" width="1200" height="400" ${i ? 'loading="lazy"' : 'fetchpriority="high"'}>` : '';
    return `<div class="banner-slide${b.image_path ? '' : ' no-image'}" role="group" aria-label="Offer ${i + 1} of ${banners.length}"${bannerHref(b) ? ` tabindex="0" onclick="openBanner(${i})" onkeydown="if(event.key==='Enter')openBanner(${i})"` : ''}>${img}<div class="banner-text"><strong>${esc(b.heading)}</strong>${b.description ? `<span>${esc(b.description)}</span>` : ''}</div></div>`;
  }).join('')}</div>${banners.length > 1 ? `<div class="banner-dots">${banners.map((_, i) => `<button type="button" aria-label="Show offer ${i + 1}" onclick="showBanner(${i})"></button>`).join('')}</div>` : ''}`;
  const track = $('bannerTrack');
  track.addEventListener('scroll', () => { const i = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1)); if (i !== bannerIndex) { bannerIndex = i; markBannerDot(); } }, { passive: true });
  ['pointerdown', 'focusin', 'mouseenter'].forEach(ev => track.addEventListener(ev, stopBannerTimer));
  markBannerDot();
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (banners.length > 1 && !reduce) bannerTimer = setInterval(() => showBanner((bannerIndex + 1) % banners.length), 6000);
}
function stopBannerTimer() { if (bannerTimer) { clearInterval(bannerTimer); bannerTimer = null; } }
function markBannerDot() { document.querySelectorAll('.banner-dots button').forEach((b, i) => b.setAttribute('aria-current', i === bannerIndex ? 'true' : 'false')); }
function showBanner(i) { const t = $('bannerTrack'); if (!t) return; bannerIndex = i; if (typeof t.scrollTo === 'function') t.scrollTo({ left: i * t.clientWidth, behavior: 'smooth' }); markBannerDot(); }
function openBanner(i) {
  const b = banners[i]; if (!b) return;
  if (b.link_type === 'category' && b.link_target) { activeCat = b.link_target; renderCategories(); renderGrid(); $('catalogue')?.scrollIntoView({ behavior: 'smooth' }); }
  else if (b.link_type === 'product' && b.link_target) openProductDetails(b.link_target);
  else if (b.link_type === 'deals') $('dealsSection')?.scrollIntoView({ behavior: 'smooth' });
  else if (b.link_type === 'membership') openMembership();
}

// ------------------------------------------------------------------ deals section
function renderDealsSection() {
  const box = $('dealsSection'); if (!box) return;
  const items = [...promo.deals.values()].map(d => ({ d, v: currentVariant(d.variant_id) })).filter(x => x.v && liveDealFor(x.v.id));
  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div class="section-head"><h2>Today’s offers</h2><span class="muted">Limited quantities · while the offer lasts</span></div><div class="deal-row">${items.map(({ d, v }) => `<button type="button" class="deal-card" onclick="openProductDetails('${esc(v.product.id)}')"><span class="deal-price">${fmt(rupees(d.deal_price_paise))}</span> <s class="muted">${fmt(rupees(v.price_paise))}</s><span class="deal-name">${esc(v.product.name)} · ${esc(v.name)}</span><span class="muted">Up to ${d.max_units_per_order} per order${d.min_order_paise ? ` · min order ${fmt(rupees(d.min_order_paise))}` : ''}${d.eligibility === 'new_customers' ? ' · first order' : d.eligibility === 'members' ? ' · members' : ''}${v.in_stock ? '' : ' · unavailable today'}</span></button>`).join('')}</div>`;
}

// ------------------------------------------------------------------ membership
function planCard(p) {
  const per = p.code === 'weekly' ? 'week' : 'month';
  return `<div class="plan-card"><h3>${esc(p.name)}</h3><div class="plan-price">${fmt(rupees(p.price_paise))}<span>/${per}</span></div><ul><li>${p.free_deliveries} free deliveries per membership ${per}</li><li>No minimum order for free delivery</li></ul>${p.is_enabled ? `<button class="primary-btn" type="button" onclick="joinMembership('${esc(p.code)}')">Join ${esc(p.name.toLowerCase())}</button>` : '<button class="ghost-btn" type="button" disabled>Coming soon</button>'}</div>`;
}
function membershipStatusHtml() {
  const m = membership;
  if (m.status === 'signed_out') return '<p class="muted">Sign in to see your membership.</p>';
  if (m.status === 'none' || !m.status) return '<p class="muted">You do not have a membership yet.</p>';
  const end = m.period_end ? new Date(m.period_end).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return `<div class="member-status"><b>${esc(m.plan_name || m.plan || 'Membership')}</b> · <span class="badge-status">${esc(m.status)}</span>${m.status === 'active' ? `<div>${Number(m.remaining)} of ${Number(m.free_deliveries)} free deliveries left · renews ${esc(end)}</div>` : m.status === 'pending' ? '<div class="muted">Waiting for payment confirmation from Razorpay.</div>' : ''}</div>`;
}
function renderMembershipTeaser() {
  const box = $('membershipTeaser'); if (!box) return;
  if (!membership.plans.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="section-head"><h2>TaajaMandi membership</h2><button class="small-btn" type="button" onclick="openMembership()">Details</button></div><div class="plan-row">${membership.plans.map(planCard).join('')}</div>`;
}
function openMembership() {
  const hist = (membership.history || []).map(h => `<div class="sum-row"><span>${esc(h.plan_code)} · ${esc(h.status)}</span><span class="muted">${h.current_period_start ? new Date(h.current_period_start).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : new Date(h.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</span></div>`).join('');
  $('membershipBody').innerHTML = `${membershipStatusHtml()}${membership.status === 'active' ? '<button class="ghost-btn" type="button" onclick="cancelMembership()">Cancel at the end of this period</button>' : ''}<div class="plan-row">${membership.plans.map(planCard).join('')}</div><p class="inline-note">Free deliveries are applied automatically at checkout. A free delivery used on an order that is later cancelled is given back. Your membership starts only after Razorpay confirms the payment.</p>${hist ? `<h3>History</h3>${hist}` : ''}<div id="membershipMsg" aria-live="polite"></div>`;
  $('membershipOverlay').classList.add('open');
}
function closeMembership() { $('membershipOverlay').classList.remove('open'); }
function loadRazorpayCheckout() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve(window.Razorpay);
    const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(window.Razorpay); s.onerror = () => reject(new Error('Could not load the payment window.'));
    document.head.appendChild(s);
  });
}
async function joinMembership(code) {
  if (!session?.user) { closeMembership(); openAuth(); showMsg('authMsg', 'Sign in to join a membership.'); return; }
  const { data, error } = await supabase.functions.invoke('membership-ops', { body: { action: 'subscribe', plan_code: code } });
  if (error || !data?.success) { showMsg('membershipMsg', data?.error || 'Membership payments are not available right now.'); return; }
  try {
    const Rzp = await loadRazorpayCheckout();
    new Rzp({
      key: data.key_id, subscription_id: data.subscription_id, name: 'TaajaMandi', description: data.plan_name,
      handler: () => { showMsg('membershipMsg', 'Payment received. Your membership starts as soon as Razorpay confirms it (usually within a minute).', true); setTimeout(loadCustomerExtras, 5000); },
      theme: { color: '#1B6B3C' },
    }).open();
  } catch (e) { showMsg('membershipMsg', e.message); }
}
async function cancelMembership() {
  if (!confirm('Cancel your membership at the end of the current period?')) return;
  const { data, error } = await supabase.functions.invoke('membership-ops', { body: { action: 'cancel' } });
  showMsg('membershipMsg', data?.message || data?.error || error?.message || 'Could not cancel right now.', !!data?.success);
}

// ------------------------------------------------------------------ support
function renderSupportButton() {
  if ($('waFloat')) return;
  const a = document.createElement('a');
  a.id = 'waFloat'; a.className = 'wa-float'; a.target = '_blank'; a.rel = 'noopener';
  a.href = `https://wa.me/${supportNumber}?text=${encodeURIComponent('Hello TaajaMandi, I need help with my order.')}`;
  a.setAttribute('aria-label', 'Chat with TaajaMandi support on WhatsApp');
  a.textContent = '💬 Help';
  document.body.appendChild(a);
}
async function openSupport() {
  if (!session?.user) { openAuth(); showMsg('authMsg', 'Sign in to contact support about an order.'); return; }
  const [{ data: orders }, { data: tickets }] = await Promise.all([
    supabase.from('orders').select('id,order_number').eq('user_id', session.user.id).order('placed_at', { ascending: false }).limit(10),
    supabase.from('support_tickets').select('id,category,message,status,admin_note,created_at').order('created_at', { ascending: false }).limit(10),
  ]);
  $('supportBody').innerHTML = `<p>WhatsApp us on <a href="https://wa.me/${supportNumber}" target="_blank" rel="noopener">+${esc(supportNumber.replace(/^91/, '91 '))}</a>, or send a request here.</p><form class="admin-form" onsubmit="submitSupport(event)"><div class="form-field"><label for="supCategory">Topic</label><select id="supCategory"><option value="freshness">Freshness / quality</option><option value="missing_item">Missing item</option><option value="delivery">Delivery</option><option value="payment">Payment</option><option value="other">Something else</option></select></div><div class="form-field"><label for="supOrder">Order (optional)</label><select id="supOrder"><option value="">No specific order</option>${(orders || []).map(o => `<option value="${esc(o.id)}">${esc(o.order_number)}</option>`).join('')}</select></div><div class="form-field"><label for="supMessage">Message</label><textarea id="supMessage" rows="3" maxlength="1000" required></textarea></div><button class="primary-btn">Send to TaajaMandi</button></form><div id="supportMsg" aria-live="polite"></div>${(tickets || []).length ? `<h3>Your requests</h3>${tickets.map(t => `<div class="admin-card"><div class="section-head"><b>${esc(String(t.category || 'other').replace('_', ' '))}</b><span class="badge-status">${esc(String(t.status || 'open').replace('_', ' '))}</span></div><div>${esc(t.message)}</div>${t.admin_note ? `<div class="muted">TaajaMandi: ${esc(t.admin_note)}</div>` : ''}</div>`).join('')}` : ''}`;
  $('supportOverlay').classList.add('open');
}
function closeSupport() { $('supportOverlay').classList.remove('open'); }
async function submitSupport(e) {
  e.preventDefault();
  const message = $('supMessage').value.trim();
  if (message.length < 5) { showMsg('supportMsg', 'Please describe the problem in a few words.'); return; }
  const { error } = await supabase.from('support_tickets').insert({ category: $('supCategory').value, order_id: $('supOrder').value || null, message });
  if (error) { showMsg('supportMsg', 'Could not send your request. Please try WhatsApp instead.'); return; }
  showMsg('supportMsg', 'Thank you. Our team will get back to you.', true);
  setTimeout(openSupport, 800);
}

// ------------------------------------------------------------------ favourites, recently viewed, related, reorder
function renderFavouriteChip() {
  const cats = $('categories'); if (!cats) return;
  let chip = cats.querySelector('[data-cat="fav"]');
  if (session?.user && !chip) { chip = document.createElement('button'); chip.className = 'chip'; chip.dataset.cat = 'fav'; chip.textContent = '♥ Favourites'; cats.appendChild(chip); }
  if (!session?.user && chip) { chip.remove(); if (activeCat === 'fav') { activeCat = 'all'; renderGrid(); } }
}
async function toggleFavourite(pid) {
  if (!session?.user) { openAuth(); showMsg('authMsg', 'Sign in to save favourites.'); return; }
  const on = favourites.has(pid);
  const { error } = on ? await supabase.from('favourites').delete().eq('product_id', pid).eq('user_id', session.user.id)
    : await supabase.from('favourites').insert({ product_id: pid });
  if (error) { notify('Could not update favourites.'); return; }
  on ? favourites.delete(pid) : favourites.add(pid);
  const b = $('favBtn'); if (b) { b.setAttribute('aria-pressed', String(!on)); b.textContent = !on ? '♥ Saved' : '♡ Save'; }
  if (activeCat === 'fav') renderGrid();
}
function readRecent() { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 8) : []; } catch (e) { return []; } }
function rememberViewed(pid) { try { localStorage.setItem(RECENT_KEY, JSON.stringify([pid, ...readRecent().filter(x => x !== pid)].slice(0, 8))); } catch (e) { /* storage unavailable */ } renderRecentlyViewed(); }
function renderRecentlyViewed() {
  const box = $('recentSection'); if (!box) return;
  const list = readRecent().map(currentProduct).filter(Boolean);
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="section-head"><h2>Recently viewed</h2></div><div class="chip-row">${list.map(p => `<button type="button" class="chip" onclick="openProductDetails('${esc(p.id)}')">${esc(p.name)}</button>`).join('')}</div>`;
}
function relatedProducts(p) { return products.filter(x => x.id !== p.id && x.catSlug === p.catSlug && x.variants.some(v => v.in_stock)).slice(0, 4); }
const _baseOpenProductDetails = openProductDetails;
openProductDetails = function (pid) {
  _baseOpenProductDetails(pid);
  const p = currentProduct(pid); if (!p) return;
  rememberViewed(pid);
  const body = $('productDetailBody'); if (!body || body.querySelector('#favBtn')) return;
  const rel = relatedProducts(p);
  body.insertAdjacentHTML('beforeend', `<div class="detail-extras"><button class="small-btn" id="favBtn" type="button" aria-pressed="${favourites.has(pid)}" onclick="toggleFavourite('${esc(pid)}')">${favourites.has(pid) ? '♥ Saved' : '♡ Save'}</button>${rel.length ? `<h3>You may also like</h3><div class="chip-row">${rel.map(r => `<button type="button" class="chip" onclick="openProductDetails('${esc(r.id)}')">${esc(r.name)}</button>`).join('')}</div>` : ''}</div>`);
};
async function reorder(orderId) {
  const { data: items, error } = await supabase.from('order_items').select('variant_id,quantity,promo_type').eq('order_id', orderId);
  if (error) { notify('Could not load that order.'); return; }
  let added = 0, skipped = 0;
  for (const it of items || []) {
    if (it.promo_type === 'free_item') continue;
    const v = it.variant_id && currentVariant(it.variant_id);
    if (!v || !v.in_stock) { skipped++; continue; }
    for (let i = 0; i < Math.min(Math.floor(Number(it.quantity)), MAX_LINE_QTY); i++) await changeQty(v.id, 1);
    added++;
  }
  notify(added ? `Added ${added} item${added === 1 ? '' : 's'} to your basket${skipped ? `; ${skipped} not available today` : ''}. Prices are today's prices.` : 'None of these items are available today.');
  if (added) { closeOrders(); openCart(); }
}
const _baseOpenOrders = openOrders;
openOrders = async function () {
  await _baseOpenOrders();
  const { data: orders } = session?.user ? await supabase.from('orders').select('id').eq('user_id', session.user.id).order('placed_at', { ascending: false }).limit(30) : { data: [] };
  const cards = [...document.querySelectorAll('#ordersBody > .admin-card')];
  cards.forEach((card, i) => { const o = (orders || [])[i]; if (o && !card.querySelector('.reorder-btn')) card.insertAdjacentHTML('beforeend', `<div class="admin-actions"><button class="small-btn reorder-btn" type="button" onclick="reorder('${esc(o.id)}')">Reorder</button><button class="small-btn" type="button" onclick="closeOrders();openSupport()">Get help</button></div>`); });
};
const _baseOpenAccountPanel = openAccountPanel;
openAccountPanel = function () {
  _baseOpenAccountPanel();
  const body = $('authBody'); if (!body || body.querySelector('#acctMembership')) return;
  const signOutBtn = [...body.querySelectorAll('button')].find(b => /Sign out/.test(b.textContent));
  const html = `<button class="ghost-btn" id="acctMembership" type="button" onclick="closeAuth();openMembership()">Membership</button><button class="ghost-btn" type="button" onclick="closeAuth();openSupport()">Help &amp; support</button>`;
  signOutBtn ? signOutBtn.insertAdjacentHTML('beforebegin', html) : body.insertAdjacentHTML('beforeend', html);
};
