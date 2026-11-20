# TaajaMandi Fresh Market

Fresh vegetables and fruits for Hyderabad, delivered within 7.4 km of the store. Live at
https://taajamandi.vercel.app (Vercel project `taajamandi`, production branch `main`).

## What is live and where the code is

| Part | Where | Notes |
| --- | --- | --- |
| Customer storefront + admin panel | `index.html` (markup and styles) and `public/js/` | Plain scripts loaded in order: `rules.js` (pure, tested business rules), `store.js` (environment guard, Supabase client, catalogue, basket, auth, checkout, orders), `admin.js` (admin panel), `extras.js` (banners, offers, free gifts, membership, support, favourites, reorder), `admin-extra.js` (admin banners, offers, gifts, memberships, suppliers, support, reports), `app.js` (start-up). PWA: `public/manifest.webmanifest`, `public/sw.js`, `public/offline.html`. |
| Packing and delivery staff app | `public/staff.html` | Email + password sign-in; packer queue and delivery tasks. |
| Backend | Supabase: Postgres + RLS, Auth, Edge Functions in `supabase/functions/` | `create-order` (COD, server-priced), `catalogue-availability`, `get-my-role`, `admin-ops`, `packer-ops`, `my-deliveries`, `delivery-update`, `membership-ops` and `razorpay-webhook` (memberships, Razorpay test mode); `staff-admin` is retired (HTTP 410). |
| Database changes | `supabase/migrations/` | Rollback scripts, where needed, in `supabase/rollback/`. |
| React app in `src/` | Not used by production | Vercel serves the root `index.html` for every page. |

Environments: production Supabase `qebdpjzhbqzjbvjqeztl`; QA Supabase `tcdpbutitfrtunarhxhz` (schema mirror, no customer
data). `scripts/write-env-config.mjs` picks the project at build time: only production builds use production; previews,
local and unknown builds use QA and show a red QA banner. See `docs/environments.md`.

Business rules: delivery boundary 7.4 km around 17.5299559, 78.3055903; Cash on Delivery only; before 1 Dec 2026 only
advance delivery on 1 Dec or later, from 1 Dec same-day (today) or advance (future); each size can be marked
unavailable by the store, and checkout re-checks it; staff roles are granted and removed only by admins, through
audited database functions. Offers (₹1 deals, free gifts) and memberships (weekly ₹59 = 5 free deliveries, monthly
₹159 = 20) are priced only on the server and start switched off; a membership becomes active only through a verified
Razorpay webhook.

Tests (all offline, no network or production access):
`npm run test:env`, `node --test storefront-tests/run-tests.mjs`, `node --test staff-tests/run-tests.mjs`,
`node --test storefront-tests/pwa.test.mjs`, `node --test supabase/tests/razorpay.test.mjs`,
`npx vitest run`, and the PGlite backend suite `supabase/tests/backend.test.mjs` (needs a schema export; see its header).

Change process: feature branch → Vercel preview (QA) → owner approval → `main`. Production migrations and Edge Function
deployments always need separate owner approval. Rollout order, rollback and secrets: `docs/deployment.md`; open
launch items: `docs/launch-checklist.md`; latest test evidence: `docs/qa-test-report.md`.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/26049c56-a559-40fe-b560-bad4cd992575).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
