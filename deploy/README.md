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
# Edit .env: set POSTGRES_PASSWORD, DOMAIN, ACME_EMAIL, a strong token in
# OPERATE_ADMIN_API_KEY, and the two login secrets (CREDENTIAL_PEPPER and
# OPERATE_TOKEN_SIGNING_KEY). The UI has a login now, so you create the first
# tenant and user yourself -- five curl calls, no shell in the container; see
# "The UI has a login" below.

docker compose up -d --build          # build images + start everything
docker compose logs -f migrate        # watch the schema apply, then exit 0
```

When `migrate` has exited successfully and `caddy` has obtained certificates
(`docker compose logs -f caddy`), open:

- **UI:** `https://erp.example.com` — the admin console; tenant management is at `/platform`
- **API:** `https://api.erp.example.com`

> The `migrate` job is idempotent (hash-tracked in `_meta_migrations`), so it is safe
> to run on every `up`. It applies the full meta-schema before the API starts.

### If `extensions` exits 2

```bash
docker compose logs extensions
```

Exit **2** is psql's code for *the connection to the server went bad* — it never ran the SQL. That
matters, because a failure **in** `00-extension.sql` would be exit **3** under `ON_ERROR_STOP=1`, and
only then is the extension the thing to look at. Two causes, and the log names which:

- **`connection to server at "db" … failed`** — the container could not reach Postgres. On a first
  `up` this was a race until the `db` healthcheck gained `-h 127.0.0.1`: without a host
  `pg_isready` probes the Unix socket, and the official entrypoint runs the init scripts against a
  temporary server started with `listen_addresses=''`, so the socket answers *accepting connections*
  while nothing is listening on 5432. `docker compose up -d` again succeeded, which is what made it
  look intermittent. Pull and rebuild if your compose file predates that flag; otherwise check the
  `db` container is up at all (`docker compose ps`).
- **`role "…" does not exist`** or **`password authentication failed for user "…"`** — `.env` is the
  problem and the database is fine. `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` are read
  by *both* services: `db` creates that role at initdb time and `extensions` connects as it. Two
  causes, and this message cannot tell you which:

  **The value changed after the first `up`.** Postgres uses it once, to create the role in a fresh
  data directory, so a later edit does not change the role's password — the volume still holds a
  cluster made with the old one, which is why `db` reports healthy while nothing can connect. Put
  the old value back, or destroy just the database:

  ```bash
  docker compose down
  docker volume rm crossengin_db-data      # erases the database
  docker compose up -d --build
  ```

  Removing that one volume rather than `down -v` is deliberate: `-v` also takes `crossengin_caddy-data`,
  and re-issuing the certificate counts against Let's Encrypt's limit of 5 duplicate certificates
  per week — cycle a few times and you are rate-limited into plain HTTP, where the login silently
  cannot work.

  **Or `$` / `#` in the password.** Compose interpolates `$NAME` in `.env`, so `pa$$word` becomes
  `pa` plus two empty variables behind a "variable is not set" warning that scrolls past in a build
  log, and `#` starts a comment. `openssl rand -hex 24` avoids the question.

  To keep the database instead, set the role's password to match `.env`. A local socket connection
  inside the container is trusted, so this needs no password:

  ```bash
  docker compose exec db psql -U "$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)"     -d postgres -c "ALTER ROLE "$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)"     WITH PASSWORD '$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)'"
  ```

Nothing downstream runs if this fails: `migrate` is gated on
`extensions: service_completed_successfully` and `api` on `migrate`, so a stack whose first service
could not connect reports exactly this one error and stops, rather than failing later somewhere less
obvious.

### If `migrate` exits 1

Read the reason first — it is printed, and there are only a few:

```bash
docker compose logs migrate
```

**`PRECONDITIONS FAILED — no statements were executed … [MISSING_EXTENSION]
uuid_generate_v7() is required but is neither an installed extension nor a defined function`**

The database has no `uuid_generate_v7()`. Every `meta.*` id defaults to it, so the applier refuses
before executing anything — nothing is half-applied.

It happens on a `db-data` volume that was created **before** the image could install the extension,
and the arm64 build defect guaranteed a population of those: `postgres/init/00-extension.sql` runs
from `/docker-entrypoint-initdb.d`, which the entrypoint fires **only on the first initialisation of
an empty data directory**, so fixing the image does not repair a database created before it. initdb
is skipped, `db` reports healthy, and `migrate` fails identically on every `up`.

