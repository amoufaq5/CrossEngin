# ADR-0354: A declaration adjudicated by reading, and a writer that reads differently

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-10 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0353, ADR-0352, ADR-0350, ADR-0344, ADR-0336, ADR-0334, ADR-0333, ADR-0330, ADR-0288 |

## Context

ADR-0353 declared, for each of the **287** catalogued value-set CHECKs, which workspace domain
governs it, and `mirrors` asserts the two enumerate the same members in both directions. That is the
right assertion, and it is blind to the question this ADR asks.

A declaration says *which* domain governs a column. A member comparison cannot see which: two
constants spelling one domain are interchangeable to it. So a declaration adjudicated by reading —
which is how all 287 were written, and which 19 of them required, by reading which record each table
stores — can name the wrong symbol and pass. ADR-0353 recorded that as its own first open end, and
said the parameter-to-field link was *"invisible to a scan"*, the same wall `pg-column-coverage.ts`
stops at.

**That premise is false, and measuring it is most of this increment.** The link is in the source,
positionally, and the measurement that establishes it also establishes why three plausible ways of
reading it are wrong.

ADR-0353 also had the live evidence that the hazard is real, in the direction that matters:
`meta.deployments.environment` exactly equalled `@crossengin/feature-flags`' environment enum and so
read as accounted for while the record that table stores emits `@crossengin/deploy`'s. Exact set
equality was refused there as *unsound rather than imprecise* for precisely this reason. Nothing then
closed the loop.

## Decision

A seventh thing in `packages/testing/src/strategy/` — `pg-column-bindings.ts` — derives, for each
catalogued value-set column, the workspace **symbol** the SQL actually binds into it, and compares it
against the declared ref. Every step of the derivation is reported when it fails rather than skipped.

The chain, and the measurement behind each step:

1. **`INSERT INTO t (cols) VALUES (exprs)` maps column *i* to expression *i*.** Never a zip of the
   column list against the parameter array. `apps/operate-server/src/platform-users.ts` writes
   `VALUES ($4::uuid, $1, $2, $3, 'active')`: column order is not parameter order, and `status`
   arrives from a SQL literal rather than from any parameter at all. A zip reports
   `id ← params[0]` with nothing to say it is wrong.
2. **`$n` resolves to `params[n-1]`, where the array belongs to the `query(…)` call that *encloses*
   the statement** — or, when the SQL is assigned to a `const`, to the next call that passes *that
   identifier*. "The next query call" alone is wrong and measured wrong: for the common
   `tx.query(\`INSERT …\`, […])` the call opens *before* the statement it carries, so the next one
   belongs to another method, and 56 positions resolved against the wrong array.
3. **A spread in the parameter array refuses every position at or after it, and none before.** A
   spread's length is unknown, so it shifts everything downstream and nothing upstream; the split is
   exact. Without that rule `access_review_evidence.status` resolved to `evidence.acceptedAt`,
   because `...EVIDENCE_RATE_FIELDS.map(…)` sits at position 9 of that store's array and expands to
   six. This is ADR-0344's correspondence rule in a new place, with one difference worth stating: the
   prefix of a *short* array is not evidence, while the prefix of a *spread-bearing* one is, because
   a spread cannot move what precedes it.
4. **`receiver.property` resolves through the receiver's declared type; a bare identifier resolves
   through its own.** Two questions, not one: the first asks which type declares that field, the
   second what the identifier is. Collapsing them would mean looking for a field named after a
   variable.
5. **`(Type, field)` resolves over the four idioms this repo uses to type an enum field** —
   `field: z.enum(CONST)`, `field: z.enum([…])` (inline, nameable only as `XSchema.field`),
   `field: SomeEnumSchema` where that is `z.enum(CONST)`, and an `interface`/object-type field typed
   `(typeof CONST)[number]` — with `type X = z.infer<typeof XSchema>` as a hop. The first form is
   answered from `collectWorkspaceDomains`' own output rather than re-parsed, so there is **one
   reader** of that declaration.
6. **Both refs are canonicalised before comparison**, following a `schema_field` to the constant it
   is typed by and a re-export alias to its target. That is what gives a declaration the latitude
   ADR-0353's 29 schema-field refs need, without weakening the comparison back to a member test.

