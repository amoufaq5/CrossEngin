# ADR-0376: A default that is not a default

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-20 |
| **Authors** | platform |
| **Reviewers** | platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0301 (credentials never on argv), ADR-0334 (a remedy that cannot work is worse than none; `missing` vs `not applicable`), ADR-0338 (a refusal that breaks nothing that worked), ADR-0357 (the compose contradicting its own comment), ADR-0364 (the documented path that could not be followed), ADR-0369 (a session carries every role its membership grants) |

## Context

The register's P0 item 3 says the shipped `deploy/docker-compose.yml` mounts no background
subsystem, so nearly everything built since Phase 3 is off on every deployment there is. It has
been open for five increments and its count has gone stale three times, because each increment
added a request-path flag to the compose and moved nothing about the background half.

That framing turned out to be the wrong question, and asking the right one is most of this
increment. The register's own method — P3 item 1 is a list of thirteen documented claims that were
false in the direction that wastes an increment — says to measure a verdict before pasting it, and
the measurement here refuted the register on three of the flags, refuted **this increment's own
first draft** on one, and turned up a defect in the deployed binary that was in no register entry
at all.

The class is **a default that is not a default, and a surface that does not say it is there.**

## Decision

Three things, measured in that order.

**1. The drain-absence warning could never fire, and `in_app` is the instance of the rule rather
than an exception to it.** `node.ts` gated it on `senderWiring.report.channels.length > 1` with a
comment saying it exists so that `[notify] channels: …` does not read as "email works" to an
operator who configured a provider and never started the drain. But `buildSenderRegistryFromEnv`
registers `in_app` unconditionally and the shipped compose sets no SES or Twilio variable, so
`channels` is exactly `["in_app"]` — length 1 — and the warning was unreachable on every deployment
that ships. Boot printed `[notify] channels: in_app` and stopped, which reads as "in-app notices
work", and they did not: `DeliveryScheduler` is the only delivery path in the binary, so with no
drain nothing is delivered on any channel.

The gate is the **store** now, which is the axis on which the two states genuinely differ: a
Postgres store with no drain has a remedy to name, and `--store memory` refuses the flag at parse
and builds no notification store at all, so there is nothing to warn about (ADR-0334's `missing`
versus `not applicable`). A channel-count threshold could not have been right at any value —
lowering it to `>= 1` is a tautology dressed as a threshold, because `in_app` makes it always true.

**2. Two flags become defaults on the compose, and one does not.**
`--notification-drain-ms 15000` and `--tenant-status-gate` are on the `api` command.
`--read-state-routes` was on it in a draft and the measurement took it back out; see below.

**3. Two surfaces that mounted silently now announce themselves.** Eighteen bracketed boot surfaces
print a line — `[platform-users] registry routes mounted for roles: …`, `[auth] credential routes
mounted: … for roles: …`, `[tenant-status] gate mounted over …` — and the read-state routes and the
delivery drain printed nothing at all. The read-state surface had three `[read-state]` warnings for
its *refusal* branches and no line on success, so the one mount an operator could not confirm from
the log was the one whose client silently degrades.

And the documented bootstrap is corrected in `deploy/.env.example`, `deploy/README.md` and
`deploy/ORACLE.md`: it was **one step short of runnable** and it claimed a shell step it no longer
needs. See *Implementation notes*.

## Alternatives considered

- **Option A: default `--read-state-routes --read-state-role platform_admin` on.** This was the
  first draft and it shipped as far as a live verification before being withdrawn.
  - **Pros:** measured to work end to end. Without the flag every badge fetch in `operate-web`
    answers `404 no route for GET /v1/notifications/unread`; with it, and a session minted by the
    documented bootstrap, `GET /v1/notifications/unread` answers **200** with
    `{"scope":"self","viewer":{...},"unread":0}` and the real viewer resolved.
  - **Cons:** nothing in the UI can clear what it counts. `markNoticeRead` and `markReadThrough`
    exist in `operate-web/lib/notifications.ts` with **zero consumers**; no page lists notifications
    at all (`listNotifications` is called by `Sidebar.tsx`'s badge fallback and by `/setup`, which
    filters to design-review decisions); and `/inbox` is the *approvals* inbox over entity records,
    a different subject — `Sidebar.tsx`'s own comment says so. So the default would replace a
    decaying recency approximation with a true unread count that only ever goes up.
  - **Why not:** a number that only goes up is not information, and ADR-0334's rule is that a remedy
    which cannot work is worse than naming none. It is blocked on a **surface** — a notifications
    page with a mark-read affordance — and not on a default decision. The absence is fenced with its
    reason so that the next person meets the finding rather than the flag.