The one-shot `extensions` service now issues `CREATE EXTENSION IF NOT EXISTS pg_uuidv7` on **every**
`up` for exactly this reason, so the repair is just:

```bash
git pull && docker compose up -d --build
```

If you are on a stack without that service, the same statement by hand (keeps all data):

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_uuidv7' \
  -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto'
docker compose up -d
```

If `CREATE EXTENSION` answers `extension "pg_uuidv7" is not available … Could not open extension
control file`, the **server** does not have the `.so` and the image needs rebuilding
(`docker compose build --no-cache db`) — that is the arm64 case, and it is a build defect rather
than a database one.

Starting over instead, **which destroys every row**:

```bash
docker compose down -v && docker compose up -d --build
```

Other reasons `migrate` exits 1, in rough order of likelihood: `.env` not present or
`POSTGRES_PASSWORD` disagreeing with the volume's stored password (the password is set at initdb and
changing `.env` afterwards does not change it); and individual statements failing, which the report
lists with an index and a message — the applier continues past a failure and re-runs it next time,
so a partial apply is recoverable.

## Create your first tenant

Once up, use the platform console you just launched — which now needs a login, so do
**The UI has a login** below first. Via the API instead:

```bash
# The token half of OPERATE_ADMIN_API_KEY, i.e. everything before the first colon.
ADMIN_TOKEN=${OPERATE_ADMIN_API_KEY%%:*}

curl -sS -X POST https://api.erp.example.com/v1/platform/tenants \
  -H "x-api-key: $ADMIN_TOKEN" -H 'content-type: application/json' \
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

The registry that creates one is mounted: `--platform-user-routes --platform-user-role
platform_admin` is on the `api` command. It was *not*, for as long as this section has
existed — the compose file's own comment named the flag and the command did not pass it,
so every reader of this page was told to POST to a route their stack did not serve. The
grant is fail-closed, so with no `--platform-user-role` nothing is mounted at all and the
API says so at boot; it is deliberately a *different* grant from `--platform-admin-role`,
because the people who may create tenants need not be the people who may mint the
identities inside them. The calls below use the bootstrap key, which is why the shipped
value is `platform_admin`.

