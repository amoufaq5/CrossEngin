# ADR-0381: A revocation already read

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-20 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0358 (the login this is the missing half of), ADR-0369 (the roles a session carries), ADR-0341 (the attribute directory and its cache), ADR-0331 (a claim is not a gap), ADR-0334 (the tenant-status directory, this one's precedent), ADR-0361 (a check that cannot fire) |

## Context

Register item P0.1's residual, left open when ADR-0358 gave the console a login:

> **Revocation.** The role is read from the membership at mint time and frozen in the token, so
> revoking a membership or suspending a user bites at the next login within `--session-token-ttl` —
> which on the shipped compose is **one hour**, since that flag is not passed and
> `DEFAULT_SESSION_TOKEN_SECONDS` is 3600.

All of that is true. What the item does not say — and what makes this a small increment rather than a
subsystem — is that **the fact was already being read on every request, already correct, and thrown
away.**

`abacAttributeDirectoryFromStore` reads `PostgresUserStore.membershipFor` in the gateway's auth stage
and answers:

```ts
const membership = await store.membershipFor(tenantId, userId);
if (membership === null) return null;
if (membership.status !== ACTIVE_MEMBERSHIP_STATUS) return null;
return membership.abacAttributes;
```

So a revoked membership resolved `null` there, behind a TTL cache with its three figures already
argued (value, absence, max-stale). And the only consumer of that `null` was `dischargeAbac`, which
answers `undischargeable` for a grant **carrying an obligation** — of which the measured count across
the seven packs is **zero**. The revocation was detected in the auth stage and the detection reached
nothing.

This run's most-found shape, and the register's own framing pointed away from it: it named the
precedent as ADR-0334's tenant-status directory, which would have meant building a second directory
over a row this one already reads.

## Decision

**`withMembershipRevocationCheck(resolver, directory, onRefused?)` refuses a person-naming principal
whose membership does not resolve.** A sibling decoration beside `withAbacAttributes`, composed
outside it, over **one shared directory instance**.

Four decisions carry it.

**`null` is a sound refusal signal, and that rests on a measurement rather than on the type.**
`attributesFor` answers `null` in exactly two cases — no membership row, or a row whose status is not
`active` — and **never** for an active membership with no attributes, because
`MembershipRecord.abacAttributes` is `z.record(z.unknown())`, neither optional nor nullable, over a
column declared `NOT NULL DEFAULT '{}'::jsonb` (checked against the live catalog). Were it nullable
this gate would refuse active members whose attributes are empty, which is most of them. The property
is pinned by a test through the real `abacAttributeDirectoryFromStore`, because the whole decoration
rests on it. (An earlier draft of this increment assumed the opposite and had planned a three-valued
`MembershipStanding` refactor of the cache; the measurement retired it.)

**One directory instance, two readers.** `node.ts` builds `membershipDirectory` under **either**
`--abac-policy` or `--credential-login`, and the ABAC option takes that same object. Two directories
would be two caches with two TTLs that can disagree about whether one membership is active, which is
the divergence this repo refuses wherever it has found it. The second `attributesFor` the composition
makes is a cache hit by construction: the first call populated the entry and no TTL can lapse inside
one request.

**A sibling, not a flag on `withAbacAttributes`.** The two are gated by different declarations, so a
boolean switching whether a *refusal* happens would make one function mean two things — ADR-0364's
reason for refusing `buildSetHandler(ctx, onBehalf)`. And `sessionRevocation` is its own option field
rather than a member of `abac`, because a deployment with a login and no ABAC policy must still get
the check, and that is the shipped compose.

**Default-on under `--credential-login`, with no flag of its own.** ADR-0338's rule: nothing revoked a
live session correctly before, so refusing one breaks nothing that worked. And the *absent-row* case
cannot be the normal state there, because a session is minted only after the login read an **active**
membership — which is also why the gate is tied to the login rather than offered to a `--jwks-url`
deployment, where a subject with no `meta.users` row is ordinary. The two flags are **mutually
exclusive** (refused twice in `cli.ts`), so the gate never sees a foreign subject.

It is scoped to a principal that **names a person** (`PRINCIPAL_KIND_NAMES_A_PERSON`, ADR-0341) for
`withAbacAttributes`' reasons, which are stronger here: a bare api-key shares one
`DEFAULT_PRINCIPAL_ID` across the deployment (ADR-0331), so reading that id would refuse every
service credential the moment any one placeholder membership lapsed.

It returns `null` rather than throwing — the auth stage turns that into the same 401 a bad signature
gets, so a caller learns their session is no longer good and nothing about why — and a directory
failure **propagates**, because not knowing whether a membership is still active must not resolve to
"it is". The cache's `maxStaleMs` arm is what keeps a blip from becoming an outage.

**The window is named at boot, with its figure**, because the figure *is* the guarantee and is the one
an operator would otherwise get wrong: it is the directory's 30s value TTL, not the session TTL
printed on the line immediately above, and the two differ by two orders of magnitude.

## Alternatives considered

- **Option A: a denylist of revoked session ids.**
  - **Pros:** immediate rather than TTL-bounded; the standard answer.
  - **Why not:** it needs a new table, a writer on every revocation path (the membership transition
    handler, the user status handler, `set-credential`), a reaper, and a read per request — and the
    read it replaces is one this deployment already performs. It is the right answer for *immediate*
    revocation and is recorded as the follow-up; it is not the answer to "the fact is read and
    discarded".

- **Option B: a second directory in ADR-0334's `CachedTenantStatusDirectory` shape**, which is what
  the register's own text pointed at.
  - **Pros:** symmetric with the tenant-status gate; no coupling to the ABAC wiring.
  - **Why not:** two caches over one row, with two TTLs that can disagree about one membership. The
    tenant-status directory is the right precedent for its own question (there was no existing read
    of `meta.tenants` on the request path); here there is one.

- **Option C: a three-valued `MembershipStanding` so the directory separates *absent* from
  *not active*.**
  - **Pros:** the refusal could name which, which is what an operator wants in the log.
  - **Why not:** it requires retyping the cache and its test suite, and the measurement above shows
    `null` is already sound for the *decision*. The diagnosis split is a real but separate
    improvement, recorded as an open end rather than bundled.

- **Option D: shorten `--session-token-ttl` instead.**
  - **Pros:** no new code at all.
  - **Why not:** it trades the revocation window against the login rate for every user, and at a TTL
    short enough to matter (30s) the login becomes the request path. It also does nothing for a
    *suspended user* whose token is still inside its window.

- **Option E: make the gate a flag.**
  - **Pros:** an operator can decline the per-request read.
  - **Why not:** the read is cached at 30s and already happens under `--abac-policy`, and a flag that
    turns a security check off is one a deployment forgets to turn on. ADR-0334's gate is opt-in for
    a measured reason that does not apply here — that one 403s a credential whose tenant has no row,
    and this one cannot, because the login would not have minted the session.

## Consequences

- **Positive:** the revocation window goes from **one hour to 30 seconds** on the shipped compose, for
  a revoked membership *and* for a suspended or deleted user, with no new table, no new flag and no
  second read. An operator sees the window's real figure at boot.

- **Negative:** a per-request membership read (cached, in-flight-collapsed) on every deployment with a
  login, where previously only `--abac-policy` deployments paid it. And a directory outage now refuses
  requests after `maxStaleMs` that would previously have been served — which is the fail-closed
  direction and is what the stale window exists to bound.

- **Bounded, and stated:** 30 seconds is not immediate. A session remains valid for up to the value
  TTL after revocation, measured live.

## Verification

**Offline.** 8 new tests: the contract property the gate rests on (an active membership never
resolves `null`, asserted through the real directory), the refusal and its callback, the pass-through
being the *same object* rather than a copy, no read for the three non-person principal kinds, no read
with no tenant, the wrapped resolver's own refusal preserved, a directory failure propagating, and the
composition order.

**Live**, on a throwaway PG 16.13 through the documented bootstrap — provision a user with an active
membership, set a password over HTTP, log in, use the session:

| step | result |
|---|---|
| `GET /v1/vendors` with the session | **200** |
| membership `UPDATE … SET status='revoked'`, then immediately | **200** — the 30s cached value is still served |
| after 31s | **401** |
| the operator's log line | `[auth] session refused: 01a15b64-… holds no active membership in tenant 1111… (revoked, suspended, or the row is gone) — the session token is still signed and unexpired, and this check is why it no longer works` |

And the two controls, which a fence that refused everything would have passed:

| control | result |
|---|---|
| the api-key (names no person) | **200**, unaffected |
| membership restored, after 6s (absence TTL is 5s) | **200** — the same token works again |

Boot line: `[auth] session revocation: on — a session's membership is re-read every 30s, so revoking
one (or suspending the user) stops it within that, not at the next login 3600s away`.

**This increment's own class landed on its own fix.** The boot line was first written as a ternary
with an `OFF — needs a Postgres store` arm, and **that arm cannot fire**: `--credential-login` is
refused at parse under `--store memory` (*"the credential lives in `meta.users` and there is no such
table"*), so reaching the line implies a connection, which implies the directory, which implies the
gate. A check that cannot fire reads as coverage it does not provide — ADR-0361's reason for deleting
`validateReports`' unreachable duplicate — and it was caught by booting the arm it claimed to
describe, which is the only thing that would have.

## Open questions

1. **30 seconds is not immediate**, and closing that is Option A's denylist: a table, a writer on each
   of the three revocation paths, a reaper, and a read per request. Worth it only if a deployment needs
   sub-TTL revocation, and the figure is now on the boot line so the decision is informed.

2. **The refusal conflates two causes.** `null` means *no membership row* or *a row that is not
   active*, and the log line says so rather than choosing. Option C's three-valued standing separates
   them and would also let the gate treat them differently if that ever mattered — a deleted row is
   arguably a worse finding than a revoked status.

3. **The user's own `status` is not read.** `meta.users.status` going `suspended` or `deleted` is
   caught **only** where it is accompanied by a membership change, which `buildMembershipTransitionHandler`
   does not guarantee: the two statuses are independent columns on independent tables. A suspended user
   whose membership stays `active` keeps their session. `PostgresCredentialStore.findById` reads that
   column and `credential-routes.ts` already consults it (ADR-0364's addendum), so the read exists — it
   is a second table and a second cache key, and folding it in is the natural next step.

4. **Nothing cuts every session off at once** except rotating `OPERATE_TOKEN_SIGNING_KEY`, which is
   still the documented answer and still invalidates every session including the operator's own.

5. **The 30s figure is `DEFAULT_ABAC_TTL_MS` and is not configurable.** It was chosen for an attribute
   lookup and is now also a security window; those two want different knobs if either ever moves.

6. **A per-tenant gateway gets the gate** (both `buildOperateHttpServer` call sites pass it, ADR-0340's
   placement) and shares the deployment's directory, which is correct because a membership is keyed
   `(user_id, tenant_id)` and the tenant is in the key — but it means a tenant serving its own manifest
   cannot decline the check, which is the right default and worth knowing.
