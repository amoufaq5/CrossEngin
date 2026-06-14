# Deploying CrossEngin online (Vercel + Supabase) and operating it as admin

A complete, copy-pasteable guide to getting CrossEngin running on the public
internet and driving it as an administrator. It uses **Supabase** for Postgres
(the data + isolation layer) and **Vercel** for the HTTP API, with the
background workers on a small always-on host.

> Honest scope note. CrossEngin ships as a pnpm workspace of runtime packages +
> runnable bins, not yet as a published Docker image or npm release. "Deploy"
> here means: build from source, apply the schema to a managed Postgres, and run
> the bins / a thin Vercel function. The glue files referenced below live in this
> repo: `api/index.ts`, `vercel.json`, `deploy/supabase/migrations/`,
> `deploy/worker/Dockerfile`.

---

## 0. Architecture — where each piece runs

| Component | Runs on | Why |
|---|---|---|
| Postgres (128 meta tables, RLS, pgcrypto) | **Supabase** | managed Postgres; RLS is CrossEngin's tenant boundary |
| `operate-server` REST API (`/v1/...`, `/v1/openapi.json`) | **Vercel** (Node runtime) | Fetch handler; node-postgres needs TCP → not Edge |
| `operate-web` UI view-model API (optional) | **Vercel** (Node runtime) | same pattern |
| `workflow-worker` (timers/retries/timeouts/monitoring) | **always-on host** (Fly/Railway/Render/VM) | long-running poll loop, not serverless |
| `crossengin` / `crossengin-pg` CLIs (authoring, migrations, ops) | **your laptop / CI** | admin tooling, run on demand |

Two hard constraints, learned the hard way:
1. **Vercel functions must use the Node runtime, not Edge** — the Postgres
   driver opens a socket the Edge runtime forbids.
2. **The gateway verifies EdDSA (Ed25519) JWTs only.** Supabase Auth tokens
   (HS256/RS256/ES256) will *not* verify directly. Use **API keys** (simplest),
   or **mint your own Ed25519 JWTs** (Supabase can still be your login/identity
   source upstream). See §6.

---

## 1. Supabase — the database

1. Create a Supabase project. Note the project ref `<proj>` and the database
   password.
2. Grab two connection strings (Project → Settings → Database):
   - **Direct** (port 5432) — for one-time admin work (`crossengin-pg apply`).
   - **Pooler / transaction mode** (port 6543) — for the serverless API
     (handles per-invocation fan-out). Safe here because every store op sets
     `app.current_tenant_id` with a *transaction-local* `set_config`.
3. Install the prerequisites. Open the SQL Editor and run
   `deploy/supabase/migrations/20260614000000_crossengin_prereqs.sql`
   (pgcrypto + the `uuid_generate_v7()` shim — see the file's header for the
   `pg_uuidv7` caveat).
4. Apply the meta-schema from your machine, pointed at the **direct** string:
   ```bash
   pnpm install && pnpm -r build
   export PGHOST=db.<proj>.supabase.co PGPORT=5432 PGUSER=postgres \
          PGPASSWORD='<db-password>' PGDATABASE=postgres PGSSLMODE=require
   node packages/kernel-pg/dist/bin/crossengin-pg.js apply
   # verify it matches the catalog (exits 1 on drift):
   node packages/kernel-pg/dist/bin/crossengin-pg.js drift
   ```
   You now have 128 `meta.*` tables with RLS enabled.

> Tip: `pnpm link --global` inside `packages/kernel-pg` and `apps/*` puts
> `crossengin-pg`, `crossengin`, `operate-server`, `workflow-worker` on your PATH
> so you can drop the `node …/dist/bin/…` prefix. The rest of this guide assumes
> that.

### Database roles (least privilege)

- **API role** — used by Vercel. A normal (NOT BYPASSRLS) role; the gateway sets
  the tenant context per request and RLS confines it. On Supabase you can use the
  `authenticator`/`postgres` role to start, but for production create a dedicated
  role with `INSERT/SELECT/UPDATE/DELETE` on `meta.*` and **no** BYPASSRLS.
- **Worker role** — used by `workflow-worker`. This one **needs BYPASSRLS** (one
  worker drains every tenant).

