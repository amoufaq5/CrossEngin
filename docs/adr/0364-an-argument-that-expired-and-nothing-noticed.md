# ADR-0364: An argument that expired, and nothing noticed

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-13 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0301, ADR-0313, ADR-0316, ADR-0321, ADR-0331, ADR-0332, ADR-0333, ADR-0334, ADR-0335, ADR-0350, ADR-0358, ADR-0359, ADR-0362, ADR-0363 |

## Context

The user asked for one of two things: tenant self-registration, or an interface to manage tenants,
manifests and the database. This increment is the second, and most of it turned out to be the
first's prerequisite — a signup is *create a tenant, create a user, set a credential*, which are
exactly the three acts a console has to put behind a surface.

The measurement that decided the scope is short. `--platform-user-routes` (ADR-0335) mounts **ten**
routes: list, provision, get, suspend, reactivate and retire a user, and list, grant, activate and
revoke a membership inside a tenant. That is a complete identity surface. It has **zero** UI, and
the one act that makes any of it usable had **no route at all**.

### The argument against a route was right once and expired

`set-credential.ts` states its own reason for being a subcommand, and it is a good one:

> It is a subcommand and not a route because there is **no mail channel** … An operator with shell
> access to the box is the only principal that exists **before the first password does**.

Every clause is true. It is also an argument about the *bootstrap*, and it stops applying the
moment the CLI has been run once: after that there is an authenticated principal carrying a grant,
which is a thing that did not exist at install time. Nothing noticed the expiry, so the conclusion
outlived its premise and *every* password — the first and the thousandth — needed shell access to
the container.

The cost is specific. Onboarding a tenant through the browser broke at step 3 of 4:

| Step | Before |
| --- | --- |
| Create the tenant | `POST /v1/platform/tenants` ✔ |
| Create the user | `POST /v1/platform/users` ✔ |
| Set their password | `docker compose exec` ✘ |
| They log in | `/login` ✔ |

A console cannot replace a shell while one step still needs one, and that step was per *person*
rather than per deployment.

### A user could not change their own password either

The other half is worse in a different way: `PostgresCredentialStore.setCredential` has exactly two
callers — the CLI subcommand, and the login path's opportunistic re-hash when the scrypt floor has
risen. So **no deployment had any way for a user to change their own password**, and there is no
mail channel, so there is no reset either. Register item P1.16 recorded "no self-service password
change" as a UI gap; it was not a UI gap, there was nothing to build a UI over.

### Three live defects in the console this extends

Found while reading, not while looking:

- **`lib/platform.ts` declared a four-value `TenantStatus`.** The server's has had five since
  ADR-0334 added `pending_deletion`. Two consequences, both live: the type was *false about the
  wire*, and `platform/page.tsx`'s status filter offered the four it knew — so a tenant awaiting an
  Article 17 erasure was **unfindable in the console**, which is the one state in which an operator
  most wants to find a tenant.
- **`deploy/.env.example`'s step-1 curl could never have worked.** It posts a flat
  `{"email":…,"displayName":…}`; the server's body is `{user, membership?}` parsed `.strict()`, so
  it is a 400 every time. `deploy/README.md` has the nested form correctly — so the two documents
  disagreed and the one in the bootstrap path was the wrong one.
- **The sidebar's Platform group computed its active state by excluding its sibling**
  (`startsWith("/platform") && !startsWith("/platform/reviews")`). That is a maintained list of
  siblings written as an exclusion, so the third page under `/platform` would have lit up
  "Tenants" and nothing would have said so. ADR-0288's shape in a nav bar.

## Decision

### Two routes, and the split is the design

`credential-routes.ts` holds both, and they are **two acts wearing one name**:

| | Operator sets another's | Person changes their own |
| --- | --- | --- |
| Route | `POST /v1/platform/users/{id}/credential` | `POST /v1/account/password` |
| Authorised by | a **grant** (`--credential-admin-role`) | **possession of the current password** |
| Body | `{password, confirmUserId}` | `{currentPassword, newPassword}` |
| Subject | in the path | never — it is the caller |
| Mounts when | a role is granted | always, with `--credential-login` |