**Name resolution is the same four steps on both sides** — the same file, the same package, the
package the referencing file imports it from, then a workspace-unique match. This is the load-bearing
decision rather than a detail. The first measurement produced six "contradictions" and **five were
the measurement's own fault**: four were an imported constant attributed to the importing package,
and one was a bare-name map holding whichever `SeveritySchema` had been scanned last —
`incident-response`'s `sev1..sev5` against `observability`'s `P0..P3`, which would have made the
single most alarming-looking finding of the run an artefact. A declared ref resolved one way and a
bound ref resolved another is not a comparison.

### What it found

**One finding, and it is the open end's exact predicate.** `apps/operate-server` spelled one
two-member domain twice: `MANIFEST_PROPOSAL_SOURCES` in `tenant-manifests.ts`, which owns
`meta.operate_tenant_manifests` and the records it stores, **module-private**; and
`AI_MANIFEST_SOURCES` in `ai-design-routes.ts`, exported. The writer binds the private one. A ref can
only name something a package exports, so the declaration named the other — and because the two
enumerate the same members, `mirrors` passed.

So the finding is reported as `binding_domain_unexported` rather than `ref_contradicts_binding`, and
fires **instead of** it, on ADR-0334's rule that naming a remedy which would not work is worse than
naming none: while the bound constant is private no declaration can be right, so "the ref
contradicts the binding" sends the reader to re-adjudicate a declaration that has no right answer.
The remedy is a different sentence — export it, or converge the two spellings.

The fix converges them, in the direction the catalog decides: `tenant-manifests.ts` exports
`MANIFEST_PROPOSAL_SOURCES`, and `ai-design-routes.ts` imports it rather than declaring a second
`as const`. Its `AI_MANIFEST_STATUSES` was the same duplication one column across — the same three
members as `MANIFEST_PROPOSAL_STATUSES` — and is converged with it, because leaving the second half
is the half-sweep this repo keeps finding. `AiManifestRecordLike` stays a structural seam on purpose:
this module must not depend on the concrete store. **A value set is not a structure.**

### Three checks that need no declaration at all

- **A SQL literal written into a value-set column is checked against its CHECK.** 23 of them, all
  admitted. `auditColumnDefaults`' sibling: no declaration can be wrong about it, so none is asked
  for. It is the offline mirror of ADR-0352's `check-admission.ts`, which asks a live database the
  converse question.
- **A field typed as an inline literal union is checked as a subset**, since members are readable
  where no symbol is nameable. Subset and not equality, because one write path need not cover the
  whole domain: `job-engine.ts` binds `"failed" | "dead-lettered"` into a six-member status column
  and is right to.
- **A field typed `string` is `unconstrained`** — reported, and declared in
  `UNCONSTRAINED_BINDINGS` with its consequence. Four today, all on
  `meta.notification_dispatches`, whose `DispatchInput` is `apps/operate-server`'s own persistence
  shape with `channel`, `category`, `priority` and `status` all `string`. Its comment says the
  decoupling is deliberate; the cost is that nothing in the process validates those four values, so
  a producer bug is a `23514` after the planner has acted.

### Measured

**66 of the 287** value-set columns are checked against what their writer actually binds, and **83**
bindings among them have their declared ref confirmed against the bound symbol — more bindings than
columns, because a column written by two statements is checked twice. **164 of the 287 sit on tables
`pg-storeless-tables.ts` already declares writerless**, which bounds how high that can go: a table
with no store has nothing to bind, so this rule's silence there is that rule's finding and not a
second one — asserted, in both directions, by a test.

## Alternatives considered

- **Option A: zip the column list against the parameter array.**
  - **Pros:** trivial; would have covered 45 of 73 inserts on the first attempt.
  - **Cons:** unsound, and silently so.
  - **Why not:** `platform-users.ts` disproves it in one line — `VALUES ($4::uuid, $1, $2, $3,
    'active')`. 28 of 73 inserts misalign, and a misalignment is a confident wrong answer about which
    symbol a column is bound from. Reading the `VALUES` list costs one bracket match.

- **Option B: match on the *name* — does any schema field named like the bound property carry the
  declared domain?**
  - **Pros:** needs no receiver type at all, so it covers the 15 bindings whose receiver the module
    annotates nowhere.
  - **Cons:** too weak for the case the rule exists for.
  - **Why not:** `status` is a field on 51 schemas (ADR-0353 measured it). The declared domain would
    almost always type *some* field of the right name, so ADR-0353's own
    `meta.deployments.environment` defect — a same-named field in the wrong package — would pass.

