# Deploying CrossEngin on a VM with Docker Compose

This brings up the whole platform on a single Linux VM: **Postgres** (with the
`pg_uuidv7` extension), a one-shot **schema migration**, the **operate-server** API,
the **operate-web** admin UI (including the `/platform` tenant-management console),
and **Caddy** for automatic HTTPS.

## Prerequisites

- A Linux VM (2 vCPU / 4 GB RAM is a comfortable start) with **Docker Engine + the
  Compose plugin** installed, and **ports 80 and 443** open to the internet.
- A **domain** you control, with two DNS records pointing at the VM's public IP:
  - `erp.example.com` → the UI
  - `api.erp.example.com` → the API
- Outbound internet during the build (the images fetch npm packages and the
  `pg_uuidv7` release).

## First launch

```bash
git clone <your-fork-url> crossengin && cd crossengin/deploy

cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, DOMAIN, ACME_EMAIL, and a strong token in
# OPERATE_ADMIN_API_KEY + OPERATE_WEB_API_KEY (same token in both).

docker compose up -d --build          # build images + start everything
docker compose logs -f migrate        # watch the schema apply, then exit 0
```

When `migrate` has exited successfully and `caddy` has obtained certificates
(`docker compose logs -f caddy`), open:

- **UI:** `https://erp.example.com` — the admin console; tenant management is at `/platform`
- **API:** `https://api.erp.example.com`

> The `migrate` job is idempotent (hash-tracked in `_meta_migrations`), so it is safe
> to run on every `up`. It applies the full meta-schema before the API starts.

## Create your first tenant

Once up, use the platform console you just launched. In the UI go to **Platform →
New tenant**, or via the API:

```bash
curl -sS -X POST https://api.erp.example.com/v1/platform/tenants \
  -H "x-api-key: $OPERATE_WEB_API_KEY" -H 'content-type: application/json' \
  -d '{"slug":"acme","name":"Acme Inc.","tier":"small","region":"eu"}'
```

The console can list / create / suspend / archive / reactivate tenants; the `schema_name`
is auto-derived from the slug. (Hard deletion is intentionally not exposed — that's the
audited GDPR flow.)

## Create your first user

An api-key spec is `token:role:tenant[:principalId]`, and the optional 4th field is what
makes the key a **person** rather than a service account:

- `token:platform_admin:<tenant-uuid>` — no principal named. Every such key shares one
  placeholder principal id, so it resolves as a `service_account`: the read-state and
  preference routes refuse it outright rather than handing two keys one shared identity,
  and the notification inbox is per-recipient so it comes back empty. This is the right
  shape for the bootstrap key in `.env.example`: an operator, not a tenant user.
- `token:cashier:<tenant-uuid>:<user-uuid>` — names a principal, resolves as a `user`, and
  the per-person surfaces work. That `<user-uuid>` must be a real `meta.users.id`.

To create one, mount the registry: add `--platform-user-routes` and at least one
`--platform-user-role` to the `api` command in `docker-compose.yml` (the grant is
fail-closed — with no role nothing is mounted at all, and the API says so at boot).
It is deliberately a *different* grant from `--platform-admin-role`: the people who may
create tenants need not be the people who may mint the identities inside them. The calls
below use the bootstrap key, so they assume `--platform-user-role platform_admin`.

```bash
# Provision the principal and its tenant membership in one call. `id` is accepted — and is
# the point — because the id that needs a row is one the deployment has already committed
# to in an --api-key spec.
curl -sS -X POST https://api.erp.example.com/v1/platform/users \
  -H "x-api-key: $OPERATE_WEB_API_KEY" -H 'content-type: application/json' \
  -d '{"user":{"id":"<user-uuid>","email":"ana@acme.example","displayName":"Ana"},
       "membership":{"tenantId":"<tenant-uuid>","primaryRole":"cashier","status":"active"}}'

# Or grant a membership to an existing principal (the tenant comes from the path, never
# the body). `status` has no default: "active" grants access now, "invited" only promises
# it, and only an active membership resolves as a notification recipient.
curl -sS -X POST https://api.erp.example.com/v1/platform/tenants/<tenant-uuid>/members \
  -H "x-api-key: $OPERATE_WEB_API_KEY" -H 'content-type: application/json' \
  -d '{"userId":"<user-uuid>","primaryRole":"cashier","status":"active"}'
```