```bash
# Provision the principal and its tenant membership in one call. `id` is accepted — and is
# the point — because the id that needs a row is one the deployment has already committed
# to in an --api-key spec.
curl -sS -X POST https://api.erp.example.com/v1/platform/users \
  -H "x-api-key: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"user":{"id":"<user-uuid>","email":"ana@acme.example","displayName":"Ana"},
       "membership":{"tenantId":"<tenant-uuid>","primaryRole":"cashier","status":"active"}}'

# Or grant a membership to an existing principal (the tenant comes from the path, never
# the body). `status` has no default: "active" grants access now, "invited" only promises
# it, and only an active membership resolves as a notification recipient.
curl -sS -X POST https://api.erp.example.com/v1/platform/tenants/<tenant-uuid>/members \
  -H "x-api-key: $ADMIN_TOKEN" -H 'content-type: application/json' \
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

The api-key above is a simple shared secret — fine to bootstrap, but for real
end-users switch `operate-server` to JWT/JWKS by adding these args to the `api`
service `command` in `docker-compose.yml`:

```
--jwks-url https://your-idp/.well-known/jwks.json --jwks-refresh-ms 300000
--jwt-issuer https://your-idp --jwt-audience crossengin-api
```

Keep a single `platform_admin` API key only for the console. See
`operate-server --help` for the full flag surface (SLO enforcement, audit chain,
checkpoints, billing, marketplace, etc.) — add the flags you want to the `api` command.

Three things the boot log tells you about this deployment's exposure, which are worth
reading once after the first `up`:

- **`[auth] api-key specs: …`** — where the specs came from. A spec's token *is* a
  credential and argv is readable by anyone who can run `ps`, so the compose file passes
  them as `OPERATE_API_KEY_SPECS` in the `environment:` block. If this line names argv,
  something is still passing `--api-key`. Both sources are read and concatenated, so
  moving one does not lose the other.
- **`[pg] database channel: PGSSLMODE=…`** — what the database wire promises. It carries
  `app.current_tenant_id`, which is the whole tenant-isolation boundary, on every query.
  Inside this compose stack the hop is a private Docker network and the default `prefer`
  is reasonable; the moment the database is anywhere else, `PGSSLMODE=verify-full` is the
  only mode that validates its certificate. `require` encrypts and authenticates nothing.
- **`[cursor] cursor disclosure: …`** — whether a caller can read a classified field's
  value out of an entity-list cursor. The keyset cursor carries the plaintext of every
  declared sort key, and the response body's redaction is a different code path that does
  consult the caller's grants — so `?sort=<classified field>` returns in `nextCursor` what
  the same response just withheld. `erp-core` has one such field
  (`Employee.work_email`, `pii`), so this line says `plaintext_disclosing` until
  `CURSOR_ENCRYPTION_SECRET` is set, and names the field either way.

### The UI has a login

It did not until ADR-0358. `operate-web`'s proxy sent one fixed `OPERATE_WEB_API_KEY` on
every request, so **every browser that could reach `$DOMAIN` was that principal** — on the
shipped compose, a `platform_admin` who can provision and delete tenants — and Caddy
terminates TLS and forwards without checking a credential. That variable no longer exists.

What is there now: a `/login` form, an `httpOnly; Secure; SameSite=strict` session cookie,
a `middleware.ts` that redirects a cookie-less page request and answers a cookie-less
`/api/*` request with a 401, and a proxy that forwards **the viewer's own** token. The
cookie is only a hint — the API verifies the token on every request, so a forged or expired
one is a 401 from the API rather than something the browser layer decides.

Three things to know before you expose it.

**Set the two secrets.** `CREDENTIAL_PEPPER` and `OPERATE_TOKEN_SIGNING_KEY` are required,
and `.env.example` says what each is for and how to generate it. The boot line is
`[auth] credential login: enabled (kid login-v1, public key …)`; if it says `refused`,
nobody can log in and the reason names the variable.

**One boot line on a fresh stack is an error and is correct.** `--tenant-status-gate` is a
default now, and it surveys the tenants your api-key specs name before the first request:

```
[tenant-status] 1 configured API-key tenant(s) have no meta.tenants row and EVERY request
from them will be refused 403: 00000000-0000-4000-8000-000000000000
```

That is the placeholder uuid in `OPERATE_ADMIN_API_KEY`, and it has no row because the tenant
id is **minted by the server** — there is no way to name a tenant that does not exist yet. The
key is a platform-routes credential and `/v1/platform` is exempt from the gate, so the
bootstrap below still runs and the console still works. Do not read the line as the default
having broken the deployment; it goes away when a key points at a provisioned tenant. What the
gate buys is the other case: before it, an api-key naming a placeholder tenant *with an ERP
role* was served **200**, writing records under a `tenant_id` with no parent row.

**Create the first user by hand — but not with a shell.** There is no mail channel in a fresh
deployment, so there is no "forgot password" and no self-service sign-up: somebody has to make
the first account deliberately. `.env.example` has the five commands and every one of them is a
`curl` against `127.0.0.1:8787` — create the tenant, create the user, grant a membership (which
is what decides the role every session of theirs carries), set the password, log in.

This paragraph used to say the first password was a shell step, and gave the reason as: the
console sets a password over HTTP, and reaching that route needs a session, which needs a
password. **That reasoning expired when ADR-0364 shipped the operator route**, and it had been
false since: `POST /v1/platform/users/{id}/credential` is authorised by the
`--credential-admin-role` *grant*, which the shipped compose passes, and the credential that
satisfies it is `OPERATE_ADMIN_API_KEY` — an api-key, not a session. Measured on a stack holding
no password anywhere: that call answers 200 with `x-api-key` alone. `set-credential` remains the
answer for a deployment that grants no credential-admin role, and it is the only path that works
with the API refusing requests; it is no longer the only path for this one. The password comes
from the environment and never from argv either way; the subcommand refuses `--password` by name
and says why.

**Every user after the first is a console step** — see *The console* below. Until ADR-0364 that
was not true of any of them: `--platform-user-routes` mounted ten identity routes and the one act
that makes them usable had no route at all, so onboarding broke at step 3 of 4 and a
`docker compose exec` was mandatory per person.

**And the documented bootstrap was one step short of runnable until now.** Every version of it
omitted creating the tenant, so the membership call — step 3 of 5 — answered
`422 cannot grant a membership: meta.tenants has no row for the id this grant names` on every
fresh deployment, and there was no documented source for the `<tenant-uuid>` it wanted. The
tenant id is **minted by the server** (`POST /v1/platform/tenants` takes `{slug, name}` and
rejects an `id` key), which is also why `OPERATE_ADMIN_API_KEY`'s tenant uuid is a placeholder
that can never name a real tenant — and why `/v1/platform` is exempt from the tenant-status gate.

**A session's roles are frozen until it expires.** The membership's primary role *and its
secondary roles* are read at login and stamped into the token, and nothing re-reads the
directory per request. So granting, revoking or downgrading a membership takes effect at the
next login, within `--session-token-ttl` (one hour by default; lower it if that window
matters to you). The same is true of suspending a user. If you need a session cut off now,
rotate `OPERATE_TOKEN_SIGNING_KEY` — that invalidates every session at once.

Secondary roles are additive and were inert before ADR-0369: the membership form accepted
them, stored them and showed them in the Members panel, and the session carried the primary
alone. A principal now holds the union of its roles, so the usual answer to "this person
administers tenants *and* works in the ERP" is one membership with
`primaryRole: platform_admin` and `secondaryRoles: ["erp_admin"]` — measured on `erp-core`,
that reaches 250 of 255 (entity, operation) pairs where `platform_admin` alone reaches 0.
Two consequences worth knowing. A role name may not contain a space (the token's scope claim
is space-delimited, so the grant is refused with that reason). And an **api-key** carries
exactly one role whatever the membership says — `--api-key key:role:tenant` has one role
field and names no person, so there is no membership to read a list from; if a key needs two
roles, declare a manifest role that inherits both.

A wrong password locks the account after `--login-lockout-attempts` tries (10 by default)
for `--login-lockout-seconds` (15 minutes). That bounds guessing against one account and
deliberately does **not** address credential stuffing — one password tried across many
accounts — for which there is no per-IP limit available here: behind Caddy every request
arrives from the same container address. It also means anyone who knows an email address can
lock that user out for the window, which is why the window lapses rather than being
permanent and why `set-credential` clears a lock.

### The console

Once you can log in, `https://$DOMAIN` is where the deployment is operated. What is reachable,
and what is not:

| Where | What you can do |
| --- | --- |
| **Platform → Tenants** | List, filter by status, create. Open one to see its record and to suspend / archive / reactivate it — each needs a typed **reason**, which lands in the tenant's permanent lifecycle trail. |
| **Platform → Tenants → one tenant** | Grant a membership (user id, primary role, optional secondary roles, and a status you must choose), activate or revoke one, and see every member of that tenant. The secondary roles are additive and take effect at that person's next login — they were accepted and inert before ADR-0369. |
| **Platform → Users** | List every `meta.users` row with a per-status census, filter by status or by exact email address, provision a new one, and open one to suspend / reactivate / retire it. |
| **Platform → Users → one user** | **Set their password.** This is the route that did not exist before ADR-0364 and the reason onboarding needed a shell. It cannot be aimed at yourself. |
| **Platform → Design Reviews** | Approve or reject a manifest the Architect designed, with a field-level diff. This page used to 404: the routes behind it mount on `--design-review`, which the compose did not pass. It does now, via `--require-design-review`. The diff covers five of the manifest's sixteen sections and has **no `jobs` and no `views` layer**, so read it as "what entities, roles, permissions and classifications changed", not as the whole change. |
| **AI Studio** (`/setup`) | Describe a business in prose and have the Architect design a manifest for it. Activating one **merges it over this deployment's pack** — before ADR-0368 it replaced the pack outright, so a design with four entities took the other forty-seven away from that tenant. Activation now requires a platform reviewer's approval. It does **not** create typed Postgres tables on `--store pg`; the new entities live in the shared JSONB record table. |
| **/account** | Change your own password. Needs the current one, so it is the one credential act that needs no grant. |

