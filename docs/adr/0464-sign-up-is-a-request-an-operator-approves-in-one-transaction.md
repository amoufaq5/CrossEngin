# ADR-0464: Sign-up is a request an operator approves, and approval creates the workspace in one transaction

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-23 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0463 (go-live guide), ADR-0358 (credential login), ADR-0364 (passwords over HTTP), ADR-0335 (actor columns carry no foreign key), ADR-0313 (record before the write), ADR-0331 (platform-scope audit rows) |

## Context

ADR-0463's guide said there was no self-registration: every tenant, user, membership and password
was created by the operator, by hand, in three or four separate requests (or one script). The owner
asked for customers to be able to sign themselves up.

Full self-registration was costed and not built. It needs a mail channel for email verification
(none exists), a password-reset flow (needs the same channel), per-client abuse controls (behind
Caddy and the web proxy every request arrives from one container address), and a decision about
what a self-registered tenant *gets* (plans, trials and per-tenant quotas are absent). Without email
verification anyone could register under someone else's address, and since `meta.users.email` is
unique platform-wide the real owner could then never be onboarded.

So the increment is **request and approve** ("Option A"): a public form records a request and
creates nothing; the operator approves it with one click; approval creates everything at once. Two
things made the manual path worse than merely slow, and both are fixed by this:

- **It was three transactions.** Create tenant, provision user, set password ran as separate
  requests, so a failure in the middle left an orphan tenant or a user with no password, which the
  onboarding script had to detect and explain (the companion fix in this increment prints how to
  resume).
- **Nothing recorded that a customer accepted any terms.** There was no place to keep which version
  of the terms a company agreed to, or when, before taking its financial data.

## Decision

### The request

`meta.access_requests` is a platform-wide table (no `tenant_id`, so no RLS by meta-schema invariant
1). A request is `pending`, then `approved` or `rejected`, with
`access_requests_decision_pairing_check` making the decision columns agree with the status. One
pending request per address (a partial unique index), so a re-submit is absorbed rather than
duplicated. `decided_by` is TEXT under `uuidShapeCheck` with no foreign key, and
`approved_tenant_id` / `approved_user_id` are plain UUIDs with no foreign key: ADR-0335's rule (a
column recording a past act must not make its subject undeletable), and for the tenant column a
second reason, since `ON DELETE SET NULL` would violate the pairing check on an approved row.

The public intake is two out-of-registry paths in front of the gateway, the login's pattern:
`GET /v1/public/access-requests/terms` and `POST /v1/public/access-requests`. The POST answers the
**same 202** for a new request, an absorbed duplicate and a honeypot hit, and never asks whether a
user or a slug exists, so the route is not an oracle for either. Refusals, in order: intake closed
(503), invalid body (400 naming field paths only), honeypot (202, nothing stored), stale terms
version (409, the page reloads), reserved slug (400), queue full (503 + `Retry-After`). The body cap
(8 KiB) is enforced by the listener as the body arrives, not after it is buffered, and a
process-wide window caps submissions at 30 a minute on top of the optional per-client limiter.

**The intake opens only when three environment variables are all set**: the terms URL, the privacy
URL and the terms version. None set: closed, said at boot, and the form says sign-up is not open.
Some set: refused at boot naming the rest. The URLs must be https (http only for localhost).

### The approval

`POST /v1/platform/access-requests/{id}/approve` requires the caller to hold **all three** of this
deployment's platform-admin, platform-user and credential-admin grants, because approving does what
those three grants separately permit. It refuses an undeclared primary role (422
`role_not_declared`). That is stricter than provisioning, which only warns, because a workspace whose
only admin can do nothing is a failed onboarding. It also applies provisioning's escalation check,
and refuses a principal whose id is not uuid-shaped (403 `principal_not_recordable`) before
recording anything, since `decided_by` could not store it.

Then **one transaction** through `PostgresTenantStore.create(input, within)`:

1. set the new tenant's context;
2. record the tenant's creation, with the terms evidence in `after.origin`;
3. provision the user and membership, or attach an existing user;
4. set the password;
5. write the default settings;
6. mark the request approved, guarded by `status = 'pending' AND expires_at > now()`.

