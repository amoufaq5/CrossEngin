# ADR-0233: Retention JSON envelope two-level field naming separation

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.json-envelope.two-level-naming
- **Closes**: ADR-0224 future Q6 (result-level field naming unification
  documentation)
- **Related**: ADR-0224 (family-wide envelope conventions), ADR-0225
  (history envelope rename)

## Context

ADR-0224 codified the canonical JSON envelope shape conventions but
deferred (future Q6) rigorous documentation of the **two-level field
naming separation**: envelope-level fields echo operator INPUT (which
flags were used), while result-level fields contain the actual DATA
(diff output, history entries). These two levels intentionally use
DIFFERENT naming conventions, which has surprised operators reading the
JSON without understanding the distinction.

This ADR documents the separation rigorously and adds documentary tests
that enforce the structure, closing ADR-0224 Q6. No production code
changes — the current state is correct, just under-documented.

### The confusion this resolves

An operator running:
```
retention diff-history ID_A ID_B --kind-a opt_out_set --format=json
```
sees BOTH:
- `envelope.kindsA = ["opt_out_set"]` (what they asked for)
- `envelope.result.eventKindA = "opt_out_set"` (what event A actually is)

Without documentation, operators may wonder why the same concept appears
under two different names (`kindsA` vs `eventKindA`) at two nesting
levels. This ADR explains the intentional design.

## Decision

Document the two-level field naming separation as a canonical convention.
Add documentary tests verifying the structure across surfaces.

### The two levels

#### Level 1 — Envelope (operator INPUT echo)

Top-level envelope fields echo the operator's flag inputs. Naming derives
from **CLI flag names** (plural for multi-value, per ADR-0224):

| CLI flag | Envelope field | Meaning |
|----------|----------------|---------|
| `--kind X --kind Y` | `kinds: ["X", "Y"]` | "operator filtered/expected these kinds" |
| `--kind-a X` | `kindsA: ["X"]` | "operator's per-side A kind expectation" |
| `--actor-id Z` | `actorIds: ["Z"]` | "operator's actor filter/expectation" |
| `--system-only` | `systemOnly: true` | "operator requested system-only" |

These answer: **"what did the operator ask for?"**

#### Level 2 — Result (actual DATA)

Fields inside `result` (diff-history / diff-timeline) or `entries[]`
(history) contain the actual fetched data. Naming derives from the
**domain model / PG column names** (singular, reflecting the actual
record shape):

**diff-history `result`:**
| Result field | Meaning |
|--------------|---------|
| `idA` / `idB` | the two history-event IDs compared |
| `eventKindA` / `eventKindB` | event A's / event B's ACTUAL event_kind |
| `actorIdA` / `actorIdB` | event A's / event B's ACTUAL actor_id |
| `occurredAtA` / `occurredAtB` | timestamps |
| `fieldDiffs` | the field-by-field diff array |

**history `entries[]` (each `OptOutHistoryEntry`):**
| Entry field | Meaning |
|-------------|---------|
| `id` | the history row ID |
| `eventKind` | the ACTUAL event_kind |
| `actorId` | the ACTUAL actor_id |
| `tenantId` / `tableName` | the ACTUAL tenant / table |
| `occurredAt`, `prevState`, `nextState`, `attributes` | the ACTUAL data |

These answer: **"what did the query return?"**

### Why the naming differs intentionally

1. **Different semantic** — `kindsA` (envelope) is a tuple expectation
   ("event A should be one of these kinds"); `eventKindA` (result) is a
   scalar fact ("event A IS this kind"). Plural-vs-singular reflects
   tuple-vs-scalar.

2. **Different provenance** — envelope names track CLI flags (operator-
   facing vocabulary); result names track domain-model / PG columns
   (data-facing vocabulary).

3. **Path-disambiguation is a feature** — operators can distinguish "what
   I asked for" (`env.kindsA`) from "what I got" (`env.result.eventKindA`)
   purely by JSON path, without ambiguity.

