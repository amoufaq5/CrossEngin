# ADR-0131: `incidents` CLI subcommand on workflow-worker (Phase 3 P2.22)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0130 (incident replayer), ADR-0123 (incident persistence sink), ADR-0106 (workflow-worker binary), ADR-0074 (crossengin-pg encrypt CLI — gate-on-drift pattern), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.22).

## Context

P2.21 (ADR-0130) gave `meta.incidents` a typed read+verify API
(`PostgresIncidentReplayer`), but it was only reachable in code — an operator
couldn't ask "which incidents are open?" or gate CI on "zero timeline drift"
from a shell. The `workflow-worker` binary had a single mode of operation: parse
flags → start the long-running poll loop. P2.22 adds an `incidents` subcommand
that surfaces the replayer as a one-shot operator query, mirroring how
`crossengin-pg encrypt --verify` (ADR-0074) exposes a coverage check that exits
non-zero on drift for CI gating.

## Decision

- **A subcommand split in the binary.** `workflow-worker incidents …` (i.e.
  `process.argv[2] === "incidents"`) routes to a one-shot query that *exits*;
  every other invocation is the unchanged long-running worker loop. No change to
  the default behavior or any existing flag.
- **`incidents-cli.ts` — pure parsing + formatting + a runner over an injected
  source.** `parseIncidentsArgs(argv)` (the slice after the verb) yields an
  `IncidentsCliOptions` for one of three commands:
  - **`open`** — list incidents still open (`listOpen`, status not in the
    terminal set), `[--limit]`.
  - **`period --from <iso> --to <iso>`** — list every incident declared in the
    window (`listForPeriod`).
  - **`verify --from <iso> --to <iso>`** — run the drift sweep (`bulkVerify` +
    `summarizeIncidentIssues`) and **exit 1 when any issue is found** (CI gate).
  `--format human|json` (default human), `--schema`, `--help`. Spaced + inline
  (`--limit=10`) forms; `CliUsageError` on misuse (exit 2), with `period`/
  `verify` requiring the `--from`/`--to` window.
- **`runIncidents(options, source, out)`** — dispatches the command against a
  structural `IncidentQuerySource` (which `PostgresIncidentReplayer` satisfies),
  writing the formatted result to an injected `out` sink and returning the exit
  code. Pure over its inputs — no DB/IO — so it's fully offline-tested with a
  fake source.
- **`executeIncidents(options, out?)` in `node.ts`** — the thin DB wiring: opens
  a `PgConnection` from the `PG*` env vars, builds a `PostgresIncidentReplayer`
  (honoring `--schema`), runs `runIncidents`, closes the connection in a
  `finally`, returns the exit code. The bin awaits it and `process.exit`s.

## Cross-cutting invariants enforced (by tests)

- **Parsing.** No command → help; `open --limit N --format json` (spaced +
  inline); `period`/`verify` require `--from`+`--to`; unknown command / format /
  argument → `CliUsageError`; custom `--schema` carried.
- **Formatting.** `formatIncidentList` renders one line per incident with the
  timeline kinds (and a `none` marker when empty); `formatVerifyReport` reports
  `OK — no timeline drift` when clean and lists each issue otherwise.
- **Runner.** `open`/`period` exit 0 and pass the limit/window through to the
  source; `verify` exits **0 when clean, 1 when drift is found**; `--format json`
  emits a parseable list (`open`/`period`) or `{summary, issues}` (`verify`).
- **End-to-end (manual smoke).** Against the local test DB, `incidents open`
  lists real rows with their timelines and `incidents verify` over a wide window
  surfaced two real `resolved_status_without_timeline_entry` drift rows left by
  pre-P2.19 test runs — the verifier catching genuine drift.

## Alternatives considered

- **A separate `incidents` binary.**
  - **Decision.** No — the worker already owns `meta.incidents` (sink +
    replayer) and connects with the right role; a subcommand reuses the env/wiring
    and keeps one deployable artifact.
- **Make `verify` always exit 0 and only print.**
  - **Decision.** No — the value is CI gating ("fail the build if any incident
    timeline drifted"), which needs a non-zero exit, exactly like
    `crossengin-pg encrypt --verify` (ADR-0074).
- **A gated PG integration test for the CLI path.**
  - **Decision.** Deferred — `runIncidents` is fully offline-tested over a fake
    source and `PostgresIncidentReplayer` is gated-tested (ADR-0130); the bin's
    `executeIncidents` wiring is thin and was smoke-proven against real PG. A
    gated CLI test would be marginal.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,574 offline tests + 26 gated
  real-Postgres integration tests** (15 worker + 11 serving; +16 offline; 0 new
  tables/columns/packages). The incident audit trail is now operable from the
  shell: `workflow-worker incidents open|period|verify [--format json]` — a live
  view, a window report, and a CI-gateable drift check.
- **The stale-worker incident loop is end-to-end operable** — declare/escalate/
  resolve (write) → list/period/verify (read) — all from one binary.
