# ADR-0357: A claim the deployment does not make

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0301, ADR-0312, ADR-0322, ADR-0334, ADR-0338, ADR-0340, ADR-0345, ADR-0346, ADR-0349, ADR-0351 |

## Context

The nine rules in `packages/testing/src/strategy/` all ask a question about the *artifact* —
does this store write the columns it names, does this CHECK admit what the contract emits,
does this property name the column it is read from — and the run that built them (ADR-0333
through ADR-0337, then ADR-0352 through ADR-0356) left the artifact in good shape. The
increments between those two stretches asked about *behaviour* the artifact serves: at-rest
PHI, field authorization, ABAC obligations, the Article 17 erasure and its proof.

This increment asks the question about the **deployment**, and the class is **a claim about
the deployment that the deployment does not make**. Four members, each one a protection
stated in one place and absent from the place that would enforce it, and each found by
reading `deploy/` against the code rather than by reading the code against itself.

### The one that is a disclosure, not a gap

ADR-0346 sealed the entity-list keyset cursor and put a boot refusal behind it,
`cursor_discloses_withheld_rows`, which fires when a record-bearing ABAC obligation sits on
an entity's `list` grant and the sealer is `absent`. That refusal is correct and it is
**vacuously silent on every deployment there is**: the measured count of row-filtering grants
across the seven packs is zero (ADR-0340 established it, ADR-0345 relied on it), so nothing
has ever met it.

The disclosure that is not vacuous is one layer in. `keysetOf` maps over the **whole declared
sort** and renders `String(row[s.field])` from the record:

```ts
export function keysetOf(row: EntityRecord, sort: readonly ListSort[]): KeysetCursor {
  return {
    k: sort.map((s) => {
      const value = row[s.field];
      return isMissing(value) ? null : String(value);
    }),
    id: String(row["id"] ?? ""),
  };
}
```

`parseListQuery` honours `?sort=<field>` for any member of `listConfigForEntity(...)
.sortableFields`. So a caller who names a **classified** field in `?sort` is handed that
field's plaintext in `nextCursor`, inside a response whose body the gateway redacted on their
own grants. The redaction stage and the cursor are two code paths and only the first consults
a grant.

Measured against the real resolved packs — not fixtures — this is **14 (entity, sortable
classified field) pairs across the seven packs, 8 distinct, and at least one in every pack**:

| pack | members |
|---|---|
| `erp-core` | `Employee.work_email` (pii) |
| `erp-retail` | `Employee.work_email` |
| `erp-healthcare` | `Employee.work_email`, `Patient.mrn` (**phi**), `Patient.given_name`, `Patient.family_name`, `Patient.date_of_birth` |
| `erp-grocery` | `Employee.work_email` |
| `erp-government` | `Employee.work_email`, `Citizen.contact_email`, `Citizen.contact_phone` |
| `erp-education` | `Employee.work_email`, `Student.student_email` |
| `erp-construction` | `Employee.work_email` |

**This is a different disclosure from the one ADR-0345 and ADR-0346 reasoned about**, and the
difference is what makes it live. Both of those argue about a **withheld row's** value —
`withheldAddressing`'s own doc says *"ordering by a classified field puts that field's value,
for a withheld row, into a string handed straight back"* — which is true and is gated on a
record policy that no pack declares. Here the row is one the caller **is** shown and the
*value* is one they are not: the list grant admits them, the response body redacts the field
on their per-field grant, and the cursor hands it back. No record policy is involved, so
nothing gates it.

`erp-core` is `OPERATE_PACK`'s default in the shipped compose file, so this is live on the
deployment the repo tells people to run. `Patient.mrn` is the `phi` field ADR-0338 made
`bytea` ciphertext at rest and ADR-0339 found `front_desk` blind-overwriting — and it is
reachable here only as a *caller-chosen* `?sort`, because healthcare's `Patient` list sorts by
`family_name` by default. ADR-0345's `withheldAddressing` guard would have refused it, and
does not run: it is gated on `obligationOutstanding`, the same zero-member predicate.

