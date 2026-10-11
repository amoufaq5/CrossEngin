# ADR-0358: A perimeter the deployment asserted and nothing enforced

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Authors** | Platform |
| **Reviewers** | Platform |

## Context

`operate-web` authenticated nobody. Its server-side proxy stamped one fixed
`OPERATE_API_KEY` as `x-api-key` on every request of all five verbs, defaulting to the
literal `"devkey"` when the variable was unset — so **every browser that could resolve the
domain was that principal**, which on the shipped compose is a `platform_admin` who can
provision and delete tenants. There was no `middleware.ts`, no cookie, no session and no
login surface anywhere in the app, and Caddy terminates TLS and forwards without checking a
credential.

ADR-0357 found this and documented it under *The UI has no login* in `deploy/README.md`.
Documenting it is not fixing it, and the register that increment wrote into `CLAUDE.md`
ranks it **P0 item 1** — ahead of everything else, on the test that no new capability is
needed to be harmed by it.

The class is the one ADR-0357 named: **a claim about the deployment that the deployment does
not make.** Here the claim is the perimeter itself. `deploy/README.md` told an operator to
put something authenticating in front of the `web` service, which is advice rather than a
mechanism, and the one place the product could have enforced it shipped a default credential.

## The measurement that scoped the increment

Taken before designing anything, because the alternative was guessing at how large this is.

A JWT minted **entirely in-repo** — a freshly generated Ed25519 key, `sub` = a real
`meta.users.id`, `tenant_id`, `scope` = a role, signed with `@crossengin/crypto`'s
`signEd25519` and verified against `--jwks-key <kid>:<derived pub>` — is accepted by the
existing gateway **with no change to the verifier**. Three tokens under one key, differing
only in the `scope` claim, against one `GET /v1/employees?limit=1`:

| token `scope` | `work_email` in the page |
|---|---|
| `erp_admin`  | `'ada-secret@example.test'` (11 fields) |
| `erp_viewer` | **absent** (10 fields) |
| `hr_manager` | `'ada-secret@example.test'` (11 fields) |

which is exactly `erp-core`'s declared read grant `[erp_admin, hr_manager]` on that `pii`
field. A token signed by a different key is a 401.

So a self-minted token already drives authentication, tenant scoping, principal identity and
per-field classification redaction. This is **not** a subsystem across six packages: the API
side works, and what is missing is a credential, a mint and a browser session. Everything
below is scoped by that measurement.

## Decision

### The credential is four columns on `meta.users`, and never in `USER_COLUMNS`

`credential_hash`, `credential_updated_at`, `credential_locked_until` (all nullable) and
`credential_failed_attempts INTEGER NOT NULL DEFAULT 0`.

**Nullable** for two reasons that agree. `provision` writes two complete literal `INSERT`
statements naming `(email, display_name, phone_e164, status)`, and
`pg-column-coverage`'s `missing_required_column` rule fails any `notNull`-with-no-default
column an existing `INSERT` omits — so a required hash would fail the workspace rule before
it failed a deployment. And it is semantically right: a provisioned user holds no credential
until one is set, and *no credential* must stay distinguishable from *a credential nobody has
matched* (ADR-0331). The counter is the one that may be `notNull`, **because** it has a
default: absent and zero are the same fact for an attempt count, which is not true of the
hash beside it.

**Not in `USER_COLUMNS`.** That one constant feeds seven statements and `rowToUser` parses
into a `.strict()` `UserRecordSchema`, so adding the hash there has exactly two outcomes and
both are wrong: without a schema change every registry read throws on the unknown key, and
with one the password hash appears in the 200 body of `platform.users.list`, `.get`,
`.provision`, `.suspend`, `.reactivate` and `.retire`. A hash is not a field of the user
record the registry serves, so the login lookup gets its own statement naming its own
columns.

A separate table was considered and buys **no confinement**: `meta.users` carries no
`tenant_id`, so by the catalog's own first invariant it gets no RLS — verified against a live
catalog, `relrowsecurity = false` with zero policies — and the serving role's table GRANT is
the only control either way. It would cost a catalog entry and two `meta-schema.test.ts`
edits for nothing.

