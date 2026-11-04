# ADR-0403: A loop that accepts a typed row and helpers that refuse it

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-04 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0373, ADR-0356, ADR-0362, ADR-0331, ADR-0307, ADR-0334 |

## Context

ADR-0373 lifted `read-rows.ts` into `kernel-pg` so that a multi-row read reports the row its
contract refuses and keeps the rest of the page. Its loop is generic in the **row** type, and that
ADR states why in the module itself:

> Generic in the **row** type as well as the record's, because a store that types its rows
> (`tx.query<Row>`) could not use this otherwise: a function parameter is contravariant, so an
> `interface Row` with no index signature is assignable to neither `Record<string, unknown>` nor a
> parameter of that type, and the first slice to meet it wrote a second copy of this loop rather
> than widen its own mapper.

The two identity helpers beside it did not follow. `textIdentity(row: Record<string, unknown>,
column: string)` and `numericIdentity` with the same first parameter — so the loop accepted a typed
row and its own identity helpers refused it. Measured under `tsc --strict` against the built
package, with a declared `interface InvoiceRow` carrying no index signature, which is the shape
ADR-0356 counts **40** of in this workspace:

```
textIdentity(row, "invoice_id")                                  TS2345  not assignable to Record<string, unknown>
readRows(rows, map, (r) => textIdentity(r, "invoice_id"), rep)   TS2345  ... same, through readRows' OWN identify
readRowsWithUnreadable(rows, map, (r) => textIdentity(r, ...))   TS2345  ... same
readRows(rows, map, (r) => rowKey(r.invoice_id), rep)            clean
```

Three refusals, and the middle one is the finding: the position the helpers exist to fill is the
`identify` callback of the primitive they ship beside, and a typed-row store could not put them
there. That leaves exactly two legal options — cast (`row as unknown as Record<string, unknown>`,
which is ADR-0362's annotation standing in for a check, and which also reinstates the second hazard
below), or write a value-taking helper of one's own.

`packages/access-reviews-runtime-pg/src/records.ts:33` took the second, and its own neighbouring
comment names the cause outright — *"contravariant, so no widening gets there"*:

```ts
export function rowKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
```

Its four reads are `tx.query<ItemRow>`, `<DecisionRow>`, `<CampaignRow>` and `<EvidenceRow>`, all
declared interfaces, so `rowKey` is the **forced** option rather than a preference — and
`deletion-request-store.ts:262` independently records that this predicate already had **four**
spellings before it.

### Two independent measurements reached the same forced choice from opposite ends

This was found twice in one session, by paths that did not know about each other.

Reading the already-migrated sites to establish the house pattern for ADR-0373's remaining backlog
turned up `rowKey` as an apparent second spelling of `textIdentity` — `scopeFilter`'s class
(ADR-0334), where the obvious remedy is convergence onto the primitive. **That reading is
backwards, and I held two wrong versions of it before measuring the contravariance**, which is
recorded here because each was plausible and only the measurement separated them: first *"converge
`rowKey` onto the primitive"*, refuted because the primitive refuses the typed row; then *"`rowKey`
is type-safe and `textIdentity` is not, so converge the other way"*, refuted because it reads a
symptom as a design.

Independently, an adversarial refuter over a seven-group measurement of ADR-0373's 42 remaining
sites reached `rowKey(row.id)` for three `marketplace-runtime-pg` sites — and got there by refusing
the obvious alternative as **harmful**. The measurement it audited had proposed changing
`interface InstallationRow` to `type InstallationRow = {...}` so that `textIdentity` could reach it,
and the refuter's verdict is the useful part:

> Harmful prescription. Taking it silently removes 36 reads (18 in `rowToInstallation`, 19 in
> `version-store`'s `rowToRecord`) from the one rule that checks a field is read from the column it
> names — in the two shapes this very migration touches.

That rule is ADR-0356's `pg-record-reads.ts`, which resolves a read's table by column-set
containment over declared `interface \w*Row` names. An `interface` → `type` change to satisfy a
helper's parameter would therefore have bought the helper at the price of a workspace rule's
coverage, silently, in the files being migrated.

So the forced choice is real, it is reachable from two directions, and both available answers are
bad: a cast defeats the type system, and a local helper is a fifth spelling of one predicate whose
convergence is the thing `read-rows.ts` exists to have done.

### The second hazard, which the same signature closes

Even where a cast makes the helper reachable, its `column: string` is unchecked. Measured, with the
runtime answers beside the compile results:

```
textIdentity(row, "item_id")              = "ari_x"
textIdentity(row, "itm_id")        TYPO   = null      COMPILES CLEAN
textIdentity(row, "reminder_count")       = null      COMPILES CLEAN  (numeric column, text helper)
numericIdentity(row, "item_id")           = null      COMPILES CLEAN  (text column, numeric helper)
rowKey(row.itm_id)                        = TS2551: Property 'itm_id' does not exist on type 'ItemRow'.
                                                     Did you mean 'item_id'?
```

The direction is what matters. All three silent failures answer `null`, and `UnreadableRow.identity`
documents `null` as *the row does not name one* — ADR-0331's distinction between a claim and a gap.
So a mistyped column name is **indistinguishable from the genuine claim**, and reports *not
identifiable* for a row that is. `read-rows.ts` already **stated** this cost rather than hiding it
(its loop's comment ends *"where the column name is a string nobody checked"*), so it is a declared
cost and not an unnoticed one. What changed is the population: accepted for 19 sites, and ADR-0373's
backlog applies it 42 more times.

## Decision

Both helpers become generic in the row, with the column constrained to its keys:

```ts
export function textIdentity<R extends object>(row: R, column: keyof R & string): string | null
export function numericIdentity<R extends object>(row: R, column: keyof R & string): string | null
```

The bodies do not change: `row[column]` is `R[keyof R & string]`, typed, with no cast.

`keyof R & string` is what makes both halves true at once, and the two arms are why:

- For `Record<string, unknown>` it collapses to **`string`**, so every existing call typechecks
  unchanged and stays exactly as permissive as before. That is honest rather than lax: a store with
  no declared row has nothing to check a column name against.
- For a declared row it accepts the row — `R extends object` needs no index signature — **and**
  requires the column to be one of its keys.

So the contravariance and the unchecked column name close together, and `rowKey`'s stated reason
expires: `textIdentity(row, "item_id")` on a typed row is now *stricter* than `rowKey(row.item_id)`,
which takes `unknown` and accepts any property, and it reads the same as the other 19 migrated
sites.

### Verified on four arms, with the no-op guarantee measured rather than assumed

| arm | shape | result |
|---|---|---|
| 1 | `Record<string, unknown>` — **all 14** existing call sites | compiles unchanged, still permissive |
| 2 | a declared `interface InvoiceRow` | **now accepted** — three `TS2345`s before |
| 3 | `textIdentity(typedRow, "invioce_id")` | **compile error**, and the `@ts-expect-error` is *consumed* |
| 4 | `readonly InvoiceRow[]`, as node-postgres hands rows back | compiles |

Arm 1 is not a hope. Every one of the 14 production call sites passes a `Record<string, unknown>`:
`actionIdentity`, `drillIdentity`, `snapshotIdentity`, `failoverIdentity`, `readOne`, the four
`sequence_number` reads in `forensics-pg`, both `tombstone_id` reads, the three `request_id` reads,
`definition_id`, and `audit-log-store`'s `id`. Diffstat: **2 files, 0 production call sites.**

### The one real cost, and why it clarifies

`keyof {} & string` is `never`, so the two test calls that pin *"the column is absent from the
row"* — `textIdentity({}, "id")` and `numericIdentity({}, "seq")` — stop compiling. Measured as
exactly those two and no others; every other shape the test passes (`{id: "x"}`, `{id: " "}`,
`{seq: 42}`, `{seq: "42"}`, `textIdentity({seq: 42}, "seq")`) is unchanged, so the behaviour table
the test pins is intact.

The repair is `textIdentity({} as Record<string, unknown>, "id")`, and it **says which arm the case
belongs to**: an absent column is reachable only where there is no declared row — a `SELECT` that
did not return it — and is impossible by the type on a declared one. That is the distinction the
change exists to draw, so making the test state it is the point rather than a concession.

### The fence lives in the typechecker, not in vitest

Arm 3 is pinned by a `@ts-expect-error` in `read-rows.test.ts`. Only
`tsc -p tsconfig.typecheck.json` evaluates it — vitest transpiles through esbuild without
typechecking, which is ADR-0307's whole subject — so the fence is real precisely because that ADR
put the tests back into a typechecked project. Mutation-checked both ways: correcting the typo
answers `src/read-rows.test.ts(357,5): error TS2578: Unused '@ts-expect-error' directive.` and exit
2, and the mutation was reversed by the same string replacement rather than by `git checkout --`,
since the worktree may hold another slice's work.

## Alternatives

**Converge `rowKey` onto `textIdentity` as it stood.** Refused by measurement: impossible. The
helper refuses `rowKey`'s callers' rows, which is why `rowKey` exists.

**Converge `textIdentity` onto `rowKey`'s value-taking shape.** Refused: it reads the symptom as the
design. `rowKey(value: unknown)` accepts any property of any type, so it is *weaker* than the
constrained form, and it moves the column name out of the helper where `pg-binding-names.ts` and
`pg-record-reads.ts` can see it as a column at all.

**Change the 40 row interfaces to type aliases** (the batch-7 measurement's own prescription).
Refused with the refuter's measurement: it removes 36 reads from `pg-record-reads.ts` in the two
shapes being migrated, buying a helper's parameter at the price of a workspace rule's coverage.

**Cast at each call site.** Refused: 42 casts, ADR-0362's class 42 times, and each one reinstates
the unchecked column name.

**Also filter the key by its value type**, with
`{ [K in keyof R]: R[K] extends string | null | undefined ? K : never }[keyof R] & string`, which
would close the numeric-column-through-the-text-helper hazard too. Refused **for now** and
deliberately not attempted: an interface typing a column `unknown` would be refused by it, and that
is the common shape among the 40. It wants measuring against all of them first, which is a
different increment.

**Leave it and let batch 7 write 9 local helpers.** Refused: nine sites of the 42 read a typed row,
so the backlog would have produced a sixth, seventh and eighth spelling of one predicate — in the
increment whose whole subject is that a lifted primitive beats a copy.

## Consequences

**Nothing in any deployment behaves differently.** The runtime bodies are untouched and verified
identical; this is a type-level change. 88 packages, build and typecheck clean, **21,249 tests**
green (21,248 before, plus the one new case).

**ADR-0373's backlog is now writable as the primitive intends.** The nine typed-row sites among the
42 take `textIdentity`/`numericIdentity` directly, with no cast, no new local helper and no change
to the row interfaces that `pg-record-reads.ts` resolves tables from.

**`rowKey` and `TypedRowRead` now carry expired reasons.** `access-reviews-runtime-pg`'s comment
*"contravariant, so no widening gets there"* became false with this change, and
`export type TypedRowRead<T> = RowRead<T>` is an alias whose own comment says the generic primitive
*"is what that copy's own comment said would retire it"*. Both should converge or state a new
reason; leaving them is leaving a false reason in the tree, which is this repository's most-found
documentation defect. Deliberately not done here: it is four reads in another package, and bundling
it would mix a primitive change with a consumer migration.

**The permissive arm is now explicit at two call sites** rather than implicit everywhere. That is
the intended direction, and it means a future reader can grep `as Record<string, unknown>` to find
the reads with no declared row.

**And one finding outside the subject, found by running the index generator rather than by
reading.** This ADR was drafted with a bullet-list header, and `generate-index.py`'s status parse is
`field("Status", "Proposed")` — a default, not a refusal — so it counted as **Proposed** with no
warning, and the only tell was that `398 records` moved while `Accepted` did not. That is register
P3.3's `pg-record-reads.ts` shape in the ADR tooling: *a fact a parser cannot read must come back as
unreadable, never as absent.* Measured over all 398 after the fix, **zero** carry a header this
generator cannot parse, so the mechanism is silent and has no other victim — the honest grade is a
hazard rather than a defect, and it is recorded in `CLAUDE.md`'s ADR section where a reader learns
how the index is produced. The generator could name an unparseable header instead of defaulting; it
is a two-line change and is not made here, because it belongs with whoever next touches that script
rather than bundled into a primitive's signature.

## Open questions

1. **The value-type-filtered key**, which would close the remaining two hazards (a numeric column
   through the text helper and the reverse, both of which compile on a typed row today and answer
   `null` for every row). It needs measuring against the 40 declared row interfaces first; an
   interface typing a column `unknown` is refused by it and that is the common shape.
2. **`rowKey`'s convergence**, above — and with it `TypedRowRead`, whose alias adds nothing now that
   the primitive is generic in its row. Four reads in `access-reviews-runtime-pg`.
3. **Nothing fences the symmetry itself.** The defect was that one function in a module was generic
   in its row and two beside it were not; no rule compares them. A test asserting that every
   exported helper in `read-rows.ts` taking a row takes it generically would be a narrow fence over
   one file, and whether that earns its place against the eight `strategy/` rules is undecided.
4. **The 14 existing call sites could now pass their declared row** where one exists, which would
   buy the typo check on them too. None declares a row interface today (`result.rows` is
   `Record<string, unknown>` in all 14), so this is a question about the stores rather than about
   the helpers, and it arrives whenever one of them types its query.
