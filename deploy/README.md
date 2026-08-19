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

- **`pg_uuidv7`:** the DB image (`deploy/postgres/Dockerfile`) compiles the extension in
  because the migration applier requires the *extension*, not just a function. If you use
  a **managed** Postgres instead, ensure `CREATE EXTENSION pg_uuidv7;` succeeds there and
  point `PGHOST`/… at it (drop the `db` service).
- **AI features are not required to serve.** `operate-server` never calls an LLM at
  runtime — the AI Architect (natural-language manifest authoring) is a separate,
  dev-time tool (`crossengin chat` in `architect-cli`). See the main README for
  self-hosting an open-source model behind it.