A column, on the other hand, touches **no** assertion in that test file (the count and the
sorted-names list move only for a new table, and the per-table assertion is
`toContain("email")`). So the credential columns would have landed with no fence at all, and
two new assertions were added for exactly that reason — one pinning the nullability split,
one pinning that the hash's CHECK names the KDF.

### The hash is scrypt over a peppered password, async, with an explicit `maxmem`

`scrypt(hmacSha256(pepper, password), salt, 64, {N: 2^15, r: 8, p: 1, maxmem})`, stored as
`scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` under a **regex** CHECK.

**The pepper is a deployment secret and the reason is the RLS finding above.** The hashes are
readable by anything holding the serving role's grant, so a secret the database does not hold
is what makes reading the table insufficient. `parseCredentialPepper` is a **third** parser
beside `parseColumnEncryptionSecret` and `parseCursorEncryptionSecret`, over the same
`refuseWeakSecret` — which is that function's own stated intent, *"there is one floor, so a
secret good enough for a PHI column is good enough for a cursor and vice versa; `label`
changes only which variable the operator is told to fix."* The floor applies to the
**deployment's** secret and explicitly not to a user's password: 32 bytes with 16 distinct
values is a sane rule for a secret an operator generates and a hostile one for a person, and
`password.ts` imposes none.

**`maxmem` is mandatory and the documented formula is wrong for this purpose.** Node's
default ceiling is 32 MiB. The real requirement, found by bisection rather than from the
docs, is `128 · r · (N + p + 2)` — exactly 3,072 bytes *more* than the documented
`128 · N · r`. And `128 · N · r` at the default N=2^15, r=8 is **precisely 33,554,432**, i.e.
the ceiling itself. So the default parameters sit just above it and scrypt throws
`memory limit exceeded`; measured, N=2^14 succeeds with no `maxmem` and N=2^15 does not.
Omitting it is a silent ceiling at 2^14 nobody declared, and computing it from the documented
formula would still fail by 3 KiB.

**The async form is a correctness decision, not a style one.** Measured: eight concurrent
derivations at N=2^15 finish in 415 ms with a 10 ms timer still firing **39 times**, where
`scryptSync` blocks the loop flat (296 ms at N=2^16 with zero timer ticks). On a
single-process server the sync form stalls every concurrent request behind one login. The
libuv pool is 4 and shared with fs and dns, so login throughput is bounded around 30/s and a
flood starves file I/O — which is why the lockout below exists and the KDF cost is not
treated as the limiter.

Cost on the box this was measured on: 2^14 56–70 ms / 16 MiB, **2^15 114–144 ms / 32 MiB**,
2^16 218–475 ms / 64 MiB, 2^17 501–981 ms / 128 MiB. 2^15 is the default because the cost is
affordable interactively and the memory fits a small VM; OWASP's 2^17 floor is ~700 ms and
128 MiB per concurrent login here, which is a denial of service against a 4-thread pool.
Raising it is a one-line change *and nothing breaks*, because the parameters travel in the
string.

Not argon2id: zero runtime dependencies is the house rule and `node:crypto` has no argon2.
The stored string is deliberately **not** the house `<name>_sha256 CHAR(64)` + `^[0-9a-f]{64}$`
digest shape, because a password hash that does not record its parameters cannot be verified
once the defaults move — and a bare sha256 of a password is not a password hash at all. The
parameters live *in* the string rather than in sibling columns, so there is one spelling of
what produced this value instead of a column that can disagree with the bytes beside it;
that also removes the `pg-value-set-domains.ts` declaration an `algorithm` column would have
needed, since `check-admission.ts` classifies `~` as `pattern`.

### One environment variable, and the public half is derived

`OPERATE_TOKEN_SIGNING_KEY` holds a raw base64 Ed25519 **seed**.
`ed25519PublicKeyFromSeed` is added to `packages/crypto/src/signing.ts` — the module that
already owns Ed25519, as `key-derivation.ts` and `aead.ts` landed without touching the three
pins — and the server registers its own JWKS entry from it.

