// TaajaMandi storefront — admin extras (overnight build, 20 Nov 2026): banners, offers (deals), free gifts,
// memberships, suppliers and purchase orders, support tickets and basic reports.
// Every write goes through RLS (admin/manager policies) or an audited server function; config tables are audited by
// database triggers. Campaigns are created DISABLED; enabling asks for confirmation. Plain script after extras.js.
'use strict';

ADMIN_TABS.push(['banners', 'Banners'], ['deals', 'Offers'], ['coupons', 'Coupons'], ['freeitems', 'Free gifts'], ['memberships', 'Memberships'],
  ['suppliers', 'Suppliers'], ['support', 'Support'], ['reports', 'Reports']);
const ADMIN_EXTRA_TABS = {
  banners: adminBanners, deals: adminDeals, coupons: adminCoupons, freeitems: adminFreeItems, memberships: adminMemberships,
  suppliers: adminSuppliers, support: adminSupport, reports: adminReports,
};
const istTime = (ts) => ts ? new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
const toIso = (v) => v ? new Date(v).toISOString() : null;
const paiseOrNull = (raw) => { const s = String(raw ?? '').trim(); if (!s) return null; if (s === '0') return 0; return rupeesToPaise(s); };
async function adminVariantOptions() {
  const [{ data: vars }, { data: prods }] = await Promise.all([
    supabase.from('product_variants').select('id,product_id,name,price_paise,is_active').eq('is_active', true),
    supabase.from('products').select('id,name').eq('is_active', true).order('name'),
  ]);
  const byProduct = new Map((prods || []).map(p => [p.id, p.name]));
  return (vars || []).filter(v => byProduct.has(v.product_id))
    .map(v => ({ id: v.id, label: `${byProduct.get(v.product_id)} · ${v.name} (${fmt(rupees(v.price_paise))})`, price: v.price_paise }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
const variantSelect = (id, opts, selected = '') => `<select id="${id}" required><option value="">Choose a size</option>${opts.map(o => `<option value="${esc(o.id)}" ${o.id === selected ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
const adminError = (e) => { notify(e?.message || 'Could not save.'); };

// ------------------------------------------------------------------ banners
async function adminBanners() {
  const { data, error } = await supabase.from('promo_banners').select('*').order('sort_order');
  if (error) throw error;
  $('adminBody').innerHTML = `<h2>Banners</h2><div class="admin-card"><h3>Add a banner</h3><form class="admin-form" onsubmit="saveBanner(event)"><div class="form-field"><label for="bnHeading">Heading</label><input id="bnHeading" maxlength="80" required></div><div class="form-field"><label for="bnDesc">Description</label><input id="bnDesc" maxlength="200"></div><div class="form-field"><label for="bnLinkType">Link</label><select id="bnLinkType"><option value="none">No link</option><option value="category">Category (slug)</option><option value="product">Product (id)</option><option value="deals">Offers section</option><option value="membership">Membership</option></select></div><div class="form-field"><label for="bnTarget">Link target</label><input id="bnTarget" maxlength="120" placeholder="e.g. fruit"></div><div class="form-field"><label for="bnCta">Button label (optional, shown when the banner has a link)</label><input id="bnCta" maxlength="24" placeholder="e.g. Shop fruit"></div><div class="form-field"><label for="bnStart">Starts</label><input id="bnStart" type="datetime-local"></div><div class="form-field"><label for="bnEnd">Ends</label><input id="bnEnd" type="datetime-local"></div><div class="form-field"><label for="bnOrder">Display order</label><input id="bnOrder" type="number" value="0"></div><div class="form-field"><label for="bnImage">Image (JPEG/PNG/WebP, wide 3:1)</label><input id="bnImage" type="file" accept="image/jpeg,image/png,image/webp" onchange="previewBannerImage(this)"></div><div class="banner-slide" id="bnPreview" hidden aria-label="Banner preview"></div><div><button class="primary-btn">Save banner (disabled)</button></div></form><p class="inline-note">New banners start disabled. Customers see at most 3 enabled banners inside their dates.</p></div><div class="admin-card"><h3>All banners</h3>${(data || []).map(b => `<div class="cart-line"><div class="info"><div class="n">${esc(b.heading)}</div><div class="p">${b.is_enabled ? 'Enabled' : 'Disabled'} · ${istTime(b.starts_at)} → ${istTime(b.ends_at)} · order ${b.sort_order}${b.image_path ? ' · image' : ' · no image'} · link ${esc(b.link_type)}${b.link_target ? ' ' + esc(b.link_target) : ''}</div></div><div class="admin-actions"><button class="small-btn ${b.is_enabled ? 'danger' : ''}" onclick="toggleRow('promo_banners','${b.id}',${!b.is_enabled},'banners')">${b.is_enabled ? 'Disable' : 'Enable'}</button><button class="small-btn danger" onclick="deleteRow('promo_banners','${b.id}','banners')">Delete</button></div></div>`).join('') || '<div class="empty">No banners yet.</div>'}</div>`;
}
async function saveBanner(e) {
  e.preventDefault();
  let image_path = null;
  const file = $('bnImage').files?.[0];
  if (file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { notify('Use a JPEG, PNG or WebP image under 2 MB.'); return; }
    image_path = `banners/${crypto.randomUUID()}.${file.type.split('/')[1].replace('jpeg', 'jpg')}`;
    const { error: upErr } = await supabase.storage.from('product-images').upload(image_path, file, { contentType: file.type, upsert: false });
    if (upErr) { adminError(upErr); return; }
  }
  const row = { heading: $('bnHeading').value.trim(), description: $('bnDesc').value.trim() || null, cta_label: $('bnCta').value.trim() || null, link_type: $('bnLinkType').value, link_target: $('bnTarget').value.trim() || null, starts_at: toIso($('bnStart').value), ends_at: toIso($('bnEnd').value), sort_order: Number($('bnOrder').value) || 0, image_path, is_enabled: false };
  const { error } = await supabase.from('promo_banners').insert(row);
  if (error) { adminError(error); return; }
  notify('Banner saved as disabled. Enable it when it is ready.');
  await loadAdminTab('banners');
}
// Shows the chosen image in the banner's real shape before it is uploaded (nothing is saved until Save).
function previewBannerImage(input) {
  const box = $('bnPreview'), file = input.files && input.files[0];
  if (!box) return;
  if (!file) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<img alt="Banner preview" src="${URL.createObjectURL(file)}"><div class="banner-text"><strong>${esc($('bnHeading').value.trim() || 'Heading')}</strong><span>${esc($('bnDesc').value.trim())}</span></div>`;
}
async function toggleRow(table, id, enable, tab) {
  if (!confirm(enable ? 'Enable this for customers now?' : 'Disable this? Customers will stop seeing it.')) return;
  const { error } = await supabase.from(table).update({ is_enabled: enable, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) { adminError(error); return; }
  await loadAdminTab(tab);
  if (typeof loadExtras === 'function') loadExtras().catch(() => {});
}
async function deleteRow(table, id, tab) {
  if (!confirm('Delete this permanently? This cannot be undone.')) return;
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) { adminError(error); return; }
  await loadAdminTab(tab);
}

// ------------------------------------------------------------------ deals
async function adminDeals() {
  const [{ data, error }, opts] = await Promise.all([supabase.from('promo_deals').select('*').order('created_at', { ascending: false }), adminVariantOptions()]);
  if (error) throw error;
  const label = (id) => opts.find(o => o.id === id)?.label || 'Size not active';
  $('adminBody').innerHTML = `<h2>Offers (e.g. ₹1 deals)</h2><div class="admin-card"><h3>Create an offer</h3><form class="admin-form" onsubmit="saveDeal(event)"><div class="form-field"><label for="dlVariant">Size</label>${variantSelect('dlVariant', opts)}</div><div class="form-field"><label for="dlPrice">Offer price (₹)</label><input id="dlPrice" inputmode="decimal" required placeholder="1"></div><div class="form-field"><label for="dlLabel">Badge text (optional)</label><input id="dlLabel" maxlength="60" placeholder="₹1 deal"></div><div class="form-field"><label for="dlStart">Starts</label><input id="dlStart" type="datetime-local" required></div><div class="form-field"><label for="dlEnd">Ends</label><input id="dlEnd" type="datetime-local" required></div><div class="form-field"><label for="dlElig">Who can use it</label><select id="dlElig"><option value="all">Everyone</option><option value="new_customers">First order only</option><option value="members">Members only</option></select></div><div class="form-field"><label for="dlUnits">Units per order at offer price</label><input id="dlUnits" type="number" min="1" max="50" value="1" required></div><div class="form-field"><label for="dlOrders">Orders per customer</label><input id="dlOrders" type="number" min="1" value="1" required></div><div class="form-field"><label for="dlTotal">Total units available (blank = no cap)</label><input id="dlTotal" type="number" min="1"></div><div class="form-field"><label for="dlMin">Minimum order (₹, blank = none)</label><input id="dlMin" inputmode="decimal"></div><div><button class="primary-btn">Save offer (disabled)</button></div></form><p class="inline-note">Offers start disabled and are checked again at checkout on the server: limits, dates and availability are enforced there, never in the browser.</p></div><div class="admin-card"><h3>All offers</h3>${(data || []).map(d => `<div class="cart-line"><div class="info"><div class="n">${esc(label(d.variant_id))}</div><div class="p">${fmt(rupees(d.deal_price_paise))} · ${d.is_enabled ? 'Enabled' : 'Disabled'} · ${istTime(d.starts_at)} → ${istTime(d.ends_at)} · ${d.max_units_per_order}/order · ${d.max_orders_per_customer} order(s)/customer${d.max_total_units ? ` · ${d.max_total_units} total` : ''} · ${esc(d.eligibility)}</div></div><div class="admin-actions"><button class="small-btn ${d.is_enabled ? 'danger' : ''}" onclick="toggleRow('promo_deals','${d.id}',${!d.is_enabled},'deals')">${d.is_enabled ? 'Disable' : 'Enable'}</button></div></div>`).join('') || '<div class="empty">No offers yet.</div>'}</div>`;
}
async function saveDeal(e) {
  e.preventDefault();
  const price = paiseOrNull($('dlPrice').value), min = paiseOrNull($('dlMin').value);
  if (price === null) { notify('Enter the offer price in rupees, e.g. 1.'); return; }
  const row = { variant_id: $('dlVariant').value, deal_price_paise: price, label: $('dlLabel').value.trim() || null, starts_at: toIso($('dlStart').value), ends_at: toIso($('dlEnd').value), eligibility: $('dlElig').value, max_units_per_order: Number($('dlUnits').value), max_orders_per_customer: Number($('dlOrders').value), max_total_units: $('dlTotal').value ? Number($('dlTotal').value) : null, min_order_paise: min ?? 0, is_enabled: false };
  const { error } = await supabase.from('promo_deals').insert(row);
  if (error) { adminError(error); return; }
  notify('Offer saved as disabled.');
  await loadAdminTab('deals');
}

// ------------------------------------------------------------------ free items
async function adminFreeItems() {
  const [{ data, error }, opts] = await Promise.all([supabase.from('promo_free_items').select('*').order('created_at', { ascending: false }), adminVariantOptions()]);
  if (error) throw error;
  const label = (id) => opts.find(o => o.id === id)?.label || 'Size not active';
  $('adminBody').innerHTML = `<h2>Free gifts</h2><div class="admin-card"><h3>Create a free-item campaign</h3><form class="admin-form" onsubmit="saveFreeItem(event)"><div class="form-field"><label for="fiName">Name</label><input id="fiName" maxlength="80" required></div><div class="form-field"><label for="fiVariant">Free size</label>${variantSelect('fiVariant', opts)}</div><div class="form-field"><label for="fiQty">Free quantity</label><input id="fiQty" type="number" min="1" max="5" value="1" required></div><div class="form-field"><label for="fiTrigger">When</label><select id="fiTrigger"><option value="min_subtotal">Basket at least a minimum value</option><option value="with_variant">Basket contains a size</option><option value="campaign">Every order during the campaign</option></select></div><div class="form-field"><label for="fiMin">Minimum basket (₹)</label><input id="fiMin" inputmode="decimal"></div><div class="form-field"><label for="fiTriggerVariant">Qualifying size</label>${variantSelect('fiTriggerVariant', opts).replace(' required', '')}</div><div class="form-field"><label for="fiStart">Starts</label><input id="fiStart" type="datetime-local" required></div><div class="form-field"><label for="fiEnd">Ends</label><input id="fiEnd" type="datetime-local" required></div><div class="form-field"><label for="fiElig">Who can get it</label><select id="fiElig"><option value="all">Everyone</option><option value="new_customers">First order only</option><option value="members">Members only</option></select></div><div class="form-field"><label for="fiPer">Times per customer</label><input id="fiPer" type="number" min="1" value="1" required></div><div class="form-field"><label for="fiTotal">Total gifts available (blank = no cap)</label><input id="fiTotal" type="number" min="1"></div><div><button class="primary-btn">Save campaign (disabled)</button></div></form><p class="inline-note">The free item is added on the server as a ₹0 line only if the free size is available; customers cannot add or change it.</p></div><div class="admin-card"><h3>All campaigns</h3>${(data || []).map(f => `<div class="cart-line"><div class="info"><div class="n">${esc(f.name)}</div><div class="p">${esc(label(f.free_variant_id))} × ${Number(f.free_quantity)} · ${esc(f.trigger_type.replace('_', ' '))}${f.min_subtotal_paise != null ? ' ≥ ' + fmt(rupees(f.min_subtotal_paise)) : ''} · ${f.is_enabled ? 'Enabled' : 'Disabled'} · ${istTime(f.starts_at)} → ${istTime(f.ends_at)} · ${f.max_per_customer}/customer${f.max_total ? ` · ${f.max_total} total` : ''}</div></div><div class="admin-actions"><button class="small-btn ${f.is_enabled ? 'danger' : ''}" onclick="toggleRow('promo_free_items','${f.id}',${!f.is_enabled},'freeitems')">${f.is_enabled ? 'Disable' : 'Enable'}</button></div></div>`).join('') || '<div class="empty">No campaigns yet.</div>'}</div>`;
}
async function saveFreeItem(e) {
  e.preventDefault();
  const trigger = $('fiTrigger').value, min = paiseOrNull($('fiMin').value);
  if (trigger === 'min_subtotal' && min === null) { notify('Enter the minimum basket value.'); return; }
  if (trigger === 'with_variant' && !$('fiTriggerVariant').value) { notify('Choose the qualifying size.'); return; }
  const row = { name: $('fiName').value.trim(), free_variant_id: $('fiVariant').value, free_quantity: Number($('fiQty').value), trigger_type: trigger, min_subtotal_paise: trigger === 'min_subtotal' ? min : null, trigger_variant_id: trigger === 'with_variant' ? $('fiTriggerVariant').value : null, starts_at: toIso($('fiStart').value), ends_at: toIso($('fiEnd').value), eligibility: $('fiElig').value, max_per_customer: Number($('fiPer').value), max_total: $('fiTotal').value ? Number($('fiTotal').value) : null, is_enabled: false };
  const { error } = await supabase.from('promo_free_items').insert(row);
  if (error) { adminError(error); return; }
  notify('Campaign saved as disabled.');
  await loadAdminTab('freeitems');
}

// ------------------------------------------------------------------ memberships
async function adminMemberships() {
  const [{ data: plans, error }, { data: members }, { data: events }] = await Promise.all([
    supabase.from('membership_plans').select('*').order('price_paise'),
    supabase.from('memberships').select('id,user_id,plan_code,status,current_period_start,current_period_end,created_at').order('created_at', { ascending: false }).limit(50),
    supabase.from('payment_webhook_events').select('event_id,event_type,processed,received_at').order('received_at', { ascending: false }).limit(10),
  ]);
  if (error) throw error;
  $('adminBody').innerHTML = `<h2>Memberships</h2><div class="admin-card"><h3>Plans</h3><p class="inline-note">Prices and free deliveries are the confirmed business rules. A plan can be enabled only after its Razorpay plan id is set (Razorpay Test Mode in QA). Only admins can change plans; every change is audited.</p>${(plans || []).map(p => `<div class="cart-line"><div class="info"><div class="n">${esc(p.name)} · ${fmt(rupees(p.price_paise))}</div><div class="p">${p.free_deliveries} free deliveries per ${p.period_days} days · ${p.is_enabled ? 'Enabled' : 'Disabled'} · Razorpay plan: ${p.razorpay_plan_id ? esc(p.razorpay_plan_id) : 'not set'}</div></div><div class="admin-actions"><button class="small-btn" onclick="setPlanId('${p.code}')">Set Razorpay plan id</button><button class="small-btn ${p.is_enabled ? 'danger' : ''}" onclick="togglePlan('${p.code}',${!p.is_enabled},${Boolean(p.razorpay_plan_id)})">${p.is_enabled ? 'Disable' : 'Enable'}</button></div></div>`).join('')}</div><div class="admin-card"><h3>Members (latest 50)</h3>${(members || []).map(m => `<div class="cart-line"><div class="info"><div class="n">${esc(m.plan_code)} · ${esc(m.status)}</div><div class="p">${istTime(m.current_period_start)} → ${istTime(m.current_period_end)} · account ${esc(m.user_id.slice(0, 8))}</div></div></div>`).join('') || '<div class="empty">No memberships yet.</div>'}</div><div class="admin-card"><h3>Latest payment webhooks</h3>${(events || []).map(ev => `<div class="sum-row"><span>${esc(ev.event_type)}</span><span>${ev.processed ? 'processed' : 'stored'} · ${istTime(ev.received_at)}</span></div>`).join('') || '<div class="empty">No webhooks received yet.</div>'}</div>`;
}
async function setPlanId(code) {
  const v = prompt('Razorpay plan id (from the Razorpay dashboard, e.g. plan_XXXX). Leave empty to clear.');
  if (v === null) return;
  const id = v.trim();
  if (id && !/^plan_[A-Za-z0-9]{6,}$/.test(id)) { notify('That does not look like a Razorpay plan id.'); return; }
  const { error } = await supabase.from('membership_plans').update({ razorpay_plan_id: id || null, is_enabled: id ? undefined : false, updated_at: new Date().toISOString() }).eq('code', code);
  if (error) { adminError(error); return; }
  await loadAdminTab('memberships');
}
async function togglePlan(code, enable, hasPlanId) {
  if (enable && !hasPlanId) { notify('Set the Razorpay plan id first.'); return; }
  if (!confirm(enable ? 'Show this plan to customers with a Join button?' : 'Hide the Join button for this plan? Existing members keep their benefits.')) return;
  const { error } = await supabase.from('membership_plans').update({ is_enabled: enable, updated_at: new Date().toISOString() }).eq('code', code);
  if (error) { adminError(error); return; }
  await loadAdminTab('memberships');
}

// ------------------------------------------------------------------ suppliers and purchase orders
async function adminSuppliers() {
  const [{ data: sups, error }, { data: pos }, opts] = await Promise.all([
    supabase.from('suppliers').select('*').order('name'),
    supabase.from('purchase_orders').select('id,po_number,status,supplier_id,created_at,ordered_at,received_at').order('created_at', { ascending: false }).limit(30),
    adminVariantOptions(),
  ]);
  if (error) throw error;
  const supName = (id) => (sups || []).find(s => s.id === id)?.name || '—';
  $('adminBody').innerHTML = `<h2>Suppliers &amp; purchasing</h2><div class="admin-card"><h3>Add a supplier</h3><form class="admin-form" onsubmit="saveSupplier(event)"><div class="form-field"><label for="spName">Name</label><input id="spName" required maxlength="120"></div><div class="form-field"><label for="spContact">Contact person</label><input id="spContact" maxlength="120"></div><div class="form-field"><label for="spPhone">Phone</label><input id="spPhone" maxlength="20"></div><div class="form-field"><label for="spEmail">Email</label><input id="spEmail" type="email"></div><div class="form-field"><label for="spAddress">Address</label><input id="spAddress"></div><div><button class="primary-btn">Save supplier</button></div></form><p class="inline-note">Supplier details are visible only to admins and managers, never to customers or staff apps.</p></div><div class="admin-card"><h3>Suppliers</h3>${(sups || []).map(s => `<div class="cart-line"><div class="info"><div class="n">${esc(s.name)}</div><div class="p">${esc(s.contact_person || '')} ${esc(s.phone || '')} · ${s.is_active ? 'Active' : 'Inactive'}</div></div></div>`).join('') || '<div class="empty">No suppliers yet.</div>'}</div><div class="admin-card"><h3>New purchase order (draft)</h3><form class="admin-form" onsubmit="savePurchaseOrder(event)"><div class="form-field"><label for="poSupplier">Supplier</label><select id="poSupplier" required><option value="">Choose</option>${(sups || []).filter(s => s.is_active).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div><div class="form-field"><label for="poVariant">Size</label>${variantSelect('poVariant', opts)}</div><div class="form-field"><label for="poQty">Quantity ordered</label><input id="poQty" type="number" min="0.001" step="0.001" required></div><div class="form-field"><label for="poCost">Unit cost (₹)</label><input id="poCost" inputmode="decimal" required></div><div><button class="primary-btn">Create draft</button></div></form></div><div class="admin-card"><h3>Purchase orders</h3>${(pos || []).map(p => `<div class="cart-line"><div class="info"><div class="n">${esc(p.po_number)} · ${esc(supName(p.supplier_id))}</div><div class="p">${esc(p.status.replace('_', ' '))} · created ${istTime(p.created_at)}${p.received_at ? ' · received ' + istTime(p.received_at) : ''}</div></div><div class="admin-actions">${p.status === 'draft' ? `<button class="small-btn" onclick="placePurchaseOrder('${p.id}')">Mark placed</button>` : ''}${['placed', 'partially_received'].includes(p.status) ? `<button class="small-btn" onclick="receivePurchaseOrder('${p.id}')">Receive goods</button>` : ''}</div></div>`).join('') || '<div class="empty">No purchase orders yet.</div>'}</div>`;
}
async function saveSupplier(e) {
  e.preventDefault();
  const { error } = await supabase.from('suppliers').insert({ name: $('spName').value.trim(), contact_person: $('spContact').value.trim() || null, phone: $('spPhone').value.trim() || null, email: $('spEmail').value.trim() || null, address: $('spAddress').value.trim() || null });
  if (error) { adminError(error); return; }
  await loadAdminTab('suppliers');
}
async function savePurchaseOrder(e) {
  e.preventDefault();
  const cost = paiseOrNull($('poCost').value);
  if (cost === null) { notify('Enter the unit cost in rupees.'); return; }
  const po_number = `PO-${taajaTodayIndia().replaceAll('-', '')}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const qty = Number($('poQty').value);
  const { data: po, error } = await supabase.from('purchase_orders').insert({ supplier_id: $('poSupplier').value, po_number, status: 'draft', subtotal_paise: Math.round(cost * qty), created_by: session.user.id }).select('id').single();
  if (error) { adminError(error); return; }
  const { error: itemErr } = await supabase.from('purchase_order_items').insert({ purchase_order_id: po.id, variant_id: $('poVariant').value, quantity_ordered: qty, unit_cost_paise: cost });
  if (itemErr) { adminError(itemErr); return; }
  notify(`Draft ${po_number} created.`);
  await loadAdminTab('suppliers');
}
async function placePurchaseOrder(id) {
  if (!confirm('Mark this purchase order as placed with the supplier?')) return;
  const { error } = await supabase.from('purchase_orders').update({ status: 'placed', ordered_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'draft');
  if (error) { adminError(error); return; }
  await loadAdminTab('suppliers');
}
async function receivePurchaseOrder(id) {
  const { data: items, error } = await supabase.from('purchase_order_items').select('id,quantity_ordered,quantity_received,variant_id').eq('purchase_order_id', id);
  if (error) { adminError(error); return; }
  const lines = [];
  for (const it of items || []) {
    const open = Number(it.quantity_ordered) - Number(it.quantity_received);
    if (open <= 0) continue;
    const v = prompt(`Quantity received now (open: ${open})`, String(open));
    if (v === null) return;
    const q = Number(v);
    if (q > 0) lines.push({ item_id: it.id, quantity: q });
  }
  if (!lines.length) { notify('Nothing to receive.'); return; }
  const { data, error: recErr } = await supabase.functions.invoke('admin-ops', { body: { action: 'receive_purchase_order', purchase_order_id: id, lines } });
  if (recErr || !data?.success) { notify(data?.error || recErr?.message || 'Could not receive goods.'); return; }
  notify(data.result.status === 'received' ? 'All goods received; stock updated.' : 'Partial delivery recorded; stock updated.');
  await loadAdminTab('suppliers');
}

// ------------------------------------------------------------------ support
async function adminSupport() {
  const { data, error } = await supabase.from('support_tickets').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  $('adminBody').innerHTML = `<h2>Customer support</h2>${(data || []).map(t => `<div class="admin-card"><div class="section-head"><b>${esc(t.category.replace('_', ' '))}</b><span class="badge-status">${esc(t.status.replace('_', ' '))}</span></div><div>${esc(t.message)}</div><div class="muted">${istTime(t.created_at)}${t.order_id ? ' · order linked' : ''}</div><div class="admin-form"><div class="form-field"><label for="ts-${t.id}">Status</label><select id="ts-${t.id}">${['open', 'in_progress', 'resolved', 'closed'].map(s => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select></div><div class="form-field"><label for="tn-${t.id}">Reply to customer</label><input id="tn-${t.id}" maxlength="1000" value="${esc(t.admin_note || '')}"></div><button class="small-btn" onclick="updateTicket('${t.id}')">Save</button></div></div>`).join('') || '<div class="empty">No support requests.</div>'}`;
}
async function updateTicket(id) {
  const { error } = await supabase.from('support_tickets').update({ status: $('ts-' + id).value, admin_note: $('tn-' + id).value.trim() || null, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) { adminError(error); return; }
  notify('Saved.');
}

// ------------------------------------------------------------------ reports
async function adminReports() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const [{ data: orders, error }, { data: redemptions }, { data: members }] = await Promise.all([
    supabase.from('orders').select('id,status,total_paise,discount_paise,placed_at').gte('placed_at', since),
    supabase.from('promo_redemptions').select('promo_type,quantity,created_at').gte('created_at', since),
    supabase.from('memberships').select('status'),
  ]);
  if (error) throw error;
  const ids = (orders || []).filter(o => !['cancelled', 'refunded'].includes(o.status)).map(o => o.id);
  const { data: items } = ids.length ? await supabase.from('order_items').select('product_name,variant_name,quantity,promo_type').in('order_id', ids) : { data: [] };
  const byStatus = {}; for (const o of orders || []) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  const delivered = (orders || []).filter(o => o.status === 'delivered');
  const revenue = delivered.reduce((s, o) => s + Number(o.total_paise), 0);
  const top = {}; for (const it of items || []) if (it.promo_type !== 'free_item') { const k = `${it.product_name} · ${it.variant_name}`; top[k] = (top[k] || 0) + Number(it.quantity); }
  const topList = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const deals = (redemptions || []).filter(r => r.promo_type === 'deal').reduce((s, r) => s + Number(r.quantity), 0);
  const gifts = (redemptions || []).filter(r => r.promo_type === 'free_item').length;
  const activeMembers = (members || []).filter(m => m.status === 'active').length;
  $('adminBody').innerHTML = `<h2>Reports · last 30 days</h2><div class="admin-card"><div class="sum-row"><span>Orders placed</span><b>${(orders || []).length}</b></div>${Object.entries(byStatus).map(([s, n]) => `<div class="sum-row"><span>${esc(s.replaceAll('_', ' '))}</span><span>${n}</span></div>`).join('')}<div class="sum-row"><span>Delivered revenue</span><b>${fmt(rupees(revenue))}</b></div><div class="sum-row"><span>Average delivered order</span><span>${delivered.length ? fmt(rupees(Math.round(revenue / delivered.length))) : '—'}</span></div><div class="sum-row"><span>Offer units sold</span><span>${deals}</span></div><div class="sum-row"><span>Free gifts given</span><span>${gifts}</span></div><div class="sum-row"><span>Active members</span><span>${activeMembers}</span></div></div><div class="admin-card"><h3>Top 10 items (not cancelled)</h3>${topList.map(([k, q]) => `<div class="sum-row"><span>${esc(k)}</span><span>${q}</span></div>`).join('') || '<div class="empty">No orders in this period.</div>'}</div>`;
}

Object.assign(window, { saveBanner, toggleRow, deleteRow, saveDeal, saveFreeItem, setPlanId, togglePlan, saveSupplier, savePurchaseOrder, placePurchaseOrder, receivePurchaseOrder, updateTicket });

// ------------------------------------------------------------------ coupons (launch build 21 Nov 2026)
// Validation and discounts happen only on the server (check_coupon / create_order_from_cart_v3). New coupons are
// saved DISABLED; enabling asks for confirmation; every change is audited by a database trigger. Coupons are never
// deleted here (switch them off instead), so order history keeps its coupon records.
let couponEditId = null;
async function adminCoupons() {
  const [{ data: coupons, error }, { data: cats }, { data: reds }] = await Promise.all([
    supabase.from('coupons').select('*').order('created_at', { ascending: false }),
    supabase.from('categories').select('id,name').order('name'),
    supabase.from('coupon_redemptions').select('coupon_id,order_id,discount_paise'),
  ]);
  if (error) throw error;
  const orderIds = [...new Set((reds || []).map(x => x.order_id).filter(Boolean))];
  const { data: live } = orderIds.length ? await supabase.from('orders').select('id,status').in('id', orderIds) : { data: [] };
  const liveIds = new Set((live || []).filter(o => !['cancelled', 'refunded'].includes(o.status)).map(o => o.id));
  const uses = (id) => (reds || []).filter(x => x.coupon_id === id && liveIds.has(x.order_id)).length;
  const catOpts = (cats || []).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  const rule = (c) => [c.discount_type === 'percentage' ? `${c.discount_value}% off${c.max_discount_paise ? ' up to ' + fmt(rupees(c.max_discount_paise)) : ''}` : `${fmt(rupees(c.discount_value))} off`,
    c.min_order_paise ? 'min order ' + fmt(rupees(c.min_order_paise)) : 'no minimum', c.usage_limit ? `${c.usage_limit} uses in total` : 'no total limit',
    c.per_user_limit ? `${c.per_user_limit} per customer` : 'no per-customer limit', c.first_order_only ? 'first order only' : '', c.allow_with_offers ? 'can combine with offers' : 'not with ₹1 offers',
    c.eligible_category_ids?.length ? 'only: ' + c.eligible_category_ids.map(id => (cats || []).find(x => x.id === id)?.name || 'category').join(', ') : '',
    c.starts_at ? 'from ' + istTime(c.starts_at) : '', c.expires_at ? 'until ' + istTime(c.expires_at) : ''].filter(Boolean).join(' · ');
  $('adminBody').innerHTML = `<h2>Coupons</h2><div class="admin-card"><h3 id="cpFormTitle">Create a coupon</h3><p class="inline-note">Coupons are checked and applied by the server at checkout: one coupon per order, never more than the items' value, delivery is not discounted. New coupons are saved disabled.</p>
<form class="admin-form" onsubmit="saveCoupon(event)">
<div class="form-field"><label for="cpCode">Code</label><input id="cpCode" required maxlength="30" pattern="[A-Za-z0-9-]{3,30}" placeholder="e.g. FRESH50" autocapitalize="characters"></div>
<div class="form-field"><label for="cpDesc">Description (shown to customers)</label><input id="cpDesc" maxlength="120"></div>
<div class="form-field"><label for="cpType">Discount type</label><select id="cpType"><option value="flat">Fixed amount (₹)</option><option value="percentage">Percentage (%)</option></select></div>
<div class="form-field"><label for="cpValue">Discount (₹ for fixed, % for percentage)</label><input id="cpValue" inputmode="decimal" required></div>
<div class="form-field"><label for="cpMax">Maximum discount for percentage (₹, optional)</label><input id="cpMax" inputmode="decimal"></div>
<div class="form-field"><label for="cpMin">Minimum order (₹)</label><input id="cpMin" inputmode="decimal" value="0"></div>
<div class="form-field"><label for="cpTotal">Total uses allowed (optional)</label><input id="cpTotal" type="number" min="1" step="1"></div>
<div class="form-field"><label for="cpPerUser">Uses per customer (optional)</label><input id="cpPerUser" type="number" min="1" step="1"></div>
<div class="form-field"><label for="cpStart">Starts (optional)</label><input id="cpStart" type="datetime-local"></div>
<div class="form-field"><label for="cpEnd">Expires (optional)</label><input id="cpEnd" type="datetime-local"></div>
<div class="form-field"><label for="cpCats">Only for these categories (optional; none = all items)</label><select id="cpCats" multiple size="4">${catOpts}</select></div>
<div class="pay-option"><input type="checkbox" id="cpFirst"><label for="cpFirst">First order only</label></div>
<div class="pay-option"><input type="checkbox" id="cpOffers"><label for="cpOffers">Can be combined with ₹1 offers</label></div>
<div><button class="primary-btn" id="cpSaveBtn">Save as disabled</button> <button class="ghost-btn" type="button" onclick="resetCouponForm()">Clear</button></div></form></div>
<div class="admin-card"><h3>All coupons</h3>${(coupons || []).map(c => `<div class="cart-line"><div class="info"><div class="n">${esc(c.code)} · ${c.is_active ? 'Enabled' : 'Disabled'}</div><div class="p">${esc(rule(c))}</div>${c.description ? `<div class="p">${esc(c.description)}</div>` : ''}<div class="p">Used on ${uses(c.id)} active order${uses(c.id) === 1 ? '' : 's'}</div></div><div class="admin-actions"><button class="small-btn" type="button" onclick="editCoupon('${esc(c.id)}')">Edit</button><button class="small-btn ${c.is_active ? 'danger' : ''}" type="button" onclick="toggleCoupon('${esc(c.id)}',${!c.is_active})">${c.is_active ? 'Disable' : 'Enable'}</button></div></div>`).join('') || '<div class="empty">No coupons yet.</div>'}</div>`;
  window.__coupons = coupons || [];
}
function couponRowFromForm() {
  const type = $('cpType').value, raw = $('cpValue').value.trim();
  const value = type === 'percentage' ? Number(raw) : paiseOrNull(raw);
  if (!value || value <= 0 || (type === 'percentage' && (!Number.isInteger(value) || value > 100))) return { error: type === 'percentage' ? 'Enter a whole percentage from 1 to 100.' : 'Enter the discount in rupees, e.g. 50.' };
  const code = $('cpCode').value.trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,30}$/.test(code)) return { error: 'Use 3–30 letters, numbers or hyphens for the code.' };
  const cats = [...$('cpCats').selectedOptions].map(o => o.value);
  return { row: { code, description: $('cpDesc').value.trim() || null, discount_type: type, discount_value: value,
    max_discount_paise: type === 'percentage' ? paiseOrNull($('cpMax').value) : null, min_order_paise: paiseOrNull($('cpMin').value) ?? 0,
    usage_limit: $('cpTotal').value ? Number($('cpTotal').value) : null, per_user_limit: $('cpPerUser').value ? Number($('cpPerUser').value) : null,
    starts_at: toIso($('cpStart').value), expires_at: toIso($('cpEnd').value), eligible_category_ids: cats.length ? cats : null,
    first_order_only: $('cpFirst').checked, allow_with_offers: $('cpOffers').checked, updated_at: new Date().toISOString() } };
}
async function saveCoupon(e) {
  e.preventDefault();
  const { row, error: formError } = couponRowFromForm();
  if (formError) { notify(formError); return; }
  const res = couponEditId ? await supabase.from('coupons').update(row).eq('id', couponEditId) : await supabase.from('coupons').insert({ ...row, is_active: false });
  if (res.error) { notify(/duplicate key/.test(res.error.message) ? 'That code is already used by another coupon.' : res.error.message); return; }
  notify(couponEditId ? 'Coupon updated.' : 'Coupon saved as disabled. Enable it when it is ready.');
  couponEditId = null;
  await loadAdminTab('coupons');
}
function editCoupon(id) {
  const c = (window.__coupons || []).find(x => x.id === id); if (!c) return;
  couponEditId = id;
  $('cpCode').value = c.code; $('cpDesc').value = c.description || ''; $('cpType').value = c.discount_type;
  $('cpValue').value = c.discount_type === 'percentage' ? c.discount_value : (c.discount_value / 100).toFixed(2);
  $('cpMax').value = c.max_discount_paise ? (c.max_discount_paise / 100).toFixed(2) : ''; $('cpMin').value = ((c.min_order_paise || 0) / 100).toFixed(2);
  $('cpTotal').value = c.usage_limit || ''; $('cpPerUser').value = c.per_user_limit || '';
  const local = (ts) => { if (!ts) return ''; const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }; // same local-time convention as toIso
  $('cpStart').value = local(c.starts_at); $('cpEnd').value = local(c.expires_at);
  [...$('cpCats').options].forEach(o => { o.selected = (c.eligible_category_ids || []).includes(o.value); });
  $('cpFirst').checked = !!c.first_order_only; $('cpOffers').checked = !!c.allow_with_offers;
  $('cpFormTitle').textContent = 'Edit coupon ' + c.code; $('cpSaveBtn').textContent = 'Save changes';
  $('cpCode').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function resetCouponForm() { couponEditId = null; loadAdminTab('coupons'); }
async function toggleCoupon(id, enable) {
  if (!confirm(enable ? 'Enable this coupon for customers now?' : 'Disable this coupon? Customers will no longer be able to use it.')) return;
  const { error } = await supabase.from('coupons').update({ is_active: enable, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) { adminError(error); return; }
  await loadAdminTab('coupons');
}