And the column store is **worse than the document store**, which is the opposite of how one
line reads. `ColumnMappedEntityStore`'s adapter answers `columnExpr → null` for an
`encryptAtRest` column — *"an unknown or encrypted column is dropped from filter/sort (can't
order ciphertext)"* — so `?sort=mrn` is silently dropped from `ORDER BY`. But the value is in
the record either way: `selectList` emits `pgp_sym_decrypt(…) AS mrn`, and it is selected with
no `?fields` at all, while *with* one `projectionColumns` adds every `query.sort` field's
column back unconditionally — it has no `encryptAtRest` filter, because the cursor needs the
value. `keysetOf` then reads the **record**. So the cursor carries the decrypted plaintext of
an ordering that was never applied, which is a soundness bug in the keyset sitting beside the
disclosure. A store-narrowed survey would have dropped the one `phi` member, from a plausible
reading of that one comment.

### The one the compose file contradicted in its own comments

`deploy/docker-compose.yml` carries this, in the `api` service's `environment:` block:

> Credentials reach the API through the environment, not through `command`, because argv is
> readable by anyone who can run `ps` (ADR-0301).

and then, nine lines down in `command:`:

```yaml
- --api-key
- ${OPERATE_ADMIN_API_KEY}
```

An api-key spec is `token:role:tenant[:principal]` and the **token is the credential** — it is
what a client sends as `x-api-key`. The one in the shipped compose file is the
`platform_admin` key, which is the single credential on the stack that can provision and
delete tenants. It was on the command line because `--api-key` was the **only** route:
`cli.ts` reads `process.env` nowhere by design, and no module owned a variable for it. So the
comment was not wrong about the rule, it was describing a route that did not exist.

### The one where the mode names a guarantee it does not give

`PgConfig.ssl` accepts all six libpq mode names and `createNodePgConnection` maps them:

```ts
: config.ssl === "require" || config.ssl === "verify-ca" || config.ssl === "verify-full"
  ? { rejectUnauthorized: config.ssl === "verify-full" }
```

So `verify-ca` — the mode whose entire purpose is to validate the server's certificate
against a CA — accepts any certificate the server offers. Nothing anywhere in the binding
reads `PGSSLROOTCERT` and `PgConfig` carries no `ca` field, so there is no configuration that
repairs it. Meanwhile `PGSSLMODE` defaults to `prefer`, which lets the *server* decide whether
there is any TLS at all, and `deploy/VERCEL-SUPABASE.md` prescribed `require` with the comment
*"Supabase requires TLS"* for a connection that crosses the public internet.

What crosses that wire is not incidental: `app.current_tenant_id` is set on it for every
query, and it **is** the tenant-isolation boundary; on `--store pg-columns`,
`app.column_encryption_key` crosses it as a bound parameter on every PHI write (ADR-0338).

### The one where a considered refusal reached nobody

There was no `/health` and no `/readyz` anywhere in the workspace, and no `healthcheck:` on
any service in the compose file. This binary's boot is full of deliberate refusals — ADR-0338's
classified pack with no secret, ADR-0340's undischargeable obligation, ADR-0345's classified
default sort, ADR-0349's `envelope` on a deployment that encrypts nothing — and every one of
them exits the process. With no probe declared, Docker reports the container `started` the
moment it is spawned, `web` was declared `depends_on: {api: {condition: service_started}}`,
Caddy is pointed at it regardless, and the public domain serves 502 while nothing in the stack
holds the opinion that anything is wrong. The refusals were made loud in the log and invisible
to the thing that decides whether to route traffic.

## Decision

Four changes, one per member, plus one convergence each where the fix exposed a second
spelling of its own judgement.