The preferences module's `buildSetHandler(ctx, onBehalf)` shape — one handler, a boolean — would
have been wrong here, and that is worth stating because it is the obvious move. There, self and
on-behalf are the *same* act on a different subject. Here the authorisations are **disjoint**: the
operator route must *not* ask for the current password, because the operator does not know it. The
bodies differ, the fences differ and the failure modes differ; one handler would branch on the
boolean four times.

The self route takes **no flag**, following `--idempotency-store`'s reaper argument: a deployment
that can log in must be able to change the password it logs in with, and putting that behind a
second opt-in is a feature with a trap in it.

### An operator may not aim the operator route at themselves

`self_not_permitted` (403) is the four-eyes shape that actually applies to a credential, and unlike
a second approver it is **checkable from what the request already carries**. The operator route
skips the current-password proof by design; letting an operator target themselves would let them
replace their own credential *without proving they hold it*, so a session lifted from a live
browser could lock the real operator out and keep the account. Changing your own password is the
other route, which proves possession. Neither route can do the other's job.

It is refused **before any store call and before any audit row**: an operator aiming it at
themselves is a request that must not be expressible, not a write we want a record of attempting.

### The grant is its own, because `meta.users` has no belt behind it

Verified against the live catalog as a non-owner:

```
audit_log               | relrowsecurity t | confined t
operate_entity_records  | relrowsecurity t | confined t
tenant_lifecycle_events | relrowsecurity t | confined t
user_tenant_membership  | relrowsecurity t | confined t
tenants                 | relrowsecurity f | confined f
users                   | relrowsecurity f | confined f
```

`meta.users` has **no `tenant_id`, no RLS and no policies** — which `credential-store.ts` already
says in its own words, and which is what makes login possible at all. So for a write to that table
the route's role check is the **entire** authorisation: there is no policy behind it that would
refuse a session which got past the handler, which is the belt every tenant-scoped write in this
app has.

That is the argument for `--credential-admin-role` rather than reusing `--platform-user-role`.
Provisioning a principal and taking over its credential are different privileges, and the second
has nothing underneath it. The shipped compose grants both to `platform_admin`, because on a
single-operator deployment they are one person and pretending otherwise buys nothing — but the flag
is separate, so a deployment that wants those populations to differ changes one line.

### The refusal set is smaller than the CLI's, by construction

`SET_CREDENTIAL_OUTCOMES` carries `pepper_absent` and `pepper_refused`; `CREDENTIAL_REFUSALS` does
not, and the omission is the interesting part. These routes are built from the **same**
`resolveCredentialAuth` material the login is built from, so a deployment with no usable pepper has
no login, and a gateway route cannot be reached without one. The CLI has to carry both because it
resolves its own.

`CREDENTIAL_REFUSAL_STATUS` is a total map over the eight that remain, so a ninth is a compile
error at the one place that decides rather than a member inheriting whichever branch an `if`-chain
ended on. Two of the statuses are decisions:

- **`current_password_wrong` is 401, not 403.** The caller is authenticated as themselves and their
  role is irrelevant; what failed is a second authentication, not an authorisation.
- **`no_current_credential` is 409, not 401.** *There is no password* is a different fact from *the
  one you sent did not match*, and conflating them would tell an api-key or SSO user to try harder
  at something that cannot succeed. The remedy is an operator setting a first one.

`unreadable_hash` from `verifyPassword` maps to `current_password_wrong` and is deliberately **not**
counted as a failed attempt — `password.ts` states the reason, and counting it would lock a person
out of an account whose password they typed correctly.

### The 200 says the sessions are **not** revoked

`{credentialChanged: true, sessionsRevoked: false}` plus a sentence. A session token is verified
against the JWKS by signature and carries its own expiry, so changing the password **cannot** end
one. Saying so is the alternative to a reader assuming that it does — and a page that implied
revocation where there is none would be worse than silence. The remedy for cutting every session
off is rotating `OPERATE_TOKEN_SIGNING_KEY`, which `deploy/README.md` already documents.

### Nothing derived from a password is recorded

The audit payload carries who, whom, which act, and `hadCredential` — the one fact about the
previous state worth having, because it separates provisioning a first password from replacing a
working one, which are different acts to anyone reading the trail. `before` is absent entirely: the
only thing that changed is the one value that must not be recorded.