- **Option C: a `typescript` compiler pass, for real type resolution.**
  - **Pros:** correct by construction; would resolve the 15 untyped receivers and the two
    `JobRunDisposition`-shaped narrowings.
  - **Cons:** the measurement ADR-0337 already did for `pg-unreachable-stores.ts` applies unchanged.
  - **Why not:** 26 s and 1.2 GB for 1,026 roots inside a 3-second suite; one program cannot hold 90
    packages; and decisively there is no `paths` mapping, so cross-package symbols resolve into
    `dist/*.d.ts` — green only after a build, and against a stale `dist`, green on the previous
    build. ADR-0337 put that refusal in the module so nobody attempts it a third time; this is the
    second place it would have been attempted.

- **Option D: put the binding audit inside `pg-value-set-domains.ts`.**
  - **Pros:** one module holds the declarations and both checks over them.
  - **Cons:** that module is 1,400 lines and landed one increment ago with 61 tests; the binding
    scan has nothing to do with reading the catalog.
  - **Why not:** the overlap is exactly one thing — what `XSchema.field` is typed by — and that is
    shared as **data** (`WorkspaceDomain.typedBy`, resolved by the existing `lookup`) rather than by
    moving code. One reader of that declaration, 15 lines of diff to the module that landed last.

- **Option E: declare every unresolved binding per column rather than per `(file, table, kind)`.**
  - **Pros:** finer; a column that stops resolving is named.
  - **Cons:** 64 declarations of mostly identical prose.
  - **Why not:** `PG_SCAN_GAPS`' grain is `(file, table, kind)` and it is the same question about the
    same statements; 28 entries, and the per-column fact is already in the audit's own output.

- **Option F: fold `binding_domain_unexported` into `ref_contradicts_binding`.**
  - **Pros:** one finding kind for one condition.
  - **Cons:** one remedy for two problems, and the wrong one for the live case.
  - **Why not:** ADR-0334's rule. A contradiction tells the reader to re-adjudicate the declaration;
    while the bound constant is private there is nothing to adjudicate to.

## Consequences

- **Positive.** The 287 declarations are no longer adjudicated only by reading: 66 columns are
  checked against the symbol their writer binds, and a ref pointed at a coincidentally-equal domain
  is a test failure. Three further checks need no declaration: a refused literal, an inline union exceeding
  its CHECK, and an unconstrained binding. One duplicate-spelling pair is gone from
  `apps/operate-server`, and `WorkspaceDomain.typedBy` makes the two legal spellings of a domain
  comparable for anything that needs it later.
- **Negative.** The type resolution is four idioms wide and bounded by convention, not by the
  compiler, so the coverage figure is a lower bound that moves when a store is rewritten. Two
  declaration lists (`BINDING_GAPS`, `UNCONSTRAINED_BINDINGS`) join the five that already exist in
  this directory. The sixth and seventh rules now both read the whole workspace from disk, which is
  ~1.3 s of the suite.
- **Neutral.** The audit reports and never refuses *the code*: an unconstrained binding is declared,
  not fixed, following `check-admission.ts`' choice. What it refuses is a stale or absent
  **declaration**.
- **Reversibility.** The rule is a test and the declarations are data; deleting the module costs
  nothing but the fence. The `tenant-manifests.ts`/`ai-design-routes.ts` convergence is a visibility
  change plus a rename with no behaviour in it, trivially revertible.

## Implementation notes

- `pg-column-bindings.ts` holds the extraction (`extractColumnBindings`, `scanColumnBindings`), the
  type index (`collectStoreTypes`), the resolution (`resolveBoundDomain`, `resolveLocalDomain`,
  `canonicalDomainRef`, `pickByOrigin`), the two declaration lists, and the audit
  (`auditColumnBindings`, `summarizeColumnBindings`). It imports `matchBracket`, `splitTopLevel`,
  `substituteBindings`, `clauseOf`, `untilTemplateEnd`, `normalizeSource`, `stripComments` and the
  module-binding resolver from `pg-column-coverage.ts`, so one scanner's interpolation resolution
  serves both rules.
- `WorkspaceDomain.typedBy` is the only change to `pg-value-set-domains.ts`: the ref of the constant
  a `schema_field`, `schema_enum` or **alias** domain references, `null` for a constant with members
  of its own. Resolved through the existing `lookup`, and recorded even when the target is not
  exported — a private constant types a schema's field perfectly well, and hiding that is what would
  make the live finding invisible.