**1. `OPERATE_API_KEY_SPECS` is the environment route `--api-key` never had.**
`apps/operate-server/src/api-key-source.ts` owns the variable name and the merge, beside its
own decision, the way `column-encryption.ts` owns `COLUMN_ENCRYPTION_SECRET_VAR`; `cli.ts`
stays a pure argv parser. `resolveApiKeySpecs` is called **once** in `serve()`, before
anything reads the specs, and both readers (`surveyEnvelopeTenantReadiness` and the principal
wiring) take that one answer. The shipped compose passes
`OPERATE_API_KEY_SPECS: ${OPERATE_ADMIN_API_KEY}` and `--api-key` is gone from its `command:`.

**2. `PGSSLMODE=verify-ca` is refused, and the channel is reported on every boot.**
`PG_CHANNEL_ASSURANCES` is three facts — `plaintext_possible` /
`encrypted_unauthenticated` / `authenticated` — over the six modes, with
`sslModeValidatesCertificate` **composed from two total maps** rather than written as a second
per-mode one. `deploy/VERCEL-SUPABASE.md` prescribes `verify-full`.

**3. A classified field's value in a cursor is surveyed and reported.**
`surveySortableClassifiedFields` + `decideCursorDisclosure` answer the second cursor question
at boot, in four verdicts, and **report rather than refuse**. `CURSOR_DISCLOSURE_MAY_SERVE` is
the total map that records that, every member `true`.

**4. `/health` and `/readyz` exist, and the compose stack waits on the second.**
Liveness touches nothing and readiness checks Postgres, with the split made explicit because
getting it the wrong way round is invisible until the first outage. `web` now
`depends_on: {api: {condition: service_healthy}}`.

## Alternatives considered

- **Option A (cursor): refuse the boot when a classified field is sortable and the sealer is absent.**
  - **Pros:** closes the disclosure rather than describing it; matches ADR-0338's shape for PHI.
  - **Cons:** refuses every deployment there is.
  - **Why not:** measured. ADR-0338's refusal rests on *"nothing served PHI correctly today, so
    the refusal breaks nothing that worked"* — false here, since all seven packs have a member
    and `erp-core` is the compose default. ADR-0334 left `--tenant-status-gate` opt-in for
    exactly this reason. And a refusal would be *actively worse* than a report, not merely
    stricter: the hatch an operator would reach for is `--allow-cursor-disclosure`, which also
    accepts `cursor_discloses_withheld_rows` — the refusal about rows the caller was never
    shown. So every deployment would arrive pre-disarmed for the day a grant starts filtering
    rows. "A remedy that cannot work is worse than none" (ADR-0334), one notch out.

- **Option B (cursor): drop a classified field from the cursor's keyset instead of sealing it.**
  - **Pros:** no secret to configure; the disclosure is structurally impossible.
  - **Cons:** a keyset component is what makes the seek work. Dropping one makes `isAfter`
    compare a position that does not describe the ordering, so the walk re-admits or skips rows
    — ADR-0333's non-terminating `limit 1` walk, deliberately reintroduced.
  - **Why not:** a wrong answer ranks below a refusal and below a reported disclosure. ADR-0346
    already chose sealing over narrowing for the row case and the argument is unchanged.

- **Option C (cursor): narrow the survey to the stores that can really disclose.**
  - **Pros:** fewer findings; `--store pg-columns` drops an encrypted column from `ORDER BY`,
    so it reads like an exemption.
  - **Cons:** it is the opposite of an exemption — see Context. The cursor carries the
    decrypted plaintext of an ordering that was never applied.
  - **Why not:** it would have dropped `Patient.mrn`, the one `phi` member, which is the unsafe
    direction from a plausible reading of one line.

- **Option D (ssl): warn on `verify-ca` instead of refusing.**
  - **Pros:** no deployment stops booting; follows this increment's own api-key choice.
  - **Cons:** an operator who set `verify-ca` has *made* the trust decision and believes it took
    effect. A warning they scroll past leaves them with `require`'s guarantees under
    `verify-full`'s name, and nothing can repair it by configuration.
  - **Why not:** this is ADR-0340's shape, not ADR-0338's — serving a mode with its guarantee
    removed is the opposite of what the configuration declares, where plaintext PHI is
    degraded-but-coherent. And the count settles it the same way ADR-0340's did: **zero**
    occurrences of `verify-ca` anywhere in the repo's configuration, docs or deployment
    guides, so refusing breaks nothing that worked.

