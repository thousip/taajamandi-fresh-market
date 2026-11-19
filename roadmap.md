# TaajaMandi roadmap

This file previously tracked an early Lovable build of the React app (`src/`), which production does not use. Those items
are obsolete: the live storefront is the root `index.html` + `public/js/`, with the staff app at `public/staff.html`.

Current status (19 Nov 2026):

- [x] Launch backend: booking rules, order lifecycle, slot capacity, bargains, staff apps (migrations of 18 Nov).
- [x] Phase 0: environment isolation (production vs QA), QA rebuild, Edge Function sources in the repo,
      password recovery form, storefront code split into `public/js/` — live on production (`c4dcf4f`).
- [ ] Phase 1 (branch `phase1/ops-reliability`, QA only until approved): audited admin-only staff roles,
      per-size availability with history and checkout re-check, authorization and workflow regression,
      Supabase–Vercel integration remediation.
- [ ] Launch items before 1 Dec 2026: QA Auth redirect URLs and password-reset email test, leaked-password
      protection, delivery-staff live test, a live production order, custom domain DNS.
- [ ] Later (not started, needs approval): installable PWA, then an Android app via Trusted Web Activity, both using
      the same website and Supabase backend.