That closes a class by construction rather than by a check, and the measurement is sharper
than convenience. **`signEd25519(seedA, pubB, m)` does not throw: node builds the key from
`d` and silently discards an inconsistent `x`, so the signature verifies under A and not
under B.** A configured pair can therefore be stated inconsistently and nothing says so — the
failure surfaces as `invalid_signature` on every login, at the gateway rather than at the
mint. The primitive is left unchecked on a measurement (deriving the public half costs
0.099 ms against a 0.133 ms signature — a **75% overhead** on a function the forensic chain
calls for every audit append) and the hazard is unreachable here for the better reason: the
pair cannot be inconsistent in the first place. A test pins the silent-ignore so the next
reader knows.

`isEd25519PublicKeyBase64` had existed since `principals.ts` did with **zero callers**, while
`parseJwksKeySpec` checked only for a colon — so a typo'd or truncated `--jwks-key` booted
cleanly and turned every Bearer request into an `invalid_signature` 401 whose body says only
"jwt verification failed". Both ends are closed: the parser validates (a **usage** error with
the help text, exit 2) and `resolveJwtConfig` validates again for a programmatic
`ServeOptions`. Fixing it caught two in-repo fixtures using fake keys.

`--credential-login` is **mutually exclusive with `--jwks-url`**, refused at parse. `node.ts`
branches on the URL and *discards* the static key specs, so the derived key would never be
registered and every minted token would come back `invalid_signature`. Refused rather than
warned: there is no degraded behaviour to protect, and the failure lands at the gateway rather
than at the mint, so the mint looks fine in testing.

### The login names its tenant, and the token asserts it

`membershipFor(tenantId, userId)` requires a tenant, and `platform-users.ts` **deliberately
refuses** a by-user membership read on the stated grounds that *"that read has no scope to
name, so it would be owner-dependent by construction."* So login by email alone cannot
enumerate a user's tenants, and the honest answer respects that refusal rather than adding
the read it declined: the body is `{tenant, email, password}`, where `tenant` is a slug or an
id resolved through **one** statement so a slug that happens to look like a UUID cannot take
a different path than the one the operator meant.

Three claim decisions, each fencing something the verifier tolerates silently:

- **`sub` is the `meta.users.id` UUID.** `subjectToUuid` passes a UUID through and
  sha256-hashes anything else into a v5 shape that exists in no table, which would leave
  `principalId` pointing at nothing and break the ABAC attribute lookup,
  `meta.notification_read_states`' foreign key and every per-person surface.
- **`tenant_id` is always present.** A verified JWT without it is bound to the caller's
  `x-tenant-id` header instead, which is spoofable and needs no cooperation from the proxy —
  and every per-tenant control in the system reads that value. The proxy sends no such header
  and must not start: the cross-check is raw string equality with no case normalization, so a
  hex-case difference is a 401.
- **`exp`, `nbf` and `iat` are numbers.** Measured: a correctly-signed token with the payload
  `{}` verifies as `authenticated`, because every payload claim is checked only when present —
  and `exp` is honoured only when `typeof === "number"`, so a *stringified* one is ignored
  entirely and a token 10,000 s expired reads as authenticated. A JSON round-trip through a
  schema typing it as a string would do exactly that. Three tests fence these, because the
  safety of these tokens rests entirely on the minter.

`nbf` is backdated 60 s. `clockSkewSeconds` is fixed at 30 and `buildOperateGateway` does not
forward it, so no flag can move it, and a replica a few seconds ahead of the gateway would
answer `not_yet_valid_token` for a token it had just minted. 60 s is what the repository's own
JWT fixture already uses, and a token valid one minute early is not a weaker token where one
valid one minute late is an outage.

### One role per session, read from the membership at mint time

