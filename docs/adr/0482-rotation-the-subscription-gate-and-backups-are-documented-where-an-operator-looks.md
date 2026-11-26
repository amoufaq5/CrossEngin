# ADR-0482: Rotation, the subscription gate and backups are documented where an operator looks, and the CI workflow declares its token, its concurrency and its timeouts

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0437 (chain trust set), ADR-0445 (column-secret ring), ADR-0448 (pepper ring), ADR-0418 (entitlement 402s), ADR-0423 (unique on the document store), ADR-0449 (listener drain), ADR-0390 (backup documents), ADR-0382 (CI rules), ADR-0439 (supply chain), ADR-0274 / ADR-0301 (notification backlog), ADR-0416 / ADR-0417 (that backlog corrected) |

## Context

The remaining-open-items run grouped fourteen documentation and CI items into one slice. Each was
measured against the tree before it was changed (register P3.1's rule). What the measurements found:

- **Three secret rotations had no deploy-side route.** `AUDIT_CHAIN_TRUSTED_PUBLIC_KEYS` (ADR-0437),
  `COLUMN_ENCRYPTION_SECRET_PREVIOUS`/`_GENERATION` (ADR-0445) and `CREDENTIAL_PEPPER_VERSION` /
  `CREDENTIAL_PEPPER_RETIRED_<N>` (ADR-0448) are each read by the binary and **none was forwarded by
  `deploy/docker-compose.yml`**. An operator following any document could not rotate. `ORACLE.md`'s
  secrets table also said the old chain key "must stay registered", which is the pre-ADR-0437 model.
- **The subscription gate is armed by a side effect and printed nothing.** On `--store pg`,
  `STRIPE_WEBHOOK_SECRET` alone mounts `POST /v1/webhooks/stripe` *and* builds
  `PostgresEntitlementResolver` over `meta.billing_subscriptions`. `evaluateEntitlement(null, …)`
  answers **402 `no_subscription` for reads as well as writes**. So the first operator to set the
  variable would lose every tenant's read access until a webhook wrote a row. The brief described
  this as "refused writes", and the policy shows that was wrong. Neither variable was forwarded, and
  no boot line named the gate.
- **The API's shutdown raced Docker's default.** `shutdownGraceMs` 8000 plus
  `SHUTDOWN_DRAIN_ALLOWANCE_MS` 2000 is 10 s, the same as Docker's default stop timeout, so a
  `docker compose stop` could SIGKILL a drain in progress.
- **`dump.log` grew without bound** in `ORACLE.md`'s scheduled script (`exec >> "$log"`, with no
  trim).
- **`VERCEL-SUPABASE.md` had no backup section** (no occurrence of backup, dump, restore or PITR,
  recorded in ADR-0390). Its TLS note still said `PGSSLROOTCERT` was read by nothing, which ADR-0444
  made false.
- **README's *Loading existing records* described a pre-ADR-0423 store.** It said unique fields are
  not enforced on `--store pg`. Since ADR-0423 the `document-indexes` owner step builds them, a
  duplicate is **409 `unique_violation`**, and a withheld index names its reason (`index_not_owner`,
  `existing_duplicates`). The sequence bullet also needed correcting: a caller-chosen clash is the
  fixed **500** rather than a 409 when the allocator hands out a number an import already used,
  because the clashing value was the allocator's and not the caller's.
- **ADR-0274 and ADR-0301 still asserted the backlog sentence** ("configure the channel later and
  the backlog is delivered"). ADR-0416 measured that sentence as false when written (retries at
  30/60/120/240 s, then `dropped` at ~450 s, and `node.ts` passes no `maxAttempts`: 0 occurrences).
  It was corrected in code and the deploy documents, and left standing as history in both ADRs.
- **A failed `migrate` during an upgrade** left the old API serving a partly migrated schema, which
  README's Day-2 section did not say.
- **`.github/workflows/ci.yml` declared no `permissions`, no `concurrency` and no
  `timeout-minutes`.** So the token had the repository default, superseded runs kept running, and a
  hung job ran for the runner's six-hour ceiling. `auditCiWorkflow` would have reported the two
  top-level blocks as `workflow_key_undeclared` and a job's `timeout-minutes:` as
  `job_key_undeclared`. That refusal was the right default and is now replaced by declared values
  compared in both directions.