The audit goes **before** the write and an unrecordable one refuses with 503 (ADR-0313), and the
two routes file against different scopes, deliberately:

- the operator route uses `tenantId: null` — platform scope (ADR-0331), because a credential is a
  property of the **user** and not of any one membership, so filing it under a tenant would file it
  under an arbitrary one;
- the self route uses the caller's own tenant, because that act is about a person inside a tenant
  and that tenant's auditor is entitled to read it.

Neither uses the operator's tenant.

### The console

`/platform/users` (list + provision), `/platform/users/[id]` (record, status actions, set password),
a **Members** panel on `/platform/[id]` (list, grant, activate, revoke) and `/account` (change your
own). `lib/users.ts` is the one client, importing `PlatformError` and `throwProblem` from
`lib/platform.ts` rather than restating them — the 401-redirect inside `throwProblem` is the half a
second copy would forget.

Four things the console deliberately does **not** do, each because the honest version does not
exist:

- **No user search.** `buildListUsersHandler` reads exactly `status`, `limit` and `cursor`, and
  `PostgresUserStore.list` builds its `WHERE` from `status` alone. A client sending `?email=` would
  get every user back under a 200 indistinguishable from a filtered one — ADR-0359's class
  precisely, a surface whose drop changes *which rows come back*. So the parameter is absent from
  the client and its absence carries the reason.
- **No "which tenants is this user in" view.** `platform-users.ts` refuses that read by name, on the
  stated ground that it has no scope to name and would be owner-dependent by construction. The user
  page says memberships are reached from the tenant and links back, rather than faking it by
  looping over tenants.
- **No role dropdown.** Valid roles come from the tenant's resolved manifest and no route serves
  them. The field is free text and the form says an unknown role is accepted here and grants
  nothing at serve time — a real property, where a dropdown built from a list we do not have would
  be a guess.
- **No database browser and no SQL.** A tenant's records are served by that tenant's own compiled
  gateway under its field grants, classification and redaction (ADR-0338, ADR-0339, ADR-0343). A
  platform-level reader would be a second path to the same rows with none of that applied.

### `confirmUserId` is typed, never prefilled

The id is repeated in the body, following `rekey --confirm-tenant` and ADR-0316's
`confirmTenantId`: this overwrites a credential, so naming the wrong user locks a real person out
*and* hands their account to whoever chose the password. There is no `confirm: true` boolean,
because a flag meaning "I meant it" can be sent by a client that never read the id.

The page does **not** seed the field from the route param, and the comment says why: prefilling it
from the same variable would confirm nothing. The comparison is case-insensitive, because a UUID
differing only in hex case is the same id.

## Alternatives considered

**Put the self-service change on the login interceptor.** Rejected: `POST /v1/auth/token` is
wrapped in front of the gateway because `authenticate` runs before `match_route` and a login
carries no credential. Both of these carry one, so they belong behind exactly the auth stage that
would have 401'd the login. Putting a change-password route outside the gateway would mean
re-implementing authentication to find out who was asking.

**One flag mounting both routes.** Rejected: the self route's authorisation is possession of the
current password, so gating it on a grant would make a deployment choose whether its users may
change their own passwords — a question with one sensible answer.

**A `must_change_password` column**, so an operator-set password is single-use. Attractive and
refused for this increment: it is a catalog change plus a login-path branch, and its absence is
degraded rather than wrong. Named as the top follow-up.

**Four-eyes on the operator route** (a second approver, as `--notification-template-routes` has).
Rejected on the bootstrap: a single-operator deployment is the shipped shape, so requiring two
people would make user #2 unprovisionable. `self_not_permitted` is the part of four-eyes that is
checkable here without that cost.

**Adding an email filter to the users list.** Deferred rather than faked. It is a store change, a
handler change and a `pg-column-coverage` row — a capability, not part of this spine — and the
alternative of a client-side filter over the loaded page would look like a search and see one page.

## Consequences

### What this fixes

- A password can be set over HTTP. Onboarding a tenant is four browser steps, not three plus a
  shell, and the shell step is **once per deployment** rather than once per person.
