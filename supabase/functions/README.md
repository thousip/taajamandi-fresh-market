# Edge Functions (recovered from production 2026-11-19)

Each `index.ts` was fetched read-only from production `qebdpjzhbqzjbvjqeztl` and saved unchanged.
The saved file was re-read and compared byte-for-byte with the deployed content (all identical).
Vercel/Supabase bundle hashes (`ezbr_sha256`) cannot be recomputed locally, so verification is by content.

| Function | Deployed version | verify_jwt | Source SHA-256 (first 12) |
|---|---|---|---|
| create-order | v5 | true | fa132a0b7763 |
| delivery-update | v4 | true | 3667c690af48 |
| admin-ops | v2 | true | b32251db2d39 |
| packer-ops | v2 | true | 7de3762cea38 |
| my-deliveries | v2 | true | 1829d49c41bf |
| get-my-role | v1 | true | f23549d0b35f |
| staff-admin | v1 | true | be0a95cb3d3c |
| catalogue-availability | v2 | false | 4dd293d0edb4 |

`create-order` and `delivery-update` previously had repo copies whose first comment line said
"deployed 2026-11-18"; they now match the deployed bytes exactly (comment-only difference, no code change).

Known follow-ups (not changed in Phase 0): `staff-admin` grants the packer role to any existing account
by email; no admin page calls it yet. `catalogue-availability` returns every active variant as in stock.
