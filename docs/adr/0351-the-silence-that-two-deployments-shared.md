# ADR-0351: The silence that two deployments shared

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-09 |
| **Authors** | platform |
| **Reviewers** | platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288, ADR-0317, ADR-0322, ADR-0323, ADR-0324, ADR-0328, ADR-0329, ADR-0330, ADR-0331, ADR-0334, ADR-0342, ADR-0344, ADR-0350 |

## Context

ADR-0350 widened the `shared_tables` erasure to the boot manifest's typed entity tables and made the
target list a **required** parameter, which made *nobody looked* unrepresentable in the code. Its own
first open question said what that left:

> an empty boot group and no boot group still compose **byte-identical scopes**, so a reader of a
> stored proof cannot tell a `pg` deployment from a `pg-columns` one whose list came out empty.

That is measured, not reasoned. The same `DeletionScope`, capability declaration and retention claim
hashed under `crossengin.tombstone.content.v3`:

```
--store pg         (no typed relations):          d8cb6d10f973020cde7949f1bc3fb366ac323a12d6d6d6a44fb7db067b1eb042
--store pg-columns (54, manifest declared none):  d8cb6d10f973020cde7949f1bc3fb366ac323a12d6d6d6a44fb7db067b1eb042
```

`d8cb6d10…` is not a constructed example. It is the digest **ADR-0350's own live pre-fix run
stored**, in the tombstone whose scope named exactly `meta.operate_tenant_settings` while
`public.patient` still held the tenant's PHI. So the collision is demonstrated against a proof this
repository actually wrote.

The class is the one this lineage keeps finding: **a silence in the scope that the bytes cannot make
honest.** v1 could not tell "we have no object storage" from "nobody asked", so ADR-0329 signed the
capability declaration as `content.v2`. v2 could not tell "nothing was lawfully retained" from "this
proof cannot say", so ADR-0331 signed the retention claim as `content.v3`. v3 cannot tell "this
deployment has no typed per-entity relations" from "it has 54 and the manifest declared none" — and
the second is the wrong pack having loaded, which `boot-erasure-report.ts` warns about at boot and no
stored proof could say.

There is a third case the model alone does not separate, and it is the one that earns a figure. A
column store serving a manifest that declares no entity is **legitimate** where every tenant
activates its own manifest, and is the signature of a misconfiguration otherwise.

## Decision

**`crossengin.tombstone.content.v4` signs a record-storage declaration.** Six parts.

**1. A fourth tag, never an edit to the v3 body.** v2's reason, restated twice over: every stored v3
digest commits to the v3 body, so appending a key to it would stop all of them verifying, and a
digest that stops verifying is reported `scope_tampered` (ADR-0323) and fires a paging `sev1`
(ADR-0324). A migration that forges the one alarm the forensic chain cannot raise is not a migration.
`crossengin.tombstone.proof.v1` is unchanged for all four versions.

**2. The declaration is `{model, schema, relationCount}`.** `model` is one of `typed_tables` /
`document_rows` / `no_durable_store`; `schema` is non-null for `typed_tables` alone; `relationCount`
counts the typed per-entity relations the manifest declares. The model separates ADR-0350's two cases
and the count separates the third. Live, the three compose three distinct digests.

**3. It is a *declaration*, not a measurement, and that decides where it lives.** Every field is
derivable from the store mode and the manifest before a row is read, so it rides beside
`capabilityDeclaration` and not on an attestation. `DeletionAttestation`'s own comment states the rule
it would otherwise have broken: *the figures in a proof describe what was destroyed*. A count on an
attestation would sit beside `rowCount` and be read as part of that total.

**4. The count is derived, never supplied.** `BootSchemaDeletionInput` takes
`Omit<TombstoneRecordStorageDeclaration, "relationCount">`, and the pipeline fills the count from the
target list it hands the erasure. So the figure the digest commits to **is** the number of relations
that deletion targeted, structurally rather than by a cross-check somebody has to remember —
ADR-0344's `Omit` idiom, for its reason: supplying it twice is impossible rather than resolved by a
precedence rule nobody reads.

