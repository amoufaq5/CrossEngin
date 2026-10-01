# ADR-0297: Storing how a recovery ended, and one way to declare (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0293 (SLO incident persistence), ADR-0294 (open-episode hydration), ADR-0288 (integrity incident escalation) |

## Context

Two follow-ups from ADR-0293, both small and both about the same thing — the same question being
answered in two places, or not answered at all:

- *"A recovery's `closeOut` is logged, not stored. `slo_enforcement_actions` has no column for it, so
  'was the recovery clean?' is answerable from `meta.incidents.status` but not from the action row."*
- *"`IntegrityEscalator` still has its own declaration path — a per-process counter plus
  `planIncidentDeclaration` — now that a shared `IncidentDeclarer` exists. Its `disposition`
  vocabulary and `IncidentCloseOut` overlap closely enough that the two should probably become one."*

ADR-0294 added a third: *"The replayer does not check the one-open-per-signal invariant."*

## Decision

- **`slo_enforcement_actions` gains `close_out`, and null means "not a recovery".** Nullable `TEXT`
  with a four-value CHECK. The pairing is enforced in the record schema, not the database: `closeOut`
  must be set **iff** `decision === 'recovered'`, refused in both directions. A CHECK constraint
  cannot see two columns agree, and without the rule the column would be decorative — a `breach_opened`
  row carrying a close-out would be accepted and mean nothing.
- **The vocabulary is imported, not re-declared.** `INCIDENT_CLOSE_OUTS` comes from
  `incident-response-runtime`. A second copy of four strings is a second thing to drift.
- **`IntegrityEscalator` takes an `IncidentDeclarer`, and its ledger type is deleted.** The app module
  no longer knows the store exists. `CountingIncidentDeclarer` replaces both roles the bespoke counter
  played: the default when nothing is injected, **and** the fallback when an injected declarer throws
  — which is how "page even when the record could not be persisted" survives, and is the wrapping
  declarer ADR-0293 described without building.
- **`disposition` is derived from `IncidentCloseOut`, not replaced by it.** Three values pass through;
  `failed` maps to `declared`, which is what the old `catch { return "declared" }` meant. What stays
  distinct is the reason the two types do not merge: **`declared` is the disposition of an *open*
  incident**, reported on `opened` and `ongoing`, and no close-out value can express it, because a
  close-out answers what became of a *recovery*. `formatIntegrityEscalation`'s strings are unchanged,
  since earlier ADRs' live verification quotes them.
- **One new replayer drift kind in each layer, and no more.** `recovered_close_out_failed` in
  `observability-runtime-pg` — a recovery that could not close its incident, so the row is still open
  and nobody was told. `duplicate_open_for_signal` in `incident-response-runtime-pg`, grouping exactly
  as the partial unique index does: non-null key, open status only, so two *closed* episodes of one
  signal are correct and not reported.

## Consequences

- **Verified live** against a real Postgres: a full episode driven through the scheduler left
  `INC-2026-0002 | recovered | cancelled` on the action row, and a query confirmed **no** non-recovery
  row anywhere carried a close-out.
- The integrity escalator's whole behaviour is pinned unchanged by its existing suite plus eight new
  tests: declare-once-per-episode, adopt-after-restart without re-paging, cancel only if untriaged,
  page on a failed declaration, audit row for a tenant scope and `audited: false` for the platform.
- `node.ts` is a two-line swap — `PostgresIncidentDeclarer` for `PersistentIncidentEngine` — because
  the declarer already wraps the engine.
- The hazard ADR-0294 named bit again and was handled deliberately: **test files are not typechecked**,
  so replacing the escalator's injected type could have left every test double silently unsatisfying
  the interface while the suite stayed green. Every path now asserts a recorded *call* — `findOpen`
  was asked, `closeOut` was asked with this reason, `declare` was never reached on the fallback path —
  rather than asserting that nothing threw.
- +15 tests in `observability-runtime-pg`, +8 in `operate-server`, +10 in the incident replayer.

## Follow-ups

- **`planIntegrityEscalation` is now unused** inside its own module and nothing else in the repo calls
  it. It is still exported and still tested. Deleting public API is a separate decision; the only thing
  it offers over the seam is building record and page together for a caller that chose its own id.
- **A `failed` close-out is still not retried.** Hydration partly covers it — the row stays open, so
  the next breach of that signal adopts it rather than declaring a second — but nothing ever cancels it
  without a human.
- **The close-out is stored but not queried.** Nothing reads `close_out` except the replayer; "show me
  every recovery that did not close cleanly" wants a route, like every other record in this repo.
