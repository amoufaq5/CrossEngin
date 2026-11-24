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
chmod 600 .env      # it will hold every secret the platform has; no other account on the VM needs it
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
API=http://127.0.0.1:8787
# The bootstrap key goes to curl as a header FILE, never on the command line, where any account on
# the VM could read it with `ps`. Delete the file at the end of this step.
umask 077
printf 'x-api-key: %s\ncontent-type: application/json\n' \
  "$(grep '^OPERATE_ADMIN_API_KEY=' .env | cut -d= -f2- | cut -d: -f1)" > ~/.crossengin-admin-header

# A tenant for yourself (the "workspace" you sign in to). Its id comes back in the response.
curl -sS -X POST $API/v1/platform/tenants -H @$HOME/.crossengin-admin-header \
  -d '{"slug":"ops","name":"Platform Operations","tier":"small","region":"eu"}'
TENANT=<the "id" from that response>
ME=$(cat /proc/sys/kernel/random/uuid)

# You, with two roles: platform_admin (the console) and erp_admin (the ERP itself).
curl -sS -X POST $API/v1/platform/users -H @$HOME/.crossengin-admin-header \
  -d "{\"user\":{\"id\":\"$ME\",\"email\":\"you@yourdomain.com\",\"displayName\":\"You\"},
       \"membership\":{\"tenantId\":\"$TENANT\",\"primaryRole\":\"platform_admin\",
                       \"secondaryRoles\":[\"erp_admin\"],\"status\":\"active\"}}"

# Your password: at least 12 characters. Typed, not echoed, and sent on stdin so it is never on
# a command line `ps` can read.
read -rs -p 'password: ' PW; echo
PW="$PW" ME="$ME" python3 -c 'import json,os; print(json.dumps({"password": os.environ["PW"], "confirmUserId": os.environ["ME"]}))' |
  curl -sS -X POST $API/v1/platform/users/$ME/credential -H @$HOME/.crossengin-admin-header \
    --data-binary @-
unset PW
rm -f ~/.crossengin-admin-header
```

The user call warns that `platform_admin` is not one of the ERP's roles. That is expected: it is the
console's role, not the ERP's, which is exactly why `erp_admin` rides beside it.

Now open **`https://yourdomain.com/login`** and sign in with **Workspace** `ops`, your email and
password. You will see **Platform** in the sidebar.

## 7. Onboard a customer (a tenant and its people)

There is no *instant* self-registration — nobody gets a working account from a public page without
you. What exists is **request and approve**: a customer asks for access, you approve it with one
click, and the approval creates everything at once. Email verification and password reset by email
still do not exist, because there is no mail channel, so you hand the password over yourself. A
customer's own `erp_admin` runs their ERP but **cannot add their own staff** — you do that too.

### The sign-up request form (recommended)

1. **Open the form.** Put your terms and privacy notice somewhere public (two https pages you
   control), then in `deploy/.env` set:

   ```
   ACCESS_REQUEST_TERMS_URL=https://yourdomain.com/terms
   ACCESS_REQUEST_PRIVACY_URL=https://yourdomain.com/privacy
   ACCESS_REQUEST_TERMS_VERSION=2026-11-01
   ```

   and `docker compose up -d`. The boot log says `[access-request] intake open (terms v2026-11-01)`;
   with the variables unset it says `intake CLOSED` and the form tells visitors sign-up is not open.
   Change the version whenever the terms change: it is recorded with every acceptance.
2. **Send people to `https://yourdomain.com/request-access`** (link it from your website; the
   sign-in page links to it too). They give the company name, their name and email, an optional
   workspace name and a message, read the privacy notice, and accept the terms. Nothing is created.
3. **Watch for requests.** Platform → **Access requests** shows a count in the sidebar, and each
   request logs `[access-request] new request …` (no name or email in the line). Pending requests
   expire after **72 hours** if you do nothing; decided ones are deleted after **30 days**.