**5. The coverage lists became one total map.** `PROOF_VERSION_COVERAGE` over
`TombstoneProofVersion` to `{declaration, retentionClaim, recordStorage}`, with the three exported
arrays derived from it. See *The fence that was not one*.

**6. A boot probe converts the migration's sharp edge.** See *What the migration costs*.

## Alternatives considered

- **Option A: a seventh `DELETION_SUBSYSTEMS` member, `entity_tables`.**
  - **Pros:** it needs no new content-manifest key at all — the disposition would ride in the v2
    bytes, and `absent` versus `erases` + `nothing_to_erase` separates ADR-0350's two cases. And
    ADR-0350's own comment says this is what a seventh member *would have bought*, rejecting it only
    on migration grounds, so a v4 tag plausibly unblocks it.
  - **Cons, and the one that decides it:** the disposition would be a **hand-typed declaration of a
    derivable fact**. `--deletion-capabilities` is a file an operator writes (ADR-0328), and whether
    this deployment holds typed relations follows from `--store`. So the seventh key would add a
    second, redundant, fallible source for something the deployment has already declared — and a
    deployment that typed `absent` on `pg-columns` would have every deletion refused
    `absent_subsystem_attested`, while one that typed `erases` on `pg` would attest
    `nothing_to_erase` about a subsystem it does not have.
  - **Also:** every existing `--deletion-capabilities` file is refused at boot (the schema is total
    with no `z.default()`, deliberately — ADR-0328); `TombstoneCapabilityDeclarationSchema` would
    need two versions, since stored v2/v3 declarations have six keys and a seven-key total schema
    refuses them; and `SUBSYSTEM_SCOPE_FIELDS` would need the one erasure to produce two attestations,
    undoing ADR-0350's one-target-list, one-probe, one-refusal-pass decision — the thing that keeps
    ADR-0330's *"a returned refusal means nothing was destroyed"* true across both groups.
  - **Why not:** ADR-0328's rule is that the **deployment** declares rather than the caller, and
    `--store` already is that declaration. Deriving from it satisfies the rule; a seventh capability
    key would restate it in a place an operator can get wrong.

- **Option B: put the count on the `shared_tables` attestation.**
  - **Pros:** it is a figure about what that subsystem did, and attestations are where figures live.
  - **Cons:** `SUBSYSTEM_SCOPE_FIELDS.shared_tables` is `["tables", "rowCount", "storageBytes"]` and
    `DeletionAttestationSchema` refuses any other key per subsystem by name, so it would need the
    remit widened; and the comment on `retainedObligations` states the rule it would break.
  - **Why not:** it is not a measurement. The number of relations a manifest declares is known before
    a row is read, which is what makes it a declaration and keeps it out of the destroyed total.

- **Option C: carry the table *names* rather than a count.**
  - **Pros:** strictly more informative — it would name what was examined, not just how much.
  - **Cons:** the catalogued half's coverage is not in the bytes either, so names for one group and
    nothing for the other is a half-answer; and it makes a *coverage* claim, which the scope
    deliberately does not carry.
  - **Why not:** out of scope for the question ADR-0350 asked, and the full-coverage question applies
    equally to both halves. Left as an open end rather than half-answered.

- **Option D: `relationCount` for `document_rows` meaning "all relations holding records" (2).**
  - **Why not:** the two would be `meta.operate_entity_records` and `_links`, named by hand — the
    constant-nobody-maintains shape this repo has found wrong repeatedly. And a figure that sometimes
    meant "typed relations" and sometimes "all relations" would be the two-spellings defect inside a
    signed claim. It counts typed relations only, and says so.

- **Option E: default `recordStorage` when a caller omits it, and keep emitting v3.**
  - **Why not:** every candidate default is a *claim*. `document_rows` asserts there were no typed
    relations, which is exactly the assertion ADR-0350's gap made unavailable. And emitting v3 on
    omission would make the version a function of the caller's completeness, so a forgetful caller's
    proof would be indistinguishable from one written before v4 existed — ADR-0331's argument for why
    v3 is the default for *every* capabilities-path assembly rather than only for a retention.

