# Deploying CrossEngin on Supabase + Vercel

This is the managed-cloud path: **Supabase** hosts Postgres, **Vercel** hosts the
`operate-web` admin UI, and the `operate-server` API runs on a **container host**
(Railway / Render / Fly.io) pointed at Supabase.

> **Why not the API on Vercel too?** `operate-server` is a *long-lived* Node
> service — it holds an event loop and runs background schedulers (SLO
> enforcement, audit-chain checkpointing, the job scheduler, metering flush,
> JWKS refresh). Vercel only runs short-lived serverless/edge **functions**, which
> can't keep those loops alive between requests and would open a new Postgres
> connection per invocation. So the UI goes on Vercel (a perfect fit — it's a
> plain Next.js app) and the API goes on a host that runs a container. The DB is
> Supabase for both. (A request-only serverless build of the API over the P1.9
> edge adapter is possible but out of scope here — see the last section.)

The three tiers and where they live:

| Tier | Runs on | Notes |
|---|---|---|
| Postgres | **Supabase** | needs the `uuid_generate_v7()` polyfill (below) |
| `operate-web` (admin UI + `/platform` console) | **Vercel** | zero backend deps; talks to the API over HTTPS |
| `operate-server` (API) | **Railway / Render / Fly** | container from `deploy/Dockerfile`, pointed at Supabase |

---

## 1. Supabase: the database

1. Create a Supabase project. Note the project's Postgres connection details
   (Project → **Settings → Database**).
2. **Install the UUIDv7 polyfill.** Supabase does not offer the `pg_uuidv7` C
   extension, and every table defaults its `id` to `uuid_generate_v7()`. Open
   Supabase **SQL Editor**, paste the contents of
   [`deploy/supabase/00-uuidv7.sql`](./supabase/00-uuidv7.sql), and run it. It
   defines `uuid_generate_v7()` in pure SQL (over `pgcrypto`, which Supabase
   has) and self-checks that it emits real v7 UUIDs. Idempotent — safe to re-run.
3. **Apply the schema.** From your laptop, with the repo built
   (`pnpm install && pnpm -r build`), point the CLI at Supabase's **direct**
   connection (Settings → Database → *Connection string* → **Direct**, port
   `5432`) and run the migration:

   ```bash
   export PGHOST=db.<project-ref>.supabase.co
   export PGPORT=5432
   export PGUSER=postgres
   export PGPASSWORD='<your-db-password>'
   export PGDATABASE=postgres
   export PGSSLMODE=require            # Supabase requires TLS

   node apps/architect-cli/dist/bin/crossengin.js apply --confirm
   ```

   This creates the full meta-schema (idempotent, hash-tracked in
   `_meta_migrations` — safe to re-run on every schema change). The applier's
   `pg_uuidv7` precondition is satisfied by the pure-SQL function from step 2.

> Re-run steps 2–3 (in that order) whenever you pull a new version that changes
> the schema.

---

## 2. Railway / Render / Fly: the API (`operate-server`)

The repo already ships a production image, [`deploy/Dockerfile`](./Dockerfile),
that builds the whole workspace. Deploy it and set the API's command + env.

**Command** (args in list form so the API key is never shell-split):

```
node apps/operate-server/dist/bin/operate-server.js \
  --pack erp-core --store pg --port 8787 --scheme https --platform-admin \
  --api-key <STRONG_TOKEN>:platform_admin:00000000-0000-4000-8000-000000000000
```

**Environment** (point at Supabase's **session pooler** — a long-lived service
should use the pooler in *session* mode, Settings → Database → *Connection
pooling*):

```
PGHOST=<project-ref>.pooler.supabase.com
PGPORT=5432                # session-mode pooler
PGUSER=postgres.<project-ref>
PGPASSWORD=<your-db-password>
PGDATABASE=postgres
PGSSLMODE=require
NODE_ENV=production
```

- **Railway:** New Project → Deploy from repo → set the Dockerfile path to
  `deploy/Dockerfile`, the start command above, and the env vars. Railway gives
  you a public `https://<app>.up.railway.app` URL.
- **Render:** New → Web Service → Docker → `deploy/Dockerfile`, same command +
  env. Health check path `/` .
- **Fly.io:** `fly launch --dockerfile deploy/Dockerfile`, set secrets with
  `fly secrets set PGHOST=… PGPASSWORD=…`, `internal_port = 8787`.

