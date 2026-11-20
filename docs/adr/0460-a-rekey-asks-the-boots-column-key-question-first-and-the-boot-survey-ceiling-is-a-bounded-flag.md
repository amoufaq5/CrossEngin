# ADR-0460: A rekey asks the boot's column-key question first, and the boot survey's ceiling is a bounded flag

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-20 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0338 (refuse only what serves nothing correctly), ADR-0347 (seeded keys), ADR-0349 (`operate-server rekey`), ADR-0372 (no falsely-true control), ADR-0445 (the secret ring), ADR-0455 (the boot column-key survey; this closes two of its open questions) |

## Context

ADR-0455 made a column-key configuration that cannot open the stored keys a boot refusal, and left
two open questions this increment takes:

1. **`operate-server rekey` builds its own ring and store and does not run the survey.** A rekey,
   a `--plan` or a `--rewrap-kek` under a ring that cannot open the tenant's stored key reached
   `PostgresDataKeyStore.load` — inside `surveyTenantRekey`, or the re-wrap's own read — and failed
   there with a bare `DataKeyUnwrapFailed` / `DataKeyKekUnavailable` naming no condition and no
   remedy. The boot had the sentence that says which secret is wrong and what to set; the one
   maintenance command that opens a tenant's key on purpose did not use it. `--plan` was the worst
   of it: the command an operator runs *to find out* threw instead of reporting.
2. **The confined route's ceiling was a constant.** `PER_TENANT_SURVEY_CEILING = 10,000` with no
   flag, so a deployment past 10,000 tenants booted with an `unknown` line for the rest and no way
   to examine them, and the `survey_incomplete` line named a number without saying it could move —
   the keyless-ciphertext half did not name the number at all ("stopped at its ceiling").

## Decision

### The rekey's pre-flight is the boot's composition, scoped to one tenant

`surveyColumnKeyConsistency(conn, {mode, ring, keySchema, dataSchema, scope})` is the whole check —
key-row survey, keyless-ciphertext check, assessment — as **one function with two callers**. The
boot calls it with `scope: {kind: "deployment", ceiling}`; `runRekey` calls it with
`scope: {kind: "tenant", tenantId}` and `mode: "envelope"` (the rekey always resolves the envelope
ring). The boot's inline composition of the three calls is deleted, so there is no second spelling
of which secret keyless ciphertext is read under or which schema it is asked in.

**Scoped to the named tenant, not the deployment.** `surveyDataKeyRows` and
`checkKeylessCiphertext` gained a `tenantId` option that reads exactly that tenant under its own
`app.current_tenant_id`, whatever the session's confinement — an owner's read is filtered by the same
`tenant_id = $1` the policy imposes on a confined one, so the confinement probe would decide nothing
and is not asked, and neither is `meta.tenants`. The scope is the decision and not an optimisation:
a per-tenant operation must be refused only for a fact about **that** tenant. A deployment-wide
survey would refuse a rekey of tenant A over tenant B's corrupt row, and `--rewrap-kek` exists to
move a rotation forward one tenant at a time — refusing it over the tenants not yet moved would make
the rotation's own tool refuse the rotation.

**Before anything else, `--plan` and `--rewrap-kek` included.** The order inside `runRekey` is
unchanged except for one step: the secret-absent refusal and the ring's own refusals still come
first (they need no connection), then the pre-flight, then — as before — the store, the re-wrap or
the write-status probe, the rotation survey, the write gate, the rekey. A `refuse` verdict returns a
report with `ok: false` (exit 1) and every later field `null`; the reason it **returns** rather than
throws is the subcommand's existing contract — `survey.refusals` are reported, not thrown, and
`--plan` must print what it found. `unknown` does not stop the rekey, on ADR-0455's rule that an
unestablished fact is not a refusal; its warn lines print, and the request path's per-tenant failure
is unchanged behind them.

