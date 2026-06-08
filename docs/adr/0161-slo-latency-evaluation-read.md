# ADR-0161: SLO latency evaluations in the `crossengin-slo` read API + CLI (Phase 3 P2.49)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0157 (SLO enforcement read API + `crossengin-slo` CLI — the runner this extends), ADR-0063 (latency enforcement persistence — `meta.slo_latency_evaluations`), ADR-0061 (observability-runtime-pg persistence), ADR-0151 (gateway-execution bin pattern), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.49).

## Context

P2.46 (ADR-0157) gave `@crossengin/observability-runtime-pg` an operator
read+verify surface — `query.ts` (`parseSloArgs` + `runSloQuery` over a
structural `SloQuerySource`) + the `crossengin-slo` bin with `slo
actions|summary|verify`, all over `meta.slo_enforcement_actions` and the
enforcement-history drift check. But M8.7 (ADR-0063) also persists **latency**
verdict snapshots to a *separate* table, `meta.slo_latency_evaluations`
(`PostgresSloLatencyEvaluationStore`, `slle_` ids, `worst_percentile` /
`sample_count` / `breaches` JSONB), and those rows had **no operator read
surface**. An operator could ask "what enforcement actions fired?" but not "what
latency evaluations were recorded — which surfaces, which percentile breached,
how many samples?". P2.49 adds that, mirroring the existing `actions`/`summary`/
`verify` shape exactly.

## Decision

- **`PostgresSloLatencyEvaluationStore.listSince(since, limit?)`** — a new
  windowed read (`WHERE evaluated_at >= $1 ORDER BY evaluated_at DESC LIMIT $2`,
  default limit 1000, positive-limit guard), the parity sibling of the
  `PostgresSloEnforcementActionStore.listSince` P2.46 added. A `rowToRecord`
  mapper coerces the row back into a schema-validated `SloLatencyEvaluationRecord`
  (lenient `breaches` parse — accepts an array or a JSON-string column; a `Date`
  `evaluated_at` → ISO string). `listRecent`/`countBreachesSince` already existed
  but didn't cover a windowed list; `listSince` is the thin addition.
- **`query.ts` gains a `latency` command.** `SloCommand` widens to
  `actions|summary|verify|latency`. `SloQuerySource` gains a
  `listLatencyEvaluations({since?, limit?})` method (the store satisfies it via a
  bin adapter). `runSloQuery`'s `latency` branch lists recent latency evaluations
  (id, surface, worst percentile, sample count, breach count, evaluated_at) in
  human (one line per evaluation, `none` when empty, a `BREACH(n)`/`ok` marker)
  or JSON form, **always exit 0** (a read, not a gate — `verify` keeps the only
  non-zero exit). `formatSloLatency` is the human renderer.
  `actions`/`summary`/`verify` are unchanged.
- **`parseSloArgs`** accepts `latency` as a fourth command word (else
  `CliUsageError`, message widened to `actions|summary|verify|latency`). The
  `--since`/`--limit`/`--format` flags carry over unchanged.
- **`bin/crossengin-slo.ts`** builds a `PostgresSloLatencyEvaluationStore`
  alongside the enforcement-action store and threads both into the
  `StoreSloQuerySource` adapter, so `slo latency` works end-to-end. Without
  `--since`, the adapter scopes from epoch (`new Date(0)`), so `slo latency`
  alone lists the most recent rows up to `--limit`. The help text gains the
  `slo latency` line; the flag descriptions read "rows" (now covering both
  tables).

## Cross-cutting invariants enforced (by tests)

- **Parsing.** `latency` is accepted as a command; `latency --since/--limit/
  --format` resolve like the other commands. (`actions`/`summary`/`verify` parse
  tests unchanged.)
- **Runner.** `latency` lists in human form (surface + percentile + sample count
  + `BREACH(n)` marker; a `none` marker when empty) and as a JSON array; always
  exit 0. The fake `SloQuerySource` now implements `listLatencyEvaluations`.
- **Store.** `listSince` issues the windowed `SELECT … WHERE evaluated_at >= $1
  ORDER BY evaluated_at DESC LIMIT $2` (bound since + limit), maps a row into a
  validated record, parses a JSON-string `breaches` column, and rejects a
  non-positive limit.

## Alternatives considered

- **Fold latency into the existing `actions` command (one combined list).**
  - **Decision.** No — the two are distinct tables with distinct shapes
    (enforcement actions carry decision/incident/kill-switch/paging; latency
    evaluations carry percentile/sample-count/breaches). A separate `latency`
    command keeps each list clean and mirrors the table separation, exactly as
    M8.7 kept the latency evaluations in their own table rather than overloading
    the actions table.
- **Add a `verify`-style drift gate for latency evaluations.**
  - **Decision.** Deferred — latency evaluations are append-only snapshots with
    no cross-row history invariant to check (unlike the enforcement-action
    open→ongoing→recovered timeline). `latency` is a read; the
    enforcement-history `verify` gate is unchanged and remains the only non-zero
    exit.
- **A gated PG integration test for the `slo latency` path.**
  - **Decision.** Deferred (offline-only) — `runSloQuery` is fully offline-tested
    over a fake source and the store is offline-tested with a mock connection;
    the bin wiring is thin and help-smoke-proven. The operate-server SLO suite
    already populates `meta.slo_latency_evaluations` under `--slo-persist`, so a
    gated `slo latency --since 2000-01-01` over the test DB is a natural future
    follow-on.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables** (no new tables/columns/
  packages); `observability-runtime-pg`'s offline test count rises by 8 (+4 in
  `query.test.ts` for the `latency` parse + run cases, +4 in
  `latency-evaluation-store.test.ts` for `listSince`). The latency verdict
  snapshots persisted by M8.7 are now operable from a shell: `crossengin-slo slo
  latency [--since <iso>] [--limit N] [--format json]`.
- **The full SLO audit surface — availability *and* latency — is now readable
  from one bin.** `slo actions|summary|verify` cover the enforcement-action
  stream and its drift gate; `slo latency` covers the latency-evaluation
  snapshots — both over the same `SloQuerySource` runner and the same `PG*` env
  wiring.