Note the API's public URL — the web app needs it. (RLS + `withTenantContext`
run every op inside a transaction with a bound `set_config`, so the pooler is
safe: tenant isolation holds.)

---

## 3. Vercel: the admin UI (`operate-web`)

`operate-web` is a self-contained Next.js 14 app with **no** backend
dependencies — it calls the API through its own server-side `/api` proxy, so the
API key never reaches the browser.

1. Vercel → **Add New Project** → import this repo.
2. Set **Root Directory** to `apps/operate-web`. Framework preset **Next.js** is
   auto-detected; leave build/install commands at their defaults.
3. Add two **Environment Variables**:

   | Name | Value |
   |---|---|
   | `OPERATE_API_URL` | the API URL from step 2, e.g. `https://<app>.up.railway.app` |
   | `OPERATE_API_KEY` | the **token part only** of the API key (the `<STRONG_TOKEN>` before the first `:`) |

4. Deploy. Vercel serves the UI at `https://<project>.vercel.app`; the
   `/platform` route is the tenant-management console.

> The browser only ever talks to the Vercel app; the Vercel app's `/api/[...path]`
> route ([`app/api/[...path]/route.ts`](../apps/operate-web/app/api/%5B...path%5D/route.ts))
> forwards to `OPERATE_API_URL` with the `x-api-key`. No CORS, and the secret
> stays server-side.

---

## 4. Create your first tenant

Open the Vercel UI → **Platform → New tenant**, or via the API directly:

```bash
curl -sS -X POST https://<your-api-host>/v1/platform/tenants \
  -H "x-api-key: $OPERATE_WEB_API_KEY" -H 'content-type: application/json' \
  -d '{"slug":"acme","name":"Acme Inc.","tier":"small","region":"eu"}'
```

The console lists / creates / suspends / archives / reactivates tenants; the
`schema_name` is derived from the slug. (Hard delete is intentionally not
exposed — that's the audited GDPR flow.)

---

## 5. Production auth

The `--api-key` shared secret bootstraps the platform console. For end-users,
switch `operate-server` to JWT/JWKS by adding to its command:

```
--jwks-url https://your-idp/.well-known/jwks.json --jwks-refresh-ms 300000
--jwt-issuer https://your-idp --jwt-audience crossengin-api
```

Keep one `platform_admin` API key for the console only. See
`operate-server --help` for the full flag surface.

---

## 6. The AI Architect (open-source model)

**None of the deployed tiers call an LLM.** The API and UI serve tenants with no
AI at runtime. The AI Architect — natural-language manifest authoring — is a
separate **developer CLI** (`crossengin chat`) you run **locally**, not on
Vercel or Supabase. To run it against a self-hosted open-source model:

1. Run an OpenAI-compatible server on your machine (or a GPU box), e.g.
   [Ollama](https://ollama.com): `ollama serve` then `ollama pull qwen2.5-coder`
   (a strong schema/code model). vLLM and LocalAI work the same way.
2. Point the Architect at it. Two equivalent routes:

   ```bash
   # Dedicated local provider (zero-cost, arbitrary model name):
   crossengin chat --provider local \
     --local-url http://localhost:11434/v1 --local-model qwen2.5-coder

   # …or the OpenAI provider aimed at the same server (keeps OpenAI pricing/labels):
   OPENAI_API_KEY=sk-anything \
   crossengin chat --provider openai \
     --openai-base-url http://localhost:11434 --openai-model gpt-4o
   ```

   (`--openai-base-url` is the host **without** `/v1`; `--local-url` includes it.
   The dummy `OPENAI_API_KEY` just satisfies the client — OSS servers ignore it.)

Nothing about the AI needs to be deployed to Supabase or Vercel. If you later
want an in-product AI endpoint, that's a new serving feature, not part of this
deployment.

---

## Troubleshooting

- **`crossengin apply` says the `pg_uuidv7` extension is missing** → you skipped
  §1.2. Run `deploy/supabase/00-uuidv7.sql` in the SQL Editor first.
- **API 500s with a connection error** → check `PGSSLMODE=require` and that
  you're using the **pooler** host/user for the long-lived API (§2), not the
  direct connection.
- **UI shows `upstream_unreachable`** → `OPERATE_API_URL` is wrong or the API
  isn't public. It must be the API's external HTTPS URL, reachable from Vercel.
- **UI 401 / empty lists** → `OPERATE_API_KEY` on Vercel must be only the token
  part (before the first `:`), matching the `<STRONG_TOKEN>` in the API's
  `--api-key`.