- **Option B: lower the drain gate to `channels.length >= 1`.** The minimal edit.
  - **Pros:** one character.
  - **Cons:** `in_app` is registered unconditionally, so the condition is always true and the
    threshold is decorative. It would also still be *about* channels, when the question is whether
    anything will be delivered.
  - **Why not:** a conjunct that cannot be false is a conjunct a reader will trust and a maintainer
    will "tidy". Deleting it and gating on the store says what the branch means.
- **Option C: grant `--read-state-role` for every role a person might sign in with.** Sixteen flag
  occurrences on the compose.
  - **Pros:** every console user's badge answered rather than approximated.
  - **Cons:** measured, the base grant protects nothing: `resolveViewer` takes the viewer from
    `principal.principalId` unconditionally and `bodyNamesAViewer` refuses a body naming one, so
    `allowedRoles` gates a principal's access to its *own* row. That is ADR-0364's argument for
    `/v1/account/password` needing no grant at all.
  - **Why not:** moot once Option A is withdrawn, and the honest fix is upstream — dropping the role
    check from the three self-scoped reads while keeping `backfillRoles`, which is the one grant that
    gates something. That is an authorization-contract change and is recorded as an open question
    rather than slipped into a compose edit.
- **Option D: leave `--tenant-status-gate` opt-in, per ADR-0334.** That ADR's stated reason is that
  on-by-default "would refuse requests of a deployment that works today".
  - **Pros:** no behaviour change.
  - **Cons:** measured on this stack, it refuses nothing that worked. The shipped key carries
    `platform_admin`, which reaches 0 of `erp-core`'s 255 (entity, operation) pairs (ADR-0365), so
    `GET /v1/vendors` with it was **already** a 403 — the gate only changes which 403 and improves
    the diagnosis, and `/v1/platform` is exempt so the bootstrap is untouched. What it does change is
    the case an operator reaches by following `.env.example`'s own advice to use "any placeholder
    tenant uuid": with an ERP role, that key was served **200** over a tenant with no `meta.tenants`
    row, writing records under a `tenant_id` with no parent.
  - **Why not:** serving an unprovisioned tenant is not "working", it is the wrong answer — ADR-0338's
    rule — and the boot survey names the offending tenant by uuid before the first request. The
    register's own reason for defaulting it on (the directory read works for any role) answered a
    different question and is corrected here.
- **Option E: add a `volumes:` mount for the four file-taking flags in this increment.**
  - **Pros:** would close the rest of P0.3.
  - **Cons:** the four are not peers, which decides how that edit should be designed. Measured:
    `CheckpointConfigSchema.safeParse({})` and `IntegrityProofConfigSchema.safeParse({})` both
    succeed **fully defaulted**, `--deletion-capabilities` is a six-key declaration with no secret,
    and `AuditChainConfigSchema` requires `privateKeyBase64` and `publicKeyBase64` — a 32-byte
    Ed25519 private seed. And that fourth one is the **keystone**: `--tenant-deletion-routes` is
    skipped outright when no chain producer exists, so the whole Article 17 story sits behind the one
    flag carrying a credential, which ADR-0301 says reaches this process through the environment
    rather than through a file.
  - **Why not:** three need a volume and one needs an env route for its keypair, so it is a design
    decision about the supply mechanism and not a compose line. Documented with its measurement.

## Consequences

