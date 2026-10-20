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
   export PGSSLMODE=verify-full        # TLS + certificate validation; see §2's note
                                       # if your project's cert is not publicly trusted

   node apps/architect-cli/dist/bin/crossengin.js apply --confirm
   ```

   This creates the full meta-schema (idempotent, hash-tracked in
   `_meta_migrations` — safe to re-run on every schema change). The applier's
   `pg_uuidv7` precondition is satisfied by the pure-SQL function from step 2.

> Re-run steps 2–3 (in that order) whenever you pull a new version that changes
> the schema.

> **Upgrading an existing database?** The version that added the user registry also
> stopped declaring **29 foreign keys** your database is still enforcing, so `apply`
> will report them as `unreconciled` on every run until you clear them **once**.
> A database created after that version reports nothing and needs none of this.
> `apply --plan` lists them without touching anything, and
> [*Clearing the foreign-key drift*](./README.md#clearing-the-foreign-key-drift-after-an-upgrade)
> in the single-VM guide has the one-time invocation, the reasoning, and the one
> `ALTER` that stays manual forever. Do not make `--allow-loosening` part of your
> regular deploy step: it turns every future undeclared-foreign-key refusal into a
> silent drop, and that refusal is the only guardrail between a typo in the catalog
> and a dropped constraint on a live database.

---

## 2. Railway / Render / Fly: the API (`operate-server`)

The repo already ships a production image, [`deploy/Dockerfile`](./Dockerfile),
that builds the whole workspace. Deploy it and set the API's command + env.

**Command:**

```
node apps/operate-server/dist/bin/operate-server.js \
  --pack erp-core --store pg --port 8787 --scheme https --platform-admin \
  --platform-user-routes --platform-user-role platform_admin \
  --idempotency-store pg
