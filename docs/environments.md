# Environments

| Environment | Supabase project | Selected when | Banner |
|---|---|---|---|
| Production | `qebdpjzhbqzjbvjqeztl` | Vercel production build (`VERCEL_ENV=production`) **and** page opened on an allowed production host | none |
| QA | `tcdpbutitfrtunarhxhz` | Vercel preview and development builds, local builds, any unknown environment | red "QA / TEST ENVIRONMENT" |

## How it works

1. `npm run build` / `npm run dev` first run `scripts/write-env-config.mjs`, which writes `public/env-config.js`
   (`window.TAAJA_ENV`, generated, git-ignored).
2. The script reads `VERCEL_ENV`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`:
   - production: both variables required and must point at `qebdpjzhbqzjbvjqeztl`, otherwise the build fails;
   - everything else: QA only; if the variables point at production (or any project other than QA) the
     build fails; if they are missing, the built-in QA URL and publishable key are used.
   - secret (`sb_secret_…`) and service-role keys always fail the build.
3. `index.html` and `public/staff.html` load `/env-config.js` before their own code and refuse to start
   (no Supabase client is created) when the config is missing, or when a production config is opened on a
   host that is not one of: `taajamandi.vercel.app`, `taajamandi-toxic-6dab.vercel.app`,
   `taajamandi-git-main-toxic-6dab.vercel.app`, `tajjamandi.in`, `www.tajjamandi.in`.
4. QA pages show product photos from production's public image URLs (read-only GET of public files; no
   database or storage writes). All database, auth, function and storage-upload calls go to QA.

## Vercel variables (owner-approved layout)

| Variable | production target | preview + development targets |
|---|---|---|
| `VITE_SUPABASE_URL` | production URL (unchanged) | QA URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | production publishable key (unchanged) | QA publishable key |

The Supabase–Vercel integration variables (`POSTGRES_*`, `SUPABASE_*`, `NEXT_PUBLIC_SUPABASE_*`) are
production-only, unused by the code, and left untouched.

## Tests

- `node --test scripts/write-env-config.test.mjs` — which project each build kind selects; production refused for
  preview/development/local/unknown; secret keys refused.
- `node --test storefront-tests/run-tests.mjs` — QA banner, image base, and the page refusing to start without a
  valid config.