- **Positive:** the deployment that ships delivers notifications, which it did not — the
  design-review decision notice `--require-design-review` makes real was written to
  `meta.notification_dispatches` and reached nobody. A tenant that is suspended, archived or
  pending deletion is enforced on every request, and an api-key naming an unprovisioned tenant is
  refused rather than served. The two silent mounts announce themselves. Three deployment documents
  describe a bootstrap that can be followed.
- **Negative:** a fresh stack now prints a boot **error** line about the placeholder tenant in
  `OPERATE_ADMIN_API_KEY`, which is correct and reads like a break — so it is documented in the
  compose comment and in `README.md` rather than left to be discovered. The drain costs one sweep
  per 15s per active tenant on a deployment that was doing none.
- **Neutral:** `--read-state-routes` stays off, so the inbox badge keeps its recency approximation.
  The 404 it falls back on is unchanged.
- **Reversibility:** every part is one line. The gate change is reverted by restoring the conjunct
  (and the fence below would fail, which is the point); the two defaults by deleting their lines
  (likewise).

## Implementation notes

**The documented bootstrap was one step short of runnable, in all three documents.** Every version
of `.env.example`'s walkthrough omitted creating the tenant, so step 2 of its four — the membership
grant — answered `422 unknown_principal: cannot grant a membership: meta.tenants has no row for the
id this grant names` on every fresh deployment, and there was no documented source for the
`<tenant-uuid>` it asked for. The tenant id is **minted by the server**:
`CreateTenantInputSchema` is `{slug, name, …}` and sending `id` is a
`400 unrecognized_keys`. So the placeholder uuid in `OPERATE_ADMIN_API_KEY` can never name a real
tenant, which is both why that comment calls it a placeholder and why `/v1/platform` has to be
exempt from the gate. It is five steps now and the first one creates the tenant.

**And the one step it called shell-only has been an HTTP route since ADR-0364.** The file's reason
was: "the console sets a password over HTTP and reaching that route needs a session, which needs a
password". That is true of the *console* and false of the *route*:
`POST /v1/platform/users/{id}/credential` is authorised by the `--credential-admin-role` grant,
which the shipped compose passes, and the credential that satisfies it is the bootstrap api-key.
Measured — 200 with `x-api-key` alone on a cluster holding no password anywhere. `set-credential`
is kept as the documented fallback for a deployment that grants no credential-admin role.

**`ORACLE.md` carried ADR-0369's pre-fix claim and told an operator to work around it.** It said *"A
session carries exactly one role … `secondaryRoles` is populated by nothing anywhere"* and concluded
that one person doing both jobs needs **two memberships in two tenants**, keeping a spare tenant for
the purpose. ADR-0369 closed that: one membership with `primaryRole: platform_admin,
secondaryRoles: ["erp_admin"]` reaches 250 of 255 where `platform_admin` alone reaches 0. The
commands grant both now.

**Verified live** on PG 16.13, as the non-owner `serving` role, against a throwaway cluster the
catalog was applied to in full (964/964 statements, 0 failed, re-plan clean, 147 `meta` tables):

| Arm | Result |
|---|---|
| shipped flag set, before | `[notify] channels: in_app` and **no** drain warning |
| new default set | `[notify] delivery drain: every 15000ms`; `[read-state] … mounted for roles: platform_admin` |
| drain removed, Postgres store | `[notify] no delivery drain is running, so NOTHING is delivered on any channel — in_app included …` |
| `--store memory` | **0** drain warnings |
| gate on, `tok_admin` → `/v1/platform/tenants` | **200** (exempt) |
| gate on, `tok_admin` → `/v1/vendors` | 403 `tenant_not_provisioned` |
| gate **off**, `tok_admin` → `/v1/vendors` | 403 `forbidden` (RBAC — so the gate loses no capability) |
| gate **off**, `tok_erp` (ERP role, placeholder tenant) → `/v1/vendors` | **200 `{"data":[]}`** — a tenant with no row, served |
| boot survey | `[tenant-status] 1 configured API-key tenant(s) have no meta.tenants row … 00000000-…` |
| documented bootstrap, step 2 as written | **422** `cannot grant a membership: meta.tenants has no row` |
| bootstrap with step 1 inserted | tenant 201 → user 201 → membership 201 → credential **200 over HTTP** → login 200 |
| read-state with that session | **200** `{"scope":"self","unread":0}` |
| read-state without the flag | **404** `no route for GET /v1/notifications/unread` |

