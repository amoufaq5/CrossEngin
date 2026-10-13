# Launching CrossEngin on Oracle Cloud Always Free

A complete runbook. Every command is meant to be pasted in order, and each step says what
success looks like so you can tell a problem from a pause.

**Why Oracle for this stack.** `operate-server` runs its schedulers in-process — cron jobs, the
notification drain, JWKS refresh, manifest-activation polling, chain checkpoints — so it needs a
process that stays alive. Oracle's Always Free tier gives you a real VM, which is the only free
tier that can host the API at all. Vercel's free tier can host `operate-web` and never the API;
that is a runtime-model limit, not a quota.

**Time:** about 45 minutes, of which 20 is the first image build.
**Cost:** nothing, if you stay inside the limits in step 1.

---

## 0. What you need before you start

- A credit or debit card. Oracle uses it for identity verification; Always Free resources are not
  billed against it. You will also verify a phone number.
- A domain name you control, with access to its DNS records. Caddy gets a Let's Encrypt
  certificate automatically, and that needs two DNS records pointing at the VM.
- An SSH key pair. If you do not have one: `ssh-keygen -t ed25519 -C "crossengin-oracle"`.

---

## 1. The free tier, and the one number that moved

Check [Oracle's own Always Free page](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)
rather than any blog, including this one — the compute allowance was cut in June 2026 and reports
of enforcement are inconsistent.

| | Always Free |
|---|---|
| Compute | **Ampere A1 (arm64)**, 1–4 instances sharing the quota. Officially **2 OCPU / 12 GB** since June 2026 (was 4 / 24) |
| | Also 2× AMD `E2.1.Micro` at 1 OCPU / 1 GB. **Ignore these** — `pnpm -r build` across 87 packages plus `next build` will not complete in 1 GB |
| Block storage | 200 GB total, boot volumes included; 47 GB is the per-instance minimum |
| Egress | 10 TB/month |

**2 OCPU / 12 GB runs this comfortably.** The heaviest moment is the image build, not serving.

### The one thing that is different on Oracle

Always Free compute is **arm64**. Until recently `deploy/postgres/Dockerfile` could not produce a
working database image on it: it installed `pg_uuidv7` from the project's GitHub release, and
[those releases are x86_64 only](https://github.com/fboulnois/pg_uuidv7/issues/24). Because
installing the extension was a file copy, the build *succeeded* and produced an image whose
`CREATE EXTENSION` then failed at `initdb` with a wrong-ELF-class error — and the entrypoint runs
init scripts with `ON_ERROR_STOP=1`, so the container never came up and nothing in the output
pointed at the architecture.

It now installs `postgresql-$PG_MAJOR-pg-uuidv7` from the PGDG apt repository, which publishes
arm64. **If you forked this repository before that change, pull it before you build.** The other
three images (`node:20-bookworm-slim`, `caddy:2`, `postgres:16-bookworm`) are already multi-arch.

---

## 2. Create the account

1. Go to `cloud.oracle.com` and sign up.
2. **Choose your home region carefully.** It cannot be changed afterwards, and Ampere A1 capacity
   varies a lot between regions. Pick one geographically near you that is not one of the two or
   three most popular.
3. Verify your phone and card. Decline the upgrade to Pay As You Go if offered; Always Free works
   on the trial account and keeps working after the trial credits expire.

---

## 3. Create the network

*Networking → Virtual Cloud Networks → **Start VCN Wizard** → "VCN with Internet Connectivity"*.

Accept every default and create it. That gives you a VCN, a public subnet, an internet gateway and
a route table — which is all this needs.

**Success looks like:** a VCN whose subnet list shows one *public* subnet.

---

## 4. Create the instance

*Compute → Instances → Create instance.*

- **Name:** anything.
- **Image:** *Change image* → **Canonical Ubuntu 24.04**. Check the architecture says **aarch64**.
- **Shape:** *Change shape* → **Ampere** → `VM.Standard.A1.Flex` → **2 OCPUs, 12 GB memory**.
- **Networking:** the VCN and public subnet from step 3. **Assign a public IPv4 address: yes.**
- **Boot volume:** tick *Specify a custom boot volume size* and set **50 GB**. The 47 GB default
  leaves very little room for container images.
- **Add SSH keys:** paste your public key (`cat ~/.ssh/id_ed25519.pub`).

Create it, and note the **public IP address**.

### "Out of host capacity"

You have not done anything wrong — A1 is heavily subscribed. Options, in order of effort:

1. Change the *availability domain* in the create dialog and try again.
2. Retry on a loop. Capacity is released continuously, so a retry every few minutes often lands
   within an hour.
3. Try a different region (this means a new tenancy, since the home region is fixed).

**Success looks like:** the instance shows **Running** and a public IP.

---

## 5. Open ports 80 and 443 — in *both* places

This is the step that catches everyone, because Oracle filters twice and fixing one half looks
like the fix having failed.

### 5a. The subnet's security list

*Networking → Virtual Cloud Networks → your VCN → Subnets → your public subnet → Security Lists →
Default Security List → Add Ingress Rules.*

Add two rules:

| Source CIDR | IP Protocol | Destination Port Range |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

### 5b. The instance's own firewall

Oracle's Ubuntu images ship with `iptables` rules that reject everything else, and they persist
across reboots. SSH in and open the two ports:

```bash
ssh ubuntu@<YOUR_PUBLIC_IP>

sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

**Success looks like:** `sudo iptables -L INPUT -n --line-numbers | head -12` shows your two
ACCEPT rules above the REJECT rule at the bottom.

---

## 6. Install Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
exec sg docker newgrp          # or log out and back in
docker run --rm hello-world    # should print "Hello from Docker!"
```

---

## 7. Add swap

The image build is the only memory-hungry step. 4 GB of swap means it cannot be the thing that
fails on a 12 GB shape, and costs you nothing when it is not needed.

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h                        # Swap: should show 4.0Gi
```

---

## 8. Point DNS at the VM

At your registrar, create **two** A records pointing at the instance's public IP:

| Name | Type | Value |
|---|---|---|
| `yourdomain.com` (or `@`) | A | `<YOUR_PUBLIC_IP>` |
| `api.yourdomain.com` | A | `<YOUR_PUBLIC_IP>` |

Both are needed: the `Caddyfile` serves the UI on the apex and the API on `api.`, and Let's
Encrypt will not issue a certificate until the name resolves to this machine.

**Success looks like:** `dig +short yourdomain.com` and `dig +short api.yourdomain.com` both
return your IP. Give DNS a few minutes.

**Wait for this before you try the UI in a browser.** The login cannot work over plain HTTP and
fails silently when it is attempted — step 12 says exactly how — and the API's own bootstrap does
not need DNS at all, because the compose file publishes it on `127.0.0.1:8787` on the VM itself.
So there is nothing to gain by reaching for the IP address while you wait.

---

## 9. Clone and configure

```bash
git clone <YOUR FORK OF THIS REPO> crossengin
cd crossengin
git log --oneline -1                     # which commit you are about to build
cd deploy
cp .env.example .env
```

**Check which branch you are on before you build, because steps 11–14 depend on it.** The login,
the user registry and the console's password panel landed on the working branch
`claude/eloquent-archimedes-bn69tr` and `main` is behind it. On `main` the `api` command passes
neither `--platform-user-routes` nor `--credential-admin-role` and publishes nothing on the host —
so the route step 12 posts to is not registered and answers **404**, `127.0.0.1:8787` refuses the
connection, and creating a user needs the compose edit this page no longer tells you to make. A
bare `git pull` on `main` does not fix that — it is a different branch, not a newer commit:

```bash
git log --oneline origin/main -1                    # has it been merged since?
git fetch origin && git checkout claude/eloquent-archimedes-bn69tr
```

If `git log origin/main` already shows that work, stay on `main`; the check is one command and the
alternative is finding out at step 12. The arm64 database fix in step 1 is on **both**, so a plain
`git pull` is enough for that one.

Generate the five secrets. Run each line and paste the output into the matching `.env` key:

```bash
# POSTGRES_PASSWORD
openssl rand -base64 32

# OPERATE_ADMIN_API_KEY — the format is token:role:tenant, and the token is the credential.
echo "$(openssl rand -hex 24):platform_admin:00000000-0000-4000-8000-000000000001"

# CREDENTIAL_PEPPER, OPERATE_TOKEN_SIGNING_KEY, CURSOR_ENCRYPTION_SECRET — one each
for v in CREDENTIAL_PEPPER OPERATE_TOKEN_SIGNING_KEY CURSOR_ENCRYPTION_SECRET; do
  echo "$v=$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))' 2>/dev/null \
    || openssl rand -base64 32)"
done
```

Then set the two plain values:

```
DOMAIN=yourdomain.com
ACME_EMAIL=you@yourdomain.com
```

What each secret does, so you know what rotating one costs:

| Key | What it protects | Cost of changing it |
|---|---|---|
| `POSTGRES_PASSWORD` | the database | must match the volume; change before first boot |
| `OPERATE_ADMIN_API_KEY` | the platform-admin credential — it can provision and delete tenants | invalidates that key |
| `CREDENTIAL_PEPPER` | password hashes, which `meta.users` holds with no RLS | **every password stops verifying.** Do not change it after users exist |
| `OPERATE_TOKEN_SIGNING_KEY` | session tokens; the public half is derived from it | every session gets one 401 and a re-login |
| `CURSOR_ENCRYPTION_SECRET` | the keyset cursor, which otherwise carries a classified field's plaintext | cursors in flight get one 400 and a restarted page walk |

**Leave `COLUMN_ENCRYPTION_SECRET` unset.** The default `erp-core` declares no `phi`/`regulated`
field, so nothing would use it. `erp-healthcare` and `erp-government` do declare them — and
switching `OPERATE_PACK` to either is **refused at boot on the shipped `--store pg` whether or not
this secret is set**, because the JSONB store cannot encrypt a column and would hold those fields in
the clear. Setting the secret alone does not get you there: serving one of those packs means
`--store pg-columns` on the `api` command *and* this secret, and `deploy/docker-compose.yml`'s
comment above the `--pack` flag says what else that switch brings with it.

---

## 10. Bring it up

```bash
docker compose up -d --build
docker compose logs -f api
```

The first build takes **10–20 minutes** on 2 A1 cores. Expect `extensions` and `migrate` to run once
and exit 0, then `api` to boot, then `web`.

> **If `migrate` exits 1 here, this is the arm64 case and the most likely single failure on Oracle.**
> `docker compose logs migrate` will say `PRECONDITIONS FAILED — no statements were executed …
> [MISSING_EXTENSION] uuid_generate_v7() is required`. The earlier postgres image installed
> `pg_uuidv7` from a GitHub release whose only prebuilt `.so` is x86_64, so on an Ampere A1 shape
> `CREATE EXTENSION` failed at initdb — and because the entrypoint runs
> `/docker-entrypoint-initdb.d` **only** on the first initialisation of an empty data directory, a
> volume created then is never repaired by a later image. `git pull && docker compose up -d --build`
> fixes it without losing data: the image now installs the extension from PGDG (which publishes
> arm64), and the one-shot `extensions` service issues `CREATE EXTENSION IF NOT EXISTS pg_uuidv7` on
> every `up`. See *If `migrate` exits 1* in `deploy/README.md` for the by-hand form and the other
> reasons.

The boot is talkative — a dozen surveys report what this manifest and this store can and cannot
do — and these are the ones that tell you the deployment is *configured* rather than merely
running. They appear in this order, interleaved with the rest, and the four `[auth]` lines are
deliberately **not adjacent**: each is said at the point the thing it describes is actually wired,
so the first lands before the database is even opened and the last two after everything else has
mounted.

```
[auth] api-key specs: 0 from argv, 1 from OPERATE_API_KEY_SPECS — none on the command line
[pg] database channel: PGSSLMODE=prefer — the server may decline TLS …
[list] declared surfaces: all serveable on --store pg
[cursor] cursor sealing: sealed …
[cursor] cursor disclosure: sealed …
[auth] credential login: enabled (kid login-v1, public key …)
[auth] credential routes mounted: POST /v1/account/password (self) and POST /v1/platform/users/{id}/credential for roles: platform_admin
[auth] serving /v1/auth/token (session ttl 3600s, lockout after 10 failures for 900s)
```

Two further `[auth]` lines appear later and are **per-request rather than per-boot**, so do not look
for them at startup: `login refused <reason>: <detail>`, which is where a failed sign-in explains
itself to you and not to the caller, and `user <id> credential re-hashed at current scrypt
parameters`, the first time someone signs in after the cost floor has been raised.

Rather than scrolling the log for them:

```bash
docker compose logs api | grep -E '\[(auth|pg|cursor|list)\]'
```

What to do when one of them says something else:

- **`credential login: refused …`** names the variable it wants, and it is fatal rather than
  degraded: the API exits on it, so this line is followed by one `fatal:` line and nothing else.
  See *When it does not come up* below for why that does not read as `unhealthy`.
- **`credential routes mounted: … (self) only`** means `--credential-admin-role` is not granted, so
  setting *another* person's password still needs a shell. The shipped compose grants it to
  `platform_admin`; seeing this means you are on a commit that predates it (step 9).
- **`cursor disclosure: plaintext_disclosing`** means `CURSOR_ENCRYPTION_SECRET` is unset. It is the
  *disclosure* line that says so and not the sealing line, which reports `absent` for the same
  cause — two lines, because sealing is about this deployment's configuration and disclosure is
  about what the manifest you are serving actually exposes.

**Success looks like:** `docker compose ps` shows `api` **healthy** (not just *running* — the
healthcheck polls `/readyz`), and from the VM:

```bash
curl -s http://127.0.0.1:8787/readyz
# {"status":"ready","checks":[{"name":"postgres","outcome":"ready"}]}
```

That address rather than the public one because the compose file publishes the API on
`127.0.0.1:8787` — loopback only — so it answers before DNS has propagated and before Caddy holds
a certificate. Once both are in place the same check answers at `https://api.yourdomain.com/readyz`,
through Caddy.

### When it does not come up

```bash
docker compose ps                      # which service, and is it healthy?
docker compose logs api | tail -40     # the API's own refusals are explicit and named
docker compose logs db  | tail -20     # an init failure means the container never started
docker compose logs caddy | tail -20   # certificate problems live here
```

The API's boot refusals are deliberate and each names its remedy — a classified pack with no
`COLUMN_ENCRYPTION_SECRET`, an undischargeable ABAC obligation, `envelope` mode on a deployment
that encrypts nothing. They exit the process on purpose, which is why `web` waits on the API's
health rather than on its start.

**A refused boot does not show up as `unhealthy`, and that is worth knowing before you spend time
in `docker compose ps`.** A refusal throws; the binary's top-level handler writes one `fatal: …`
line to stderr and exits 1; and `api` is `restart: unless-stopped`, so compose respawns it
immediately. What you see is `api` restarting on a loop and a healthcheck that simply never passes
— no "unhealthy" anywhere, and nothing in `ps` naming a cause, because the process never lived long
enough to be probed. The log is the only place the reason exists:

```bash
docker compose logs api | grep 'fatal:'
```

---

## 11. Create your first tenant

The token half of `OPERATE_ADMIN_API_KEY` is everything before the first colon — read it out of
`.env` rather than retyping a credential:

```bash
# Run from crossengin/deploy, so .env is beside you.
ADMIN=$(grep '^OPERATE_ADMIN_API_KEY=' .env | cut -d= -f2- | cut -d: -f1)

# http://127.0.0.1:8787 and not https://api.yourdomain.com: the compose file publishes the API on
# the loopback interface for exactly this moment, when DNS may not have propagated and Caddy may
# hold no certificate yet. Both reach the same API; from anywhere but the VM, use the public name.
curl -sS -X POST http://127.0.0.1:8787/v1/platform/tenants \
  -H "x-api-key: $ADMIN" -H 'content-type: application/json' \
  -d '{"slug":"acme","name":"Acme Ltd","tier":"small","region":"eu"}'
```

Note the returned tenant `id`. The `schema_name` is derived from the slug. Hard deletion is
deliberately not on this surface — that is the audited GDPR flow behind
`--tenant-deletion-routes`.

---

## 12. Create your first user — a shell step for the first one only

There is no sign-up page and no forgot-password, because a fresh deployment has **no mail
channel**. So one password comes from a shell and the rest do not, and the asymmetry is the
bootstrap rather than a policy: setting a password in the console means being signed in to the
console, which means already holding one. `set-credential` is how the first one gets in, and after
it **Platform → Users** provisions a person and sets their first password over
`POST /v1/platform/users/{id}/credential`, while each person changes their own at `/account`.
Neither of those needs a shell.

**Nothing to mount.** The shipped `docker-compose.yml` already passes
`--platform-user-routes --platform-user-role platform_admin` (the registry) and
`--credential-admin-role platform_admin` (the password panel), so there is no compose edit to make
here — check with `grep platform-user docker-compose.yml` if you want to see it. Both grants are
deliberately *separate* from `--platform-admin-role`, because the people who may create tenants need
not be the people who may mint identities inside them or take one over; on a single-operator
deployment they are one person, which is why the shipped file points all three at `platform_admin`
— two of them written out and the third by default. A deployment that wants those populations to
differ changes one line each. Re-adding a flag that is already there is at best noise, and
hand-editing that list is where a neighbouring flag goes missing.

### Which role to grant, and why it is a fork

**A session carries exactly one role.** The login reads the membership's `primaryRole` and stamps
it into the token's `scope`; the gateway takes `scope[0]` and `secondaryRoles` is populated by
nothing anywhere. So the membership below decides what this person can actually do, and the two
jobs do not overlap:

| Grant this | …and they reach |
|---|---|
| `platform_admin` | `/v1/platform/*` — **Platform → Tenants**, **Platform → Users** (including setting other people's passwords), **Platform → Design Reviews** |
| `erp_admin` | the ERP entity pages under `/e/…`, tenant settings at `/admin/settings`, and the **AI Studio** at `/setup` |

Neither reaches the other's surfaces, and in both directions it is a 403 rather than a missing
link — the sidebar shows every section to everyone and the API is what refuses. `platform_admin` is
not one of the fifteen roles `erp-core` declares, so a session carrying it has no entity permissions
at all and every ERP page comes back empty; the shipped compose passes `--ai-design-role erp_admin`,
which *replaces* the default rather than adding to it, so `platform_admin` is refused at the AI
Studio too. Going the other way, `/v1/platform/*` is guarded by `--platform-admin-role`, which
defaults to `platform_admin` alone.

**One person doing both jobs means two memberships**, because
`meta.user_tenant_membership` is `UNIQUE (user_id, tenant_id)` — one role per person per tenant.
Grant `erp_admin` in the tenant from step 11 and `platform_admin` in a second tenant kept for the
purpose, then choose which you are by the **Workspace** you type at the login form. Both tenants
have to exist: the login resolves that field against `meta.tenants` and refuses a workspace it
cannot find.

**If you only want one login, grant `platform_admin`** — it is the one that can provision everybody
else, including a second membership for yourself later. The commands below use it.

```bash
# Still on the VM, in crossengin/deploy, with $ADMIN set from step 11.
TENANT=<the tenant id from step 11>
USER_ID=$(cat /proc/sys/kernel/random/uuid)   # the kernel's own generator; needs no package

# 1. Provision the principal and its tenant membership in one call. Note the body is NESTED:
#    `user` and `membership` are separate objects and the schema is strict, so the flat form is a
#    400 every time. `id` is accepted because the id that needs a row is one the deployment may
#    already have committed to in an --api-key spec.
curl -sS -X POST http://127.0.0.1:8787/v1/platform/users \
  -H "x-api-key: $ADMIN" -H 'content-type: application/json' \
  -d "{\"user\":{\"id\":\"$USER_ID\",\"email\":\"you@yourdomain.com\",\"displayName\":\"You\"},
       \"membership\":{\"tenantId\":\"$TENANT\",\"primaryRole\":\"platform_admin\",\"status\":\"active\"}}"

# 2. Set the password. Read from the ENVIRONMENT and never from argv, because argv is readable by
#    anyone who can run `ps` — the subcommand refuses `--password` by name. It runs inside the api
#    container, which is where CREDENTIAL_PEPPER and the PG* variables already are; run it anywhere
#    else and you have to supply them yourself, and a pepper that differs from the server's stores a
#    hash no login can verify.
docker compose exec -e OPERATE_NEW_PASSWORD='<a strong password>' api \
  node apps/operate-server/dist/bin/operate-server.js set-credential \
  --user "$USER_ID" --confirm-user "$USER_ID"
```

`status` has no default: `active` grants access now, `invited` only promises it, and only an
active membership resolves as a notification recipient. The user id is typed **twice** on
`set-credential` deliberately — it overwrites a credential, so naming the wrong user locks a real
person out and hands their account to whoever typed the password. There is no `--yes`, because a
flag meaning "I meant it" can be pasted from a runbook without reading the id.

**Log in over HTTPS, because over plain HTTP it fails silently.** The session cookie is set
`Secure` whenever `NODE_ENV=production`, which the compose file sets on `web` — so on a plain-http
path the browser *discards* the cookie the login just issued: the POST returns 200, the page does a
full reload, `middleware.ts` finds no cookie, and you land back on a freshly-mounted sign-in form
with no error on it, because the error state belongs to the page that navigated away. It reads
exactly like a wrong password, and an operator who tries this before DNS resolves will conclude the
password is wrong and re-run `set-credential`. Use `https://yourdomain.com`. Reaching the VM by IP
address does not show you this either — an IP matches neither site block in `deploy/Caddyfile`, so
Caddy answers it rather than the UI — so anything other than the sign-in form means DNS or the
certificate, not the credential.

**Success looks like:** `set-credential: ok`. Then open `https://yourdomain.com`, type the
tenant's **slug** (`acme`) as the workspace, your email and the password, and you should land in
the console. From there on nobody needs a shell: **Platform → Users** provisions the next person
and sets their first password, **Platform → Tenants → one tenant** grants them a membership, and
they change their own password at `/account`.

---

## 13. Back up

Always Free includes 5 block-volume backups. Set a policy:

*Block Volume → your boot volume → Create Backup Policy → Bronze* (weekly full, monthly).

**That is a snapshot story, not a point-in-time one**, and a volume snapshot of a *running*
Postgres is crash-consistent rather than transaction-consistent. Pair it with a logical dump:

```bash
mkdir -p ~/backups
cat > ~/backups/dump.sh <<'SH'
#!/bin/bash
set -eu
cd /home/ubuntu/crossengin/deploy
docker compose exec -T db pg_dump -U crossengin crossengin \
  | gzip > "/home/ubuntu/backups/crossengin-$(date +%F-%H%M).sql.gz"
find /home/ubuntu/backups -name 'crossengin-*.sql.gz' -mtime +14 -delete
SH
chmod +x ~/backups/dump.sh
( crontab -l 2>/dev/null; echo "17 3 * * * /home/ubuntu/backups/dump.sh" ) | crontab -
```

**Test the restore now, while nothing depends on it.** An untested backup is a hope:

```bash
gunzip -c ~/backups/crossengin-*.sql.gz | head -40     # it is real SQL, not an error page
```

This repository models DR tiers with RPO/RTO targets and ships **no backup scheduler**, so until
it does, that cron line is the deployment's real recovery point.

---

## 14. Turn the rest of the platform on

The shipped `docker-compose.yml` passes the request path, the login, the identity surface and the
AI Architect — `--platform-admin`, `--platform-user-routes`, `--credential-login`,
`--credential-admin-role`, `--idempotency-store pg` and `--ai-design` are all on the `api` command
already, so none of them is in the table below. What is still off is everything that **recurs**: no
job fires, no timer fires, no notification is delivered and no audit row is anchored until you say
so. Each is a line added to that `command:`; read `deploy/README.md` for what each one needs.

| Flag | What it turns on |
|---|---|
| `--schedule-ms 60000` | the manifest's scheduled jobs (also needs `--workflow-workers` to drain them) |
| `--workflow-workers` | the timer, activity and job workers — without this a due timer never fires |
| `--notification-drain-ms 15000` | delivery — without it nothing is sent, in-app notices included |
| `--audit-chain-config …` | the hash-chained audit trail |
| `--checkpoint-config …` | the periodic chain checkpoints the next flag's truncation check needs |
| `--integrity-proof-config …` | the periodic audit-integrity verification |
| `--deletion-capabilities …` | GDPR Article 17 — **neither deletion surface mounts without it** |
| `--tenant-status-gate` | enforces `suspended` / `archived` / `pending_deletion` on every request |
| `--rate-limit-policy …` | durable, cross-replica rate limiting |

Add them a few at a time and read the boot log after each `docker compose up -d`: every one of
these has refusals that name what is missing.

### The self-hosted model, if you want one

`--ai-design` is already on, so the routes mount either way: with no provider configured the boot
log says `[ai-design] no AI provider configured …` and `POST /v1/ai/design` answers a 503
`ai_unavailable` rather than refusing the boot. Setting `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in
`.env` is the whole of the hosted path. For a model on this VM instead, bring the stack up with the
AI overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

**There is no compose edit to make, and that is a recent change worth knowing about.** The overlay
no longer carries its own copy of the `api` `command:` — compose *replaces* a command rather than
merging it, so the copy it used to hold had to repeat every flag and had drifted ten behind the
base, including `--credential-login`, which meant this self-hosted path shipped with no login at
all. It passes the model through `environment:`, which compose *merges*, so the overlay now inherits
every flag and every variable the base declares.

On an Ampere A1 with no GPU this works and is slow: generating a manifest takes minutes rather than
seconds. Fine to try, not fine to put tenants in front of.

---

## Can I do this for you?

Not end to end, and it is worth being exact about why.

**I cannot:** this session has no Oracle Cloud credentials, no OCI CLI and no Oracle connector —
I checked. Account creation also requires a card and a phone verification that cannot be
automated, and the DNS change happens at your registrar.

**What would actually change that:** if you create an OCI API signing key (*Profile → User
Settings → API Keys*) and a VM, and you are willing to paste its config into a session, I can
drive `oci` for the infrastructure steps. I would still not take your SSH private key — you
should not paste that anywhere, including to me.

**The division that works well in practice:** you do steps 2–8, which are clicks and a registrar;
then paste me the output of any command that surprises you and I will read it. Steps 9–14 are all
copy-paste, and I wrote them to be read in order. If a build fails or a boot line says something
you did not expect, paste the log and I will tell you which refusal it is and what it wants —
every one of them is a deliberate check with a named remedy.

---

## Afterwards

- `deploy/README.md` — day-2 operations, the auth model, sending mail and SMS, running a model.
- `deploy/VERCEL-SUPABASE.md` — the managed-cloud path, if you outgrow one VM.
- `CLAUDE.md` → **What's actually left** — an honest register of what is and is not built.
