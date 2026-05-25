# ADR-0247: Retention summary `--bottom-per-group N`

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-25 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0242 (`--top-per-group`, future Q1), ADR-0238 (`--top`/`--min-count`), ADR-0235 (cross-tab) |

## Context

ADR-0242 added `--top-per-group N` to `retention summary` — a per-group
leaderboard for cross-tab grids that, within each primary group, keeps the N
highest-count sub-keys via a `ROW_NUMBER()` window. Its future Q1 asked for the
symmetric `--bottom-per-group N`: the N **lowest**-count sub-keys per primary
group. Operators want the long tail as often as the head — "the 3 least-active
actors per day", "the quietest event_kinds per tenant", "under-represented
categories in each cohort" — for anomaly detection, dead-cohort cleanup, and
coverage audits. Today that requires exporting the full cross-tab and sorting
client-side, which defeats the server-side window.

## Decision

Add `--bottom-per-group N` — the exact mirror of `--top-per-group`, ranking
**ascending** so rank 1 is the lowest-count sub-key in each primary group.

- **SQL.** The cross-tab windowed branch is parameterized by sort direction:
  `ROW_NUMBER() OVER (PARTITION BY <primary> ORDER BY COUNT(*) <dir>,
  <secondary> ASC)` with `<dir>` = `DESC` for `--top-per-group`, `ASC` for
  `--bottom-per-group`; outer `ORDER BY key ASC, count <dir>, sub_key ASC`. The
  secondary tiebreak stays `ASC` in both. `--top-per-group` with `DESC` produces
  byte-identical SQL to before, so its tests are untouched.
  `SummarizeOptOutHistoryInput` gains `bottomPerGroup?: number`;
  `topPerGroup` takes precedence if both are somehow set (CLI forbids it).
- **CLI rules** (mirror `--top-per-group`): positive integer (exit 2 on
  non-positive / non-integer); **requires `--then-by`** (no per-group concept
  without cross-tab; exit 2); **mutually exclusive with `--top`** (global vs.
  per-group limit) **and with `--top-per-group`** (opposite ranking directions);
  transitively incompatible with `--fill-gaps` (which forbids `--then-by`, so the
  `--then-by` precondition fires first — no separate check). Composes with
  `--min-count` (HAVING inside the subquery, before windowing).
- Bucket shape unchanged `{key, subKey, count}`; `totalCount` is the sum of the
  returned per-group bottom-N buckets. `--explain` echoes `bottomPerGroup` in the
  plan (input flag, not result envelope — matching `--top-per-group`).

## Alternatives considered

- **A global `--bottom N` (inverse of `--top`) instead.**
  - **Why not:** different feature (global lowest-count buckets); no `--bottom`
    exists yet and per-group is what Q1 asked for. Listed as a future Q.

- **Reuse `--top-per-group` with an `--order asc|desc` modifier.**
  - **Why not:** two orthogonal flags are clearer than an overloaded flag +
    modifier, and matches the existing single-purpose CLI style.

- **Allow `--top` + `--bottom-per-group` together.**
  - **Why not:** `--top` is a global count-DESC LIMIT, `--bottom-per-group` is a
    per-partition ascending window — composing them is ambiguous; exit 2.

- **Allow `--top-per-group` + `--bottom-per-group` (head + tail of each group).**
  - **Why not:** two windows in one query is a distinct feature with its own
    output shape; exit 2 now, listed as a future Q.

- **Separate adapter branch for bottom.**
  - **Why not:** the only difference is the sort direction; one parameterized
    branch (`<dir>`) keeps top/bottom in lockstep and avoids drift.

- **`--bottom-per-group` on single-dimension summaries.**
  - **Why not:** no per-group concept without `--then-by`; exit 2 (mirrors
    `--top-per-group`).

## Consequences

- **Positive:** the long tail of every cross-tab grid is now first-class, server-
  side; the summary action is fully symmetric (top and bottom per group).
- **Negative:** another mutual-exclusivity pair to reason about (`--top-per-group`
  vs `--bottom-per-group`), documented + tested.
- **Neutral:** `topPerGroup`/`bottomPerGroup` share one windowed code path.
- **Reversibility:** trivial — additive field + flag.

## Implementation notes

- Adapter (`packages/kernel-pg/src/trace-retention.ts`): `perGroupN =
  topPerGroup ?? bottomPerGroup`; `dir = topPerGroup !== undefined ? "DESC" :
  "ASC"`. HAVING (minCount) inside the subquery; `rn <= $N` outside.
- CLI (`apps/architect-cli/src/retention.ts`): parse + 3 guards (`--then-by`
  required, exclusive with `--top`, exclusive with `--top-per-group`); thread
  `bottomPerGroup`; echo in `--explain`. Help text in `cli.ts`.
- Tests: 6 adapter (ASC window, output order, `+minCount`, param order,
  `topPerGroup`-precedence-when-both, method buckets) + 7 CLI (thread, invalid,
  no-`--then-by`, `+--top`, `+--top-per-group`, `+--min-count`, `--explain`).
  Test count 9,381 → 9,394 (+13). Existing `--top-per-group` tests unchanged.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Global `--bottom N` (lowest-count buckets, inverse of `--top`) | platform | _deferred_ |
| `--top-per-group` + `--bottom-per-group` together (head + tail per group) | platform | _deferred_ |
| `RANK()` / `DENSE_RANK()` for tie-inclusive bottom-N (currently `ROW_NUMBER`) | platform | _deferred_ |
| Expose the `rn` rank column in output buckets | platform | _deferred_ |

## References

- ADR-0242 — `--top-per-group` (this closes its future Q1).
- ADR-0238 — `--top` / `--min-count`. ADR-0235 — cross-tab `--then-by`.
- `packages/kernel-pg/src/trace-retention.ts`, `apps/architect-cli/src/retention.ts`.