- Every user of every deployment can change their own password. No deployment could before.
- Ten identity routes have a UI.
- A `pending_deletion` tenant is findable in the console and its type no longer lies.
- `deploy/.env.example`'s bootstrap curl works.
- A fourth page under `/platform` cannot silently steal "Tenants"' highlight.

### What this costs

- **An operator-set password is not single-use**, so a deployment where the operator should not
  know a user's password has no mechanism for that yet. The audit row records that they set it,
  which is the mitigation and not a fix.
- **`--credential-admin-role` is a real privilege with no belt.** `meta.users` has no RLS, so this
  grant is the whole fence. The shipped compose gives it to `platform_admin`, which is also the
  role that can delete tenants, so on that deployment it widens nothing — but a deployment that has
  separated those populations must decide this one deliberately.
- **No rate limit on `/v1/account/password`.** The lockout on the credential record bounds guessing
  the *current* password, which is the attack on that route, and `--rate-limit-policy` is absent
  from the shipped compose anyway (register P0.3).
- The users list has no search.

## Implementation notes

### I committed the increment's own class, and a cast is why `tsc` had nothing to say

The first draft of `credential-routes.ts` read `input.pathParams` and `input.body` through
`as { pathParams?: … }` casts. `HandlerInput` carries **`params`** and **`parsedBody`**. So every
request to both routes would have seen an undefined id and an undefined body and answered 400 —
and the casts are exactly why the compiler was silent. That is ADR-0362's class (a type annotation
standing in for a check) committed *inside* the increment that cites it.

The handlers destructure the real fields now and there is no cast anywhere in the file, so a
renamed one is a compile error. The file carries that paragraph where the helper used to be.

Two smaller instances of the same shape, both caught before they shipped and both from reading the
contract rather than from a test: `ResolvedPrincipal.principalId` is a **non-nullable** `string`,
so two null checks were dead branches that strict mode rejects; and the web client's
`grantMembership` sent `{...body, tenantId}` into a schema that `.omit()`s that key and is
`.strict()`, which is a 400 rather than a harmless repetition.

### Proving the module was actually compiled

"No type errors" was also true of the broken cast version, so it is not evidence. `tsc --listFiles`
confirms the module is in the program, and a deliberate `const _proof: number = "not a number"`
appended to it produces `TS2322` at that file and line, which restoring removes. Worth doing once
per new module in this app: `index.ts` is the only thing that pulls some files into the build.

### The store gained one read, and it is the exception to the scoped-read rule

`PostgresCredentialStore.findById`. Neither route can use `findByEmail`: the self-service change
identifies its subject from `principal.principalId`, which *is* `meta.users.id`, and asking the
caller for their email to look up the row they are already authenticated as would make the subject
a request field — the one thing that route must not have.

It carries **no tenant context and no scope predicate**, which is correct rather than an omission:
`meta.users` has no `tenant_id`, no RLS and no policies. It also has **no `spendPasswordWork`
obligation on a miss**, which is the one way it differs from its sibling — `findByEmail` is reached
by an unauthenticated login where an early return is an account enumerator, while every caller of
this one is past the auth stage and is naming its own id or one it holds a grant over.

### One store instance, not two

`node.ts` constructs `PostgresCredentialStore` once, before `extraRouteList` is populated, and the
login interceptor block below reuses it. Two instances over one connection would be two spellings
of the same four statements. `conn !== undefined` stays in the later condition beside
`credentialStore !== null` and is not redundant: it is what narrows `conn` for the
`PostgresUserStore` on the next line, and the store check implies it only to a reader.

### The sidebar's active state is a longest-prefix match over a declared list

`PLATFORM_LINKS` plus `activePlatformHref`, replacing the exclusion. A fourth entry is one line and
cannot be forgotten.

### Three measurements of mine answered the wrong question, which is this repository's own class

ADR-0363 found a fake connection answering a statement it could not really serve, and concluded
that **a shape match must be specific to the statement and not merely true of it**. The same shape
caught me three times here, one level out, in the measurements rather than in the code:

- A no-grant run answered `200` where the route should not have been mounted. Before concluding a
  defect I checked what was listening: the *granted* server still owned the port, and the ungranted
  one had printed its boot lines and died `EADDRINUSE` — so I had read one process's log beside
  another's response. Killed the first, and the correct `404 no route for POST …/credential`
  appeared.