The rest of the surface is `GET /v1/platform/users` and `/users/{id}`,
`POST /users/{id}/suspend` / `/reactivate` / `/retire`,
`GET /v1/platform/tenants/{tenantId}/members`, and
`POST .../members/{userId}/activate` / `/revoke`. Every one of them is recorded in the
audit log before it lands; a change that cannot be recorded is refused with a 503 rather
than made quietly.

**What actually needs a row.** Most columns that used to demand one no longer do — the six
`created_by` / `requested_by` / `decided_by_user_id` references on `pack_installations`,
`notification_templates`, `access_review_campaigns`, `access_review_decisions`,
`workflow_definitions` and `gateway_routes` are plain TEXT now, so those stores record
whichever principal acted without a registry row existing first. What still needs one is
the set where the reference is right — a user's own per-viewer state, which must go when
the user does, and the two tables that are *about* the user:

`notification_digests`, `notification_preferences`, `notification_read_states`,
`notification_read_watermarks`, `user_tenant_membership`.

**The boot survey.** `operate-server` checks, at every boot, whether the principal ids its
own `--api-key` specs name have a `meta.users` row — unconditionally, because the writers of
those five tables fail at their first `INSERT` whether or not the registry is mounted:

```sh
docker compose logs api | grep '\[platform-users\]'
# [platform-users] meta.users readiness: readable — 1 of 1 principals have no meta.users row; ...
#   unprovisioned principal: 7f3a...
#   will raise 23503: notification_read_states.user_id
```

Nothing is printed when every named principal is provisioned. When it does fire, there are
two correct fixes and you pick per key: provision that exact id through the route above, or
drop the 4th field so the key is honestly a service account. Specs that name no principal
are deliberately *not* listed — provisioning the shared placeholder would make it satisfy
the per-person guards again, which is the whole thing those guards prevent.

The line also names three states that are *not* "not provisioned", and the difference
matters because none of them is fixed by creating a row: `unreadable` (the API's role has
no `SELECT` on `meta.users` — grant it, and note that without `INSERT` the registry routes
cannot fix anything either), `unreachable` (the database was not up yet) and `absent` (no
`meta.users` at all — the `migrate` job has not applied). JWT-authenticated
principals are outside the survey entirely: their ids come from the IdP's `sub` at request
time, so there is no set to check at boot.

## Going to production (auth)

The `--api-key` above is a simple shared secret — fine to bootstrap, but for real
end-users switch `operate-server` to JWT/JWKS by adding these args to the `api`
service `command` in `docker-compose.yml`:

```
--jwks-url https://your-idp/.well-known/jwks.json --jwks-refresh-ms 300000
--jwt-issuer https://your-idp --jwt-audience crossengin-api
```

Keep a single `platform_admin` API key only for the console. See
`operate-server --help` for the full flag surface (SLO enforcement, audit chain,
checkpoints, billing, marketplace, etc.) — add the flags you want to the `api` command.

## Rate limiting

Out of the box the gateway limits at 10,000 requests per 60s window, in memory — so the
window is per replica and per restart, and nothing is written down. Declare a real policy to
change both:

```
--rate-limit-policy rlp_conservativedefault:600:60
```

The spec is `<rlp_id>:<limit>:<windowSeconds>`, the id must match `rlp_` + 8–40 lowercase
alphanumerics, and the flag is repeatable. Declaring more than one requires
`--rate-limit-default-policy <rlp_id>` to say which governs a route that names none, and a
default naming a policy you did not declare is refused rather than falling back — a decision
row that names one policy while applying another's limit is the thing this avoids. Nothing
defaults the ceiling: which limit a deployment permits is not something silence may answer,
and switching an existing deployment from 10,000/60s on upgrade would refuse traffic that
works today. Needs a Postgres store, since the point is that every decision is written to
`meta.rate_limit_decisions` naming the policy whose terms were applied.

