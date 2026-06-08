# ADR-0157: SLO enforcement read API + `crossengin-slo` CLI (Phase 3 P2.46)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0061 (observability-runtime-pg — SLO enforcement persistence), ADR-0063 (latency enforcement persistence), ADR-0131 (incidents CLI subcommand — runner-over-source pattern), ADR-0151 (gateway-execution drift CI gate — bin + exit-1-on-drift), ADR-0140 (incident-response-pg query.ts), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.46).

## Context

M8.5/M8.7 (ADR-0061/0063) made `@crossengin/observability-runtime-pg` persist
every SLO enforcement decision to `meta.slo_enforcement_actions` (+ evaluation
snapshots to `meta.slo_evaluations` / `meta.slo_latency_evaluations`), with a
`SloEnforcementReplayer` exposing pure verify helpers
(`verifyEnforcementActionShape` / `verifyEnforcementHistory` /
`summarizeEnforcement`) and stores with `listForIncident` / `listRecent` /
`countSince`. But — unlike `@crossengin/incident-response-pg` (which has a
framework-neutral `runIncidents` runner + the `incidents` operator subcommand)
and `@crossengin/api-gateway-pg` (which has `runVerifyExecutions` + a
`crossengin-gateway-pg executions verify` bin) — there was no operator-facing
read+verify surface over the enforcement tables. An operator couldn't ask "what
did the SLO loop do recently?" / "summarize the breach decisions" / "gate CI on
enforcement-history drift" from a shell.

P2.46 closes that gap by mirroring the two existing runner-over-source patterns.

## Decision

- **`query.ts` — a framework-neutral runner + parser + formatters, pure over an
  injected source.** Mirrors `incident-response-pg`'s `query.ts` and
  `api-gateway-pg`'s `verify-runner.ts`.
  - **`SloQuerySource`** is the structural read surface the runner needs:
    `listActions({since?, limit?})` → `SloEnforcementActionRecord[]` and
    `verifyActions({since?, limit?})` → `DriftIssue[]`. A small adapter in the
    bin satisfies it from the existing store + the pure
    `verifyEnforcementHistory`.
  - **`parseSloArgs(argv)`** (the slice after the `slo` verb) yields an
    `SloCliOptions` for one of three commands:
    - **`actions`** — list recent enforcement actions (`--limit`, default 100;
      with `--since`, default 1000).
    - **`summary`** — the `summarizeEnforcement` rollup (total / opened / ongoing
      / recovered / paged + paged ratio).
    - **`verify`** — run `verifyEnforcementHistory` over the window and **exit 1
      when any drift is found** (the CI-gate contract).
    `--since <iso>` / `--limit <n>` / `--format human|json` (default human);
    spaced + inline (`--limit=10`) forms; a local `CliUsageError` on misuse
    (unknown command / bad format / non-positive limit / value-less flag).
  - **`runSloQuery(options, source, out)`** dispatches the command against the
    source, writes the formatted (or JSON) result to the injected `out`, and
    returns the exit code (`verify` → 1 on any drift, else 0; `actions`/`summary`
    always 0). Pure over its inputs — no DB/IO — so it's fully offline-tested with
    a fake source. `formatSloActions` / `formatSloSummary` / `formatSloVerify` are
    the human renderers.
- **`PostgresSloEnforcementActionStore.listSince(since, limit?)`** — a new windowed
  read (`WHERE occurred_at >= $1 ORDER BY occurred_at DESC LIMIT $2`) so the runner
  can scope to a window; `listRecent` covers the no-`--since` case.
- **`bin/crossengin-slo.ts`** — the thin DB wiring: a `slo <actions|summary|verify>`
  subcommand opens a `PgConnection` from the `PG*` env vars, builds the store + a
  `StoreSloQuerySource` adapter (load via `listSince`/`listRecent`, verify via
  `verifyEnforcementHistory`), runs `runSloQuery`, closes the connection in a
  `finally`, and `process.exit`s the returned code. `version` / `help` round it
  out. The package shifts `rootDir` to `.` (so `dist/src/index.js` +
  `dist/bin/crossengin-slo.js`), updates `main`/`types`/`exports` to `dist/src/…`,
  and adds the `bin` map — exactly as `api-gateway-pg` did for its bin (ADR-0151).
  Consumers import the package by name, so the `exports` shift is transparent.

## Cross-cutting invariants enforced (by tests)

- **Parsing.** `actions`/`summary`/`verify` accepted; bare `--help` → help with a
  default command; spaced + inline `--since`/`--limit`/`--format`; unknown command
  / bad format / non-positive limit / value-less `--since` → `CliUsageError`.
- **Runner.** `actions` lists (human one-line-per-action + a `none` marker when
  empty; JSON array); `summary` rolls up the decision counts (human + JSON object);
  `verify` exits **0 on a clean open→ongoing→recovered history, 1 on drift**
  (`ongoing_without_open` / `recovered_without_open`), JSON emits
  `{verifiedActions, issues}`; an empty table verifies clean (exit 0).
- **Bin (manual smoke).** `crossengin-slo help` / `version` print; `bogus` →
  exit 2; the `slo` path opens a conn (the gated suites already populate the
  enforcement tables, so a `slo verify --since 2000-01-01` over the test DB is a
  natural follow-on gate).

## Alternatives considered

- **A separate `slo` subcommand on `apps/operate-server` (which owns the SLO loop)
  instead of a package bin.**
  - **Decision.** No — the read surface belongs with the persistence layer
    (`observability-runtime-pg`), exactly as the incident read surface lives in
    `incident-response-pg` and the gateway-execution one in `api-gateway-pg`. A
    package bin is reusable by any deployment that persists enforcement, and the
    operate-server could still mirror it later (as it did for `incidents`,
    ADR-0143) over the same shared runner.
- **Make `verify` always exit 0 and only print.**
  - **Decision.** No — the value is CI gating ("fail the build on any drifted
    enforcement history"), which needs a non-zero exit, exactly like
    `crossengin-gateway-pg executions verify` (ADR-0151) and `crossengin-pg
    encrypt --verify` (ADR-0074).
- **A gated PG integration test for the CLI path.**
  - **Decision.** Deferred (kept offline-only) — `runSloQuery` is fully
    offline-tested over a fake source and the store/replayer are already
    gated-tested (ADR-0061); the bin's wiring is thin and smoke-proven. The
    operate-server SLO suite already populates these tables, so a gated `verify`
    over a wide window is a natural future CI gate without new test complexity.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables** (no new tables/columns/
  packages); `observability-runtime-pg`'s offline test count rises from 46 to 64
  (+18 in `query.test.ts`). The SLO enforcement audit trail is now operable from a
  shell: `crossengin-slo slo actions|summary|verify [--since <iso>] [--limit N]
  [--format json]` — a recent-action view, a decision rollup, and a CI-gateable
  enforcement-history drift check.
- **The persistence ↔ read+verify symmetry now holds for all three audit tables** —
  `meta.incidents` (incident-response-pg), `meta.gateway_pipeline_executions`
  (api-gateway-pg), and `meta.slo_enforcement_actions`
  (observability-runtime-pg) — each with a framework-neutral runner over a
  structural source and an exit-1-on-drift verify bin.