**The boot's sentences, scoped.** `ColumnKeyConsistency` carries its `scope`, and
`formatColumnKeyConsistency` reads it in three places: the prefix (`column keys (tenant <id>):` — the
operator typed the id), the consistent line ("this tenant's stored data key opened under this secret
ring", where a census sentence would be false of one tenant), and the closing refusal sentence, which
must not tell an operator running a rekey that "booting would answer those tenants' PHI requests
with a 500". Every finding's `detail` — the remedy — is the boot's own, so the variable a rekey
operator is told to set is the variable the boot would have named. The deployment scope's
**consistent** and **refusal** lines are unchanged, each pinned in full by an exact assertion; its two
**incomplete** lines changed deliberately (below), which is the only deployment-scope wording this
increment moves. `formatRekeyColumnKeys` prefixes a level word, because
this output has no logger to carry one, and the bin prints it first on every run.

### `--column-key-survey-ceiling <n>`, bounded 1,000..100,000, default 10,000

A serve flag, digits only (`Number("1e4")` and `Number(" 5000")` are both in range, and a count an
operator types is not a spelling that merely parses), **refused rather than clamped** in both
directions, defaulting at parse to today's constant so an unchanged deployment boots exactly as
before. `ServeOptions.columnKeySurveyCeiling` is a number, never `null`, and travels to the survey on
the `deployment` scope.

- **The floor is a sampling bound, not a cost bound, and it bounds one attack.** The confined key
  route reads the first N tenants **by id** and samples 32 per key-encryption-key generation at
  random from them. ADR-0455's review closed "three tenants at the head of the id order corrupt
  their own rows into a permanent refusal" by sampling 32 at random; a ceiling of 50 would reopen it
  by shrinking what the 32 are drawn from. At 1,000 a refusal by corrupting `wrapped_key` bytes
  needs every one of the 32 rows drawn from that generation's tenants among the first 1,000 to fail.
  **That is all it bounds.** A tenant-context session can also move its own row into a generation
  of its own — `kek_generation`'s only CHECK is `>= 1` and the table's one policy is `ALL`-scope —
  and a one-row group at an unheld generation is `kek_generation_unheld`, which refuses for the
  whole deployment at **any** ceiling (on the confined route whenever that tenant is among the
  first N, on the unconfined route always). That predates this flag (ADR-0455's grouping) and is
  this ADR's first open question; the rekey's `tenant` scope is unaffected, since it reads the named
  tenant's row only.
- **The ceiling is a cost bound.** ADR-0455 measured the confined route at 3.45 s per 10,000 tenants
  on loopback and ~40 s at a 1 ms round trip; 100,000 is ~35 s on loopback — the compose healthcheck's
  `start_period` — and several minutes across a network. Past that the remedy is an unconfined survey
  session, not a longer boot.

**The line says where it stopped, when it stopped.** Both `survey_incomplete` findings — the key
survey's and the keyless scan's — now end "the survey stops at N tenants
(`--column-key-survey-ceiling`, 1000..100000)". The keyless half previously named no number. A survey
that did not reach its ceiling says nothing about it (a control test), so the clause appears exactly
when it is actionable.

## Alternatives considered

- **Run the deployment-wide survey in the rekey.**
  - **Pros:** literally the boot's call; catches a ring that is wrong for other tenants too.
  - **Cons:** refuses a per-tenant operation over other tenants' rows, including mid-rotation, where
    the not-yet-re-wrapped tenants are the reason the command is being run; on a confined session it
    costs the boot's per-tenant latency on every invocation.
  - **Why not:** the question a rekey asks is about one tenant; the composition is shared, the scope
    is not.
- **Throw `ColumnKeyConfigurationRefused` from `runRekey`.**
  - **Pros:** one line; the boot's own type.
  - **Cons:** `--plan` would print nothing but a stack's message, and `--format json` would emit no
    report; the subcommand reports its refusals and exits 1, and a second convention for one of them
    is a second thing to read.
  - **Why not:** the report is the subcommand's contract.
- **Only the rekey path, not `--rewrap-kek`.**
  - **Pros:** re-wrap is the remedy for some of these conditions.
  - **Cons:** a re-wrap reads and opens the row first, so under a wrong ring it fails exactly as a
    rekey does; and when the pre-flight is consistent mid-rotation (the row opens under the previous
    secret) it does not refuse, so it never blocks a re-wrap that would succeed.
  - **Why not:** it refuses only what would fail anyway, with the sentence instead of the exception.
- **Clamp an out-of-band ceiling, or accept any positive integer.**
  - **Pros:** no boot failure for a typo.
  - **Cons:** the boot line would state a ceiling the operator did not choose; a tiny ceiling reopens
    the head-of-id sampling defect.
  - **Why not:** `--column-key-ttl-ms`' rule, refused rather than clamped.
- **Remove the ceiling (read every tenant).**
  - **Pros:** no `unknown` remainder.
  - **Cons:** the confined boot is linear in tenants with no bound, so a large deployment on a remote
    database cannot pass its healthcheck.
  - **Why not:** a bounded boot that says what it did not read is honest; an unbounded one is an
    outage.

## Consequences

- **Positive:** a rekey, plan or re-wrap under a ring that cannot open the tenant's key (or the
  ciphertext its first key would be seeded from) is a report naming the condition and the remedy,
  instead of a bare unwrap exception; `--plan` reports the pre-flight either way. A deployment past
  10,000 tenants can examine up to 100,000, and every incomplete line says where it stopped and how to
  move it.
- **Negative:**
  - **One tenant is one sample.** ADR-0455's single-sample limit is the normal case here: a tenant
    whose only row is corrupt reads as `kek_secret_mismatch` and the remedy reads as a
    misconfiguration. The rekey would fail on that row anyway; only the wording is wrong.
  - A handful more statements per rekey invocation (the catalog read, the context and the key row;
    the keyless reads only when an at-rest column exists in `--data-schema`).
  - Past the ceiling the confined key route still examines the **lowest** ids, so the unexamined
    remainder is the same (newest) tenants on every boot — reported, not sampled.
  - A rekey under a ring that answers `unknown` (a role that cannot read `meta.tenant_data_keys`)
    proceeds as before and fails where it failed before.
- **Neutral:** the boot's behaviour is unchanged at the default ceiling, and so are its consistent
  and refusal lines; its two `survey_incomplete` lines now carry the ceiling clause.
- **Reversibility:** code only; the flag can be dropped and the default is the old constant.

## Implementation notes

- `apps/operate-server/src/column-key-consistency.ts`: `ColumnKeySurveyScope`,
  `surveyColumnKeyConsistency`, `COLUMN_KEY_SURVEY_CEILING_FLAG` / `_BOUNDS`; `tenantId` on
  `surveyDataKeyRows` and `checkKeylessCiphertext` (a `listed` per-tenant source beside `every`);
  `scope` on `assessColumnKeyConsistency` and `ColumnKeyConsistency`; scope-aware lines.
- `node.ts`: the boot calls the composition with the flag's ceiling; `runRekey(options, connect?)`
  runs the tenant-scoped pre-flight first and carries `keyConsistency` on `RekeyReport` (the `connect`
  thunk is the test seam; the default is the old `createNodePgConnection(parsePgEnvConfig())`).
- `rekey.ts`: `formatRekeyColumnKeys`; `bin/operate-server.ts` prints it first.
- `cli.ts`: the flag, its help entry, and the rekey help's pre-flight paragraph and exit line.
- Tests: `column-key-consistency.test.ts` 70 (12 new — the scoped reads in both halves, a refusal and
  its control, the other tenant's row not refusing, the keyless mis-seed and its control, the
  deployment consistent and refusal lines pinned in full, the ceiling on both incomplete lines and its absence when not reached,
  the bounds, and the boot/rekey wiring fences); `rekey-preflight.test.ts` 7 (refusal for rekey,
  `--plan`, `--rewrap-kek`, `--rewrap-kek --plan`; the right ring reaching the write-status probe; a
  clean `--rewrap-kek --plan`; no key material in the JSON, asserted against the fixture's own wrapped
  and plaintext key bytes in base64, hex and `Buffer` JSON form); `cli.test.ts` 6 (default, both forms,
  both bounds, out-of-band and non-digit refusals, help). operate-server: 168 files, 6,258 tests.
- Mutation-checked, each reversed: dropping the rekey's refusal return (5 fail); ignoring `tenantId`
  in the key survey (2); dropping the ceiling clause from the keyless line (1).
- `packages/testing`'s `pg-record-reads` rule failed during this slice on
  `deletion-owner-connection.ts:156`, another slice's in-flight file; nothing here adds SQL.
- Verified live; see the addendum below.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| One tenant can refuse every boot by moving its own key row to an unheld `kek_generation` (a singleton group is `kek_generation_unheld`), at any ceiling — the floor bounds corruption within a generation, not a new one. Options: treat a group smaller than `SAMPLES_PER_GROUP` at an unheld or newer generation as `unknown` with its tenant count, or fence `kek_generation` writes. Pre-existing (ADR-0455). | CrossEngin platform | _unscheduled_ |
| A one-tenant survey cannot tell a corrupt row from a wrong secret; the rekey could say "or this tenant's row is damaged" when the scope is a tenant and the sample count is one. | CrossEngin platform | _unscheduled_ |
| Past the ceiling the confined key route always examines the lowest ids; sampling the tenant list (as the keyless route does) would rotate the remainder at the cost of the head-of-id argument above. | CrossEngin platform | _unscheduled_ |
| `prune-links`, `replay` and `set-credential` open no column key, so none needs the pre-flight; a future maintenance command that does should take the `tenant` scope rather than a third composition. | CrossEngin platform | _unscheduled_ |

## References

- ADR-0455, open questions "operate-server rekey builds its own ring…" and "The per-tenant route's
  ceiling is a constant with no flag…".

## Addendum: four review findings

An adversarial review of this increment raised four; all four held and are closed above.

- **The floor's justification claimed more than the grouping gives.** The sampling argument holds
  for corrupting rows within an existing key-encryption-key generation and not for a tenant moving
  its own row into a generation of its own, which refuses at any ceiling. The sentence is narrowed in
  the source comment and here, and the hole is the first open question rather than a fix in this
  increment, because closing it changes ADR-0455's refusal semantics for a case a deployment can
  also reach honestly (a replica booting under an older ring mid-rotation).
- **`--help` priced a tenant at two round trips.** It is up to four (two for the key survey, two for
  the keyless-ciphertext scan, plus a decrypt for at most 32 hits), ~3.5 s per 10,000 on loopback.
- **"Byte-identical, pinned by a test" was false twice.** The deployment's incomplete lines changed
  deliberately, and the only pin was a `startsWith` on one derived-mode line while the deployment
  refusal sentence was pinned by nothing. Both the consistent and the REFUSED lines are now asserted
  in full.
- **The JSON key-material test checked a spelling the report could not contain.** It asserted
  `wrapped_key` absent — the column name — while a leak would serialize as `wrappedKey` or a
  `{"type":"Buffer","data":[…]}`. It now asserts against the fixture's own bytes in every spelling.

## Addendum: verified live

PG 16 in compose order (extensions, migrate — 990 executed, `app-role.sql`, `eraser-role.sql` with no
deletion user, `column-schema --pack erp-healthcare --grant-to crossengin_app`), the built binary
unchanged, `--store pg-columns --column-key-mode envelope`. Three tenants; A and B each wrote a patient
under S1, giving random keys at key-encryption-key generation 1. Every rekey arm was run as
`crossengin_app` and again as the owner; the pre-flight verdict was the same in every pair.

- **Control** (S1, `--plan`, A): first line `ok: column keys (tenant A): consistent — this tenant's
  stored data key opened under this secret ring …`, then the rekey survey. The owner's survey reported
  5 rows to rewrite, exit 0. The confined role's survey kept its existing
  `rls_would_confine_this_session` refusals (exit 1), printed after the pre-flight line.
- **Wrong secret** (S2, with `--plan` and again without it, `--allow-live-rekey`): `KEK_SECRET_MISMATCH
  … (1 tried)` with the boot's remedy, then the scoped `REFUSED` line. There was no `rekey survey:`
  line and the exit code was 1. The statement log shows the catalog probe, one `set_config` for A, A's
  key read and one keyless probe for A. There was no statement against `meta.tenants` and no
  `UPDATE`/`INSERT`/`DELETE`. A's key row was unchanged, including the md5 of `wrapped_key`.
- **`--format json`**: `ok: false`, `keyConsistency.verdict: "refuse"`, scope
  `{kind: "tenant", tenantId}`, and `writeStatus`, `survey`, `result` and `rewrap` all `null`. Neither
  the wrapped key (in base64 or hex) nor any secret appeared in the output.
- **`--rewrap-kek`**: S2 at generation 2 with no previous secret gave `KEK_GENERATION_UNHELD` and
  exit 1, and the row stayed at kek 1. With `PREVIOUS=S1` the run printed `ok: … consistent`, then
  `re-wrapped data key generation 1 from key-encryption-key generation 1 to 2`, exit 0, and the row
  moved to kek 2.
- **Scope**: B's `wrapped_key` was overwritten with `\x00`. A `--plan` on A was still consistent, and
  only A's tenant id appeared in any bound parameter. A `--plan` on B gave `KEK_SECRET_MISMATCH` (1
  tried), which is open question 2's single-sample wording.
