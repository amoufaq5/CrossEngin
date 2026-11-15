# 01 — Commands run and results

Everything was run on 2026-11-15 on the audit checkout (commit `7bc8db9`), Node v22.23.4, pnpm 9.12.0, PostgreSQL 16.15. No source file was modified; `git status` shows only `audit/` as untracked. No production service or third-party API was contacted. The one network use was the npm registry (dependency install, advisory database).

## Static / build

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | OK (3.3 s; warnings only about bins that exist after build) |
| `pnpm -r --no-bail build` | exit 0, 83 s |
| `pnpm -r --no-bail typecheck` | exit 0, 81 s, 0 TypeScript errors |
| `pnpm -r --no-bail test` | exit 0, 97 s — 753 test files, **18,929 tests passed**, 0 failed, 0 skipped |
| `pnpm -r --no-bail lint` | **exit 1** — only `apps/operate-web` has a lint script; `next lint` stops at an interactive "How would you like to configure ESLint?" prompt. No package is linted. |
| `pnpm audit --json` | 73 advisories over 412 packages: **6 critical, 32 high, 31 moderate, 4 low** — full list in `dependency_audit.txt` |
| `pnpm licenses list` | MIT 210, Apache-2.0 18, ISC 14, BSD-2 6, BSD-3 2, 0BSD 1, BlueOak 1, Python-2.0 1, CC-BY-4.0 1 (caniuse-lite data). No GPL/AGPL/LGPL. |
| Coverage: `vitest run --coverage` per package (v8 provider supplied from outside the repo, because `@vitest/coverage-v8` is not a dependency) | **94.2 % lines, 88.6 % branches, 92.9 % functions** overall; `apps/operate-server/src/node.ts` 17.3 % — per package in `coverage_by_package.txt` |
| AST scan for function length / cyclomatic complexity (TypeScript compiler API, 1,072 non-test files, 9,115 functions) | 122 functions > 100 lines, 12 > 300 lines, 20 with complexity > 50 — `complexity_hotspots.txt` |
| Secret scan of the 50 visible commits (`git log -p` + pattern grep) | Two credential-shaped values, both in `deploy/.env.example` at HEAD (commit `7bc8db9`). History before the shallow boundary NOT scanned. |
| `gitleaks` / `trufflehog` / `osv-scanner` / `semgrep` | Not installed in the environment; not run. |

Production-relevant advisories are all in `next@14.2.35` (two critical: unauthenticated RCE in the Image Optimization API with AVIF, and an RCE on Windows-hosted servers; several high: SSRF and DoS in Server Actions/rewrites, middleware bypass in Pages Router i18n) and its bundled `postcss@8.4.31`. The remaining critical/high items are in dev tooling (vitest, tinypool, vite, eslint transitive deps, turbo) and do not ship in the API path — but the Docker image installs dev dependencies (see finding H-OPS-04).

## Live verification

A throwaway PostgreSQL 16 cluster was initialised locally, configured the way `deploy/docker-compose.yml` configures it (application role = superuser; `uuid_generate_v7()` from `deploy/supabase/00-uuidv7.sql`; `pgcrypto`). The schema was applied with `crossengin apply --confirm` (964 statements, 0 failed) and the real server was started with the exact flag set from the compose file:

```
operate-server --pack erp-core --store pg --port 8787 --scheme https --platform-admin \
  --idempotency-store pg --credential-login --jwt-issuer https://localhost/ --jwt-audience crossengin-operate
```

Two tenants (A, B) and five API keys were configured. Requests were made with `curl`. Results:

| # | Test | Observed | Verdict |
|---|---|---|---|
| L1 | Catalog: tables with RLS / with FORCE RLS; app role attributes | 115 with RLS, **0 with FORCE**; role `rolsuper = t` | RLS is bypassed by the shipped role |
| L2 | Tenant B lists / GETs / PATCHes / DELETEs tenant A's vendor | empty list, 404, 404, 404 | Isolation holds at the API |
| L3 | API-key request with a foreign `x-tenant-id` header | 401 `tenant_mismatch` | Good |
| L4 | Unauthenticated request | 401 | Good |
| L5 | Create two vendors with the same `vendor_code` (declared `unique`) | both 201 | Unique not enforced on `--store pg` |
| L6 | POST vendor with `id`, `created_at`, `tenant_id`, unknown field `bogus` | 201, all stored; later PATCH rewrote `created_at` to 1999 | Mass assignment of server-owned fields |
| L7 | POST with an id that already exists | 500 `write_failed` (not 409) | |
| L8 | After ~40 writes incl. posting and reversing journal entries: `select count(*) from meta.audit_log` / `forensic_chain_entries` | **0 / 0** | No audit trail in the shipped configuration |
| L9 | Post an unbalanced journal entry (100 Dr / 0 Cr), by transition and by PATCH `state` | 422 both | Good |
| L10 | Edit / delete a posted entry or its lines | 422 | Good |
| L11 | Post entry with debit 100 / credit 100 but functional_debit 100 / functional_credit 7 | 200 posted | Functional-currency balance not checked |
| L12 | Create an entry directly as `posted`, no lines, client-chosen `entry_number` | 201 | Born-posted empty entry; numbering bypass |
| L13 | **Move the credit line of a posted, balanced entry to another entry (PATCH `journal_entry_id`)** | 200; posted entry now 500 Dr / 0 Cr | **Posted ledger can be unbalanced** |
| L14 | Edit a `reversed` entry (date, memo) | 200 | Reversed entries are mutable |
| L15 | **PATCH a bill `draft→approved→draft→approved→draft→approved`** | all 200; **three posted journal entries**, same number `BILL-2026-00002-GL` | **Double/triple posting** |
| L16 | Same loop on an invoice | first 200, rest 422 | Invoices are guarded |
| L17 | `ap_clerk` creates a bill already in state `paid`, total 999,999 | 201 | Transition grants bypassed by writing `state` |
| L18 | Delete a ledger account referenced by posted lines; create a line referencing a non-existent account | 204; 201 | No referential integrity on `--store pg` |
| L19 | 20 parallel creates → sequence numbers | 20 distinct numbers | Unique under concurrency |
| L20 | Failed create (422) then successful create | number skipped (…22 → …24) | Sequences are not gapless |
| L21 | `GET /v1/vendors?q=acme` | **500**; Postgres log: `function unaccent(text) does not exist` | Search broken on the default store |
| L22 | 300 rapid authenticated requests | 300 × 200 | No rate limiting in the shipped configuration |
| L23 | Idempotency-Key replay; same key different body | 201 with **empty body** + `x-idempotent-replay`; 409 | Replay loses the response body |
| L24 | 11 MB request body | 413 | Good |
| L25 | Login: 40 parallel wrong passwords (threshold 10) | all evaluated; `credential_failed_attempts = 40` | Lockout does not bound concurrent guessing |
| L26 | After lock expiry, one wrong password | re-locked immediately (counter 41); correct password refused while locked | Trivial persistent account lockout (DoS) |
| L27 | Use a session token after the user is suspended and membership revoked | 200 | No revocation within token lifetime (1 h default) |
| L28 | Token signed with the deployment key but with no `exp`/`iss`/`aud` | accepted | Claims are optional in the verifier |
| L29 | Token with no `tenant_id` claim + `x-tenant-id: <tenant B>` | record created in tenant B | Tenant taken from a client header when the claim is absent |
| L30 | Viewer role, `?sort=tax_id` (classified field) | body redacted; cursor is plain base64 JSON | Matches the server's own boot warning |
| L31 | Manifest with `default: {kind:"expression", expression:"'a'); CREATE TABLE public.pwned(x int); --"}` through `validateManifest` and `emitManifestSchemaDdl` (pure functions, not executed against a DB) | validation passes; emitted DDL contains the injected statement | SQL injection sink confirmed |
| L32 | Response headers | HSTS, CSP, X-Frame-Options, nosniff present on 2xx | Good |

L28/L29 were produced with a token I signed using the test deployment's own signing seed; they demonstrate verifier behaviour, not a forgery. The built-in login always sets `exp`, `iss`, `aud` and `tenant_id`.

Not live-tested: `--store pg-columns`, per-tenant manifests, the AI design routes (no provider contacted), notification delivery, Stripe, the deletion pipeline, multi-replica behaviour, `operate-web` in a browser, load.