The window itself is still counted in each process, so with several `api` replicas the
effective ceiling is the limit times the replica count, and a restart starts a fresh window.
What the flag buys is the limit being *yours* and every decision being on the record.

## Day-2 operations

- **Update to a new version:** `git pull && docker compose up -d --build`
  (the `migrate` job re-applies any new schema before the API restarts).
- **Backups:** the data lives in the `db-data` volume. Dump regularly, e.g.
  `docker compose exec db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql`.
- **Logs:** `docker compose logs -f api` / `web` / `caddy`.
- **Stop / start:** `docker compose down` (keeps volumes) / `docker compose up -d`.
- **Scale the API:** the API is stateless — run several `api` replicas behind Caddy
  and they share Postgres safely (idempotency, advisory locks, RLS all hold).

## Sending email and SMS

Out of the box only **in-app** notices are delivered: an email or SMS dispatch is refused as
`no_sender_configured`, which the drain treats as retryable — so configuring a channel later
delivers the backlog rather than losing it.

To turn them on, fill the SES and/or Twilio block in `.env` (see
[`.env.example`](./.env.example)) and add `--notification-drain-ms 15000` to the `api` command in
`docker-compose.yml`. Without the drain flag nothing is sent at all, and the API says so at boot.

These are credentials, so they live in the environment rather than in `command` — a process's argv
is readable by anyone who can run `ps`. After the first `up`, check what was registered:

```sh
docker compose logs api | grep '\[notify\]'
# [notify] channels: in_app, email, sms
```

A channel you configured but that is missing from that line is reported on the next line with what
it still needs. A half-configured channel is never guessed at.

