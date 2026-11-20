# TaajaMandi roadmap

This file previously tracked an early Lovable build of the React app (`src/`), which production does not use. Those items
are obsolete: the live storefront is the root `index.html` + `public/js/`, with the staff app at `public/staff.html`.

Current status (20 Nov 2026):

- [x] Launch backend: booking rules, order lifecycle, slot capacity, bargains, staff apps (migrations of 18 Nov).
- [x] Phase 0: environment isolation (production vs QA), QA rebuild, Edge Function sources in the repo,
      password recovery form, storefront code split into `public/js/` — live on production (`c4dcf4f`).
- [x] Phase 1 (QA only): audited admin-only staff roles, per-size availability with history and checkout re-check,
      authorization and workflow regression tests.
- [x] Overnight build (QA only, branch `overnight/launch-build`): banners, ₹1 deals, free gifts, server-side price
      check, memberships with Razorpay (test mode) and a free-delivery ledger, support tickets and WhatsApp help,
      favourites/recently viewed/reorder, suppliers and purchase receiving, reports, PWA foundations.
      Report: `docs/overnight-implementation-report.md`.
- [x] Production rollout of Phase 1 + overnight work: live 20 Nov 2026 (`main` 770354d; see `supabase/production/README.md`).
      Everything new is switched off until configured.
- [ ] Launch items before 1 Dec 2026: see `docs/launch-checklist.md` (delivery fees, Razorpay set-up, Auth URLs and
      reset-email test, leaked-password protection, delivery-staff live test, a live production order, DNS).
- [ ] Later (needs approval): membership priority booking (to be defined), bulk-order process, product deep links,
      Android app via Trusted Web Activity (package name, signing key, `assetlinks.json`).