- **Option F: infer the version from whether a declaration is attached.**
  - **Why not:** refused three times already in this lineage, for one reason — an inference reads a
    *deleted* declaration as an older record, a tamper that covers its own tracks.

### The fence that was not one

The three coverage membership lists were replaced by one total map, and the reason is that adding
`"v4"` to the enum **and nothing else** typechecked and passed every test. Measured:
`proofVersionCoversDeclaration("v4")` answered `false`, so a v4 record was structurally a v1 record —
the two refinements refused it for carrying a declaration or obligations, and `readDeclaredAbsences`
reported it `reason: "v1_proof"`. A silent regression of both v2 and v3.

The test that existed for exactly this case said so in its own comment — *"A fourth tag added to
neither list would silently sign nothing new, which is the kind of omission `SCOPE_BEARING_OUTCOMES`
has a partition test for"* — and then asserted only that the predicates return a boolean, which they
do for every input. It documented the hazard and checked nothing.

The original choice of lists over an ordering comparison stands and is restated: *a version names a
domain tag, not an ordinal.* But a **map** is not an ordering comparison, and it buys what the lists
could not — a new enum member is now a compile error until it says what its bytes carry.
`ABAC_OUTCOME_ALLOWS` is a map for this reason; this is the same reason.

## Consequences

- **Positive.** A stored Article 17 proof says where the tenant's records were. Live, two deployments
  with the **identical** `scope.tables: ['meta.operate_tenant_settings']`:

  | deployment | `recordStorage` | `contentManifestSha256` |
  |---|---|---|
  | `--store pg-columns`, 51 typed relations | `{typed_tables, public, 51}` | `f18eb91de8d6ff2b…` |
  | `--store pg`, no typed relations | `{document_rows, null, 0}` | `ee0f759422d29197…` |

  Both round-trip through the store and verify `{contentManifestOk: true, proofOk: true}`, and
  `readRecordStorage` answers `covered_by_proof` for each. Under v3 both were `d8cb6d10…`.
- **Positive.** Editing a stored `recordStorage` now moves the digest, so it is a tamper
  `verifyStoredEvidence` detects. Before v4 the field did not exist; had it been added as an unsigned
  column it would have been ADR-0323's `scope_tampered` in a fourth place.
- **Positive.** A new proof version can no longer be added without declaring its coverage.
- **Negative.** An existing deployment holding any tombstone needs one manual `ALTER`. See below.
- **Negative.** `TombstoneAssemblyInput` gained a third optional field governed by run-time refusals
  rather than by the type, which is this input's existing idiom (`capabilities` and
  `requiredSubsystems` are an exactly-one rule the type does not express) and still weaker than a
  compile error.
- **Neutral.** `tombstoneMatchesAttestations` deliberately does **not** check the declaration, for
  `capabilityDeclaration`'s reason: it is not derived from attestations, so there is no evidence to
  compare it against. The v4 digest is its only detector.
- **Reversibility.** Moderate. No stored proof changes meaning, v1–v3 records verify untouched, and
  the catalog change is additive plus one widened CHECK. Reverting means narrowing that CHECK, which
  would refuse every v4 row already written.

### What the migration costs

Measured on a live cluster, planning the change against the pre-change schema:

| table state | plan |
|---|---|
| `tenant_tombstones` **empty** | 2 steps, 0 unreconciled — `add_column` and a guarded `replace_column_check` |
| `tenant_tombstones` **populated** (1 row) | 1 step, 1 unreconciled — the column lands, the CHECK does not |

So the **column is automatic and the CHECK is manual**, which is ADR-0330's rule working as designed:
a widening CHECK cannot be told from a narrowing one, so validating it against existing rows is the
one thing a plan may not assume. The plan hands over the exact SQL, with the probe query for rows
that would refuse it.