4. **Stability** — envelope names evolve with CLI flag changes; result
   names evolve with the data model. Decoupling them means a CLI flag
   rename (e.g., ADR-0225's `eventKinds` → `kinds`) doesn't force a
   data-model field rename.

### Documentary tests

Add tests verifying the two-level structure holds:
- diff-history JSON has `env.kindsA` (envelope) AND
  `env.result.eventKindA` (result) at different nesting levels.
- history JSON has `env.kinds` (envelope) AND `env.entries[].eventKind`
  (entry) at different nesting levels.
- The names are intentionally different (envelope plural CLI-derived;
  result singular domain-derived).

These tests document + enforce the separation so future refactors don't
accidentally collapse the two levels.

## Rejected alternatives

1. **Unify the names (rename result `eventKindA` → `kindsA`)** — would
   conflate the scalar fact with the tuple expectation; loses the
   semantic distinction; breaks the data-model field naming.
2. **Unify the names (rename envelope `kindsA` → `eventKindA`)** —
   envelope echoes CLI flags; `--kind-a` → `eventKindA` would break the
   ADR-0224 flag-derived naming convention.
3. **Prefix envelope fields with `requested` (`requestedKindsA`)** —
   verbose; the nesting level (top-level vs `result.`) already
   disambiguates.
4. **Prefix result fields with `actual` (`actualEventKindA`)** — verbose;
   the `result.` nesting already disambiguates; would diverge from the
   adapter's `DiffHistoryEntriesResult` field names.
5. **Flatten the two levels into one** — operators would lose the
   "asked for vs got" distinction; the envelope's filter echo is
   valuable for debugging.
6. **Document only in code comments** — operators reading JSON output
   don't see code comments; an ADR + documentary tests are discoverable.
7. **Add a JSON Schema with descriptions** — heavier tooling; defer to
   ADR-0224 future Q (JSON Schema generation). This ADR is the prose
   reference.

## Future questions

1. **JSON Schema generation with field descriptions** — auto-generate a
   schema documenting both levels with `description` annotations. Defer —
   ADR-0224 future Q4 (separate tooling milestone).

2. **Result-level field naming for the new `summary` action** —
   `summary` buckets use `key` + `count` (generic) rather than dimension-
   specific names (`eventKind` / `tenantId`). This is intentional (the
   grouped dimension is dynamic); document if it causes confusion.
   Currently clear via the `groupBy` envelope field. Defer.

3. **Operator-facing documentation page** — a `docs/operator-guides/
   retention-json-output.md` walking through the two levels with
   examples. Defer — ADR + tests suffice for now; operator guide is a
   docs-site concern.

4. **Consistent `occurredAt` vs `occurred_at` casing** — envelope/result
   use camelCase (`occurredAt`); CSV/TSV use snake_case (`occurred_at`,
   matching PG columns). Document the format-specific casing convention.
   Defer — CSV snake_case is intentional (matches PG columns for
   spreadsheet operators); JSON camelCase is intentional (JS
   convention).

5. **Diff-timeline result entries naming** — timeline entries use
   `tenantSide` / `tenantLabel` / `tableLabel` (dispatch-specific) plus
   the standard `eventKind` / `actorId`. Document the dispatch-specific
   discriminator fields. Defer — covered by ADR-0227 CSV column docs.

6. **Versioned envelope shape for the two-level contract** — if the
   two-level structure ever needs to change, a version field would
   enable migration. Defer — no external consumers; structure is
   stable.

## Consequences

- **The two-level field naming separation is now documented** — operators
  reading JSON understand why `kindsA` (envelope) and `eventKindA`
  (result) coexist.
- **Test count: 9,280 → 9,284** (+4 net: documentary tests verifying the
  two-level structure on diff-history + history).
- **No production code changes** — the current state is correct; this
  milestone documents + enforces it.
- **Future refactors guarded** — documentary tests fail if a refactor
  accidentally collapses the two levels (e.g., renaming result
  `eventKindA` to match envelope `kindsA`).
- **Canonical reference for new surfaces** — when new retention actions
  add JSON output, they follow the two-level convention: envelope echoes
  operator input (CLI-flag-derived names); result/entries contain data
  (domain-model names).
- **Closes ADR-0224 Q6** — the last documentation gap from the envelope-
  conventions codification is now filled.
- **Summary action noted as a special case** — `summary` buckets use
  generic `key`/`count` (dynamic dimension) rather than dimension-
  specific result names; documented as intentional.