`principalRoles` reads `grantedScopes[0]` and `secondaryRoles` is populated by nothing
anywhere, so a session holds exactly one manifest role however many scopes travel in the
token. The mint reads `primary_role` from `meta.user_tenant_membership` through
`PostgresUserStore.membershipFor` — **not** a second statement, because that one already
carries the `withTenantContext` and the strict `scopeFilter` that table's single `ALL`-scope
policy requires, and a second spelling of a scoped read is how two of them drift.

`AuthTokenRequestSchema` is `.strict()`, so a body naming `role`, `scope`, `sub` or
`tenant_id` is **refused** rather than ignored. The gateway takes a session's role from the
token verbatim and consults no directory per request, so a route that let a caller influence
the role would hand them their own authorization, and a silently-ignored extra field is one
edit away from being honoured.

**The consequence is stated rather than hidden:** the role is frozen at mint time, so a
membership revoked or downgraded mid-session keeps its role until the token expires. That is
the tenant-status gate's TTL reasoning (ADR-0334) with the token lifetime as the window,
which is why `--session-token-ttl` exists and why rotating the signing key is documented as
the way to cut every session off at once.

### A lockout in SQL, with ADR-0332's refusal

The interceptor sits **in front of** the gateway, so it gets no rate limiting — and the KDF
cost is not an acceptable substitute, because it is self-DoS. So `credential_failed_attempts`
and `credential_locked_until` advance in **one** statement: read-modify-write loses its race
in the direction that *admits* an attempt, which is
`meta.notification_fax_observations`' exact reasoning about a counter whose whole job is to
stop something. The lock is set from `now()` rather than the process clock, so a drifted
worker cannot unlock early.

`REFUSAL_COUNTS_AGAINST_LOCKOUT` is a total map over the ten refusals and exactly one counts.
Two of the nine that do not are the two a condition would get wrong: `credential_unreadable`
must not count, or a corrupt row locks a user out of an account whose password they typed
**correctly**; and `account_locked` must not count, or hammering a locked account extends its
own lock indefinitely — a caller could keep an account locked forever without ever knowing a
password.

A threshold below the floor is **refused and never clamped**, which is ADR-0332's rule for
the same reason: a threshold of 1 locks a real user out on one typo, and silently raising it
would leave the deployment believing it configured something it had not.

### Every refusal is one status, one body and one cost

An unknown email, a user with no password, a wrong password, a suspended user, a tenant that
blocks reads and a user with no membership in the named tenant all answer `401` with one RFC
9457 body. Where a path would be *cheaper* than a real verification it spends a derivation
anyway (`spendPasswordWork`), because latency is as good an oracle as a message — the natural
shape is to return as soon as the lookup misses, which answers in under a millisecond against
~130 ms for a real account, and the precedent next door has exactly that shape
(`resolvePrincipalForCredential` returns `principal_not_found` immediately, correctly,
because it is behind a credential and this is not).

Two orderings are load-bearing. The password is verified **before** the membership is read,
or a caller holding no password could learn whether a user is a member of a named tenant — a
directory oracle on an unauthenticated route. And the **lock spends the work too**, which is
deliberate: short-circuiting would make a locked account answer in a millisecond where an
unknown email takes 130 ms, an oracle a caller can *create* on demand by hammering an address
until it either locks (it exists) or does not.

**`spendPasswordWork` derives under the parameters it is given, and that is what forced the
re-hash.** A fixed dummy cost would equalise today and diverge the moment the floor rose, so
a hash still stored under weaker parameters costs measurably less than an unknown email does —
re-opening the oracle, silently, in a deployment that had already tested this, and widening
with every account that has not logged in since. So a successful login whose stored hash is
below the current parameters is re-hashed, at the one moment the plaintext is in hand. It is
a correctness fix for the equaliser rather than an optimisation.

A thrown store error is a **503 and not a 401**: a store failure is not a statement about the
credential, and a 401 would send a correct password away for good where a 503 invites the
retry that will work. Nothing escapes, because the dispatch stage maps a thrown value to a 504
carrying up to 480 characters of the message — which on this route would hand an
unauthenticated caller the database error.

### The first password is a CLI subcommand

