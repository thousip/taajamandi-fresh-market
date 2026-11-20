# CLAUDE.md

Read `AGENTS.md` first: its rules apply to every agent working here. Also read `README.md` (what is live and where),
`docs/environments.md` (production vs QA), `docs/deployment.md` (rollout order, rollback, secrets) and
`docs/launch-checklist.md` (open owner decisions).

Working rules:
- Production is the root `index.html` + `public/js/` (load order: rules → store → admin → extras → admin-extra → app,
  plain scripts sharing one global scope) and `public/staff.html`. `src/` (React) is not served.
- Work on a feature branch against QA (`tcdpbutitfrtunarhxhz`). Production Supabase (`qebdpjzhbqzjbvjqeztl`)
  migrations, Edge Function deploys, auth/security settings and merges to `main` need explicit owner approval each
  time. Never force-push or rewrite pushed history (Lovable syncs `main`).
- Deploy order is always: database → Edge Functions → website.
- Never put service-role keys, database passwords, JWT secrets or Razorpay secrets in frontend code, `VITE_`
  variables, Vercel variables or git. Never copy production customer data into QA. Never weaken RLS.
- Prices, promotions and membership benefits are decided only on the server (`create_order_from_cart` core, called via
  the 8-argument wrapper or `create_order_from_cart_v2`); the browser only previews them. Never drop the 6-argument
  core.
- Memberships activate only through the signature-verified `razorpay-webhook`. Use Razorpay test mode outside an
  owner-approved production set-up.
- Before claiming a test passed, run it. The full offline suite:
  `node --test supabase/tests/razorpay.test.mjs storefront-tests/run-tests.mjs storefront-tests/pwa.test.mjs
  scripts/write-env-config.test.mjs staff-tests/run-tests.mjs`, `npx vitest run`, `npm run build`, and the PGlite
  backend suite `supabase/tests/backend.test.mjs` (see its header for the schema export it needs).
