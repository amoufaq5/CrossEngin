# Going live for free: Oracle Cloud, your domain, tenants and AI

This page is the whole path from nothing to a public CrossEngin at `https://yourdomain.com`, in
order. It links to [`ORACLE.md`](./ORACLE.md) for the long form of each server step rather than
repeating it — keep both open.

The bootstrap, onboarding and AI commands below were run against the real server — booted with the
shipped compose command, on a real PostgreSQL, connecting as the confined app role — before they
were written down, the AI paths against a stand-in for a hosted model. The Oracle, Cloudflare and
`docker compose up` steps were not run for this page; they follow `ORACLE.md`. Where something does not exist
yet, this page says so rather than describing a workaround as a feature.

**What it costs.** The server, TLS certificates and DNS are free. The domain is the one thing you
pay for (about $10–15 a year at any registrar; Cloudflare Registrar sells at cost). AI is free on
the self-hosted path and on some providers' free tiers, and cents per design on a paid key.

| Piece | Free option used here |
|---|---|
| Server | Oracle Cloud **Always Free** — one Ampere A1 VM, 2 OCPU / 12 GB, arm64 |
| DNS | **Cloudflare** free plan |
| TLS certificates | **Let's Encrypt**, obtained automatically by the Caddy container |
| Backups | the stack's own `backup` service (same VM — copy them off-host, see step 10) |
| AI | your choice in step 8: a paid key (recommended), a free OpenAI-compatible tier, or a model on the VM |

---

## 1. Get the server

Follow [`ORACLE.md`](./ORACLE.md) steps **2–7**. The short version, and the parts people get wrong:

1. **Sign up at `cloud.oracle.com`.** Pick a home region near you that is *not* one of the busiest —
   it cannot be changed later and Ampere capacity varies a lot by region.
2. **Network:** *Networking → Virtual Cloud Networks → Start VCN Wizard → "VCN with Internet
   Connectivity"*, all defaults.
3. **Instance:** image **Canonical Ubuntu 24.04** (check it says **aarch64**), shape
   `VM.Standard.A1.Flex` with **2 OCPUs / 12 GB**, public IPv4 **yes**, boot volume **50 GB**,
   your SSH public key. *"Out of host capacity"* is normal: switch availability domain or retry
   every few minutes.
4. **Open ports 80 and 443 in both places** — the subnet's security list *and* the VM's own
   `iptables` (ORACLE.md §5). Oracle filters twice; opening only one looks like nothing worked.
5. **Install Docker and add swap** (ORACLE.md §6–7).

**Keep the VM from being reclaimed.** Oracle's policy (check their Always Free page for the current
wording) reclaims Always Free instances that stay idle — very low CPU, network and memory use — for
a week. A serving deployment with real users is not idle. For an instance that sits quiet while you
build up customers, upgrading the account to *Pay As You Go* exempts it while Always Free resources
stay free; the cost of that upgrade is that a mistake (a bigger shape, a second volume) can now bill
you, so set a budget alert in *Billing → Budgets* the same day.

## 2. Point your domain at it (Cloudflare, free)

1. Buy the domain anywhere. In Cloudflare: *Add a site* → the domain → **Free** plan.
2. At your registrar, replace the nameservers with the two Cloudflare gives you. Wait until
   Cloudflare says the site is **Active** (minutes to a few hours).
3. In Cloudflare *DNS → Records*, add two `A` records pointing at the VM's public IP:

   | Type | Name | Content | Proxy status |
   |---|---|---|---|
   | A | `@` | `<VM public IP>` | **DNS only** (grey cloud) |
   | A | `api` | `<VM public IP>` | **DNS only** (grey cloud) |

   **Grey cloud, not orange.** Caddy gets its own Let's Encrypt certificates on the VM, and the
   orange proxy terminates TLS at Cloudflare first — ORACLE.md §8 says exactly what that breaks.
   Add **no `AAAA` record**: the VM has no IPv6 address.
4. Check from your laptop: `dig +short yourdomain.com` and `dig +short api.yourdomain.com` both
   print the VM's IP.