The consequence needed answering rather than noting. Between the upgrade and that `ALTER`, this
binary emits `proofVersion: "v4"` and the `INSERT` is refused `23514` — **inside the deletion
pipeline's transaction, after the tenant's schema has been dropped and their rows deleted.** The
transaction rolls back, so nothing is destroyed; ADR-0321's runner sees a throw that is not a
`DeletionPipelineAborted`, files it `aborted`, and leaves the request `in_progress`. An operator meets
that under an Article 12(3) deadline.

`proof-version-probe.ts` converts it (ADR-0334, the fourth time this move has been the right one). It
asks `pg_get_constraintdef` — Postgres's own deparse — whether the stored CHECK names every version
this binary emits, and refuses the deletion surfaces at boot if not, printing the `ALTER`. Verified
live, both arms:

```
fatal: [deletion] tombstone proof version: refuses — meta.tenant_tombstones.proof_version does not
name 'v4', so storing a tombstone at that version is refused 23514 — inside the deletion pipeline's
transaction, after the tenant's data has been deleted. …
ALTER TABLE "meta"."tenant_tombstones" DROP CONSTRAINT "tenant_tombstones_proof_version_check";
ALTER TABLE "meta"."tenant_tombstones" ADD CONSTRAINT "…" CHECK (proof_version IN ('v1','v2','v3','v4'));
```

and after running exactly that, `[deletion] tombstone proof version: admits` with the planner
reporting *nothing to do*.

Three decisions in the probe. It is gated on `deletionCapabilities` being declared and **not** on a
list of the flags that mount a deletion surface — ADR-0328 made that declaration required by both, so
it is the one derived condition that cannot fall behind the flags, which is ADR-0288's lesson found
wrong three times as a maintained list. It **refuses** where `decision-schema-probe.ts` mounts
loudly, because that probe guards a *projection* of an enforcement that happens either way and here
there is no degraded behaviour to protect. And `absent` / `unreadable` **warn and mount**, which is
ADR-0334's `missing`-versus-`unreachable` asymmetry: a CHECK observed to omit a version has one
`ALTER` as its remedy, while at boot the database may simply not be up, and refusing on an
unestablished fact would refuse a deployment that works.

## Implementation notes

- `packages/tenant-lifecycle/src/tombstones.ts` — `PROOF_VERSION_COVERAGE`, `RECORD_STORAGE_MODELS`,
  `TombstoneRecordStorageDeclarationSchema`, `recordStorage` on the record with two paired
  refinements, `readRecordStorage`. `schema` is `string | null` on the type rather than an optional
  key, so ADR-0331's explicit-`null` requirement holds by construction: `canonicalStringify` drops
  `undefined`, and a dropped key would render a model with no schema and a model whose schema was
  *stripped* identically.
- The declaration's own `superRefine` is total over the model: `typed_tables` must name a schema (the
  half an operator cross-checks, since `--schema` feeds two stores with two different defaults), and
  the other two may name none and must count zero. A `typed_tables` count of **zero is not refused** —
  it is the third case the version exists to express.
- `packages/tenant-lifecycle/src/tombstone-proof.ts` — the fourth tag, `canonicalContentManifestV4`,
  the `"v4"` subject arm, a third paired check in `contentManifestSubjectOf`, and a `case "v4"` in
  both exhaustive switches (which is why a missing arm would not compile).
- `apps/operate-server/src/boot-erasure-report.ts` — `RECORD_STORAGE_FOR_STORE` lives beside
  `STORE_ANSWER` because that module already knows what each store does with a tenant's records, so
  the boot line and the signed claim are two readings of one map rather than two statements that can
  disagree.
- `tombstoneReceipt` carries `recordStorage`. The module's own comment records that this receipt
  regressed at v2 and was one field further away at v3; a v4 receipt without it would let a holder
  read `proofVersion: "v4"`, select the right tag, and still not reconstruct the body.
- The v4 body was independently re-derived — canonical JSON hand-assembled and hashed with
  `node:crypto` by a model that first reproduced the v1, v3 and three proof fixtures exactly — and the
  implementation matched on the first run. The older pinned byte strings are unchanged; a diff that
  moved one would be the defect, not a test to update.