- **Option E (ssl): accept CA material, so `verify-ca` and a private-CA `verify-full` both work.**
  - **Pros:** honours `verify-ca` rather than declining it, and — measured after the decision —
    is what makes `verify-full` **reachable at all** on the managed-cloud path this repo
    documents. Supabase's own guidance for `verify-full` is to download the project's server
    root certificate and pass it as `sslrootcert`, which this binding cannot accept, so
    `verify-full` here validates against Node's trust store and nothing else.
  - **Cons:** `PgConfig` gains a `ca` field, every construction site gains a decision, and the
    resulting trust store is a second one beside Node's — which is the configuration most
    deployments get wrong in the direction of trusting more.
  - **Why not:** out of scope for an increment whose other three members are a variable, a
    survey and a probe — but the measurement above moves this from "nice to have" to the
    **top** open end for this member, and it is why `deploy/VERCEL-SUPABASE.md` now says to
    *try* `verify-full` and names `require` with its cost rather than prescribing a mode that
    may be unreachable. The refusal of `verify-ca` stands either way: it is about this binding
    validating nothing, which CA support is precisely what would change.

- **Option F (api-key): make `OPERATE_API_KEY_SPECS` take precedence over `--api-key`.**
  - **Pros:** one source of truth per deployment.
  - **Cons:** a deployment that sets the variable and forgets to remove the flag silently serves
    one set of credentials, and which set depends on a rule nobody reads.
  - **Why not:** concatenating makes the configuration the union of what was asked for, and the
    `both` verdict is what says so out loud. Nothing is lost to a precedence rule.

- **Option G (api-key): refuse `--api-key` outright.**
  - **Pros:** closes the argv exposure completely.
  - **Cons:** every deployment today passes it and works.
  - **Why not:** ADR-0338's rule read in the other direction, which is the same reasoning that
    made the ssl choice a refusal: refuse where nothing worked before, warn where it did. The
    exposure is also local to the host, where an unevaluated obligation is not.

- **Option H (health): one `/health` path answering both questions.**
  - **Pros:** one surface, one wiring.
  - **Cons:** liveness failure gets the container **killed**; readiness failure takes it **out of
    rotation** and leaves it running. A liveness probe that checked Postgres would, during a
    database outage, fail on every replica at once and the orchestrator would restart all of
    them repeatedly — turning a recoverable dependency outage into a total one with a thundering
    herd on top. A process whose database is down is not a process that needs restarting.
  - **Why not:** the two consequences are opposite, so one path would have to pick one. A path
    whose meaning depends on a query parameter somebody remembers to add would answer *liveness*
    when they forgot it, which is the permissive direction.

- **Option I (health): register the probes as gateway routes.**
  - **Pros:** no wrapper; the routes get the gateway's pipeline.
  - **Cons:** the gateway's auth stage 401s a credential-less request, and a probe carries no
    credential by construction.
  - **Why not:** it is the bounce webhook's argument read the other way round — that route
    cannot be a gateway `Handler` because the gateway never sees the raw body, and this one
    cannot be a gateway route because every gateway route authenticates.

## Consequences

- **Positive.** The shipped compose file no longer publishes its platform-admin credential on
  the host's process list. A classified field's value reaching a caller through a cursor is now
  a line in the boot log naming the entity, the field and its classification, on a deployment
  where it was previously invisible in both directions. A `PGSSLMODE` that names certificate
  validation and performs none is refused instead of served, and every boot says what the
  database channel actually promises. A refused boot is now a failed healthcheck, so `web` does
  not start against an API that refused to, and an orchestrator can tell a running process from
  a serving one.