4. **Approve.** Open the request, check or edit the workspace name, company name, email and role
   (`erp_admin` by default), optionally set the default currency and payment terms, press
   **Generate** for the password, **copy it**, and approve. One transaction creates the workspace,
   the admin user, their membership, the password and the settings — if any part fails, none of it
   exists. The password is shown only on your screen and never comes back from the server.
   **Create a starter chart of accounts** is ticked by default: right after the approval commits,
   the workspace gets 21 ledger accounts and its 18 finance account-code settings pointed at them, so
   its first invoice can post (the codes are listed under *The customer's first hour* below). Untick
   it for a company bringing its own chart. The confirmation says what happened to the chart, and if
   it is not complete it says why: accounts refused (a `403 forbidden` on every account means the
   role this deployment writes the chart as, `--job-actor-role`, may not create `LedgerAccount` —
   fix that flag), settings left for the admin to choose, or settings that name no account. The
   workspace is approved either way. Once the cause is fixed, the workspace's page (**Create starter
   chart of accounts**) finishes the chart; it never replaces an existing account or a setting
   already chosen, so running it changes nothing that is already in place.
   If the email already belongs to an active user, you are offered to **attach that existing user**
   to the new workspace instead (their own password is kept) — but only after ticking that you have
   confirmed, outside the request, that the account belongs to the requester: anyone can file a
   request under someone else's address, so the server refuses an attach without that confirmation.
5. **Send the sign-in details** over a channel other than that email address (a phone call, a
   message), and ask them to change the password at **`/account`**.
6. **Reject** with a reason, or **Reject all pending** if a bot fills the queue. The queue holds at
   most 200 pending requests by default (`--access-request-max-pending`), and submissions are
   rate-limited, so a flood cannot grow without bound.

The terms acceptance — which version, when, and a keyed hash (HMAC) of the email, never the
address — is written into the new workspace's permanent audit record when you approve, so it
survives the request row's deletion. Approving needs your account to hold the platform-admin,
platform-user **and** credential-admin grants, which the bootstrap operator from step 6 does.

### Or from the command line