**Per-user preferences.** Until you add `--preference-routes` plus at least one
`--preference-role`, every user's notification preferences are the built-in defaults for ever, so
nobody can opt out of a channel. The routes are `GET /v1/notifications/preferences` and
`PUT`/`DELETE /v1/notifications/preferences/{category}/{channel}`, and the viewer is always the
credential — a body naming somebody else is refused rather than ignored. `--preference-admin-role`
is additive on top and mounts one further route
(`PUT /v1/notifications/preferences/users/{userId}/{category}/{channel}`) for support staff; it is
recorded before the write, so an unrecordable on-behalf change is refused. Note that a preference
belongs to a **person**, so this needs a principal with a `meta.users` row — see
[Create your first user](#create-your-first-user).

**Bounces.** Add `--bounce-webhook` and set `NOTIFICATION_BOUNCE_SECRET` (32+ characters) to serve
`POST /v1/notifications/bounces/{tenantId}/{ses|twilio}`, which records a hard bounce or a
complaint as a suppression so the address stops receiving mail. This matters beyond tidiness:
providers throttle or pause a whole sending domain on bounce and complaint rates, so one dead
mailbox degrades every tenant's mail.

The route verifies **the platform's own HMAC**, not the provider's — whatever terminates the SNS or
Twilio callback must re-sign the byte-identical body with `signWebhookPayload` under the per-tenant
key `HMAC-SHA256(NOTIFICATION_BOUNCE_SECRET, "bounce-webhook:" + tenantId)`, so a signature captured
for one tenant cannot be replayed against another. Point `SES_CONFIGURATION_SET`'s event destination
and `TWILIO_STATUS_CALLBACK_URL` at it; without those, no bounce ever arrives and a dead address is
retried forever.

## Notes

- **`pg_uuidv7`:** the DB image (`deploy/postgres/Dockerfile`) compiles the extension in.
  The migration applier accepts *either* the `pg_uuidv7` extension *or* a pure-SQL
  `uuid_generate_v7()` function. If you use a **managed** Postgres, install whichever your
  provider allows and point `PGHOST`/… at it (drop the `db` service). For **Supabase**
  specifically (no C extensions), see [`VERCEL-SUPABASE.md`](./VERCEL-SUPABASE.md) — run
  `deploy/supabase/00-uuidv7.sql` once to define the pure-SQL function.
- **Supabase + Vercel:** for the managed-cloud path (Supabase DB + Vercel UI + a container
  host for the API) see [`VERCEL-SUPABASE.md`](./VERCEL-SUPABASE.md).
- **AI features are optional.** By default `operate-server` never calls an LLM at
  runtime. See [Running the model here too](#running-the-model-here-too) below.
  Without it, nothing calls a model; the dev-time `crossengin chat` CLI remains
  available either way.
- **API keys and the notification inbox.** The 4th field of an api-key spec
  (`token:role:tenant:user`) is the principal's `meta.users.id`, and a key without
  it is a service account whose notification inbox is empty by construction. That
  is correct for the platform-admin bootstrap key — it is an operator, not a tenant
  user — but a key belonging to a real person needs the field *and* a registry row:
  see [Create your first user](#create-your-first-user).

## Running the model here too

The compose file above runs the database, API, UI and TLS on one box. The **model**
is the one piece that is not in it, because where it runs is a real decision rather
than a default:

| | Model runs | Machine | Rough cost |
|---|---|---|---|
| **A. Hosted API** | Anthropic / OpenAI | any 2-4 vCPU VM | VM + per-token usage |
| **B. Self-hosted** | this box | **GPU**, 12+ GB VRAM for a useful model | 10-20x the VM |

**A is the right default.** The AI Architect runs once per tenant onboarding, not
per request, so hosted tokens cost very little. Choose **B** only when "no third
party sees our tenants' business descriptions" is a hard requirement — a data
residency or procurement constraint, not a preference.

### A — hosted model

Add `--ai-design` to the `api` service command in `docker-compose.yml`, put
`ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) in `.env`, and `docker compose up -d`.

### B — self-hosted model, all on this VM

No edits needed. Bring the stack up with the AI overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build

# On a GPU host (NVIDIA Container Toolkit installed):
docker compose -f docker-compose.yml -f docker-compose.ai.yml \
               -f docker-compose.ai-gpu.yml up -d --build
```

That adds two services: `ollama`, which is never published and is reachable only by
the API over the compose network, and a one-shot `ai-pull` that fetches
`OPERATE_AI_MODEL` into a named volume before the API starts. Re-running `up` is a
no-op once the model is present.

Set `OPERATE_AI_MODEL` in `.env` to any Ollama tag. Two things matter more than
raw speed:

- **It must emit strict JSON.** The Architect's output is parsed into a manifest and
  cross-validated; a model that drifts out of JSON fails the design, however quickly
  it fails. Instruction-tuned 14B-class models are the smallest that hold up.
- **It must fit in VRAM.** ~10-12 GB for a 14B at 4-bit, ~6 GB for a 7-8B. Spilling
  to system RAM costs most of the GPU's advantage.

Without a GPU this still runs, but a design takes minutes instead of seconds — fine
to try, not fine to put in front of tenants.

## Which host to run this on

Everything above needs one thing that rules most platforms out: **a long-running
process**. `operate-server` runs its schedulers in-process — cron jobs, the dangling-
link prune, the notification drain, JWKS refresh, manifest-activation polling,
chain checkpoints. Serverless and edge runtimes stop the process between requests, so
those never fire. Vercel and friends can host `operate-web`, never the API.

| Path | Provider | Best when |
|---|---|---|
| One VM, everything | **Hetzner Cloud** (CCX + volume) | Pre-revenue, cost matters. Runs this compose file unchanged |
| Managed database, less ops | **Railway** / **Render** | You would rather not run Postgres yourself |
| Room to grow | **Fly.io** (apps + Managed Postgres + GPU machines) | Multi-region later — see the `residency` package |
| Regulated buyers | **AWS** / **GCP** / **Azure** | You need a signed BAA or DPA. Hetzner will not sign one |

Two notes that matter more than price:

- **Take managed Postgres earlier than feels necessary.** Point `PGHOST` at it and
  drop the `db` service — this compose file already supports that. Backups and PITR
  are the last thing you want to be writing yourself, and the `dr` package's RPO/RTO
  targets are aspirational without them.
- **Managed Postgres usually forbids C extensions**, so `pg_uuidv7` is unavailable.
  That is already handled: run `supabase/00-uuidv7.sql` once to define the pure-SQL
  `uuid_generate_v7()`. The migration applier accepts either.
