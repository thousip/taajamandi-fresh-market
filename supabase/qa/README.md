# QA rebuild (snapshot 2026-11-19)

QA project: `tcdpbutitfrtunarhxhz` (`taajamandi-qa`). Production: `qebdpjzhbqzjbvjqeztl` — never a target of these files.

The snapshot was generated on 2026-11-19 by read-only catalog queries against production's **structure**
(`pg_get_functiondef`, `pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_triggerdef`, `pg_policies`,
privilege functions). Files 01–09 contain no data. File 10 contains only non-personal catalogue rows.

## Apply order (QA only, each step needs owner approval)

| Step | Migration name on QA | Content | Transaction |
|---|---|---|---|
| 1 | `qa_00_preflight_and_reset` | `00_preflight_and_reset.sql` | one transaction; aborts on any data or unexpected object |
| 2 | `qa_rebuild_schema_20261119` | `set local search_path = public, extensions;` + files `01`…`09` concatenated in order | one transaction, so functions never exist without their final privileges |
| 3 | `qa_seed_catalogue_20261119` | `10_seed_catalogue.sql` | one transaction |

After step 3, run `../verify-fingerprint.sql` on production and QA: all 10 fingerprints must match.

## What the files contain

| File | Objects |
|---|---|
| 01_tables | 28 tables (columns, defaults, not-null) |
| 02_constraints | 99 primary key / unique / check constraints (incl. `cart_items_quantity_max NOT VALID`) |
| 03_foreign_keys | 42 foreign keys (incl. references to `auth.users`) |
| 04_indexes | 17 non-constraint indexes |
| 05_functions | `private` schema + 20 functions (3 private, 17 public), verbatim |
| 06_triggers | 20 triggers (19 on public tables + `on_auth_user_created_taajamandi` on `auth.users`) |
| 07_rls_policies | RLS enabled on all 28 tables + 51 policies |
| 08_grants | exact table privileges per role, `private` schema usage, exact function EXECUTE privileges |
| 09_storage | `product-images` bucket settings (5 MB, jpeg/png/webp, public read) + 4 storage policies; no files |
| 10_seed_catalogue | categories 5, products 135, product_variants 281, product_images 134 (paths only), delivery_zones 15, delivery_slots 16, store_settings 1 (public) |

Excluded on purpose: all customer, auth, cart, order, payment, address, bargain, staff and audit data;
inventory and supplier rows; the duplicate `Product images` bucket; storage files (QA pages read product
photos from production's public image URLs, read-only).

Known difference that cannot be copied by SQL: production has the Supabase platform event trigger
`ensure_rls` (automatic RLS on new tables). It is a project setting, not a migration; enable it in the QA
dashboard if wanted. The function `rls_auto_enable()` itself is included.

Manual edit after generation: `09_storage.sql` — the generator printed the boolean `public` as `t`; it was
changed to `true` (noted in the file header).

## Rollback / redo

- QA holds no production data, so the fallback is always "rebuild again".
- The preflight deliberately refuses a non-empty QA. To redo after seeding or testing, a separate QA cleanup
  script (to be shown for approval first) must remove seeded/test rows before `00` can run again.
- Production is never touched by any file here.