- `objectLiteralFields` replaces an off-by-one that cost real coverage: skipping a string literal and
  then letting the loop increment again swallowed the `)` after it, so the depth counter never
  returned to zero and a schema's field list truncated at the first `.default("…")`. It hid
  `ChainCheckpointSchema.algorithm` and `CreateTenantInputSchema.region`, among 793 fields.
- Two annotation patterns, and the second is not optional: `job-engine.ts` declares
  `disposition: JobRunDisposition` (six members) and then passes a parameter annotated
  `"failed" | "dead-lettered"`. Reading past the union to the named type claims four members the
  column does not admit are bound there. A generic other than `Readonly<T>`, an array, and a **call**
  are all rejected rather than read as `T` — `candidate: Record<string, unknown>` would otherwise be
  a type named `Record`, and `reviewStatus: String(row["x"])` one named `String`.
- `sqlConstants` takes the whole statement span rather than stopping at the first closing backtick,
  because `timer-store.ts` writes `const sql = cond ? \`INSERT …\` : \`INSERT …\``. Widening is safe
  because the following call still has to pass that identifier.
- The floor is on the **checked** side (`checked >= 55`, `agreeing >= 70`), one-sided for
  `pg-unreachable-stores.ts`' reason: an extractor that stopped matching would check nothing and sail
  past a ceiling.
- The two indexes are cross-checked rather than assumed equal: for every `schema_field` domain with a
  nameable `typedBy`, the target resolves to a domain with the **same members** (400+ comparisons).
  They answer different questions about one declaration — members, and which symbol it names — so a
  shared parser would not by itself make them agree.
- Controls: a synthetic pair of identical-membership constants in two packages fires
  `ref_contradicts_binding`; a private contract fires `binding_domain_unexported`; and on the **real
  tree**, re-pointing `operate_tenant_manifests.source` at the status domain beside it fires exactly
  one finding on exactly that column.

### Verified live

On PG 16.13, as a **non-owner** role, against the full catalog applied to a throwaway cluster — see
the measurements appended to the commit. The change itself carries no SQL and no behaviour; what the
live run establishes is that the converged constant's two members are what
`meta.operate_tenant_manifests.source` admits, through the real server and the real route.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Nothing resolves the 15 bindings whose receiver the module annotates nowhere (`p.status` in an arrow, `att.kind` from a destructure). Local inference would, and is Option C. | Platform | _open_ |
| The declared ref is compared against the symbol, and nothing compares it against the **parameter position** a store binds — a store writing `record.kind` into the `status` column passes both this rule and `pg-column-coverage.ts`. Name-to-column agreement is measurable and legitimately violated often enough that the threshold needs deciding. | Platform | _open_ |
| 164 of the 287 columns are unreachable because their table has no writer. Each one becomes checkable the moment a store lands, and nothing says so at the time — the inverse of `table_declared_storeless`. | Platform | _open_ |
| `UNCONSTRAINED_BINDINGS` describes a real weakness and the rule only reports it. Typing `DispatchInput`'s four fields against the notification contract is the fix, and it is a decision about whether that store may depend on it. | Platform | _open_ |
| `collectStoreTypes` and `collectWorkspaceDomains` both walk every source. One `workspace-symbol-index.ts`, as `workspace-sql-scan.ts` is for SQL, would halve that and remove the need for the cross-check. | Platform | _open_ |
| A `conflict_update` assignment that is neither `$n` nor `EXCLUDED.col` — `status = CASE WHEN …` in `digest-store.ts` — is a value the *database* decides from the row, which is a third provenance beside a parameter and a literal and is reported as neither. | Platform | _open_ |

## References

- ADR-0353 — the 287 declarations, and this ADR's own open end.
- ADR-0352 — `check-admission.ts`, the live converse of the literal check.
- ADR-0344 — the correspondence rule a positional answer set has to satisfy.
- ADR-0337 — the measured refusal of a compiler-API pass, reached for the second time here.
- ADR-0336 — `pg-unreachable-stores.ts`, and the one-sided-floor idiom.
- ADR-0334 — naming a remedy that would not work is worse than naming none; and the re-export of the
  tenant lifecycle enum that `typedBy` exists to keep from reading as a second spelling.
- ADR-0333 — `pg-column-coverage.ts`, whose scanner this one borrows and whose boundary it extends.