- **Negative.** `PGSSLMODE=verify-ca` stops a boot that previously started, which is a
  behaviour change with a measured count of zero in this repo and no count at all outside it.
  `/readyz` is an unauthenticated endpoint that issues a database query; its cost is bounded by
  in-flight collapse (at most one `SELECT 1` per check at any instant) and deliberately not by
  a success cache, because a cached 200 asserts reachability on the evidence of a round trip
  that has already finished. The `[cursor] cursor disclosure: plaintext_disclosing` line is a
  warning every shipped deployment now sees on every boot until it sets the secret, which is
  the point and is also noise for a deployment that has weighed it — `--allow-cursor-disclosure`
  moves it to `plaintext_accepted` and keeps saying it.

- **Neutral.** `PgConfig.ssl`'s inline six-member union became the named `PgSslMode`, same
  members. `--api-key` keeps working, unchanged, and its help text now names the variable.

- **Reversibility.** All four are additive but for the `verify-ca` refusal, which is three
  lines and a message. The cursor survey is a report, so removing it removes a log line and no
  behaviour. The probes are an interceptor in front of the dispatch target, like the bounce
  webhook, and removing the wrap removes the paths. The compose `healthcheck:` and the
  `service_healthy` condition are the only changes with an operational edge: a deployment whose
  API genuinely cannot reach its database will now hold `web` down rather than starting it to
  serve 502s, which is the intended behaviour and is a change an operator will notice.

## Implementation notes

**The api-key merge is one call, early.** `serve()` had exactly two readers of
`options.apiKeys` — the envelope tenant-readiness survey and `const apiKeys =
options.apiKeys.map(parseApiKeySpec)` — and everything downstream uses the parsed local. The
resolution is placed before both. Splitting on newline **and** comma covers the two deployment
shapes (a compose `environment:` block takes a multi-line value cleanly, a `.env` file does
not) and neither character can occur inside a spec, so no value is made ambiguous. The boot
line names both counts and **never a spec**.

**The ssl judgements are composed, not duplicated — and there were two of them, not one.**
`sslModeValidatesCertificate(mode)` is
`ASSURANCE_VALIDATES_CERTIFICATE[SSL_MODE_CHANNEL_ASSURANCE[mode]]`, and
`createNodePgConnection` calls it instead of comparing `config.ssl === "verify-full"` inline.
That inline comparison *was* a second spelling: the predicate gates a refusal while the
assurance gates what an operator is told, so a mode reported `authenticated` while the
predicate answered `false` would refuse a working deployment with a message contradicting its
own boot line.

The **test written to fence that found a third judgement in the same ternary**, which is worth
recording because it is the increment's own class landing on its own fix. The test asserts both
the call and the *absence* of the literal, and it failed — because the ternary's outer arm still
listed `config.ssl === "require" || config.ssl === "verify-ca" || config.ssl === "verify-full"`
to decide *which modes get a TLS object at all*. That is a different question (**must there be
TLS** versus **is the peer checked**; `require` answers yes and no) and it is equally derivable:
that set is exactly the complement of `plaintext_possible`. So `sslModeRequiresTls` is the
second predicate, the ternary names no mode but one, and the test checks all three literals are
gone. Had the test only pinned the call, the three-name list would have stayed — a second
spelling found by writing the fence rather than by reading the code.

The one remaining mode comparison is `disable`, and it has to stay: `disable`, `allow` and
`prefer` share one assurance (the channel may be plaintext) and differ only in *who declines*,
so `disable` passes `ssl: false` where the other two pass nothing and let the server decide —
the one distinction the assurance deliberately does not carry. A test pins that too, with
`pgChannelAssurance("disable") === pgChannelAssurance("prefer")` as the reason.

**`verify-ca` stays in the union.** Refused at parse and still a member, because both total
maps have to answer for it: *this binding cannot honour this mode* is a fact about the mode and
not an absence of one, and deleting the name would leave the refusal with nothing to name.

