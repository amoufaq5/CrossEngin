# ADR-0264: Supabase-compatible UUIDv7 + Supabase/Vercel deployment path (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0047 (kernel-pg applier), ADR-0087/0089 (operate-server + edge adapter), ADR-0262 (platform admin console), ADR-0077 (Phase 4), PR #153 (Docker-Compose VM) |

## Context

Every one of the ~123 meta-schema tables defaults its `id` to `uuid_generate_v7()`,
supplied by the `pg_uuidv7` **C extension**, and the migration applier's precondition
hard-required that extension in `pg_extension`. **Supabase does not offer `pg_uuidv7`**
(and disallows arbitrary C extensions), so CrossEngin could not run on Supabase at all —
the applier aborted before the first `CREATE TABLE`. The user wants the managed-cloud path:
Supabase for Postgres, Vercel for the app.

Two facts shaped the design:
- `operate-web` has **zero** `@crossengin/*` runtime imports — it is a standalone Next.js
  app that reaches the API over HTTP through its own `/api` proxy. It deploys to Vercel with
  a root directory + two env vars, no monorepo build.
- `operate-server` is a **long-lived** Node service running background schedulers (SLO,
  checkpoints, job scheduler, metering, JWKS refresh). Vercel runs only short-lived
  functions, which cannot keep those loops alive or hold a Postgres pool — so the API is not
  a serverless fit and belongs on a container host.

## Decision

- **`kernel-pg` precondition accepts the callable function, not only the extension.**
  `checkPgUuidv7Extension` now probes `EXISTS(pg_extension WHERE extname='pg_uuidv7')
  OR EXISTS(pg_proc WHERE proname='uuid_generate_v7')`. What the DDL actually needs is the
  callable `uuid_generate_v7()` — whether it comes from the C extension (self-managed) or a
  pure-SQL definition (managed/Supabase). The remedy message names both paths.
- **`deploy/supabase/00-uuidv7.sql`** defines `uuid_generate_v7()` in pure SQL over
  `pgcrypto`'s `gen_random_uuid()` (overlay the epoch-ms into the first 48 bits, flip the
  version nibble to 7), with a `DO`-block self-check. Run once in the Supabase SQL Editor
  before `crossengin apply`. Idempotent (`CREATE OR REPLACE`).
- **`deploy/VERCEL-SUPABASE.md`** documents the three-tier managed topology: Supabase DB
  (polyfill + `crossengin apply` over the direct connection, `PGSSLMODE=require`),
  `operate-server` on Railway/Render/Fly from the existing `deploy/Dockerfile` (pointed at
  Supabase's session pooler), `operate-web` on Vercel (root dir `apps/operate-web`,
  `OPERATE_API_URL` + `OPERATE_API_KEY`), first-tenant creation, JWT/JWKS for production,
  and self-hosting an OSS model for the dev-time Architect (`--provider local` /
  `--openai-base-url`).

## Consequences

- CrossEngin now runs on Supabase. **Validated end-to-end against a real Postgres 16:** the
  polyfill emits version-7, correct-variant, time-ordered UUIDs (2000-sample distribution
  all `ver=7`, variant ∈ {8,9,a,b}); the full `crossengin apply` dry-run DDL (129
  `uuid_generate_v7()` defaults) applies cleanly on the polyfilled cluster; a `meta.tenants`
  insert gets a real v7 id from the default. The precondition change is unit-tested (+1 test
  for the SQL-function path; applier + preconditions stubs updated to the new query shape).
- The managed path is honest about tier placement: UI on Vercel (its natural home), DB on
  Supabase, API on a container host — because the API's background loops and connection pool
  disqualify serverless. The existing `deploy/Dockerfile` (PR #153) is reused for the API, so
  no new build surface.
- Behaviour-preserving for self-managed installs: a real `pg_uuidv7` extension still
  satisfies the precondition unchanged (the Docker-Compose DB image keeps compiling it in).
  kernel-pg change only; no META tables, no schema-count change. Full build + typecheck +
  workspace tests green.
- Follow-up (open): a request-only Vercel serverless build of the API over the P1.9 edge
  adapter + `PostgresEntityStore` on the transaction pooler (no background loops), for teams
  that want everything on Vercel; a one-command Supabase bootstrap (`crossengin apply
  --supabase` that runs the polyfill first).