**`deployment-defaults.test.ts` is the first fence over `deploy/`**, and it exists because this
increment's own class is a default nothing notices the loss of: the compose file is not typechecked,
not linted and imported by nothing, so a deleted line there is invisible to all twelve workspace
rules and to every test — which is how `docker-compose.ai.yml` came to be ten flags behind the base
(ADR-0364's addendum). It reads the file as text, parses the `api` service's `command:` list, and
asserts the two defaults with the measurement that earned each, the absence of the third with its
reason, that no api-key and no unexpected `${…}` is on argv (ADR-0301, named rather than derived —
`--jwks-key` is a *public* key and belongs there), and the bootstrap's step ordering. Plus a text
fence over `node.ts` holding the drain gate's shape. Thirteen tests; all seven mutations caught
(removing each default, breaking the credential grant, changing the store, reintroducing
`channels.length`, dropping the `in_app` clause, removing either bootstrap curl), with both edited
files verified byte-identical by sha256 afterwards.

That fence hit this file's own hazard on its first run and the fix is worth knowing: the branch
comment in `node.ts` *explains* the old gate by quoting `channels.length`, so matching the raw text
failed on the prose recording why the gate is gone. The window strips comments — a text fence that
reads commentary as code either fires on correct code or, worse, gets "fixed" by deleting the
explanation.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A notifications page with a mark-read affordance, and then `--read-state-routes` on the same day. `markNoticeRead`/`markReadThrough` are written and callerless; the badge is the only consumer of the unread count. | platform | 2026-11-30 |
| Should the three self-scoped read-state routes drop their role check? `resolveViewer` takes the viewer from the credential and a body naming one is refused, so `allowedRoles` gates a principal's access to its own row; `backfillRoles` is the grant that gates something. An authorization-contract change, so argued rather than assumed. | platform | 2026-11-30 |
| How the four file-taking flags get their files: a `volumes:` mount for the three that are ordinary config, and an **environment** route for `--audit-chain-config`'s Ed25519 keypair (ADR-0301), plus a documented keygen step. It is the keystone — `--tenant-deletion-routes` is skipped without a chain producer — so the whole Article 17 story waits on it. | platform | 2026-12-31 |
| `--rate-limit-policy` is the one remaining flag that is purely a `command:` line, and declaring it also retires ADR-0337's six `rate_limit_decision_not_found` replay findings. Left out here only because its ceiling is a number nobody has measured for this deployment (`README.md` argues 10,000/60s would refuse traffic that works today). | platform | 2026-11-30 |
| `--workflow-workers` and `--schedule-ms` are blocked on P1.6 and not on a default: `JOB_HANDLER_PROVIDERS` ships empty, so all three workers refuse by name, and `--schedule-ms` alone accumulates pending rows for ever against `*/15` crons. | platform | _unscheduled_ |
| Nothing compares the two compose files, so the next flag added to the base and not to an overlay is found by a reader again. ADR-0364 removed the instance by deleting the overlay's `command:`; the class wants a rule over `deploy/`, which this test is the first piece of. | platform | 2026-12-31 |

## References

- `apps/operate-server/src/node.ts` — the drain gate, the `[notify]` and `[read-state]` boot lines
- `apps/operate-server/src/deployment-defaults.test.ts` — the fence
- `apps/operate-server/src/read-state-routes.ts` — `resolveViewer`, `bodyNamesAViewer`
- `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/README.md`, `deploy/ORACLE.md`
- ADR-0301, ADR-0334, ADR-0338, ADR-0357, ADR-0364, ADR-0365, ADR-0369
