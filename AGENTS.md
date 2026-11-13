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

- Keep commerce disconnected and fail-closed until the existing project's schema, function contracts and auth are accessible; guessing writes can corrupt the seeded store.
- Centralize pure delivery-date, paise, PIN and stock rules in a browser-safe tested module so commerce surfaces share the same safeguards.
- Share storefront chrome through StoreShell and give each content route its own metadata so navigation and previews stay consistent.
- Keep external-project public configuration in one browser-safe module, reject another project URL, and strip opaque publishable-key bearer headers while preserving signed-in user JWTs; public keys cannot inspect management-only schema policies or function source.
- Keep packer staff UI isolated at /packer with role-verified, identity-scoped queries and status writes only through packer-ops; lock concurrent operations and require queue refresh after uncertain updates to avoid stale retries without claiming backend idempotency.