1. Take the details any way you like (a form tool, a `mailto:` link).
2. Run **one command on the VM**:

   ```bash
   cd ~/crossengin/deploy
   ./onboard-tenant.sh acme "Acme Ltd" ana@acme.com "Ana Silva"
   ```

   It creates the tenant, the user (as `erp_admin`, the customer's own administrator), a random
   password and the starter chart of accounts, and prints what to send:

   ```
   Sign in at:  https://yourdomain.com/login
   Workspace:   acme
   Email:       ana@acme.com
   Password:    3z3Dyd2gtBac7lfxWgw4
   ```

   Send it over a channel you trust and ask them to change it at **`/account`** — the platform does
   not force a change at first sign-in. Options: `TIER=enterprise REGION=us ./onboard-tenant.sh …`,
   a fifth argument for a different role, and `NO_STARTER_CHART=1` for a company bringing its own
   chart of accounts. It refuses a taken slug, and stops before setting a password if the role is
   not one the ERP declares. The chart is the last step and prints a `chart` summary in the console's
   words (accounts in place, and anything refused, left for the admin to choose, or naming no
   account), then the counts. If the chart is not complete the login above it still works: the script
   says why, how to finish once the cause is fixed (the workspace's **Create starter chart of
   accounts** button, or the one request to re-run), and exits 0.

**The same thing in the browser**, signed in as yourself:

1. **Platform → Tenants → New tenant** — slug (lowercase, `-` allowed), name, tier, region.
2. **Platform → Users → Provision a user** — email and display name. It shows the new user's id.
3. **Platform → Tenants → (the tenant) → Members → Grant membership** — that user id, primary role
   `erp_admin`, status **active**.
4. **Platform → Users → (the user) → Set password**.
5. **Platform → Tenants → (the tenant) → Create starter chart of accounts** — unless they bring
   their own chart. Running it on a workspace that already has the accounts changes nothing.

**Their staff:** repeat steps 2–4 in the browser. The script always creates a *new* tenant, so it
cannot add a second person to an existing one. Give each person the narrowest role
that fits: `erp_admin`, `erp_accountant`, `controller`, `ap_clerk`, `sales_manager`, `sales_rep`,
`procurement_manager`, `inventory_manager`, `warehouse_clerk`, `production_manager`,
`project_manager`, `hr_manager`, `asset_manager`, `tax_manager`, `erp_viewer`.

**The customer's first hour**, as their `erp_admin`:

1. **Admin → Settings**: company profile, default currency, timezone, fiscal year start,
   **payment terms (days)**. (Automatic jobs — overdue marking, depreciation, sales order →
   invoice — are off on this stack, see *What is not there yet*; payment terms still prefill each
   invoice's due date.)
2. Check the **chart of accounts**. A workspace approved with the default, or onboarded by the
   script, already has the starter chart (ADR-0465) and its finance account-code settings point at
   it. The admin can rename accounts and add more in the ledger accounts list. **Settings → Finance &
   tax** shows 12 of the 18 account-code settings (AR, revenue, AP, expense, cash, output tax, input
   tax, FX gain/loss, unrealized FX, WHT receivable, WHT payable, tax recoverable); the other six —
   inventory, COGS, GRNI, inventory variance, depreciation expense and accumulated depreciation — are
   changed through `PUT /v1/admin/settings` (`finance`), and a save from the form keeps them. The
   chart (version `2026-11`):

   | Code | Account | Type | Setting it fills |
   | --- | --- | --- | --- |
   | 1000 | Cash and bank | asset | cash |
   | 1100 | Accounts receivable | asset | AR |
   | 1200 | Inventory | asset | inventory |
   | 1300 | Input tax recoverable | asset | input tax |
   | 1310 | Withholding tax receivable | asset | WHT receivable |
   | 1320 | Income tax recoverable | asset | tax recoverable |
   | 1500 | Property and equipment | asset | — |
   | 1590 | Accumulated depreciation | asset | accumulated depreciation |
   | 2000 | Accounts payable | liability | AP |
   | 2100 | Goods received not invoiced | liability | GRNI |
   | 2200 | Output tax payable | liability | tax payable |
   | 2210 | Withholding tax payable | liability | WHT payable |
   | 3000 | Owner's equity | equity | — |
   | 3100 | Retained earnings | equity | — |
   | 4000 | Sales revenue | revenue | revenue |
   | 4900 | Realized foreign exchange gain/loss | revenue | FX gain/loss |
   | 4910 | Unrealized foreign exchange gain/loss | revenue | unrealized FX gain/loss |
   | 5000 | Cost of goods sold | expense | COGS |
   | 5100 | Inventory and purchase price variance | expense | inventory variance |
   | 6000 | Operating expenses | expense | expense |
   | 6500 | Depreciation expense | expense | depreciation expense |

   Withholding: tax a customer withholds from an invoice is debited to 1310, and moved to 1320 when
   its WHT certificate is confirmed; tax the workspace withholds from a supplier's bill is credited
   to 2210. A tax code that names its own `gl_account_code` posts there instead. Approving a bill
   records what was withheld on the bill (`withholding_total`), and the bill is owed and settles at
   the net: pay the supplier the total less the withholding. Paying the gross also marks it paid, but
   leaves accounts payable in debit by the withheld amount and nothing reports that, so do not.
   **Paying tax to the authority is a tax return, never a `Payment`** (a `Payment` posts to accounts
   payable and clears no tax account). Create a tax return (a `TaxReturn` record) with its
   `return_type`, jurisdiction, fiscal period, `period_start`/`period_end`, the three figures and
   the currency (it defaults to `USD`; set it to the workspace's default currency), then take it
   through the transitions `mark_ready` → `file` → `mark_paid` (ADR-0467). What `mark_paid` does depends on
   **Settings → Finance & tax → Tax return remittance**:

   - **post on mark paid** (`finance.taxRemittancePosting = on_mark_paid`; a new workspace approved
     with the starter chart after ADR-0467 starts here when it has a default currency, while the
     *Create starter chart of accounts* button on an existing workspace leaves the setting alone): marking the
     return paid posts one entry, numbered `<return_number>-REMIT-1` and dated today:

     | Return | Figures | Entry |
     | --- | --- | --- |
     | VAT, GST, consumption tax, net ≥ 0 | net = output − input | debit 2200 output · credit 1300 input · credit 1000 net |
     | the same, net < 0, `credit_disposition: refund_received` | | debit 2200 output · debit 1000 refund · credit 1300 input |
     | the same, net < 0, `credit_disposition: carried_forward` | | debit 2200 output · credit 1300 output (the rest of the credit stays in 1300) |
     | sales tax | input 0, net = output | debit 2200 · credit 1000 |
     | withholding | output 0, input 0 | debit 2210 net · credit 1000 net |

     A return the figures, the books, the currency or the account settings cannot serve is refused
     with the return left as it was. At `file` (and `refile`) the return is checked for figures that
     do not add up (422), a currency other than the default and a period overlapping another filed,
     amended or paid return of its type and jurisdiction (409); so edit it and file again. At
     `mark_paid` those are checked again, together with a return that clears more than a tax account
     holds, an unset account code and a tenant that routes tax by jurisdiction or tax code (409); so
     `amend` it, correct it and `refile`. `deploy/README.md` (*Upgrading to tax remittance posting*)
     lists the refusals and their remedies. `reverse_payment` undoes a remittance recorded in error:
     it posts the mirror entry and returns the return to `filed`, and marking it paid again posts
     `-REMIT-2`. A return marked paid before the workspace switched to posting was remitted by manual
     journal, so `reverse_payment` refuses it (`tax_remittance_paid_outside_posting`) until the
     workspace is back on manual journal. A further payment for a period already paid is a manual
     journal entry.
   - **manual journal** (the default, and the setting every workspace created before ADR-0467 keeps
     until its admin changes it): marking the return paid posts nothing. Record the remittance as a
     manual journal entry — debit 2210 and credit cash for withholding; for VAT, debit 2200, credit
     1300 and credit cash — and mark the return paid beside it. Before switching such a workspace to
     posting, mark paid every filed or amended return you have already journalled, or reverse those
     journals, or the remittance is posted twice. Returns already paid are not posted again by the
     switch, but correcting one later means switching back to manual journal first (above).

   Only **unset** settings are filled, and an existing account with a chart code is never changed.
   On a workspace that already had accounts — run through the button later — a setting is pointed at
   an existing account only if that account has the chart's type and is active and postable; if not
   (another numbering scheme, an archived account, two accounts with one code), the setting is left
   unset and the report names it for the admin to choose. A workspace created without the chart —
   unticked at approval, `NO_STARTER_CHART=1`, or created by hand in the console — has no ledger
   accounts until its admin creates them or you run **Create starter chart of accounts**. Until its
   settings point at real accounts, sending an invoice is refused `409 server_reference_unresolved`:
   the message names the record and field that needed a ledger account (not which setting) and
   points at the finance account-code settings and the starter-chart route. Opening balances are
   posted by manual journal entry (there is no import).
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
store (README → *Backups*).

**Keep `.env` somewhere else — never beside the backups.** `.env` holds the platform-admin key and
every signing secret, so a folder holding both the dumps and `.env` is a full takeover of every
tenant, not just a copy of their data. Put `.env` in a password manager. Encrypt the dumps before they
leave the VM (`age` or `gpg`), and give the off-host copies an expiry you can state to customers.
Once, before real customers, restore a dump onto a fresh VM end to end — the automatic check
counts tables, not rows.

## What is not there yet

So you can answer customers honestly:

- **Instant self-registration and password reset by email** — no mail channel exists, so there is
  no email verification. Customers *request* access at `/request-access` and you approve each one
  (section 7); you reset passwords from **Platform → Users**.
- **Industry or country charts of accounts** — every workspace gets the same 21-account starter
  chart (section 7, *The customer's first hour*); there is no per-country variant and no import of an
  existing chart, so a customer with their own chart creates it by hand or by API, one account at a
  time.
- **Email and SMS notifications** — in-app notifications work. Setting SES or Twilio credentials
  registers the channel, but nothing in the platform produces an email or SMS dispatch yet, so the
  boot's `[notify]` line saying `email, sms` does not mean anything will be sent.
- **Deleting a tenant's data** — the Article 17 deletion surfaces are built but **off** on this
  stack. Until you turn them on ([`ORACLE.md`](./ORACLE.md) has the flags and the eraser role),
  offboarding a customer means **suspending or archiving** the tenant, which cuts access and erases
  nothing.
- **Data export and subject-access requests** (GDPR Art. 15/20) — not built.
- **Automatic background jobs** — off: invoices are not marked overdue on their own (the aging
  report still ages by due date), depreciation is not posted, sales orders are not invoiced
  automatically.
- **Financial statements** — trial balance, P&L and balance sheet are not built; the reports are
  AR/AP aging, withholding tax and period close.
- **Printable invoices, data import, customer-managed staff, billing** — none built: invoices are
  not rendered or emailed, data is entered by hand or through the API, you add every user, and every
  tenant gets the whole product.
- **Single sign-on** (SAML/OIDC) — not built; people sign in with email and password.
- **File attachments** — no object storage is configured.
