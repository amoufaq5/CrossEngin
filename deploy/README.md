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

## Day-2 operations

- **Update to a new version:** `git pull && docker compose up -d --build`
  (the `migrate` job re-applies any new schema before the API restarts).
- **Backups:** the data lives in the `db-data` volume. Dump regularly, e.g.
  `docker compose exec db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql`.
- **Logs:** `docker compose logs -f api` / `web` / `caddy`.
- **Stop / start:** `docker compose down` (keeps volumes) / `docker compose up -d`.
- **Scale the API:** the API is stateless — run several `api` replicas behind Caddy
  and they share Postgres safely (idempotency, advisory locks, RLS all hold).

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
  (`token:role:tenant:user`) is the principal's `meta.users.id`. The notification
  inbox is per-recipient, so a key without it gets an empty one. That is correct
  for the platform-admin bootstrap key — it is an operator, not a tenant user —
  but any key belonging to a real person should carry their user id.

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