`operate-server set-credential --user <uuid> --confirm-user <uuid>`, with the password read
from `OPERATE_NEW_PASSWORD` in the **environment** (ADR-0301 — argv is readable by anyone who
can run `ps`), and `--password` refused *by name* so an operator is told why rather than left
thinking they mistyped it. The id is typed twice following `rekey`'s `--confirm-tenant`: this
overwrites a credential, so naming the wrong user both locks that person out and hands their
account to whoever typed the password. There is no `--yes`, because a flag meaning "I meant
it" can be pasted from a runbook without reading the id.

A `credential` arm on `POST /v1/platform/users` was the alternative and needs no new surface,
and it is refused for a specific reason: `platform-users.ts` copies
`email: normalizeEmail(user.email)` into its audit `detail`, so a plaintext password in that
request body would cross the audit path — and the three absolute log rules in this repo all
forbid a protected value in anything written down.

### The browser session is an httpOnly cookie

`/login`, a Next route handler that sets `HttpOnly; Secure; SameSite=strict; Path=/` with the
lifetime derived from the API's own `expiresAt`, a `middleware.ts` gate, and a proxy that
forwards the viewer's token. `SameSite=strict` because the app is same-origin end to end —
all 34 fetches are relative paths — so Strict costs nothing in-app.

The chrome needed moving: `app/layout.tsx` rendered `ShellBar`, `Sidebar` and
`SubscriptionBanner` unconditionally and each calls `useSchema()` independently, so a naive
`/login` would render authenticated chrome and fire authenticated requests from the login
screen. Extracted into one `AppChrome` client component keyed on `usePathname()`, rather than
moving 15 pages into a route group — which is a large diff and would not have helped, since a
route group does not escape the root layout. All 11 statically prerendered pages stayed
static.

`OPERATE_API_KEY` and its `?? "devkey"` default are **deleted**, not left unset: the default
meant removing the variable did not fail closed.

And `components/Sidebar.tsx` **failed open** — `viewerRoleList === undefined || …` with the
comment *"No viewer (dev) → show"*, where `undefined` is exactly the unauthenticated state, so
finance navigation was shown. Fixed.

## Alternatives considered

**A. Delegate identity to an external IdP (SAML/OIDC/SCIM).** `@crossengin/sso` is
contracts-only with zero importers, no `-runtime` or `-pg` sibling, five tables declared
`unbuilt_subsystem`, and the gateway's auth schemes include neither `saml` nor `oidc` — so
there is no pipeline position for one. It is also the wrong shape for the problem: a
single-VM compose stack has no IdP, and the register ranks SSO as a procurement gate rather
than a P0. Rejected, and it remains the right answer for an enterprise deployment later; the
JWKS path this uses is the same one an IdP would.

**B. Put an authenticating proxy in front of `web`.** What `deploy/README.md` advised. It
protects the perimeter and leaves the product with no notion of *who* — the API would still
see one principal, so per-user read state, notification preferences, ABAC attributes and the
audit trail's actor would all still be one shared identity. Rejected because it closes the
disclosure and none of the consequences.

**C. A session table rather than a self-contained token.** A row per session makes revocation
immediate, which is the one thing frozen claims cost. Rejected for this increment on the
measurement at the top: a JWT needs **no gateway change at all**, where a session store needs
a per-request lookup the pipeline has no stage for, plus a table, plus a reaper. Noted as the
follow-up for revocation, and the honest intermediate is a shorter `--session-token-ttl`.

**D. Configure the signing key and the public key separately.** The obvious shape, and
refused on the measurement that `signEd25519` silently ignores a mismatched public key — so
the pair can be stated inconsistently and the only symptom is every login failing at the
gateway. Deriving makes it impossible.

**E. Validate the pair inside `signEd25519`.** Measured at a 75% overhead on a primitive the
forensic chain calls for every audit append, for a case derivation makes unreachable.
Rejected, with the behaviour pinned by a test instead.