- I reported an agent as having "returned a result and written nothing". The workflow journal's
  `result` lines lag by the concurrency cap, so it was still running and mid-write; the file went
  188 → 200 → 580 lines while I was deciding. I nearly clobbered its work.
- A test run failed `expect(db.updates()).toHaveLength(0)` on an ordering the handler plainly gets
  right. It passed in isolation and passed again in the full file, because the first run had read a
  test file a sibling agent was part-way through writing — the store test count went 24 → 25
  between runs. **A test run is a measurement of the tree at an instant, and a concurrent writer
  makes that instant not the one you think you measured.**

None of the three was a code defect and all three had a confident wrong reading available. The
narrow lesson is the one CLAUDE.md now carries for `next build`: name what you are measuring —
which process, which revision of the file — before believing what it says.

### Verified live

A throwaway PG 16.13 cluster, the catalog applied (`147` `meta` tables = 146 catalogued +
`_meta_migrations`, re-plan clean), and a non-superuser `NOBYPASSRLS` role:

- The RLS census above, which is what the grant decision rests on.
- `tsc` clean across `apps/operate-server` and `apps/operate-web`.

_(The end-to-end HTTP verification is recorded in the commit message rather than here, because it
exercises the shipped binary rather than a decision.)_

## Open questions

1. **A single-use / must-change flag for an operator-set password.** The top follow-up. It is a
   nullable `credential_must_change` column, a branch in `verifyLogin`'s outcome, and a console
   surface that tells the operator the password is one-use. ADR-0358's measurement applies: a CHECK
   on a column the plan is *adding* has no existing rows to validate against, so the migration is
   free.
2. **No rate limit on the self-service route.** The record lockout is the fence for guessing the
   current password. A per-route policy needs `--rate-limit-policy` mounted, which register P0.3
   covers.
3. **`UiViewer` carries no identity.** `/account` renders the *role* it signed in with and says so,
   because `UiSchema`'s viewer has `primaryRole` and `roles` and no user id, display name or email.
   That is a server-side `ui-schema.ts` change and it is what would let the console say *who* is
   signed in rather than *as what* — ADR-0358's own open end, now with a page that wants it.
4. **An email filter on the users list.** A store change, a handler change and a
   `pg-column-coverage` row.
5. **Nothing surveys the credential surface at boot.** Every sibling capability in this binary says
   at boot what it will and will not do; the credential routes print one line naming what is
   mounted. Whether a deployment with `--credential-login` and no `--credential-admin-role` should
   *warn* that setting another user's password still needs a shell — rather than only saying it on
   the mount line — is the shape the other surveys take and is not taken here.
6. **The diagnostics half of the console is unbuilt.** Every boot survey in this binary
   (`surveyCheckAdmission`, `surveyListSurfaces`, `decideCursorDisclosure`, the unique-enforcement
   report, the erasure coverage report, the job survey) is `console.log` only, and
   `crossengin apply --plan` produces a JSON plan no route serves. An operator reads them by
   `docker compose logs`. That is the next increment of this console and it is a bigger one than
   this, because it is routes before UI.
7. **Tenant self-registration**, which this increment is the prerequisite for. What it still needs:
   a public route with `--rate-limit-policy` mounted, email verification (so a mail channel), and a
   decision about what a self-registered tenant gets — `trial` was removed from the tenant
   lifecycle in ADR-0334 as a plan tier with no producer.

## Addendum: what an adversarial review of this increment found

Written in the same session, after the increment above was committed as `df61cb8` and pushed. Four
independent lenses read the new module, the web contract, the pages and the docs against the server
they talk to; eleven findings were raised and each was handed to a separate agent instructed to
refute it. Two survived with high severity, three more were real, and the fixes are in this commit.
They are recorded here rather than in a new ADR because they are this decision's own consequences,
and one of them inverts a claim this file makes above.

### The self-service route was an unmetered guessing oracle, and it ignored the lock the login honours

`buildChangeOwnPasswordHandler` read `existing.credentialHash` and nothing else. `findById` returns
`status`, `failedAttempts` and `lockedUntil`, and the handler read **none of the last three**. So:

- **The account lockout was bypassed.** The login refuses a locked account
  (`auth-token-route.ts:243`) and this route went on verifying passwords against it at full speed.
  Two doors, one lock, and the slow one was reachable through the fast one.
- **A wrong guess was not counted.** `recordFailure` had exactly one caller in the workspace — the
  login's `onFailure` — so no number of wrong attempts here ever produced a lock.
- **A wrong guess left no trace at all.** `record` is called *after* `verifyPassword` returns
  `matched`, so the refusing branch took neither `record` nor `recordRefusal`. A wrong possession
  proof against a live account was the one event on this surface an operator reading the trail would
  want, and it wrote nothing.

The reachability is this file's own argument, one section up: *"a session stolen from a live browser
could lock the real operator out and keep the account"* is given as the reason `self_not_permitted`
exists, so a held live session is an in-scope state. With one, the holder converts a time-boxed
session into the permanent password. The refuting agent corrected two overstatements in the original
report and both corrections are worth keeping: the lock is **not** cleared by guessing (the clearing
is in `setCredential`, behind the `matched` gate), and scrypt at N=2^15 bounds the rate to roughly
130 ms per attempt. So the honest statement is *the configured lockout was unenforced and the
attempts left no trace*, not *free brute force*.

The fix shares rather than copies. `isLocked` is exported from `auth-token-route.ts` as
`credentialIsLocked`, because a second spelling of *is this account locked* is exactly how the two
doors came to disagree. `CredentialRoutesContext.onFailedAttempt` is **required**, and that is the
fence: an optional counter whose default is "do not count" is the defect restated as a default.
There is deliberately no `LoginLockoutPolicy` field beside it — the handler checks the lock by
reading the column the counter wrote, so carrying the threshold here would be a declaration nothing
reads, which is the class this run keeps finding. `parseLoginLockout` is hoisted in `node.ts` so one
result reaches both surfaces.

Not counting a locked attempt is the login's own rule, inherited: hammering a locked account must
not extend its own lock, or a caller could keep an account locked forever without ever learning a
password. Not counting `unreadable_hash` is the other half, and the comment claiming that
distinction was already in the file — describing a split the code did not make, since both outcomes
took one branch and neither was counted.

### `status` was read and never consulted, so a password for a retired user reported success

The same `findById` returned `status` and nothing read it, while `verifyLogin` refuses
`status !== "active"` outright. An operator set a password for a retired user, got
`200 credential set`, and that user was told their password was wrong. That is ADR-0337's
falsely-true-control direction on the surface built to make the act legible.

`CREDENTIAL_WRITE_BY_STATUS` is the total map, and the split is **terminal versus recoverable**,
read off `USER_STATUS_TRANSITIONS` rather than off a status name. `deleted` has no outgoing
transition, so a password set there could never be used by anybody and the route refuses. `suspended`
transitions back to `active`, so the write lands and the response **says what it does not yet
buy** — ADR-0322's report-rather-than-refuse, with `loginBlocked` and `subjectStatus` on the 200 and
in the audit detail. `selfMay` is false for every non-active status, because a session minted before
a suspension stays valid until it expires, so a suspended person can still reach that route, and
rotating the credential they were suspended from is the one thing the suspension exists to stop.

### `self_not_permitted` cannot fire for the credential the shipped compose grants, and this file overstated it

A bare `token:role:tenant` spec resolves to a `service_account` on a shared placeholder id
(ADR-0331), which names no `meta.users` row — so for the bootstrap api key there is no "yourself" to
refuse. The compose comment and `deploy/README.md` both asserted the refusal without qualification.

No code changed, and the reasoning is why: the check exists to stop a principal replacing *its own*
credential without proving possession, and a service account has no password to take over. It fires
exactly where it matters, which is a signed-in person using the console. What was wrong was the
prose, and both places now say so.

### Three documents told the operator to do things that cannot work