- **The probe's shape test was too narrow, and writing its unit test is what found it.** The first
  `ANY_ARRAY_SHAPE` was `/= ANY \( ARRAY \[/`, which is the spelling the live verification produced
  because the catalog declares `proof_version TEXT`. Asked of Postgres 16.13 rather than guessed,
  the identical `CHECK (proof_version IN ('v1', …))` deparses two ways depending only on the
  column's declared type:

  ```
  TEXT     CHECK ((proof_version = ANY (ARRAY['v1'::text, …])))
  VARCHAR  CHECK (((proof_version)::text = ANY ((ARRAY['v1'::character varying, …])::text[])))
  ```

  The second has an extra paren the first regex rejects, so a column drifted to `VARCHAR` answered
  `unreadable` — and `unreadable` **mounts**. That is the safe direction in the sense that it refuses
  nothing that works, and it is the *wrong answer* here: it leaves the `23514` this module exists to
  convert exactly where it was, behind a warning. One optional group fixes it, and both spellings are
  now pinned with the measurement beside them. Verified live against the applied catalog: `admits`
  on the real TEXT column, `refuses` with `missing: ["v4"]` after narrowing the CHECK by hand, and
  `admits` again after altering the column to `VARCHAR(8)` — the one arm the widening is for, and
  the one the pre-fix regex reported `unreadable` for.
  The general lesson is the narrower one: the live run exercised the spelling this repo's own
  catalog produces, so it could not have found this. A fake asked to answer a *second* real spelling
  could, which is the first time one of these fences has been worth more than the live pass rather
  than less.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Full *coverage* is still outside the bytes for both halves: the proof says how many typed relations exist, not which relations were examined. Option C's shape, and it applies equally to the catalogued half. | platform | — |
| v1, v2 and v3 records on file are permanently unprotected in this respect, as they are for the retention claim: nothing can retrofit them, and re-signing them under v4 would forge the alarm the chain cannot raise. | platform | — |
| `tombstoneMatchesAttestations` cannot check the declaration against evidence, because there is none to check it against. A cross-check would need the erasure to report its examined count as a measurement, which Option B's reasoning refuses. | platform | — |
| `relationCount` can disagree with `model` in one direction the derivation cannot prevent: a `document_rows` declaration beside a non-empty target list makes the derived count non-zero and the declaration incoherent, so `assembleTombstone` refuses `record_storage_invalid` and the pipeline aborts. Correct, and a boot-time check would be better than a deletion-time one. | platform | — |
| The probe reads one CHECK on one column. Every other catalogued CHECK the contract widens has the same sharp edge and no probe, so this is one instance of a class — a general "does the live catalog admit what this binary emits" boot survey is the shape. | platform | — |
| The probe reads two of Postgres's deparse spellings and reports a third as `unreadable`, which mounts. `kernel-pg`'s `expression-render.ts` already sidesteps this class properly — it asks Postgres to deparse the *declared* text and compares renderings, so no regex is involved. A probe built on that would read any shape; it costs a savepoint per probe, which a boot check can afford. | platform | — |
| `no_durable_store` is unreachable from a stored proof (the deletion routes do not mount on `--store memory`), so it exists to keep the map total. Pinned, not served. | platform | — |

## References

- GDPR Article 17 (right to erasure); Article 12(3) (one-month response deadline).
- ADR-0329 (`content.v2`, the capability declaration), ADR-0331 and its addendum (`content.v3`, the
  retention claim), ADR-0350 (the boot-schema erasure and the Q1 this closes).
- ADR-0317 (attestation provenance), ADR-0323 (`scope_tampered`), ADR-0324 (the paging `sev1`),
  ADR-0328 (the deployment declares), ADR-0330 (a widening CHECK is manual), ADR-0334 (converting a
  run-time failure into a boot refusal), ADR-0288 (why a maintained list of flags is wrong).