Four things it deliberately does **not** do, so you know where the edges are:

- **Email search is exact, not partial.** `?email=` is matched whole and case-folded, because
  `meta.users.email` is UNIQUE so an equality is one index lookup where a substring search is an
  unindexed scan of the table. You can find an address you know; you cannot find one you
  half-remember. Page, or open a user by id.
- **No "which tenants is this user in" view.** Memberships are reached from the tenant, never
  from the user, because that read has no tenant to scope by and would be correct as the
  table's owner and empty as anything else. The user page says so and links back.
- **No role dropdown when granting a membership.** The valid roles come from the tenant's
  resolved manifest and no route serves the list, so the field is free text — but the grant *is*
  checked against it, and a role the manifest does not declare comes back on the response named
  beside the ones it does, in the panel and in the audit trail. It is still accepted and stored,
  and it still grants nothing at serve time: a per-tenant manifest may declare roles the boot
  pack does not, so this warns rather than refusing. The warning now offers the declared names
  for a **secondary** role too, which it withheld before ADR-0369 because re-granting one with a
  declared name bought nothing.
- **No database browser and no SQL.** A tenant's records are served by that tenant's own
  compiled gateway, under that tenant's field grants, classification and redaction. A
  platform-level reader would be a second path to the same rows with none of that applied.