## 3. Get the code — the right branch

```bash
ssh ubuntu@<VM public IP>
git clone <your fork of this repo> crossengin
cd crossengin
git fetch origin && git checkout claude/eloquent-archimedes-bn69tr
cd deploy
cp .env.example .env
```

The login, the user registry, the console and everything on this page are on that branch; `main`
is behind it (ORACLE.md §9 has the one-line check for whether that has changed).

## 4. Fill in `.env`

Generate the seven secrets (ORACLE.md §9 has a loop that prints them) and paste each into `.env`:

| Variable | Generate with |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `POSTGRES_APP_PASSWORD` | `openssl rand -hex 24` (a different value) |
| `OPERATE_ADMIN_API_KEY` | `echo "$(openssl rand -hex 24):platform_admin:00000000-0000-4000-8000-000000000000"` |
| `CREDENTIAL_PEPPER` | `openssl rand -base64 32` |
| `OPERATE_TOKEN_SIGNING_KEY` | `openssl rand -base64 32` |
| `CURSOR_ENCRYPTION_SECRET` | `openssl rand -base64 32` |
| `AUDIT_CHAIN_SIGNING_KEY` | `openssl rand -base64 32` |

Use **base64** for the last four, not hex: hex has only 16 characters and the boot refuses a secret
with fewer than 16 distinct bytes, which a hex string misses about half the time.
`OPERATE_ADMIN_API_KEY`'s third field is a placeholder that can never name a real tenant — that is
deliberate.

Then set the two plain values:

```
DOMAIN=yourdomain.com
ACME_EMAIL=you@yourdomain.com
```

**Never change `CREDENTIAL_PEPPER` after users exist** — every password stops verifying. Keep a copy
of `.env` somewhere safe and off the VM: without it, a restored backup cannot be logged into.

## 5. Start it

```bash
docker compose up -d --build
docker compose ps -a
```

The first build takes 10–20 minutes on two Ampere cores. Five one-shot steps run and must show
`Exited (0)` — `extensions`, `migrate`, `app-role`, `eraser-role`, `document-indexes` — and then
`db`, `api`, `web`, `caddy` and `backup` stay up. Check:

```bash
curl -s http://127.0.0.1:8787/readyz             # {"status":"ready",...}
curl -sI https://yourdomain.com | head -1        # HTTP/2 200 or 307 (to /login), once Caddy has a certificate
docker compose logs api | grep -E 'fatal|\[auth\]|\[ai-design\]'
```

If a step exits non-zero, `docker compose logs <step>` names why, and ORACLE.md §10 *"When it does
not come up"* lists the usual causes (arm64 extension, password mismatch, a secret refused as weak).

## 6. Create your own account (the operator)

You are the platform's operator: you create tenants and people. Everyone else signs in through the
browser. Your first account is the one thing made with `curl`, on the VM, using the bootstrap key:

```bash
cd ~/crossengin/deploy
ADMIN=$(grep '^OPERATE_ADMIN_API_KEY=' .env | cut -d= -f2- | cut -d: -f1)
API=http://127.0.0.1:8787

# A tenant for yourself (the "workspace" you sign in to). Its id comes back in the response.
curl -sS -X POST $API/v1/platform/tenants -H "x-api-key: $ADMIN" -H 'content-type: application/json' \
  -d '{"slug":"ops","name":"Platform Operations","tier":"small","region":"eu"}'
TENANT=<the "id" from that response>
ME=$(cat /proc/sys/kernel/random/uuid)

# You, with two roles: platform_admin (the console) and erp_admin (the ERP itself).
curl -sS -X POST $API/v1/platform/users -H "x-api-key: $ADMIN" -H 'content-type: application/json' \
  -d "{\"user\":{\"id\":\"$ME\",\"email\":\"you@yourdomain.com\",\"displayName\":\"You\"},
       \"membership\":{\"tenantId\":\"$TENANT\",\"primaryRole\":\"platform_admin\",
                       \"secondaryRoles\":[\"erp_admin\"],\"status\":\"active\"}}"

# Your password: at least 12 characters. Typed, not echoed, and sent on stdin so it is never on
# a command line `ps` can read.
read -rs -p 'password: ' PW; echo
PW="$PW" ME="$ME" python3 -c 'import json,os; print(json.dumps({"password": os.environ["PW"], "confirmUserId": os.environ["ME"]}))' |
  curl -sS -X POST $API/v1/platform/users/$ME/credential -H "x-api-key: $ADMIN" \
    -H 'content-type: application/json' --data-binary @-
unset PW
```

