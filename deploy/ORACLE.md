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

---

## 9. Clone and configure

```bash
git clone <YOUR FORK OF THIS REPO> crossengin
cd crossengin/deploy
cp .env.example .env
```

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

**Leave `COLUMN_ENCRYPTION_SECRET` unset unless you are switching `OPERATE_PACK`** to
`erp-healthcare` or `erp-government`. Those declare `phi`/`regulated` fields and the API will
refuse to boot without it; the default `erp-core` declares none.

---

## 10. Bring it up

```bash
docker compose up -d --build
docker compose logs -f api
```

The first build takes **10–20 minutes** on 2 A1 cores. Expect `migrate` to run once and exit 0,
then `api` to boot, then `web`.

Four boot lines are worth reading, and they are the ones that tell you the deployment is
configured rather than merely running:

```
[auth] api-key specs: 1 from OPERATE_API_KEY_SPECS, 0 from argv …
[auth] credential login: enabled (kid login-v1, public key …)
[pg] database channel: PGSSLMODE=prefer — the server may decline TLS …
[cursor] cursor sealing: sealed …
[list] declared surfaces: all serveable on --store pg
```

If `credential login` says `refused`, it names the variable to set. If `[cursor]` says
`plaintext_disclosing`, `CURSOR_ENCRYPTION_SECRET` is unset.

**Success looks like:** `docker compose ps` shows `api` **healthy** (not just *running* — the
healthcheck polls `/readyz`), and `curl -s https://api.yourdomain.com/readyz` returns JSON with
`"status":"ready"`.

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

---

## 11. Create your first tenant

The token half of `OPERATE_ADMIN_API_KEY` is everything before the first colon.

```bash
# Everything before the first colon of OPERATE_ADMIN_API_KEY.
ADMIN=<the token half>

curl -sS -X POST https://api.yourdomain.com/v1/platform/tenants \
  -H "x-api-key: $ADMIN" -H 'content-type: application/json' \
  -d '{"slug":"acme","name":"Acme Ltd","tier":"small","region":"eu"}'
```

Note the returned tenant `id`. The `schema_name` is derived from the slug. Hard deletion is
deliberately not on this surface — that is the audited GDPR flow behind
`--tenant-deletion-routes`.

---

## 12. Create your first user — this is a shell step, on purpose

There is no sign-up page and no forgot-password, because a fresh deployment has **no mail
channel**: an operator with shell access is the only principal that exists before the first
password does.

**First mount the registry.** It is off by default and behind its own grant — deliberately a
*different* grant from `--platform-admin-role`, because the people who may create tenants need not
be the people who may mint the identities inside them. Add two lines to the `api` service's
`command:` in `docker-compose.yml`:

```yaml
      - --platform-user-routes
      - --platform-user-role
      - platform_admin
```

then `docker compose up -d api`. With no role nothing is mounted at all and the API says so at
boot — the grant is fail-closed.

```bash
TENANT=<the tenant id from step 11>
USER_ID=$(uuidgen)        # or any UUID you choose; it becomes the meta.users.id

# 1. Provision the principal and its tenant membership in one call. Note the body is NESTED:
#    `user` and `membership` are separate objects, and `id` is accepted because the id that needs
#    a row is one the deployment may already have committed to in an --api-key spec.
curl -sS -X POST https://api.yourdomain.com/v1/platform/users \
  -H "x-api-key: $ADMIN" -H 'content-type: application/json' \
  -d "{\"user\":{\"id\":\"$USER_ID\",\"email\":\"you@yourdomain.com\",\"displayName\":\"You\"},
       \"membership\":{\"tenantId\":\"$TENANT\",\"primaryRole\":\"erp_admin\",\"status\":\"active\"}}"

# 2. Set the password. Read from the ENVIRONMENT and never from argv, because argv is readable by
#    anyone who can run `ps` — the subcommand refuses `--password` by name.
docker compose exec -e OPERATE_NEW_PASSWORD='<a strong password>' api \
  node apps/operate-server/dist/bin/operate-server.js set-credential \
  --user "$USER_ID" --confirm-user "$USER_ID"
```

`status` has no default: `active` grants access now, `invited` only promises it, and only an
active membership resolves as a notification recipient. The user id is typed **twice** on
`set-credential` deliberately — it overwrites a credential, so naming the wrong user locks a real
person out and hands their account to whoever typed the password. There is no `--yes`, because a
flag meaning "I meant it" can be pasted from a runbook without reading the id.

**Success looks like:** `set-credential: ok`. Then open `https://yourdomain.com`, log in, and you
should land on the entity list.

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

The shipped `docker-compose.yml` passes a deliberately small set of flags. A great deal of what is
built is **off by default**, and each of these is a line added to the `api` service's `command:`.
Read `deploy/README.md` for what each one needs; the ones most deployments want:

| Flag | What it turns on |
|---|---|
| `--schedule-ms 60000` | the manifest's scheduled jobs (also needs `--workflow-workers` to drain them) |
| `--workflow-workers` | the timer, activity and job workers — without this a due timer never fires |
| `--audit-chain-config …` | the hash-chained audit trail |
| `--integrity-proof-config …` | the periodic audit-integrity verification |
| `--deletion-capabilities …` | GDPR Article 17 — **neither deletion surface mounts without it** |
| `--tenant-status-gate` | enforces `suspended` / `archived` / `pending_deletion` on every request |
| `--rate-limit-policy …` | durable, cross-replica rate limiting |
| `--platform-user-routes` | the user/membership registry (step 12 turns this one on already) |

Add them a few at a time and read the boot log after each `docker compose up -d`: every one of
these has refusals that name what is missing.

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