**The cursor survey borrows three functions rather than restating them.**
`listConfigForEntity` derives the sortable set, so the survey reads the set `parseListQuery`
will actually accept — a hidden column is not sortable, `sortable: false` opts out, and an
entity with no list view exposes no sort surface at all. `resolvedFields` supplies the field
list, so a classified field arriving through a **trait** is in scope. `entityClassifiedFields`
says which are classified. The predicate is **classified** and deliberately not narrowed by
`isSensitiveDataClass`, which is ADR-0345's stated reason at a second surface; measured, that
widening is vacuous on the seven shipped packs (all 173 classified fields there are
`pii`/`phi`/`regulated`/`commercial_sensitive`) and is still right, because a *tenant's own*
activated manifest can classify a field `internal`.

**It is the sortable set and not the default sort**, which is the difference from
`abac-obligations.ts`' `listSortConflicts`. That function walks `defaultSort` and is right to:
a default sort is one no caller can decline, which is why it earns a refusal with no hatch.
This one asks what a caller can *choose* — and surveying the default would have missed
`Patient.mrn` entirely.

**The disclosure line comes after `checkAbacObligations`.** That check can refuse
`cursor_discloses_withheld_rows` and its remedy is the same secret, so printing a second cursor
finding first would hand an operator two when the first is the one that stops the boot.

**Both new boot lines choose their level off a total map, not off a name.** The api-key line is
`console.warn` when `SOURCE_EXPOSES_ARGV[source]`, and the cursor line when the verdict is
`plaintext_disclosing`. That is the same reason the maps exist: a fifth api-key source has to
say which side of ADR-0301 it falls on before it can pick a log level, and a comparison against
the string would let it inherit the quiet one. Both are said at `info` otherwise rather than
suppressed, because "we checked and found nothing" cannot be claimed from the absence of a log
line.

