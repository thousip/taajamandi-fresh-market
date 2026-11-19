<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Production serves the root `index.html` with `public/js/{rules,store,admin,app}.js` (plain scripts, loaded in that order) and the staff app `public/staff.html`. The React app in `src/` is not used in production; do not port or replace the storefront without owner approval.
- Pure business rules (delivery boundary, booking dates, weights, bargains) live in `public/js/rules.js` and are unit-tested; reuse them instead of duplicating logic.
- The Supabase project is chosen at build time by `scripts/write-env-config.mjs`: production builds use production `qebdpjzhbqzjbvjqeztl` only; everything else uses QA `tcdpbutitfrtunarhxhz`. Only publishable keys may reach the browser; never add service-role or secret keys to frontend code or `VITE_` variables.
- Develop on a feature branch against QA. Never apply migrations, deploy Edge Functions or merge to `main` for production without explicit owner approval, and never copy production customer data into QA.
- Staff roles change only through `admin_grant_staff_role` / `admin_revoke_staff_role` via `admin-ops` (admins only, packer/delivery roles only, audited). `staff-admin` is retired.
- Size availability is `product_variants.is_available`; history is written by a trigger; checkout re-checks it. `create_order_from_cart` has a 6-argument core and an 8-argument wrapper: never drop the 6-argument function.
- Every Edge Function must verify the signed-in user itself: the gateway lets requests that carry only the publishable key through.
- Order status changes go only through `admin_update_order_status`, `packer_update_order_status` and `delivery_update_assignment` (packer writes via `packer-ops`); they enforce the lifecycle and write `audit_logs`.