The user call warns that `platform_admin` is not one of the ERP's roles. That is expected: it is the
console's role, not the ERP's, which is exactly why `erp_admin` rides beside it.

Now open **`https://yourdomain.com/login`** and sign in with **Workspace** `ops`, your email and
password. You will see **Platform** in the sidebar.

## 7. Onboard a customer (a tenant and its people)

**There is no self-registration.** No public sign-up page exists: it would need a public,
rate-limited route, email verification and a mail channel to send the link, and none of the three is
built. Every tenant and every user is created by you, the operator. A customer's own `erp_admin`
runs their ERP but **cannot add their own staff** — you do that too.

What works well in practice:

1. Put a short form on your website (any free form tool, or a `mailto:` link) asking for company
   name, the admin's name and email, and their country.
2. When one arrives, run **one command on the VM**:

   ```bash
   cd ~/crossengin/deploy
   ./onboard-tenant.sh acme "Acme Ltd" ana@acme.com "Ana Silva"
   ```

   It creates the tenant, the user (as `erp_admin`, the customer's own administrator) and a random
   password, and prints what to send:

   ```
   Sign in at:  https://yourdomain.com/login
   Workspace:   acme
   Email:       ana@acme.com
   Password:    3z3Dyd2gtBac7lfxWgw4
   ```

   Send it over a channel you trust and ask them to change it at **`/account`** — the platform does
   not force a change at first sign-in. Options: `TIER=enterprise REGION=us ./onboard-tenant.sh …`,
   and a fifth argument for a different role. It refuses a taken slug, and stops before setting a
   password if the role is not one the ERP declares.

**The same thing in the browser**, signed in as yourself:

1. **Platform → Tenants → New tenant** — slug (lowercase, `-` allowed), name, tier, region.
2. **Platform → Users → Provision a user** — email and display name. It shows the new user's id.
3. **Platform → Tenants → (the tenant) → Members → Grant membership** — that user id, primary role
   `erp_admin`, status **active**.
4. **Platform → Users → (the user) → Set password**.

**Their staff:** repeat steps 2–4 (or run the script with the customer's slug — it creates the
tenant only once, so for a second person use the browser steps). Give each person the narrowest role
that fits: `erp_admin`, `erp_accountant`, `controller`, `ap_clerk`, `sales_manager`, `sales_rep`,
`procurement_manager`, `inventory_manager`, `warehouse_clerk`, `production_manager`,
`project_manager`, `hr_manager`, `asset_manager`, `tax_manager`, `erp_viewer`.

**The customer's first hour**, as their `erp_admin`:

1. **Admin → Settings**: company profile, default currency, timezone, fiscal year start,
   **payment terms (days)** — the overnight sales-order → invoice job fails without it.
2. Create the **ledger accounts** they post to (accounts receivable, revenue, payables, expense,
   cash, tax), then pick each one in **Settings → Finance & tax → … account code**. Until those
   point at real accounts, sending an invoice is refused with a message naming the setting.
3. Their customers, vendors and items, then their first invoice.

Taking access away is fast: revoking a membership stops it within 30 seconds, and suspending a user
ends their sessions at once.

## 8. Turn on the AI Architect

The AI Studio (`/setup`) turns a customer's plain-English description of their business into extra
entities, fields and workflows on top of the ERP. It is already on; it needs a model. Pick one:

### A — a paid key (recommended)

```
# in .env
ANTHROPIC_API_KEY=sk-ant-...
```

Then `docker compose up -d`. A design costs cents and the shipped command caps spend at **$50 per
tenant per month and $2 per request**. `OPENAI_API_KEY` works the same way.

### A2 — a free OpenAI-compatible tier (Groq, OpenRouter and similar)

```
# in .env
OPENAI_API_KEY=<the provider's key>
OPENAI_BASE_URL=https://api.groq.com/openai     # the prefix BEFORE /v1; OpenRouter: https://openrouter.ai/api
OPERATE_AI_MODEL=<a model id that provider lists>
OPERATE_AI_MODEL_PRICE=0:0                       # USD per million tokens, input:output
OPERATE_AI_MAX_OUTPUT_TOKENS=4096                # free tiers usually cap output per request
```

The boot **refuses** a model it has no price for until `OPERATE_AI_MODEL_PRICE` is set — `0:0` is
the honest declaration for a free tier, and it means the spend ceilings bound nothing. Choose a
large instruction-tuned model: a design is one JSON document of several kilobytes and small models
fail it. **Read the provider's data-use terms** — a free tier may train on what you send, and what
you send is your customer's description of their business.

### B — a model on the VM (fully private, slow)

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

This adds Ollama with `qwen2.5:7b-instruct` (a 14B model does not fit in 12 GB beside everything
else). On two Ampere cores a design takes **tens of minutes**: fine for trying, not for customers.

**Check it took:** `docker compose logs api | grep '\[ai-design\] provider'` names the provider and
model.

### How a design goes live

1. The customer's `erp_admin` opens **AI Studio**, describes the business, and gets a design.
2. They click **Activate** — the first time it answers *review required*: the shipped command
   requires a platform reviewer to approve every design before it changes a tenant's live schema.
3. You open **Platform → Design Reviews**, read the diff, and **Approve** (or Reject).
4. They click **Activate** again. Their new pages appear beside the ERP's.

A design must *extend* the ERP; one that tried to replace it is refused before it reaches you, so
approving a design never takes a customer's invoicing away.

**The reviewer may not be the designer.** When a customer designs and you approve, that holds
naturally. If *you* design on a customer's behalf and also approve, you are refused
`designer_cannot_approve` — either have a second operator approve, or, if you run this alone, add
`      - --allow-design-self-approval` to the `api` service's `command:` list in
`docker-compose.yml` and `docker compose up -d`. That flag exists for exactly this case and turns
off the four-eyes check, so it is a choice, not a default.

## 9. Run it

- **Upgrades:** `cd ~/crossengin && git pull && cd deploy && docker compose up -d --build`. The
  migrate step reconciles the database on every `up`.
- **Logs:** `docker compose logs -f api` (and `web`, `caddy`, `backup`).
- **Uptime:** point any free monitor at `https://api.yourdomain.com/readyz`.
- **Health of the backups:** `docker compose ps backup` shows `healthy` only while the last dump was
  written *and* test-restored.

## 10. Backups, and the one thing this setup cannot do for you

The `backup` service dumps the database daily, test-restores each dump, and keeps 14 days in a Docker
volume **on the same VM**. That protects against a bad upgrade or a mistaken delete; it does not
protect against losing the VM or the account. Copy them off it — for example a nightly
`rsync`/`scp` of the backup directory to another machine, or set `BACKUP_DIR` to a mounted remote
store (README → *Backups*). Keep `.env` with them.

## What is not there yet

So you can answer customers honestly:

- **Self-registration and password reset by email** — no mail channel exists; you onboard people
  and reset passwords from **Platform → Users**.
- **Email and SMS notifications** — in-app notifications work. Setting SES or Twilio credentials
  registers the channel, but nothing in the platform produces an email or SMS dispatch yet, so the
  boot's `[notify]` line saying `email, sms` does not mean anything will be sent.
- **Data export and subject-access requests** (GDPR Art. 15/20) — not built; tenant deletion is.
- **Single sign-on** (SAML/OIDC) — not built; people sign in with email and password.
- **File attachments** — no object storage is configured.