**F. argon2id.** Stronger against GPU attack and the modern default. Rejected: zero runtime
dependencies is the house rule, `node:crypto` has no argon2, and adding one native dependency
for this would be the largest change in the increment. scrypt is memory-hard and its
parameters are stored per hash, so raising the cost is free.

**G. A `credential` arm on the platform-user route instead of a CLI subcommand.** Cheaper and
already documented as the first-user flow. Rejected because that handler's audit record
already copies the request body's email into `detail`, so a password there crosses the audit
path.

**H. Count `unreadable_hash` and `account_locked` against the lockout.** The simpler
condition (`!admitted` → count). Rejected: the first locks a user out of an account whose
password is correct, and the second lets anyone hold an account locked forever.

**I. Short-circuit a locked account without spending the KDF.** Saves exactly the work the
lock exists to save. Rejected because it is an enumeration oracle a caller can create on
demand, and the DoS it would prevent is unchanged either way — requests queue on a 4-thread
pool rather than multiplying.

**J. A per-IP rate limit on the login.** The real answer to credential stuffing. Unavailable:
behind Caddy `clientIp` is the container's address for every request and `forwardedFor` is
never populated, so an IP-keyed limit would lock out the whole deployment at once. Stated as
a limitation rather than approximated — the per-account lockout addresses spraying against one
account and explicitly not stuffing across many.

**K. Refuse a login that cannot be audited.** `platform-users.ts` refuses a privileged write
with 503 *"a registry change cannot be made while it cannot be recorded"*. Rejected here: a
database blip or a missing `app.platform_audit_write` grant would lock every user out of the
product. The opposite precedent is `appendPagedNote`, which never throws because the thing it
records has already happened.

**L. Write a login attempt to `meta.sso_logins`.** Its `outcome` CHECK already names
`account_locked` and `password_expired`. Structurally unusable: `provider_id` is
`NOT NULL REFERENCES meta.sso_providers RESTRICT` and there are no providers. A new outcome on
`meta.audit_log` would widen a CHECK and become standing manual SQL (ADR-0352). So a login
attempt is a log line, and the counter on the row is the durable record.

## Consequences

**The product authenticates people.** Verified live, end to end, against a throwaway PG 16.13
cluster as `app_user` (`rolsuper = f`, `rolbypassrls = f`, owning nothing), with the real
Next app proxying to the real API: two different people log in through the same browser flow
and get **different authorization** — the admin lists employees with `work_email`, the clerk
gets a 403 on employees and a 200 on vendors.

**`last_login_at` has a writer for the first time.** Declared in Phase 1, read by
`access-reviews`' dormancy predicate, written by nothing — so every principal read as
*dormant* and nobody noticed. A deployment that runs an access-review campaign will see its
item generation change. That is the predicate becoming real rather than a regression.

**An upgraded deployment owes nothing manual**, measured rather than reasoned: the four columns
were dropped from a **populated** `meta.users` (2 rows) to reproduce an un-upgraded deployment,
and `apply` planned **4 statements with 0 unreconciled**, executed 4 with 0 failures, and
re-planned clean. A nullable column and a `NOT NULL` column *with* a default are both plannable,
and — the part worth stating — **both CHECKs ride along on their `ADD COLUMN`** rather than
needing a separate `ALTER`, so ADR-0330's widening-versus-narrowing problem cannot bite here:
a CHECK on a column the plan is adding has no existing rows to validate against. That is the
opposite of ADR-0351's `proof_version`, whose widened CHECK on an existing column is exactly
the standing manual SQL this avoids.

**Two new required secrets.** `CREDENTIAL_PEPPER` and `OPERATE_TOKEN_SIGNING_KEY`. Losing the
pepper makes every password unverifiable; losing the signing key invalidates every session in
flight. Both are in the compose `environment:` block and `.env.example`, neither in
`command:`.

**A session's role is stale for up to its lifetime**, and suspending a user does not cut off
an existing session. Documented in `deploy/README.md` with the two remedies (lower the TTL,
or rotate the signing key).