- **`.env.example`'s bootstrap curls named `http://localhost:8787`, which the stack published
  nowhere.** `api` declared `expose: 8787` — the compose network only — and Caddy's 80/443 were the
  only published ports, so every command in the only documented path to the first login was refused
  by the host. Fixed by **publishing `127.0.0.1:8787:8787`** rather than by rewriting the commands
  against `https://api.$DOMAIN`: the bootstrap is precisely the moment DNS may not have propagated
  and Caddy may hold no certificate, so pointing it at the TLS layer makes the first user depend on
  the last thing to come up. `127.0.0.1:` is the whole of the binding — a bare `8787:8787` publishes
  on every interface, which on a cloud VM is the public one.
- **`docker-compose.ai.yml` carried its own copy of the entire `api` command, and it was ten flags
  behind.** Compose replaces a `command` rather than merging it, so adding one flag meant repeating
  all of them, and the copy's own comment read *"Keep the two in step when either changes."* Nobody
  did. Missing: `--credential-login` (so **the whole self-hosted-AI path had no login**, and the web
  app it ships with could authenticate nobody), `--platform-user-routes`, `--idempotency-store pg`,
  `--jwt-issuer`, `--jwt-audience` and five more — and it still passed `--api-key` on argv, the
  exposure ADR-0357 removed from the base. This is ADR-0288's maintained list again, and the fix is
  the one that has worked every previous time: make the duplicate **unnecessary** rather than
  correct. `ai-model-source.ts` gives the model an environment route (`OPERATE_AI_MODEL`, already
  documented and already used by the overlay's own `ai-pull` service), which was the only
  CLI-only AI setting — the provider has always resolved from env — so the overlay now declares
  `environment:` alone. Environment maps **merge** where commands replace, so it inherits all 16
  flags and all 33 variables, and there is nothing left to keep in step.
- **`deploy/ORACLE.md` was not touched by the original increment and is the document an Oracle
  operator actually follows.** It still headed its section *"Create your first user — this is a
  shell step, on purpose"*, told the reader to hand-edit the api command to add flags the compose
  already passes, and granted `erp_admin` where `.env.example` grants `platform_admin` — a fork that
  decides what the first person can do, since a session carries exactly one role.

### Four things the review got wrong, kept because the corrections are the useful part

`account_locked` is **unreachable from the operator panel**, so the UI does not claim it: that route
*clears* a lock (`lockCleared: true`), and a sentence telling an operator to wait out a lock that is
not there would be a remedy that cannot work. `credentialRouteAbsent` was already at module scope,
so the 404 defect was a missing second reader rather than a scope problem. `setUserCredential`
already returned its body, so only the interface needed the new fields. And the three 403s on that
panel (`forbidden`, `self_not_permitted`, `user_not_active`) cannot be told apart by the page at
all, because `throwProblem` keeps `detail` over `error` — so the server's sentence leads and the
page's help names all three remedies, rather than string-matching prose that will be reworded.

### Verified live, as a non-owner `NOBYPASSRLS` role

A throwaway PG 16.13 cluster, the catalog applied (964/964), the real server with
`--login-lockout-attempts 3`:

| what | result |
| --- | --- |
| operator sets a password for an **active** user | `200`, `loginBlocked: false` |
| operator sets one for a **suspended** user | `200`, `loginBlocked: true`, detail names the status |
| operator sets one for a **retired** user | `403 user_not_active`, no audit row, no write |
| three wrong current passwords on the self route | `401` each, **three refusal rows**, counter advances |
| the fourth attempt | `429 account_locked` |
| the **correct** password while locked | `429` — the lock is checked before any verification |
| the **login** while locked | `401` — one counter, one lock, two doors |
| operator sets a password | lock cleared, `UPDATE … credential_locked_until = NULL` |
| re-login, then self-change | `200`, `sessionsRevoked: false` |
| a session minted **before** a suspension | `GET /v1/meta/schema` `200` (live) and `POST /v1/account/password` `403` |
| password, hash or pepper anywhere in `meta.audit_log` | **0 rows** |

The audit trail reads `platform.user_credential_set` at platform scope carrying `subjectStatus`,
three `platform.user_credential_refused` rows at tenant scope carrying `verification: mismatched`,
and `account.credential_changed` at tenant scope. Before this commit the three refusal rows did not
exist. All of it is invisible to the serving role without `app.platform_audit`, which is RLS doing
its job rather than a missing row.