- **Keyless**: tenant C held ciphertext written in derived mode under S1 and had no key row. S2 gave
  `CIPHERTEXT_KEY_MISMATCH`, exit 1. S1 gave `consistent — this tenant holds no stored data key row …`
  followed by the existing `no_data_key_row` refusal.
- **Ceiling flag**: `999`, `100001`, `=1e4`, `=0`, `=+5000` and `=05000x` each exited 2 with `must be
  an integer between 1000 and 100000 tenants, got '<raw>'`. On 1,008 tenants, `crossengin_app` with
  `--column-key-survey-ceiling 1000` booted (`/readyz` 200) and printed two `SURVEY_INCOMPLETE` lines,
  for the key survey and the keyless scan. Each said 8 tenants were not examined and each ended
  `the survey stops at 1000 tenants (--column-key-survey-ceiling, 1000..100000)`. On the same data the
  default ceiling, the owner with ceiling 1000, and `crossengin_app` with ceiling 100000 each printed
  the unchanged consistent line with no ceiling clause.
- No secret appeared in any rekey output or boot log.

Two pre-existing wordings were seen and left alone. When the survey is incomplete, no line reports the
tenants that were examined, but the `SURVEY_INCOMPLETE` line says "What was examined is reported". The
`KEK_GENERATION_UNHELD` remedy's `rekey --rewrap-kek --tenant <id>` omits `--confirm-tenant`, so it
exits 2 with a usage error that names the missing flag.