---

## 2. Bootstrap the first tenant + admin

Everything in CrossEngin is tenant-scoped. Create a tenant and an admin user
(direct connection):

```bash
psql "$PG_DIRECT_URL" <<'SQL'
-- a tenant
insert into meta.tenants (slug, name, schema_name)
values ('acme', 'Acme Inc', 'tenant_acme')
returning id;          -- copy this UUID → <TENANT>

-- an admin user (use the returned tenant id is not needed here)
insert into meta.users (id, email)
values (gen_random_uuid(), 'admin@acme.test')
on conflict (id) do nothing
returning id;          -- copy this UUID → <ADMIN_USER>
SQL
```

Pick the **admin role** for your pack (it comes from the manifest):
`erp-retail` → `retail_admin`, `erp-core` → `erp_admin`, `erp-healthcare` →
`clinical_admin`, `erp-construction` → `construction_admin`, `erp-education` →
`education_admin`.

The simplest admin credential is an **API key** in the form
`token:role:tenant`:

```
acme-admin-7f3c9d:retail_admin:<TENANT>
```

Keep `acme-admin-7f3c9d` secret — it *is* the bearer. You'll pass it to Vercel
as an env var in §3.

---

## 3. Deploy `operate-server` to Vercel

The repo already contains the entrypoint (`api/index.ts`) and `vercel.json`
(catch-all rewrite + Node runtime + `pnpm -r build`).

1. Import the repo into Vercel. **Framework Preset: Other.** Root Directory:
   repo root. (`vercel.json` already sets Install = `pnpm install`, Build =
   `pnpm -r build`.)