**Anyone who knows an email address can lock that user out for the window.** Irreducible for
a per-account lockout keyed on a caller-supplied address, which is why the window lapses
rather than being permanent and why `set-credential` clears a lock. There is no self-service
unlock and no notification, because there is no mail channel.

**CSRF is created by this increment, not mitigated by it.** Before it there was no ambient
browser credential, so CSRF was unreachable — the posture was worse than CSRF, since no victim
was needed. `SameSite=strict` is the mitigation and the JSON content-type requirement is a
partial bound (a cross-site form cannot set `application/json`, which the body parser
requires).

**The login route is outside the gateway and so outside four of its stages** — rate limiting,
security headers, `emit_audit` and the pipeline record. The lockout covers the first; the
other three are stated rather than approximated.

### Verified live

On PG 16.13 as `app_user`, against the real server and the real Next app:

- **964/964** catalog statements applied on a fresh cluster with 0 failures and `0 unreconciled`;
  the four credential columns and both CHECKs present. Then, with the columns dropped from a
  populated table to reproduce an upgrade: **4 planned, 0 unreconciled, 4 executed, 0 failed**,
  re-plan clean, both CHECKs back.
- `set-credential` as a non-owner: both users set at `scrypt$32768$8$1$…`, `last_login_at`
  still NULL. Its three refusals fire — no password in the environment, `--password` on argv
  refused by name, mismatched `--confirm-user`.
- The boot line prints the **derived** public key, matching the value computed independently
  from the seed.
- Login → `200 {token, expiresAt, tenantId, role: "erp_admin"}`, and that token gets a 200
  from `GET /v1/employees` with `work_email` present. The clerk's token carries `ap_clerk`
  and gets **403** on employees, **200** on vendors.
- Timing equalised: wrong password 167 ms, unknown email 148 ms, unknown tenant 142 ms — all
  paying the KDF — against 15–19 ms for a malformed body, which discloses nothing because
  there is no email in it to probe.
- A body carrying `"role":"platform_admin"` is a **400**.
- Lockout at 3: attempts 1, 2, then locked. A **correct** password while locked is a 401, and
  the locked attempt did **not** extend the lock (attempts stayed 3, `locked_until`
  unchanged). A lapsed lock admits, resets the counter to 0, clears the lock and stamps
  `last_login_at`.
- Re-hash: a hash at `n=1024` was upgraded to `n=32768` on a successful login, with the log
  line.
- All seven refusals print with their reasons — four boot (`pepper_absent`, `pepper_refused`,
  `signing_key_absent`, `signing_key_malformed`) and three argv (missing issuer/audience,
  `--store memory`, `--jwks-url`).
- Through the browser stack: unauthenticated `/`, `/inbox`, `/e/employees` → `307
  /login?next=…`; `/login` → 200; the proxy with no cookie → **JSON 401** without calling
  upstream; login through the Next handler against the real API → 200 and a cookie holding the
  real JWT; with the cookie, pages 200 and `/login` → `307 /`; logout → 200 and the next page
  redirects; a forged cookie → 401 **from the API**, so the cookie is a hint and the API's
  verdict is the authorization. `OPERATE_API_KEY`, `devkey` and `x-api-key` have zero
  occurrences left in the web source.

Full workspace sweep green: build, typecheck and **18,603 tests across 749 files**, zero
failures. `apps/operate-web` separately at `tsc --noEmit` exit 0 and `next build` exit 0, with
`/login` prerendered static, the two auth handlers dynamic and **no existing page changing**
**classification**.

## Implementation notes

`parseJwksKeySpec` validating caught two in-repo fixtures using fake keys (`key-1:AAAxyz==`,
`key-1:AAAbase64`) and one test whose cross-flag assertion only passed because the key was
refused first. All three were fixtures asserting the wrong thing, not regressions.

