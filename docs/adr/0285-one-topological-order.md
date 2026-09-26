# ADR-0285: One topological order, and it is the store's (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-26 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0284 (removing the dead entity emitter), ADR-0283 (emitter reconciliation) |

## Context

ADR-0284 deleted the kernel's entity emitter and left one follow-up: `topologicalSort`
(kernel) and `topologicalEntityOrder` (`operate-runtime-pg`) compute the same entity
dependency order by different routes. It recorded that the kernel's was "now unused and is
the better home".

**That claim was wrong, and this ADR corrects it.** It was made from the fact that both
functions topologically order entities by their references, without comparing what they do
at the edges. They are not interchangeable:

| | `topologicalSort` (kernel) | `topologicalEntityOrder` (store) |
|---|---|---|
| Algorithm | DFS | Kahn |
| On a reference cycle | **throws `CycleDetectedError`** | appends the remaining nodes, no error |
| Reference graph read from | `entity.fields` | `plan.columns` (trait fields included) |
| In / out | `Entity[]` → `Entity[]` | plan map → entity names |

The cycle behaviour is the decisive difference. `topologicalSort` threw because the emitter
it served put foreign keys **inline in `CREATE TABLE`**, where a cycle genuinely cannot be
applied in any order. `ensureSchema` adds foreign keys in a **second pass** once every table
exists, so two entities that reference each other apply cleanly — and refusing them would
reject a legal manifest. Throwing was correct only for the code ADR-0284 deleted.

The graph source matters too. A trait's `fields` is a plain `FieldSchema` array, so a
**trait can contribute a `reference` field**. Since ADR-0283 the column plan expands traits,
so `plan.columns` sees that reference and orders the tables by it; reading the entity's own
`fields` alone would see no edge and could create the referencing table first.

## Decision

- **Delete `topologicalSort`**, its test module and the now-orphaned
  `CycleDetectedError`. It had zero callers, its throw-on-cycle contract matched no
  remaining consumer, and leaving it invites a future caller to get a spurious error on a
  manifest the serving store accepts.
- **`topologicalEntityOrder` is the single implementation.** It is not promoted into the
  kernel: it is keyed on `EntityTablePlan`, an `operate-runtime-pg` type, and lives beside
  the `ensureSchema` two-pass FK application that its cycle tolerance depends on. Moving it
  would separate the behaviour from the invariant that justifies it.
- **Both properties are pinned by comment and test**, so neither is re-"fixed" later by
  someone who reads a cycle as a bug: why a cycle is tolerated, and that the graph is read
  from the plan rather than the entity.

## Consequences

- `CycleDetectedError` is gone from `@crossengin/kernel`'s public API, along with
  `topologicalSort`. No in-repo consumer existed.
- **−7 tests net** (kernel **568 → 560**, −8; operate-runtime-pg **167 → 168**, +1;
  workspace **9,285 → 9,278**). The deleted tests covered deleted behaviour. The added one
  pins the trait-supplied-reference ordering the surviving implementation gets right and the
  deleted one would have missed.
- A reference cycle between two entities is now unambiguously supported end to end: the
  order function tolerates it, `ensureSchema`'s second pass applies its FKs, and a test
  states why.
- This closes the last open item from the ADR-0283 / 0284 thread. `@crossengin/kernel/ddl`
  and `manifest/` no longer contain any DDL-ordering or DDL-emitting code for tenant
  entities; that responsibility sits wholly in `operate-runtime-pg`.
- Full workspace build + typecheck + test green.
- **Lesson recorded:** ADR-0284 called one of two duplicate implementations "the better
  home" on the strength of their shared purpose. The duplication was real but the
  implementations were not equivalent, and the one that looked canonical was the one whose
  contract had expired. Comparing edge-case behaviour — not just signatures and intent —
  is what decides which of two rivals to keep.