```

The api-key spec goes in the **environment**, not here:

```
OPERATE_API_KEY_SPECS=<STRONG_TOKEN>:platform_admin:<TENANT_ID>:<USER_ID>
```

> **Not `--api-key`.** The `<STRONG_TOKEN>` *is* a credential, and a process's
> argv is readable by anyone who can run `ps` on the host — which on a shared
> PaaS is not only you. `OPERATE_API_KEY_SPECS` takes several specs separated by
> newlines or commas, so a second operator is another line rather than another
> flag. Both sources are still read and concatenated, so nothing breaks if a
> flag is left behind; the API reports which it got on every boot (`[auth]
> api-key specs: …`) and names argv when a spec came that way.

> **Both ids must name rows that exist.** The third field is a
> `meta.tenants.id` and the fourth is a `meta.users.id`, and nothing creates
> either for you. Provision the tenant through `POST /v1/platform/tenants` and
> the user through `POST /v1/platform/users` — the registry routes that
> `--platform-user-routes` mounts, which is why that flag is in the command
> above. [*Create your first user*](./README.md#create-your-first-user) in the
> single-VM guide has the exact bodies; they are the same routes here.
>
> **A key with only three fields is not a person.** It resolves as a
> `service_account` on a shared placeholder id, so the per-person surfaces
> (notification preferences, read state) *refuse* it rather than guessing, and
> the inbox simply comes back empty. That is the safe direction, and it looks
> like a bug if you were not expecting it.
>
> **The boot log tells you if you got it wrong.** `operate-server` surveys every
> api-key principal that names a user against `meta.users` before serving a
> request and prints what it finds under `[platform-users]`. An id with no row
> is named there, and the five tables that reference `meta.users` NOT NULL —
> `notification_digests`, `notification_preferences`, `notification_read_states`,
> `notification_read_watermarks`, `user_tenant_membership` — raise a foreign-key
> error at their first write until you create it. The survey also distinguishes
> *not provisioned* from *could not ask*: at boot the database may simply not be
> up yet, and calling that "not provisioned" would print a list of ids that are.
>
> Add `--notification-audit-role <role>` if some role should be able to read the
> whole tenant's notifications via `?scope=tenant`.

**Environment** (point at Supabase's **session pooler** — a long-lived service
should use the pooler in *session* mode, Settings → Database → *Connection
pooling*):

```
PGHOST=<project-ref>.pooler.supabase.com
PGPORT=5432                # session-mode pooler
PGUSER=postgres.<project-ref>
PGPASSWORD=<your-db-password>
PGDATABASE=postgres
PGSSLMODE=verify-full
NODE_ENV=production
OPERATE_API_KEY_SPECS=<STRONG_TOKEN>:platform_admin:<TENANT_ID>:<USER_ID>
CURSOR_ENCRYPTION_SECRET=<32+ random bytes>
```

`CURSOR_ENCRYPTION_SECRET` seals the entity-list keyset cursor with a per-tenant
key derived from it. Set it: `erp-core` has classified fields a list view can
sort by, and unsealed, a cursor is reversible base64url JSON carrying the
plaintext of every sort key — so `?sort=<classified field>` hands back in
`nextCursor` what the response body redacted from the same caller. The boot log
names the fields. (`COLUMN_ENCRYPTION_SECRET` is the separate at-rest one, needed
only by a pack declaring `phi`/`regulated` fields on `--store pg-columns`.)

> **Try `verify-full`, and know what `require` costs you.** This connection
> crosses the public internet and carries `app.current_tenant_id` — the whole
> tenant-isolation boundary — on every query, plus `app.column_encryption_key`
> on every PHI write under `--store pg-columns`. `require` encrypts against a
> passive observer and authenticates **nothing**: the peer is whoever answered,
> so an active man in the middle offering any certificate is accepted.
> `verify-full` is the only mode this binding validates a certificate under, and
> the API says which it got on every boot (`[pg] database channel: …`).
>
> **But it may not be reachable here, and that is this binding's limitation
> rather than yours.** `PgConfig` carries no `ca` field and nothing reads
> `PGSSLROOTCERT`, so `verify-full` validates against Node's own trust store and
> nothing else — while [Supabase's documented path for
> `verify-full`](https://supabase.com/docs/guides/database/psql) is to download
> the project's **server root certificate** from the dashboard and pass it as
> `sslrootcert`, which this binding cannot accept. So set `verify-full` and look
> at the first boot: if the connection is refused for an untrusted certificate,
> your options today are `require` — encrypted and unauthenticated, and now you
> know it — or terminating TLS at something that can be given the CA. Adding CA
> support is a named open end (ADR-0357), and this is the deployment it is for.
>
> `verify-ca` is **refused** rather than served, for the same reason: with no CA
> material it would validate nothing while naming the mode whose whole purpose
> is to validate. It also would not be equivalent to `verify-full` if it were
> implemented — it checks the chain and deliberately not the hostname.

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

   That is the **only** variable the UI takes. This table used to ask for
   `OPERATE_API_KEY` as well, and that variable is read nowhere in `operate-web`
   (ADR-0358 removed it; measured, zero occurrences in its source) — the proxy
   forwards each viewer's own session token from an `httpOnly` cookie. Setting it
   does nothing, so following this page as it stood produced a UI that
   authenticated nobody and a troubleshooting entry pointing at the wrong cause.

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
  -H "x-api-key: $ADMIN_TOKEN" -H 'content-type: application/json' \
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

**By default no deployed tier calls an LLM.** The API and UI serve tenants with
no AI at runtime. Two opt-in ways to add AI:

**In-product (deployed):** add `--ai-design` to the `operate-server` command and
set `ANTHROPIC_API_KEY` *or* `OPENAI_API_KEY` (with `OPENAI_BASE_URL` pointing at
a self-hosted OSS server to stay off commercial APIs) in the API host's
environment. Tenant admins then get **/setup** in the UI — describe the business,
review the AI-generated system, activate it as that tenant's live schema
(per-tenant manifests, served immediately).

Two flags worth setting on a real deployment:

| Flag | Why |
|---|---|
| `--ai-max-usd-per-month <n>` | Per-tenant monthly ceiling on AI design spend (default `25`). A tenant that exhausts it gets `402 ai_budget_exceeded`; the ledger is durable and shared across replicas. |
| `--manifest-refresh-ms 15000` | If you run **more than one API replica**, this makes an activation on one replica invalidate the others within the interval (otherwise they serve the previous manifest for up to 30s). One query per interval regardless of tenant count. |

**Dev-time (local):** the `crossengin chat` CLI, run **locally**, not on Vercel
or Supabase. To run it against a self-hosted open-source model:

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
- **API 500s with a connection error** → check `PGSSLMODE` and that you're using
  the **pooler** host/user for the long-lived API (§2), not the direct
  connection. If the error names a self-signed or untrusted certificate, that is
  `verify-full` working: this binding accepts no CA material, so see §2's note.
- **API refuses to start, naming `PGSSLMODE=verify-ca`** → that mode is refused
  rather than served: no CA material is read anywhere in this binding, so it
  would validate nothing under the name of the mode whose purpose is to
  validate. Use `verify-full`, or `require` to say plainly that the channel is
  encrypted and unauthenticated.
- **UI shows `upstream_unreachable`** → `OPERATE_API_URL` is wrong or the API
  isn't public. It must be the API's external HTTPS URL, reachable from Vercel.
- **UI 401 / empty lists** → you are not signed in, or your session expired.
  The UI has a login: open `/login` and sign in as a user provisioned through
  `POST /v1/platform/users` (see `.env.example`'s bootstrap). This entry used to
  blame `OPERATE_API_KEY` on Vercel, a variable the UI does not read — so the
  remedy it named could not have worked.
- **Boot log says `cursor disclosure: plaintext_disclosing`** → this manifest has
  a classified field a list view can sort by, and `CURSOR_ENCRYPTION_SECRET` is
  unset, so a caller naming that field in `?sort` gets its plaintext back in
  `nextCursor` while the response body redacts it. Set the secret (32+ random
  bytes) to seal every cursor with a per-tenant key. `erp-core` has a member, so
  this line is not hypothetical on the default pack.
