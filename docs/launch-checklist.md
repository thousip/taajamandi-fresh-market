# Launch checklist (deliveries start 1 Dec 2026)

Owner = a decision or action only the store owner can take. Nothing here has been done in production.

## Owner decisions

- [x] **Production rollout** of Phase 1 + overnight work: done 20 Nov 2026 (`supabase/production/README.md`).
- [ ] **Owner checks on production**: confirm a database backup exists in the Supabase dashboard; sign in as admin and
      open the new tabs; place one Cash on Delivery order.
- [ ] **Delivery fees**: every delivery zone currently charges ₹0, so membership "free deliveries" save customers
      nothing until a fee is set. Decide the fee per zone. The admin panel can add zones with a fee but cannot edit an existing zone's fee, so changing it needs an approved database update (or a new zone).
- [ ] **"Priority booking when stock is limited"** (membership): there are no stock caps or booking queues today, so
      this has no behaviour yet. It is deliberately **not** shown on the membership card until it is defined and built.
      Examples: members can book a delivery slot that is full for others, or get first claim on limited deal stock.
- [ ] **Membership "no minimum order"**: implemented as "a free delivery applies to any order size". Zone minimum order
      values (currently ₹0 everywhere) still apply to everyone. Confirm whether members should also skip zone minimums.
- [ ] **Supabase–Vercel integration**: it is linked to the production project. It was left untouched as instructed;
      decide whether to keep or remove it.

## Payments (Razorpay) — test mode first, in QA

- [ ] Create a Razorpay account and generate test keys; create the weekly ₹59 and monthly ₹159 plans.
- [ ] Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` as **QA** Edge Function secrets.
- [ ] Add the webhook (events listed in `docs/deployment.md`).
- [ ] In QA Admin → Memberships, set the plan ids and enable the plans. Pay with a Razorpay test card. Confirm the
      membership becomes active only after the webhook arrives and that free deliveries count down.
- [ ] Production: only after the QA test passes and with owner approval, set live keys and
      `TAAJA_ALLOW_LIVE_PAYMENTS=true`.

## Accounts, auth and email

- [ ] QA Auth: Site URL and redirect URLs for the preview domain. Then run a password-reset email test.
- [ ] Production Auth: turn on leaked-password protection (Supabase → Auth → Passwords). This is a security setting
      and needs owner approval.
- [ ] Create the real delivery-staff account(s) through Admin → Staff and run one live delivery test.

## Store content

- [ ] Banners: upload 1–3 images (1200 × 400) in Admin → Banners. They are saved disabled; enable them after checking.
- [ ] ₹1 deals and free gifts: create them in Admin → Offers and Admin → Free gifts. Each one is saved disabled, with limits per order and per
      customer. Enable deliberately.
- [ ] Suppliers: add suppliers and their products; use purchase orders to receive stock.
- [ ] WhatsApp support number: the default is +91 76719 13761; change it in Admin → Settings.

## Domain and app

- [ ] Custom domain DNS (`tajjamandi.in`) pointing at Vercel. The host is already on the allowed list.
- [ ] Replace the placeholder icons in `public/icons/` with designed brand artwork (192, 512, maskable 512,
      apple-touch 180).
- [ ] PWA/TWA: see below.

## Before opening on 1 Dec

- [ ] Place one real Cash on Delivery order in production and take it through confirm → pack → deliver.
- [ ] Confirm the Vercel rollback target (previous production deployment) is noted.

## PWA and Android (Trusted Web Activity) readiness

Done (on the branch, tested):
- Served over HTTPS (Vercel).
- Responsive layout checked at 375 px.
- `manifest.webmanifest` has name, short name, standalone display, theme `#1B6B3C`, 192/512/maskable icons, start URL
  and scope `/`.
- A minimal service worker (`sw.js`) handles page navigations only: it tries the network first and shows
  `offline.html` when there is no connection. It never caches prices, availability, baskets, orders or any Supabase
  response, so customers cannot see stale data.

Remaining:
- [ ] Brand icons (above). Optionally add screenshots to the manifest for a richer install prompt.
- [ ] Run Lighthouse's PWA/installability check on the production domain after release.
- [ ] Deep links: product links are not URL-addressable yet (product details open in an overlay). Add `?product=<id>`
      handling if links from WhatsApp or ads should open a product.
- [ ] TWA packaging (Bubblewrap or PWABuilder) using the production domain. Needs the Android package name (for
      example `in.tajjamandi.app`) and the Play signing key's SHA-256 fingerprint.
- [ ] Publish `/.well-known/assetlinks.json` with that package name and fingerprint, so the app opens without the
      browser bar.
- [ ] Play Console listing: privacy policy URL, content rating, data-safety form.