**A store can opt itself out of all nine strategy rules by how it names its table, and the only
symptom is a declared scan gap.** `PostgresCredentialStore` was first written
`constructor(conn, schema = "meta")`, assigning the table name from that parameter, which is the
obvious shape and perfectly clear to a reader — and `pg-column-coverage` reported every statement
in the file as `unresolved_target`, because its resolver chases `ident` back to a literal and reads
`options.schema ?? "meta"` and a `const` but **not a parameter default**. So none of this store's
SQL was being compared against the catalog. Declaring the gap would have been the wrong move: that
list is for genuinely unparseable SQL, not for a resolvable name a construction choice made opaque.
The fix is the options object `PostgresUserStore` already uses, and the lesson is that the failure
presents as an admission rather than as a loss of coverage.

And making it resolvable immediately bought a second finding, which is the point: with the
target readable, `pg-binding-names.ts` reported `setCredential`'s parameter as an
`undeclared_divergence` — `encodedHash` bound into `credential_hash`, whose name reads
`credentialHash`. Renamed to agree rather than declared, because agreement is this repo's norm
(682 of 764 bindings) and a declaration is a judgement the next reader has to re-verify; the fact
that the value is already encoded is stated in the doc comment, where it belongs. Neither finding
would have existed had the file kept opting itself out.

An intermediate attempt — keeping the parameter but validating through
`const s = requireSchema(schema)` — was *also* unresolved, because the resolver chases an alias to
a parameter it does not bind. The validation has to be inline **and** the name has to come from the
options object.

The stale figure **50** for `NOT NULL` foreign keys into `meta.users` was repeated in six
places across four files. Re-measured from the built catalog: **97** total references, **42**
`NOT NULL`, over 39 distinct tables. Corrected, since this increment is in those files.

## Open questions

1. **Revocation is the one thing frozen claims cost.** Suspending a user or revoking a
   membership takes effect at the next login. The precedent for closing it is the tenant-status
   directory (ADR-0334): a cached per-request lookup with a short TTL, a shorter absence TTL,
   and a first-lookup failure that propagates. That is a real increment and the right one if
   anybody needs a session cut off sooner than the TTL.
2. **`canAccess` in `lib/schema.ts:250` returns `true` when `roles.length === 0`**, and
   `viewerRoles()` answers `[]` with no viewer — so `accessibleEntities` still shows every
   entity in the nav to a browser whose schema fetch has not yet 401'd. The middleware demotes
   it from a disclosure to a flash, but it is `Sidebar.tsx:32`'s shape one file over and the
   same `undefined`/empty conflation.
3. **`principalKind` is hardcoded `"user"` for every verified JWT** with no check that the
   subject has a `meta.users` row — the exact defect ADR-0331 fixed on the api-key path and left
   standing here. True for tokens this route mints, because the row was looked up; untrue for
   any third-party JWT a deployment configures through `--jwks-key`.
4. **The verifier accepts a correctly-signed token with the payload `{}`.** Every payload claim
   is checked only when present, so a signing-key compromise is bounded by neither audience nor
   expiry, and `exp` as a *string* is ignored entirely. Three minter-side tests fence our own
   tokens; tightening the verifier is a change in a contracts-adjacent package with
   cross-package consumers and would want its own increment.
5. **`schemeRequiresHttps` has zero callers**, so `bearer_jwt` is in `SCHEMES_REQUIRING_HTTPS`
   and nothing enforces it — a session token travels over plain HTTP wherever the deployment
   allows. The cookie's `Secure` attribute is the only guard and it lives in `operate-web`.
6. **No self-service password change, and no password policy.** A user cannot rotate their own
   password; an operator runs `set-credential`. And `password.ts` imposes no floor on a
   password deliberately, so "at least N characters" is a product decision nobody has taken —
   the place for it is the request schema, not the KDF.
7. **`apps/operate-web` still has zero tests** and is outside the workspace sweep and all nine
   strategy rules, so the login flow is verified by `tsc`, `next build` and the live run above.
   Adding the first test file there also removes the app from ADR-0307's exemption, which is why
   it was not done here.
8. **The four stages the interceptor sits outside** — rate limiting, security headers,
   `emit_audit`, the pipeline record. A login attempt is a log line and a counter today. The
   general question is whether the gateway should grow a position for an unauthenticated route,
   which the bounce webhook and the health probes both also want.
