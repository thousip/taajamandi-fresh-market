# Edge Functions

Sources here are the deployed code. Hashes are SHA-256 of the committed file (LF line endings; a Windows checkout
may show CRLF locally). Supabase bundle hashes (`ezbr_sha256`) cannot be recomputed locally, so deployments are
verified by reading the deployed source back and by comparing bundle hashes between QA and production.

## Production `qebdpjzhbqzjbvjqeztl` (as of 20 Nov 2026, owner-approved rollout)

| Function | Version | verify_jwt | Source SHA-256 (first 12) | Changed on 20 Nov |
|---|---|---|---|---|
| create-order | v6 | true | 7c1230b3f9d0 | yes: calls `create_order_from_cart_v2` (refuses a total the customer did not see) |
| admin-ops | v3 | true | 55c488618fdb | yes: audited admin-only staff roles, `variant_availability`, `receive_purchase_order` |
| catalogue-availability | v3 | false | 590ae90d1754 | yes: `in_stock` follows `product_variants.is_available` |
| membership-ops | v1 | true | 238e552b3e10 | new: Razorpay subscriptions; replies "not configured" until secrets exist |
| razorpay-webhook | v1 | **false** | 14df4c629665 (+ `razorpay.ts` 289b29cab598) | new: HMAC over raw body, idempotent per event id; 503 until `RAZORPAY_WEBHOOK_SECRET` exists |
| staff-admin | v2 | true | a10e2206b3db | yes: retired, HTTP 410 for every request |
| delivery-update | v4 | true | 3667c690af48 | no |
| packer-ops | v2 | true | 7de3762cea38 | no |
| my-deliveries | v2 | true | 1829d49c41bf | no |
| get-my-role | v1 | true | f23549d0b35f | no |

`create-order`, `admin-ops`, `membership-ops`, `razorpay-webhook` and `catalogue-availability` have the same bundle
hash on QA and production. `staff-admin` has identical source on both (read back); its bundle hash differs only
because the bundle embeds project-specific paths.

Previous production sources (for rollback) are in git at `c4dcf4f`:
`git show c4dcf4f:supabase/functions/<name>/index.ts`.

## QA `tcdpbutitfrtunarhxhz`

Same sources as production. Version numbers differ: QA has `create-order` v2, `admin-ops` v4,
`catalogue-availability` v2 and `staff-admin` v2.

## Rules

- Every function verifies the signed-in user itself (the gateway lets requests with only the publishable key through),
  except `catalogue-availability` (public, returns only size id / in-stock / fulfilment) and `razorpay-webhook`
  (authenticated only by the Razorpay HMAC signature).
- Secrets (`RAZORPAY_*`, `TAAJA_ALLOW_LIVE_PAYMENTS`) live only in Supabase function secrets; see `docs/deployment.md`.
- Deploy order: database migrations first, then functions, then the website.
