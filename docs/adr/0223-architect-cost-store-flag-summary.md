# ADR-0223: `--cost-store` flag + month-to-date spend summary (Phase 3 P7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-29 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0222 (durable cost wiring), ADR-0221 (ai-architect-runtime-pg), ADR-0077 (P3 plan — P7) |

## Context

ADR-0222 made durable per-tenant cost ride along with `--persist` (the transcript flag), and the
session summary never surfaced the tenant's accumulated spend. Two small P7 niceties: let durable cost
be enabled on its own, and show the month-to-date total when it's tracked.

## Decision

- **`--cost-store` flag** (`architect-cli`, `commands.ts` + `cli.ts`). One Postgres connection now backs
  both the transcript and the cost store; **either** `--persist` **or** `--cost-store` opens it, so a
  deployment can persist per-tenant monthly Architect spend without also logging the transcript (and
  vice-versa). The error message names both flags. When the connection is up, the guard is seeded from
  the tenant's durable total and each turn's cost is written back (unchanged from ADR-0222).
- **Month-to-date spend in the session summary.** The end-of-session line is now built by a pure,
  exported `formatSessionSummary(turns, aggregateUsage, monthToDate)` — it appends
  `Tenant month-to-date spend: $<amount>` only when durable cost is active (`monthToDate` non-null; the
  guard's tenant total = the seeded month-to-date plus this session's turns). The `--format json`
  envelope gains a `tenantMonthlyDollars` field on the same condition. Without a cost store, the line is
  exactly as before.

## Consequences

- Cost governance is now an independent concern: `crossengin chat --cost-store` enforces + persists the
  per-tenant monthly ceiling with no transcript logging, and `--persist` keeps working (opening the same
  connection). An operator picks either or both.
- The operator sees where the tenant stands against its monthly budget at session end (human + JSON),
  turning the durable total into a visible number rather than a silent gate.
- Extracting `formatSessionSummary` as a pure helper makes the summary logic unit-testable (the
  Postgres-backed enable path stays offline-untestable, like `--persist`).
- 7,303 tests pass (+2: `formatSessionSummary` omits the spend line when untracked / appends the
  month-to-date when tracked). Full build + typecheck green.
- Follow-ups (still open): classify `propose_manifest_edit` against hard-refusal categories to fire the
  guard's `refuse` path; a monthly reset/rollover query.