**The probes wrap the dispatch target, not the Node listener**, which keeps both paths
available to the Fetch/Workers adapter. The readiness check list is **required and may be
empty**: `[]` is a signed assertion that this process needs nothing to serve, true of
`--store memory`, where an omitted field would mean nobody decided (ADR-0331's distinction, and
`UNREACHABLE_STORES.tables`' shape). An optional list can be forgotten with the type still
valid, and forgetting it here would make every probe answer 200 for a process whose database is
gone.

**Two things found while reviewing the probe module, both fixed with their reasons.** The slot
was released in a second `.then` on `settled`, one microtask after the probe answered — a
window in which a joining request is served `ready` on the evidence of a round trip already
over, which is the stale *ready* this surface has no success cache precisely to avoid. It is
released **inside** the settle handlers now, so the slot's lifetime is exactly "the probe is in
flight". And a probe that threw **synchronously** escaped the whole evaluation, so the request
became a **500** — the surface whose job is to report an unreachable dependency reporting
instead that the request itself failed, which is not retryable and leaves the instance in
rotation. `probeOnce` converts it to the `unreachable` 503 any other refused connection gets.

**The timeout is a race, not a cancellation**, because `PgConnection` offers no way to cancel a
statement. The slot is therefore cleared when the *probe* settles and never when a budget
expires: released at the budget, a wedged database would get a fresh connection checked out on
every probe while the previous queries still held theirs, which is the pool exhaustion the
collapse exists to prevent, caused by the surface meant to report it.

**The readiness body is a closed vocabulary.** Check names (a declared lowercase identifier,
not prose) and one of three enumerated outcomes. No version, no build id, no uptime, no
dependency error text, and `durationMs` is on the report and **not** in the response — a timing
an unauthenticated client can poll is a measurement of the database's load from outside the
perimeter. The dependency's real failure goes to `onNotReady`, server-side.

## Verified live

A throwaway PG 16.13 cluster, the real `operate-server` binary, and the serving role
`app_user` — which owns nothing (`relowner` is `app_owner` on every `meta.*` table), has
`rolbypassrls = false`, and is therefore confined by RLS, so none of this was observed as the
owner. `crossengin apply --confirm` executed **964/964** statements, 0 failed.

**The disclosure, and the pair that settles it.** `erp_viewer` holds `Employee.list` and
`Employee.read` and *not* `work_email.read`, whose grant is `[erp_admin, hr_manager]`. One
request, `GET /v1/employees?sort=work_email&order=asc&limit=1`, two deployments:

```
caller            : erp_viewer
work_email in body: False
nextCursor        : eyJrIjpbImExLXNlY3JldEBleGFtcGxlLnRlc3QiXSwiaWQiOiJyZWNfbXY0M3MzcTUwMDA1In0
DECODED           : {"k":["a1-secret@example.test"],"id":"rec_mv43s3q50005"}
```

```
work_email in body: False
nextCursor        : s1.-sdvu8Oxt1FAo-MA1431BHv4UrKtfJnz_JvPxdV2ERKNHC0qluBiXLxdEjoguzuesnvqc_Eil…
```

The body omits the field in both. The row is one `erp_viewer` is shown; the value is one they
are not. `hr_manager`, who may read it, gets `"work_email":"a1-secret@example.test"` in the
body as expected.

**The boot lines, verbatim.**

```
[auth] api-key specs: 0 from argv, 2 from OPERATE_API_KEY_SPECS — none on the command line
[pg] database channel: PGSSLMODE=disable — the server may decline TLS and the connection
     proceeds in the clear, carrying the tenant context and any column encryption key with
     it; PGSSLMODE=verify-full validates it
[cursor] cursor disclosure: plaintext_disclosing — 1 classified field(s) are nameable in
     `?sort` while CURSOR_ENCRYPTION_SECRET is not set … Employee.work_email (pii) …
[health] serving /health (liveness, touches nothing) and /readyz (readiness, checks postgres)
```

With the secret set, the two cursor lines read `sealed` and `sealed`. With one spec on argv:
`1 from argv, 1 from OPERATE_API_KEY_SPECS — a spec's token IS the credential and argv is
readable via \`ps\`, so move it to OPERATE_API_KEY_SPECS`. **Both sources authenticate**: the
env credential lists 200, the argv credential lists 200, an unknown token is 401 — so the
concatenation is not a claim about a merge, it is two working credentials from two sources.

**The ssl refusal and the typo, kept distinguishable.**

```
PGSSLMODE=verify-ca → fatal: PGSSLMODE=verify-ca is refused: certificate verification is not
  implemented for it. … Use PGSSLMODE=verify-full … or PGSSLMODE=require to state plainly that
  the channel is encrypted and unauthenticated.
PGSSLMODE=bogus    → fatal: PGSSLMODE is not recognized: bogus
```

**The liveness/readiness split, which is the whole of the probe design.** With the cluster
stopped under a running process:

```
GET /health → 200 {"status":"ok"}
GET /readyz → 503 {"status":"not_ready","checks":[{"name":"postgres","outcome":"unreachable"}]}
```

and after `pg_ctl start`, the **same process** with no restart:

```
GET /readyz → 200 {"status":"ready","checks":[{"name":"postgres","outcome":"ready"}]}
```

That is the property stated in the Decision, observed: a process whose database is down is
not killed, it is taken out of rotation, and it returns by itself. The first accidental
occurrence was more convincing than the deliberate one — a mis-set `PGSSLMODE` made the first
boot's connection fail outright, and `/health` answered 200 while `/readyz` answered 503 before
anybody asked it to.

The compose `healthcheck:` command was exercised separately against stub servers on Node 20,
the Dockerfile's version, because its exit code is what compose reads and a probe that always
exits 0 is worse than no probe: **nothing listening → 1, a 503 → 1, a 200 → 0.**

One observation that is not a finding: on that first unreachable boot the catalog admission
survey reported `incomplete — 777 unreadable`, and on a connected boot `admits — 540 admitted,
0 refusing, 237 not probeable, 0 unreadable`. The first is ADR-0352's survey answering honestly
about a database it could not read, not a privilege problem.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The cursor survey is boot-time, so a **per-tenant** activated manifest (ADR-0314) that classifies a sortable field is surveyed by nothing. `buildOperateHttpServer` is where ADR-0340 put the obligation check for exactly this reason; the same call belongs beside it, and the only question is what a per-tenant *report* (not refusal) does when the tenant is not the operator reading the log. Same shape as ADR-0339's Q5. | Platform | 2026-11 |
| `--allow-cursor-disclosure` now acknowledges **two** findings — rows withheld by a record policy, and a classified field's value — and an operator who wants to accept the second necessarily accepts the first. Splitting it is one flag and a decision about whether a second hatch is worth the surface. | Platform | 2026-11 |
| Whether sorting by a field you cannot read should be refused **generally** rather than reported: ADR-0345's `withheldAddressing` refuses it only while rows are being withheld, so today the 14 members are addressable and the ordering they reveal is a pre-existing channel neither increment widened. | Platform | 2026-12 |
| The probes are wired in `serve()` and so are absent from the Fetch/Workers edge adapter's own entry point, which builds its dispatch target separately. `buildHealthInterceptor` is transport-pure and takes a `RawHttpRequest`, so this is a wiring line rather than a design question. | Platform | 2026-11 |
| `PGSSLMODE` is still read from the environment per `parsePgEnvConfig` call and the channel line is printed once, in `resolveStore`. The four maintenance subcommands (`rekey`, `replay`, and the two survey paths) each build their own connection and say nothing about the channel. | Platform | 2026-12 |
| **`verify-full` may be unreachable on the managed-cloud path this repo documents**, and that is this binding's limitation: `PgConfig` has no `ca` field and nothing reads `PGSSLROOTCERT`, so it validates against Node's trust store alone, while Supabase's documented path for `verify-full` is to pass the project's downloaded server root certificate as `sslrootcert`. Accepting CA material is therefore the top follow-up for this member — not for `verify-ca`'s sake but because it decides whether the mode this ADR prescribes can be used at all. Until then the guide says *try it*, and names `require` with its cost. | Platform | 2026-11 |
| Implementing `verify-ca` properly wants a **fourth** assurance member, not a reclassification of the existing three: `verify-ca` validates the chain and deliberately does **not** check the hostname, so it sits between `encrypted_unauthenticated` and `authenticated` (`chain_validated_hostname_unchecked`). The composed-map shape makes adding it a compile error rather than a silent default, and the test that reads `node-pg.ts` as text is what sends its author to the refusal that must then be deleted. | Platform | 2026-12 |
| `operate-web` authenticates nobody — its proxy sends one fixed `OPERATE_API_KEY` for every request, so every browser that can reach `$DOMAIN` is served as a `platform_admin` on the shipped stack. `deploy/README.md` now says so under *The UI has no login*; saying it is not fixing it, and the fix is a session layer plus the API's existing JWT path. | Platform | 2026-11 |

## References

- ADR-0301 — a secret arrives by environment, never argv.
- ADR-0312 — refused rather than clamped, for a configured bound.
- ADR-0322 — a surface that degrades rather than refusing has to say so out loud.
- ADR-0334 — converting a page-one failure into a boot refusal; why `--tenant-status-gate` is
  opt-in; "a remedy that cannot work is worse than none".
- ADR-0338 — refuse where nothing worked before; `--allow-plaintext-phi`'s shape.
- ADR-0340 — refuse with no hatch where the served behaviour is the opposite of the declaration.
- ADR-0345 — row filtering, the untouched cursor, and `withheldAddressing`.
- ADR-0346 — sealing the cursor, and the boot refusal this increment found vacuous.
- ADR-0349 — the rekey executor, and the api-key tenants with no `meta.tenants` row.
- ADR-0351 — a boot probe whose remedy is standing manual SQL.
- libpq, *Parameter Key Words* — `sslmode` and what each mode promises.