Setting someone's password needs `--credential-admin-role` on the `api` command; the shipped
compose grants it to `platform_admin`. Without it the panel says so and names
`set-credential` as the shell path, rather than failing as though the user were missing.

Three limits of that panel are worth knowing before you use it:

- **It cannot be aimed at the person using it** (403 `self_not_permitted`), because it does not ask
  for the current password — so aiming it at yourself would replace your own credential without
  proving you hold it, which is what a stolen browser session would do. Change your own at
  `/account`. One caveat, which is honest rather than reassuring: that check compares the caller's
  principal id to the target's, and the **bootstrap api key names no person** — a
  `token:role:tenant` spec resolves to a service account on a shared placeholder id — so for that
  credential there is no "yourself" to refuse, and nothing for the check to protect either, since a
  service account has no password to take over. It bites where it matters, which is a signed-in
  person using the console.
- **A retired user is refused** (403 `user_not_active`). `deleted` has no transition back to
  `active`, so a password set then could never be used by anybody.
- **A suspended user succeeds and says so.** The password is written and the response says logging
  in is still refused until you reactivate them — setting one ahead of a reactivation is a real
  workflow, and an unqualified "credential set" for an account the login rejects outright would be
  a success message for a password that does not work.

**The API also answers on `127.0.0.1:8787`** on the VM itself, which is where the bootstrap curls in
`.env.example` go. That publish is loopback-only on purpose: it is reachable by exactly the people
who can already run `docker compose exec`, and it means creating the first user does not wait on DNS
or on Caddy holding a certificate. The same API is at `https://api.$DOMAIN` from anywhere else.

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
  (the `migrate` job re-applies any new schema before the API restarts). After the upgrade
  that landed the user registry, read
  [Clearing the foreign-key drift](#clearing-the-foreign-key-drift-after-an-upgrade) once —
  until you do, `migrate` reports the same 29 findings on every `up`.
- **Backups:** the data lives in the `db-data` volume. Dump regularly, e.g.
  `docker compose exec db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql`.
- **Logs:** `docker compose logs -f api` / `web` / `caddy`.
- **Stop / start:** `docker compose down` (keeps volumes) / `docker compose up -d`.
- **Scale the API:** the API is stateless — run several `api` replicas behind Caddy
  and they share Postgres safely (idempotency, advisory locks, RLS all hold).

### Clearing the foreign-key drift after an upgrade

A **fresh** database is unaffected by this section: it gets the patched shape straight out of
the bootstrap SQL and reports nothing. An **existing** one will report the same drift on every
`up`, forever, until an operator clears it once.

What the drift is: the catalog stopped declaring **29 foreign keys** that your database is
still enforcing — **14** into `meta.users` and **15** into `meta.tenants`. Both removals are
deliberate, and each closed a live defect:

- A column recording *who performed an act* is a record of the past, and a `RESTRICT`
  reference on it made the actor undeletable as a consequence of having acted. Those nine
  actor columns are plain `TEXT` now, which is why the stores above can record whichever
  principal acted without a registry row existing first. Three references were *kept* and
  strengthened to `CASCADE` instead — a user's own per-viewer state, which must go when the
  user does.
- A table whose purpose is to outlive the tenant it describes cannot be a `CASCADE` child of
  that tenant's row. Fifteen of the sixteen tables the GDPR Article 17 erasure protects by
  name were exactly that, so retiring the `meta.tenants` row destroyed the platform's record
  of the deletion one statement after the erasure had carefully preserved it.

`migrate` reports all 29 and does not act, because the reconciliation planner will not drop a
foreign key unless it is told to. Each appears as an `unreconciled` finding with reason
`foreign_key_removed` and the SQL beside it. To see the list without touching anything:

```sh
docker compose run --rm migrate \
  node apps/architect-cli/dist/bin/crossengin.js apply --plan
```

To clear it, run the applier **once** with `--allow-loosening`:

```sh
docker compose run --rm migrate \
  node apps/architect-cli/dist/bin/crossengin.js apply --confirm --allow-loosening
```

It says so on stderr before anything runs: this is the one invocation that removes a
constraint the database is currently enforcing.

**Do not add `--allow-loosening` to the `migrate` command in `docker-compose.yml`.** It is a
one-time invocation on purpose. Left in place it converts every *future* undeclared-foreign-key
refusal into a silent drop, and that refusal is the only guardrail between a typo in the
catalog and a dropped constraint on a live database.

The nine actor columns also change type (`UUID` → `TEXT`). The planner changes a column's type
only on an **empty** table, under a guard that re-checks emptiness in its own transaction;
these tables are empty in every deployment today precisely because nothing could write them,
which is the cheapest moment this change will ever have. If one of yours is not empty, the plan
reports the `ALTER` rather than running it — the exact statements are in ADR-0335's
implementation notes (`docs/adr/0335-the-record-nobody-could-write.md`).

**One statement stays manual, forever.** `meta.rate_limit_decisions` also lost a *column* —
`quota_definition_id`, whose `rlq_` ids have no declaration site anywhere, so re-typing it to
`TEXT` would have been the same hole in a different type. `--allow-loosening` reaches foreign
keys only, by design: dropping a foreign key is the single loosening that cannot fail against
existing rows, which is what keeps every step in a plan expected to succeed. So `column_removed`
is never planned, with or without the flag, and the catalog will report that column as drift
until you run this once as the table owner:

```sql
ALTER TABLE meta.rate_limit_decisions DROP COLUMN IF EXISTS quota_definition_id;
```

`DROP COLUMN` takes `idx_rate_limit_decisions_quota_definition` with it, so the accompanying
`index_removed` finding needs no statement of its own.

## Sending email and SMS

Out of the box only **in-app** notices are delivered: an email or SMS dispatch is refused as
`no_sender_configured`, which the drain treats as retryable — so configuring a channel later
delivers the backlog rather than losing it.

That sentence was false until the drain flag became a default, and in the direction that reads as
working. `DeliveryScheduler` is the *only* delivery path in this binary, so without
`--notification-drain-ms` nothing is delivered on **any** channel, `in_app` included — and the
warning that was supposed to say so could not fire, because it was gated on more than one channel
being registered and this stack registers exactly one. Boot printed `[notify] channels: in_app` and
stopped. The flag is now on the `api` command, and the gate is the store rather than the channel
count, so a deployment that removes it is told.

To turn email and SMS on, fill the SES and/or Twilio block in `.env` (see
[`.env.example`](./.env.example)). The drain is already running.

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

## Approving a tenant's design

A design is not live until **you** approve it. The compose passes
`--require-design-review`, so the flow has four parties and two of them are you:

1. The tenant's own `erp_admin` opens **AI Studio** and describes their business.
2. The Architect designs a manifest. It is stored as a proposal, enrolled as
   `pending`, and the tenant can read their own diff.
3. The tenant presses Activate and gets **403 `review_required`** carrying the
   proposal's `reviewStatus`. Nothing has changed for them.
4. You open **Platform → Design Reviews**, read the diff, and approve or reject. Only
   then does their Activate succeed.

Three things to know before the first one arrives.

**Approval is the only gate, so read the diff rather than the summary.** It covers
five of the manifest's sixteen sections — entities, relations, roles, permissions
and workflows. A lifecycle the Architect added **is** shown (`lifecycle added with
3 states`), and narrowing an existing one is flagged **breaking**. There is no
`jobs` layer and no `views` layer, and both of those *are* served, so a design can
change what a request gets in a way the diff does not show you.

**The diff does not show you `meta.extends`.** Measured: adding it produces zero
counts and zero warnings. So the one thing every AI design now declares — which pack
it builds on — is invisible on the page where you approve it. It is checked at build
time rather than trusted (a tenant may extend only this deployment's own pack, and
anything else is refused), so this is a gap in what you can *see* and not in what is
*enforced*. Until it is closed, read the proposal's own JSON if the lineage matters
to you.

**An activated manifest merges over this deployment's pack; it does not replace it.**
That is new in ADR-0368. Before it, `meta.extends` on a stored manifest was parsed
and never followed, so activating a four-entity design took the other forty-seven
entities, fifteen roles and nineteen workflows away from that tenant. A tenant may
extend **only the pack this deployment serves** — naming anything else is refused at
build time with `lineage_parent_unknown` and the tenant is served a 503 rather than
quietly being given the base pack.

**Turning the gate off later does not un-gate old proposals, and turning it on
stranded the ones minted before it.** The activation gate denies `not_required` as
well as `rejected`, so any proposal created before this flag went live must be
designed again. If you had drafts on this deployment before upgrading, that is why.

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

`--ai-design` is already on the `api` command. Put `ANTHROPIC_API_KEY` (or
`OPENAI_API_KEY`) in `.env` and `docker compose up -d`. Until one of them is set the
routes still mount and `POST /v1/ai/design` answers **503** — deliberately, so a
missing key is not a failed boot.

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
| One VM, everything, **free** | **Oracle Cloud** Always Free (Ampere A1) | You want the whole stack running at zero cost. Step-by-step: [`ORACLE.md`](./ORACLE.md) |
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

## On Oracle Cloud (Always Free)

**A complete step-by-step runbook is [`ORACLE.md`](./ORACLE.md).** What follows is the summary and
the one architectural thing that is different there.

Of the free options this is the only one that can host the **whole** stack, and the
reason is the sentence above: the API needs a long-running process, and Always Free
gives you a real VM rather than a function. Vercel's free tier cannot host
`operate-server` at any price point — not a quota problem, a runtime-model one — so a
"free" Vercel deployment is always a partial one. Here nothing is split.

What the tier gives you, with one caveat worth checking before you plan around it:

| | Always Free |
|---|---|
| Compute | **Ampere A1 (arm64)**, 1–4 instances sharing the quota |
| | Oracle cut that quota from 4 OCPU / 24 GB to **2 OCPU / 12 GB** in June 2026 with no announcement, and reports of enforcement are inconsistent — check Oracle's [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm) page, not this table |
| | Also 2× AMD `E2.1.Micro` (1 OCPU / 1 GB). **Ignore these**: `pnpm -r build` across 87 packages plus `next build` will not complete in 1 GB |
| Block storage | 200 GB total, boot volumes included; 47 GB is the per-instance minimum |
| Egress | 10 TB/month |

**2 OCPU / 12 GB runs this comfortably.** The heaviest moment is the image build, not
serving.

### The one thing that is different on Oracle

Always Free compute is **arm64**, and until this commit `deploy/postgres/Dockerfile`
could not produce a working database image on it. It installed `pg_uuidv7` from the
project's GitHub release, which ships a single prebuilt `.so` built for x86_64 only —
and because installing it is a file copy, the build *succeeded* and produced an image
whose `CREATE EXTENSION` then failed at `initdb` time with a wrong-ELF-class error.
`ON_ERROR_STOP=1` turns that into an aborted initialisation, so the `db` container
never came up and nothing in the output pointed at the architecture.

It now installs `postgresql-$PG_MAJOR-pg-uuidv7` from the PGDG apt repository, which
publishes amd64 and arm64 and which the official `postgres` image already leaves
configured. No architecture is named anywhere, so the same Dockerfile builds on your
laptop and on the A1. The other three images (`node:20-bookworm-slim`, `caddy:2`,
`postgres:16-bookworm`) are already multi-arch.

### Step by step

**1 — Account and region.** Sign up at `cloud.oracle.com`. A card is required for
identity verification and Always Free resources are not billed against it. Pick your
home region carefully: it cannot be changed, and A1 capacity varies by region.

**2 — Network.** *Networking → Virtual Cloud Networks → Start VCN Wizard → VCN with
Internet Connectivity.* Accept the defaults. This gives you a public subnet, an
internet gateway and a route table, which is all this needs.

**3 — Instance.** *Compute → Instances → Create instance.*

- Image: **Canonical Ubuntu 24.04** — make sure you pick the **aarch64** build.
- Shape: *Change shape → Ampere → `VM.Standard.A1.Flex`* → 2 OCPU, 12 GB.
- Networking: the VCN and public subnet from step 2, **assign a public IPv4 address**.
- Boot volume: raise it to **50 GB** (the 47 GB default leaves little room for images).
- Add your SSH public key.

If you get **"Out of host capacity"** you have not done anything wrong — A1 is heavily
subscribed. Try another availability domain, then retry on a loop; capacity is released
continuously.

**4 — Open 80 and 443, in both places.** This is the step that catches everyone,
because Oracle filters twice and fixing one half looks like the fix having failed.

*Networking:* open the subnet's security list and add two ingress rules — source
`0.0.0.0/0`, protocol TCP, destination port 80, then the same for 443.

*On the instance:* Oracle's Ubuntu images ship with `iptables` rules that reject
everything else, and they persist across reboots:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

**5 — Docker.**

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && exec sg docker newgrp
```

**6 — Swap, if you took the 12 GB shape and want the build to be dull.** The image
build is the only memory-hungry step; 4 GB of swap means it cannot be the thing that
fails.

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**7 — DNS.** Point two A records at the instance's public IP: `yourdomain.com` and
`api.yourdomain.com`. Both are needed — the `Caddyfile` serves the UI on the apex and
the API on `api.`, and Let's Encrypt will not issue until they resolve.

**8 — Bring it up.** Exactly the [First launch](#first-launch) steps above; nothing
here is Oracle-specific.

```bash
git clone <your fork> crossengin && cd crossengin/deploy
cp .env.example .env    # then set POSTGRES_PASSWORD, DOMAIN, ACME_EMAIL,
                        # OPERATE_ADMIN_API_KEY, CREDENTIAL_PEPPER,
                        # OPERATE_TOKEN_SIGNING_KEY and CURSOR_ENCRYPTION_SECRET
docker compose up -d --build
docker compose logs -f api
```

The first build takes 10–20 minutes on 2 A1 cores. Then read the boot lines the
[Going to production (auth)](#going-to-production-auth) section lists — `[auth]` twice,
`[pg]` and `[cursor]` — and create your first tenant and user with
[Create your first tenant](#create-your-first-tenant) and
[Create your first user](#create-your-first-user). There is no sign-up page and no
forgot-password, so you create the first account yourself — five `curl` calls against
`127.0.0.1:8787` and no shell in the container, since the compose grants
`--credential-admin-role`; [The UI has a login](#the-ui-has-a-login) explains why.

**9 — Backups.** *Block Volume → your boot volume → Create Backup Policy.* Always Free
includes 5 volume backups, which is a snapshot story and not a PITR one. A volume
snapshot of a running Postgres is crash-consistent rather than transaction-consistent,
so pair it with a logical dump:

```bash
docker compose exec -T db pg_dump -U crossengin crossengin | gzip > dump-$(date +%F).sql.gz
```

This repository models DR tiers with RPO/RTO targets and does not yet ship a backup
scheduler, so until it does, that cron line is the deployment's real recovery point.

### Should the UI go on Vercel instead?

You can: `operate-web` is a Next.js app and Vercel hosts it happily. On Oracle there is
little reason to, and two reasons not to.

What splitting costs you: the browser → UI → API hop stops being a private Docker
network and crosses the public internet, so it needs its own TLS and its own thinking
about who may reach `api.yourdomain.com`; and you lose the compose dependency that
makes `web` wait for the API's `/readyz`, which is what currently stops Caddy serving
502s from a UI pointed at an API that refused to boot.

What it buys you: a CDN edge and preview deployments. The UI is 15 pages of which 11
are statically prerendered, so the edge wins little, and every page is a proxy call to
the API on the Oracle box regardless.

So: **all on Oracle.** Put the UI on Vercel only if you want preview deployments for
UI work, and then set `OPERATE_API_URL` to `https://api.yourdomain.com` and keep the
API where it is.