A lost guard throws, so everything rolls back and the answer is 409. `PgConnection` has no nested
transactions, so each store gained a `*Within(tx, …)` variant (`provisionWithin`,
`grantMembershipWithin`, `setCredentialWithin`, `putWithin`), and the old methods delegate to them.

**The operator's browser generates the password; it is sent once and never returned.** It is
hashed before the transaction opens, through the login's admission limiter. The response carries
`passwordSet: true`, `cache-control: no-store`, and no password, so no response store or log can
hold it.

**An existing user is attached only after the operator confirms ownership.** Because the email is
unverified, someone can file a request under a victim's address. If that is approved, they receive
the password. When the victim later asks for access, attaching their address would hand the new
workspace to whoever holds that account. So attaching requires `confirmedExistingOwner: true`, which
the console sends only after a checkbox carrying that warning. The confirmation is recorded in the
approval's audit detail. An attach never replaces the existing user's password (400
`password_not_applicable` if one is sent) and refuses a user that is not active.

### The evidence and its retention

The terms acceptance is written into the new tenant's `platform.tenant_created` audit row as
`after.origin`. That row is anchored into the tenant's chain and **retained by the Article 17
erasure**, so the evidence outlives the request row. It holds:

- `requestId`
- `termsVersion`
- `termsAcceptedAt`
- `contactEmailHmacSha256`: an HMAC of the lowercased address, keyed by an HKDF derivation of the
  credential pepper under its own label `crossengin.access-request.contact-email.v1`.
- `contactEmailHmacPepperVersion`

It is keyed rather than a plain hash because the audit log outlives an erasure, and anyone holding
the log could confirm a guessed address against a plain hash.

Pending requests expire after `--access-request-ttl-hours` (72) and decided ones are deleted after
`--access-request-retention-days` (30), by an in-process hourly sweep. There is no job queue on the
shipped stack, so the sweep is a timer stopped on shutdown. The public privacy notice states both
figures, read from the terms endpoint rather than hard-coded, because a deployment that changes a
flag would otherwise publish a false notice. The queue holds at most
`--access-request-max-pending` (200) pending requests, and "reject all pending" clears a flooded
queue in one act.

### The surfaces

- **Platform routes:**
  - list
  - stats (the sidebar badge)
  - approve
  - reject (reason required)
  - reject-pending

  Every decision is audited at platform scope before the write; an unrecordable one is a 503.
- **`apps/operate-web`:**
  - a public `/request-access` page and its two route handlers, exempt from the session middleware;
  - a console page `/platform/access-requests` with an approve panel, a client-side password
    generator (`crypto.getRandomValues`, 20 characters, rejection-sampled) and the attach
    confirmation;
  - a sidebar link with a pending badge;
  - a link from the login page.
- **The shipped compose** passes `--access-request-routes` and forwards the three variables
  defaulted empty, so the console works and the form stays closed until an operator publishes their
  own terms. `deployment-defaults.test.ts` fences both.

## Alternatives considered

- **Full self-registration** (an account usable without the operator): refused for now. It needs
  email verification, which needs a mail channel, plus per-client abuse limits, which need the client
  address to reach the API trustworthily. Without both it hands strangers' addresses to whoever
  registers first.
- **Store the terms evidence only on the request row**: refused. That row is deleted after the
  retention period, and an approved workspace's acceptance must survive it. The audit log is the
  retained record.
- **Store the contact email in clear, or as an unkeyed SHA-256, in the evidence**: refused. The
  audit log outlives an erasure, and an unkeyed hash of an email can be confirmed by guessing.
- **Return the generated password from the server**: refused. An approve response passes through
  idempotency storage and proxies; a password generated and displayed in the operator's browser never
  leaves it except in the request body.
- **One grant for approval**: refused. Approval performs a tenant creation, a user provision and a
  password set, and each of those already has its own grant. Collapsing them would let a narrower
  role do all three.

## Consequences

Verified live on PG 16, in compose order (migrate as the owner, `app-role`, `document-indexes`),
with the API booted from the **shipped compose `command:` verbatim** and connecting as the confined
`crossengin_app`:

- **Closed:**
  - the boot line says `intake CLOSED` naming the three variables;
  - terms answers `open:false` with `ttlHours:72, retentionDays:30`;
  - the POST answers 503 `intake_closed`.
- **Open:**
  - a valid request, a re-submit from the same address in different case, and a honeypot each answer
    the identical `202 {"status":"received"}`, and only one row is stored (lowercased);
  - the old `website` honeypot key is 400;
  - a stale terms version is 409, a reserved slug 400, and a 20 KB body 413 at the listener;
  - the log line carries the request id and the pending count, never the name or the email.
- **Approve:**
  - 201 with `cache-control: no-store` and `passwordSet: true`; the password string occurs in 0
    responses, 0 log lines and 0 audit rows;
  - the new admin signs in to the new workspace (200, role `erp_admin`), reads the settings the
    approval wrote (`EUR`, 30 days) and lists invoices (200);
  - the creation audit row's `after.origin` carries the request id, the terms version, the
    acceptance instant and the keyed email hash.
- **Refusals:**
  - a second approve is 409 `not_pending`;
  - no slug is 422; an undeclared role is 422 naming the 15 declared roles; a short password is 400;
  - a taken slug is 409 with nothing left behind;
  - an existing email is 409 `user_exists` naming the user and their status;
  - attach without confirmation is 400; attach with a password is 400;
  - a confirmed attach is 201 with `passwordSet:false`, and the user's original password still signs
    in to the new workspace.
- **Atomicity:** with `INSERT` on `meta.operate_tenant_settings` revoked from the app role (so the
  fifth step fails), approve answers 500 and leaves **no** tenant, **no** user, **no**
  `tenant_created` audit row, and the request still `pending`; the retry after restoring the grant
  answers 201.
- **Reject and sweep:**
  - reject without a reason is 400; reject is 200; reject-pending reports the count;
  - stats and the rejected list agree;
  - a pending request past its expiry is replaced by a re-submit;
  - the sweep, run as `crossengin_app`, deleted exactly one expired pending row and one decided row
    past retention.

The workspace sweep is green: build, typecheck, and 24,179 tests across 88 packages. The catalog is
**147** tables.

Two shapes are worth knowing:

- **A failed approval keeps its audit row.** The approval row is recorded before the write (ADR-0313),
  so an approval that then failed with a 500 leaves a `platform.access_request_approved` row with no
  paired refusal row. It records an authorized attempt, not a completed one. The 409 paths do write
  the paired `platform.access_request_refused`.
- **A bare api-key records under a shared id.** It resolves to the shared placeholder principal
  (ADR-0331), which is uuid-shaped, so its decisions are recorded under that one shared id rather
  than a person's.

## Open questions

1. **There is no per-client rate limit on the shipped stack.** `--pre-auth-rate-limit` is not passed,
   and even if it were, every request reaches the API from the web container's address, so all
   visitors share one key. The process-wide 30-a-minute window and the 200-request queue bound the
   damage. A bot can still fill the queue in minutes and keep real requests out until the operator
   rejects all pending. Closing this needs the client address forwarded trustworthily from Caddy
   through the web proxy.
2. **Address squatting.** One pending request per address means anyone can file first under someone
   else's address. The real person's later submission is absorbed into the squatter's request, with
   the same 202, until it is decided or expires. The operator sees the contact details they will
   confirm out of band, which is where this is caught.
3. **No email verification and no mail channel.** The operator transmits the password. Self-service
   password reset, and staff invitations by a customer's own admin, both still need the operator.
4. **No starter chart of accounts.** An approved workspace has no ledger accounts, so its first
   invoice is refused until its admin creates them (register P2.18).
5. **Race codes and clocks.**
   - Two concurrent approvals of one request can answer the loser with `tenant_exists` or
     `user_exists` rather than `not_pending`.
   - The expiry pre-check uses the server clock while the guarded `UPDATE` uses the database's
     `now()`, so clock drift turns `expired` into `not_pending`.
   - An attached user's status is read before the transaction.
6. **The request row survives an Article 17 erasure of the tenant it created**, for up to the
   retention period, because it carries no `tenant_id`.