2. Set Environment Variables (Project → Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `PGHOST` | `<pooler-host>` (e.g. `aws-0-…pooler.supabase.com`) |
   | `PGPORT` | `6543` |
   | `PGUSER` | `postgres.<proj>` (pooler username form) |
   | `PGPASSWORD` | `<db-password>` |
   | `PGDATABASE` | `postgres` |
   | `PGSSLMODE` | `require` |
   | `CROSSENGIN_PACK` | `erp-retail` (or your pack alias) |
   | `CROSSENGIN_STORE` | `pg` (JSONB) or `pg-columns` (typed tables + PHI encryption) |
   | `CROSSENGIN_API_KEYS` | `acme-admin-7f3c9d:retail_admin:<TENANT>` (comma-separate more) |

   For the column store with PHI encryption also set the encryption key reference
   it reads at runtime (`app.column_encryption_key`); the simplest path for a
   first deploy is `CROSSENGIN_STORE=pg` (no key management) and graduate to
   `pg-columns` once you've wired a key.
3. Deploy. Then smoke-test:
   ```bash
   BASE=https://<your-app>.vercel.app
   # API description (RBAC-filtered to the caller)
   curl -s -H "x-api-key: acme-admin-7f3c9d:retail_admin:<TENANT>" $BASE/v1/openapi.json | head
   # create + list a record (retail pack → products)
   curl -s -X POST $BASE/v1/products \
     -H "x-api-key: acme-admin-7f3c9d:retail_admin:<TENANT>" \
     -H "content-type: application/json" \
     -d '{"sku":"SKU-1","name":"Widget","unit_cost":4.20,"category":"grocery","status":"active"}'
   curl -s -H "x-api-key: acme-admin-7f3c9d:retail_admin:<TENANT>" $BASE/v1/products
   ```
4. (Optional) attach a custom domain in Vercel.

> Cold starts: `api/index.ts` builds the server + store once per cold start and
> reuses it on warm invocations. The `pg-columns` store also runs an idempotent
> `ensureSchema()` on cold start (a few `CREATE TABLE IF NOT EXISTS`); `pg` does
> not. If Vercel's bundler can't trace `pg`, add `pg` to a root `package.json`
> `dependencies` and redeploy.

---

## 4. Deploy the workers

The workers are a long-running loop — host them off Vercel. The repo's
`deploy/worker/Dockerfile` builds the monorepo and runs the `workflow-worker`
bin.

```bash
docker build -f deploy/worker/Dockerfile -t crossengin-worker .
# run on Fly.io / Railway / Render / a VM with the WORKER (BYPASSRLS) role:
docker run -e PGHOST=… -e PGPORT=5432 -e PGUSER=<worker_role> \
  -e PGPASSWORD=… -e PGDATABASE=postgres -e PGSSLMODE=require \
  crossengin-worker
```

It runs `--mode all` (claim + retry + timeout + execute + reap) with
`--monitor --persist-incidents` (a stale worker is written to `meta.incidents`).
Provide your workflow definitions at `/app/workflows.json` (mount or bake them
in); `[]` is valid if your manifest has no workflows yet.

> No-worker option: if your manifest has no `entityLifecycle`/job workflows you
> can skip §4 entirely — the API in §3 is fully functional on its own.

---

## 5. (Optional) the `operate-web` UI

`operate-web` serves redaction-aware view models + SSR pages. Deploy it the same
way as §3 with a second Vercel project (or a second function) wrapping
`@crossengin/operate-web-app`'s edge handler, pointed at the same Supabase DB.
Build its browser bundle with `pnpm --filter @crossengin/operate-web-app
build:client`. (A turnkey `api/` for operate-web is not bundled here yet — clone
`api/index.ts` and swap the imports for the operate-web equivalents.)

---

## 6. Using it as admin

### 6a. Authentication models

**API keys (recommended to start, and for service/admin automation).** Format
`token:role:tenant`, registered via `CROSSENGIN_API_KEYS`. Sent as
`x-api-key: <token>:<role>:<tenant>` or `Authorization: Bearer <…>`. Fail-closed:
an unknown token → 401. An admin key uses the pack's admin role.

**EdDSA JWTs (for end-user auth in production).** The gateway accepts only
Ed25519-signed JWTs. Two ways to give it keys:
- `CROSSENGIN_JWKS_KEYS=kid:base64,…` — inline public keys, or
- `CROSSENGIN_JWKS_URL=https://…/jwks.json` + `CROSSENGIN_JWT_ISSUER` +
  `CROSSENGIN_JWT_AUDIENCE` — a JWKS endpoint you host.

Generate a keypair with the repo's crypto package:
```bash
node -e "import('@crossengin/crypto').then(c=>{const k=c.generateEd25519Keypair();console.log('PUBLIC (kid:base64) =>','main:'+k.publicKeyBase64);console.log('PRIVATE base64 =>',k.privateKeyBase64)})"
```
Put `main:<publicKeyBase64>` in `CROSSENGIN_JWKS_KEYS`; keep the private key in
your token-mint service. A JWT must carry `iss`/`aud` matching your config, a
`tenant_id` claim (authoritative over the spoofable `x-tenant-id` header), and a
`roles` claim (array) that maps to manifest roles. The canonical example of
constructing a valid token is `apps/operate-server/src/jwt.test.ts` (it mints
real Ed25519 JWTs end to end).

> Supabase Auth as identity: keep using Supabase for login, then exchange a
> verified Supabase session for a CrossEngin Ed25519 JWT in a tiny mint endpoint
> (it can itself be a Vercel Node function holding the private key). You cannot
> hand the raw Supabase token to the gateway.

### 6b. Authoring & applying manifests (the `crossengin` CLI)

```bash
crossengin init my-manifest.json          # scaffold
crossengin validate my-manifest.json      # zod-check + summary
crossengin hash my-manifest.json          # deterministic content hash
crossengin diff old.json my-manifest.json # human or --format json
crossengin apply --dry-run                # preview the meta-schema DDL it emits
```
Built-in vertical packs (`erp-core | erp-retail | erp-healthcare | erp-grocery |
erp-construction | erp-education`) need no authoring — set `CROSSENGIN_PACK`.

### 6c. Schema migrations & the drift gate

```bash
crossengin-pg apply           # apply pending meta-schema DDL (idempotent, hash-skipped)
crossengin-pg apply --dry-run # show the SQL
crossengin-pg drift           # exits 1 if the live schema diverges from META_TABLES
crossengin-pg inspect         # introspect the live catalog
```

### 6d. Provisioning more tenants & users

Repeat §2's inserts per customer. Each tenant is isolated by RLS; the same API
deployment serves all of them — the credential's `tenant` segment (API key) or
`tenant_id` claim (JWT) selects which tenant a request operates in.

### 6e. Driving the API as admin

```bash
H="x-api-key: acme-admin-7f3c9d:retail_admin:<TENANT>"
# CRUD
curl -X POST  $BASE/v1/products -H "$H" -H 'content-type: application/json' -d '{…}'
curl          $BASE/v1/products -H "$H"                 # keyset-paginated list
curl          "$BASE/v1/products?limit=20&sort=sku&order=asc&category[eq]=grocery" -H "$H"
curl -X PATCH  $BASE/v1/products/<id> -H "$H" -d '{"status":"active"}'
curl -X DELETE $BASE/v1/products/<id> -H "$H"
# lifecycle transition (retail SalesOrder: place/fulfill/cancel/…)
curl -X POST $BASE/v1/sales-orders/<id>/place -H "$H"
# reports + discovery
curl $BASE/v1/reports/salesRevenue -H "$H"
curl $BASE/v1/openapi.json -H "$H"        # RBAC-filtered to what this caller may invoke
```
Redaction is structural: a `cashier` key never sees `unit_cost`; a `retail_admin`
does. Projection (`?fields=`) can only narrow, never bypass redaction.

### 6f. Marketplace pack installs (per tenant)

If you serve with `--marketplace` (operate-server flag) the install surface is
live; otherwise install from the authoring CLI:
```bash
crossengin install --pack <pack-id> --version <semver> --tenant <TENANT> --by <ADMIN_USER>
```

### 6g. Operations & compliance gates

```bash
operate-server incidents open                 # live incidents
operate-server incidents metrics --from <iso> --to <iso>   # MTTP/MTTA/MTTM/MTTR
operate-server incidents verify --from <iso> --to <iso>    # timeline drift (exit 1 = drift)
crossengin-pg encrypt --verify                 # zero plaintext PHI (HIPAA gate; exit 1 on drift)
crossengin-pg drift                            # schema matches the catalog
```
(`workflow-worker incidents …` and `crossengin-slo slo …` expose the same audit
surfaces for the worker + SLO tables.)

### 6h. Generate typed SDK clients

```bash
operate-server openapi-client --pack erp-retail --lang ts     --out client.ts
operate-server openapi-client --pack erp-retail --lang python --out client.py
# also: go | php | ruby
```

---

## 7. Production security checklist

- [ ] API role is **NOT** BYPASSRLS; worker role **IS** BYPASSRLS.
- [ ] All `CROSSENGIN_API_KEYS` / private keys are Vercel secrets, never committed.
- [ ] `PGSSLMODE=require` everywhere; use the Supabase pooler for the API.
- [ ] If serving PHI: `CROSSENGIN_STORE=pg-columns` + a managed
      `app.column_encryption_key`; gate CI on `crossengin-pg encrypt --verify`.
- [ ] Rotate the encryption key periodically:
      `crossengin-pg encrypt --rotate --old-key-ref=<…>`.
- [ ] End-user auth uses EdDSA JWTs with `iss`/`aud`/`tenant_id`/`roles`; API keys
      reserved for admin/service automation.
- [ ] Run `crossengin-pg drift` in CI against a freshly-applied schema.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `relation "meta.…" does not exist` | schema not applied — run `crossengin-pg apply` (§1.4) |
| `function uuid_generate_v7() does not exist` | run the prereqs migration (§1.3) |
| Vercel function errors opening a socket | function set to Edge runtime — must be Node (don't set `runtime:"edge"`) |
| `unsupported alg …; only EdDSA is accepted` | you sent a Supabase/HS256/RS256 token — use an API key or an Ed25519 JWT (§6a) |
| Cannot find module `pg` on Vercel | add `pg` to a root `package.json` `dependencies`, redeploy |
| 401 on every request | API key not in `CROSSENGIN_API_KEYS`, or tenant/role segment wrong |
| Workflows never advance | the `workflow-worker` host isn't running (§4) |
| Cross-tenant data leak suspected | confirm the API role is not BYPASSRLS; RLS is the boundary |
```