- **There was no `.nvmrc`.** The workflow, the `engines` floor and the image agree on Node 22, but a
  developer's `nvm use` read nothing.
- **`dev_tooling_not_shipped` was checked only through the member it is declared via.** Measured:
  `@crossengin/testing` is the only member listing `vitest` in `dependencies`, and no member lists
  `tinypool` or `vite`. A second member adding it as a runtime dependency would ship an advisory the
  exception says is never shipped, and no check would see it.
- **ADR-0417 Q10's fence pinned the absence it existed to watch.** Beside the biconditional
  `claimsAbsent === (importFlags.length === 0)` sat two unconditional assertions —
  `claimsAbsent` is `true`, and `@crossengin/migration` has no dependents — which made "there is no
  import route" the specification, so an import route landing would red them and the natural fix
  would be to delete the fence (ADR-0372's class). Both are removed; the biconditional alone reds
  on either side.

## Decision

**Forward every rotation variable as an empty-default `${X:-}`, and document each rotation where an
operator reads.** `deploy/README.md` gains four sections: *Rotating the audit-chain key* (derive the
old public half with one `docker compose exec` command, list it in the trust set, keep it listed for
good, and `--integrity-proof-full-every`'s default of 24), *Rotating the column secret* (envelope
mode only, `rekey --rewrap-kek` as the owner, remove `PREVIOUS` afterwards), *Rotating the login
pepper* (`crossengin apply --plan` before raising the version, since an un-migrated catalog refuses
the `k<version>` hash with `23514`) and *Turning on the subscription gate* (license against Stripe,
reads included, and why no order avoids a window: the route that writes the rows is mounted by the
same variable that arms the gate). `.env.example` names each variable as a **commented
`REPLACE_WITH_` placeholder**, the shape ADR-0420's secret-values rule admits. `ORACLE.md`'s two
stale rows are rewritten against the trust-set model.

**Say which source gates subscriptions at boot.** `entitlement-survey.ts` reads the live resolver
(ADR-0361's rule: never re-derive from flags), with a total map `ENTITLEMENT_SOURCE_GATES` over
`none` / `license` / `stripe_snapshots` / `custom`. `node.ts` prints the `[entitlement]` line after
the webhook block that may assign the resolver. The Stripe sentence says "reads included". A test
pins the sentence against `evaluateEntitlement` itself, so a policy change shows up as a red test.
The license sentence names that Stripe snapshots do not gate while a license does.

**Give the API a stop grace period it can drain inside.** `stop_grace_period: 20s`, with a fence
asserting it exceeds `shutdownGraceMs + SHUTDOWN_DRAIN_ALLOWANCE_MS` read from the binary's own
constants, and a README sentence saying to raise it when raising `--shutdown-grace-ms`.

**Bound `dump.log` before redirecting into it.** The script keeps the last 1000 lines through a
temp file and `mv`, and removes the temp file if the trim fails. The trim runs before `exec >>`, so
a failed trim cannot corrupt the run's own output. Tested in a scratch directory: 1500 lines became
1001, and a first run creates the file.

**Give the managed path a backup section that it can follow.** It covers provider backups and PITR
by plan, that the compose `backup` service is not on this path, a `pg_dump --format=custom` against
the direct host with the password prompted rather than on argv, `pg_restore --list`, and a scratch
project restore as the proof. The TLS note is rewritten for ADR-0444.

**Correct the README sections against the post-ADR-0423 store**, add the failed-migrate Day-2
bullet, and append dated addenda to ADR-0274 and ADR-0301 rather than editing their history.

**Declare the CI token, concurrency and timeouts, and compare them both ways.**
`permissions: {contents: read}`, `concurrency: {group: ci-${{ github.ref }}, cancel-in-progress:
true}` and `timeout-minutes: 45` per job are declared in `CI_PIPELINE`. `CiJobSchema` refuses a
timeout at or below a job's measured `targetMinutes`, because such a timeout would fail a healthy
run. That is ADR-0382's refusal of `timeout-minutes: 10`, now made checkable. `parseCiWorkflow`
reads both blocks column-exactly and refuses the scalar form (`permissions: read-all`) rather than
reading it as an empty map. `auditCiWorkflow` reports `permissions_differ`, `concurrency_differ`
and `job_timeout_differs`. The two required-key lists are separated from the allow-lists, so the
new keys are allowed and the old three stay required.

**Pin Node in `.nvmrc`** (`22`), asserted equal to the workflow's `setup-node` input.

**Refuse a `dev_tooling_not_shipped` exception when any other member lists the package directly.**
The member the exception is declared through may list it, since that dependency is what the
exception declares.

## Alternatives considered

- **Precedence instead of forwarding both pepper generations.** Rejected on ADR-0357's argument:
  precedence lets a deployment that set one variable and forgot the other serve one silently.
- **Making `STRIPE_WEBHOOK_SECRET` not arm the gate.** That changes what a working deployment does,
  and is a product decision about billing. The boot line and the README make the existing coupling
  visible instead. Whether to split the two is an open question.
- **A larger `stop_grace_period` with no fence.** Rejected. The defect was two numbers drifting
  apart, so the fence reads both from the binary.
- **`logrotate` for `dump.log`.** That adds a host dependency to a document whose script is
  self-contained. Rejected.
- **A tight `timeout-minutes` (10, per ADR-0382's reviewer).** Refused on that ADR's measurement,
  because install time is unmeasured. 45 is generous and still bounded, and the schema refuses
  anything at or below the measured target.
- **Leaving `permissions:` undeclared and relying on the repository default.** The default is a
  repository setting outside the tree, which no rule can read. Declaring it makes the token's scope a
  diffable fact.
- **A CI job for the new fences.** The brief forbids one, and none is needed: the existing
  `Workspace rules` step and the operate-server test suite already run them.

## Consequences

- Each rotation now has a forwarded variable, a commented placeholder and a section, and the fences
  fail if any of the three is removed. Mutation-checked: dropping `stop_grace_period`, renaming the
  `AUDIT_CHAIN_TRUSTED_PUBLIC_KEYS` forwarding, renaming VERCEL's `## Backups`, and removing the
  dump-log trim each fail one test. Changing `.nvmrc` to `20` fails one, widening `contents: write`
  fails six, and disabling the direct-dependency check fails one. A `tail -n 1000000` survives by
  design, since that is still a bound.
- A deployment that sets `STRIPE_WEBHOOK_SECRET` now reads, at boot, that unsubscribed tenants are
  refused reads.
- CI cancels a superseded run on the same ref, and a job's token can read contents only. A workflow
  needing a write scope must declare it in `CI_PIPELINE` first.
- `.nvmrc` is a fourth Node pin and is fenced with the other three.

## Implementation notes

- `deployment-defaults.test.ts` gains a describe block of eleven tests (forwarding, placeholder
  shape, each rotation section, the gate's read refusal, no stale phrase anywhere in
  `deploy/*.md`, the backup sections, the dump-log ordering, the grace arithmetic, the notification
  list grant agreeing with the read-state roles, and `--jwt-optional-claim`'s help naming every
  `REQUIRED_JWT_CLAIMS` member). The `pg_dump` population fence is widened to the fourth document,
  with `-T` scoped to the `docker compose exec` commands and the role rule applied to the direct
  connection.
- The first-launch block had to fit the fence's measured 1200-character window. One added line took
  it to 1232, and shortening one comment line brought it to 1181.
- Shared edits: `node.ts` (one import, and the `[entitlement]` line after the Stripe block) and
  `cli.ts` (a `--jwt-optional-claim` help entry, which the flag had no entry for).
- `CLAUDE.md` is not edited by this slice. One change is reported for the orchestrator: ADR-0443's
  upgrade remedy reads "`crossengin-pg encrypt --plan` then `--apply`", and `crossengin-pg encrypt`
  uses one key and no tenant filter, so it writes ciphertext other tenants cannot read. No shipped
  tool converts a populated column per tenant.

## Verification

- `apps/operate-server`: `deployment-defaults.test.ts` (127) and `entitlement-survey.test.ts` (11)
  pass after the review fixes; `cli.test.ts` passed in the implementation pass. The package's full typecheck is red only on two errors in the other
  in-flight slice's route contexts (`PlatformUserRoutesContext.onUserIdentityChanged`,
  `CredentialRoutesContext.subjectMemberships`/`platformAuthorityRoles`). None names a file this
  slice touched.
- `packages/testing`: typecheck clean, build clean. `ci-workflow.test.ts` passes in full (70). In the
  full package run, 9 tests fail, all in `pg-unreadable-rows.test.ts` and
  `entity-field-aperture.test.ts`, and all naming the other in-flight slices' files
  (`credential-hash-admission.ts`, `platform-users.ts`, `apps/architect-cli/src/refusal.ts`). None
  names a file this slice touched.
- `docker compose config --quiet` exits 0 for the base file and for base plus `docker-compose.ai.yml`
  against a copy of `.env.example`.
- No live operate-server run: nothing in this slice changes SQL or the request path except one boot
  log line, which the unit tests cover against the real resolver classes. One documented database
  behaviour was measured on a throwaway PG 16 cluster during review: `pg_dump` as a confined role
  errors rather than writing a short dump, and `pg_restore -n meta` does not create the schema it
  restores into.

- **Review pass.** An adversarial review of this slice found five defects in its own documents,
  all fixed:
  - *Turning on the subscription gate* prescribed an order nobody could follow. It said to
    "confirm a row exists for every tenant you serve **before** you set the secret", but the only
    route that writes a row is mounted by that same secret. It now says that no order avoids the
    window, how to narrow it (resend one `customer.subscription.*` event per tenant), and the query
    that lists who is still refused. The `[entitlement]` sentence changed the same way. A fence
    refuses the old phrasing.
  - *Rotating the audit-chain key* said the first pass after boot is "always" a full fold.
    `periodicFullFoldSchedule` returns false for every pass when the value is `0`, so `0` disables
    that fold too. The section now says so, and says that a forgotten trust-set entry is still
    reported on the first pass for any scope holding a checkpoint the old key signed, because every
    pass checks every checkpoint's signature.
  - The derivation command's continuation lines were indented less than the list item. In CommonMark
    that ends the fenced block inside the list item. They are re-indented. The command itself was
    checked: its output equals `ed25519PublicKeyFromSeed` for a random seed.
  - `VERCEL-SUPABASE.md` said `pg_dump` as a confined role "silently leaves out every tenant's rows".
    That is false. `pg_dump` turns row security off and errors with `query would be affected by
    row-level security policy` on the first such table. Measured on a throwaway PG 16 cluster, as a
    `NOSUPERUSER NOBYPASSRLS` role and as a non-superuser owner of a `FORCE`d table: exit 1 both
    times, and no usable archive (the truncated file reads `end of file` to `pg_restore`). The restore test also now expects `already exists` errors (the dump
    holds the whole `postgres` database, including what every Supabase project creates for itself)
    and judges the restore by a table count and a row count, not by `pg_restore`'s exit status. A
    fence pins the error text and refuses the old phrase.
  - The `.nvmrc` agreement test compared only when it found a `setup-node` step, so it was vacuous
    if that step were renamed. It now asserts at least one comparison was made.

## Open questions

1. Should `STRIPE_WEBHOOK_SECRET` mount the webhook without arming the gate, with a separate flag
   to arm it? Deciding that changes behaviour for a working deployment.
2. The column-secret ring rotates only in envelope mode. A derived-mode deployment still has no
   rotation, as ADR-0445 records.
3. `timeout-minutes: 45` bounds the job's wall clock, while install time is still unmeasured. A
   measured install would let the ceiling be derived like `targetMinutes`.
4. The managed-path backup section's restore proof is prose. Nothing runs it, and it was not run
   against Supabase.
5. `cancel-in-progress: true` applies to pushes to `main` as well as to pull requests, so a push
   that lands while the previous push's run is in flight cancels that run, and its commit never gets
   a verdict. `${{ github.event_name == 'pull_request' }}` is the usual narrowing. It is not adopted
   here because the fence compares the literal, and the brief asked for `true`.

## References

- `deploy/README.md`, `deploy/ORACLE.md`, `deploy/VERCEL-SUPABASE.md`, `deploy/docker-compose.yml`,
  `deploy/.env.example`
- `apps/operate-server/src/entitlement-survey.ts`, `apps/operate-server/src/deployment-defaults.test.ts`
- `packages/testing/src/strategy/ci.ts`, `packages/testing/src/strategy/ci-workflow.ts`,
  `.github/workflows/ci.yml`, `.nvmrc`
