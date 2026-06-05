# ADR-0134: incidents ack/mitigate write CLI commands (Phase 3 P2.25)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0133 (ack/mitigate milestones), ADR-0131 (incidents CLI), ADR-0123 (incident persistence sink), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.25).

## Context

P2.24 (ADR-0133) added `PostgresIncidentSink.acknowledge` / `.mitigate` (and the
MTTA/MTTM metrics that consume the milestones they record), but the methods were
only reachable in code — an operator couldn't actually acknowledge or mitigate an
incident from the shell, so the MTTA/MTTM metrics had no operator-driven data
source. The `incidents` subcommand (ADR-0131) was read-only (`open` / `period` /
`verify` / `metrics`). P2.25 adds the two write commands that close the loop.

## Decision

- **`incidents ack <incident-id> [--actor <uuid>]`** and **`incidents mitigate
  <incident-id> [--actor <uuid>]`** — two new `incidents` subcommands taking a
  **positional incident id** and an optional `--actor` (the actorUserId stamped on
  the milestone entry; default `DEFAULT_INCIDENT_ACTOR`, the system actor). Both
  honor `--schema`.
- **Parser.** `parseIncidentsArgs` gained `incidentId` + `actor`, a positional
  capture (the first non-flag arg for a write command), and validation that
  `ack`/`mitigate` require an incident id (else `CliUsageError` → exit 2).
- **`runIncidentWrite(options, sink, out)`** — dispatches against a structural
  `IncidentWriteSink` (`{ acknowledge, mitigate }`, which `PostgresIncidentSink`
  satisfies), reports the milestone, and returns exit 0. Pure over the injected
  sink + out, so it's offline-tested with a fake.
- **Honest no-op reporting.** `PostgresIncidentSink.acknowledge`/`.mitigate` now
  return **whether a row actually changed** (`rowCount > 0`). The guarded UPDATE
  matches no row when the incident is absent or already past that state
  (idempotent), so the CLI prints `acknowledged <id>` / `mitigated <id>` on a
  real transition and `no-op: <id> was not …` otherwise — **exit 0 either way**
  (idempotent, not an error).
- **`executeIncidents` dispatch.** For `ack`/`mitigate` it builds a
  `PostgresIncidentSink` and calls `runIncidentWrite`; for the read commands it
  builds a `PostgresIncidentReplayer` and calls `runIncidents` (unchanged). One
  connection, closed in a `finally`.

## Cross-cutting invariants enforced (by tests)

- **Parsing.** `ack`/`mitigate` parse a positional id + default/explicit
  `--actor`; both require an incident id (`CliUsageError` otherwise).
- **Write runner.** `ack` calls `sink.acknowledge(id, actor)` and reports
  `acknowledged …`; `mitigate` the analogue; a sink that changed nothing yields a
  `no-op: …` line, all exit 0.
- **Sink return.** `acknowledge`/`mitigate` return `rowCount > 0`.
- **End-to-end (manual smoke).** Against the local DB, `incidents ack <id>`
  transitioned a declared incident (`acknowledged …`), a second `ack` reported
  `no-op …`, `incidents mitigate <id>` transitioned it, and the row showed
  `status=mitigated` with `acked_at` + `mitigated_at` both stamped.

## Alternatives considered

- **Fold write commands into `runIncidents` (one runner over a combined
  read+write source).**
  - **Decision.** No — the read replayer and write sink are different objects on
    the same table; a separate `runIncidentWrite` over an `IncidentWriteSink`
    keeps the read/write split honest and avoids churning the 19 existing
    `runIncidents` tests.
- **Make a no-op exit non-zero.**
  - **Decision.** No — ack/mitigate are idempotent; re-acking or acking an absent
    incident isn't a failure. A clear `no-op:` line at exit 0 is the right UX
    (distinct from `verify`, where drift *is* a gate failure).
- **`--actor` required (no default).**
  - **Decision.** No — a sensible system-actor default keeps the common operator
    invocation short; `--actor` overrides when attribution matters.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,600 offline tests + 27 gated
  real-Postgres integration tests** (16 worker + 11 serving; +5 offline; 0 new
  tables/columns/packages). The incident lifecycle is now **fully operable from
  one binary** — declare/escalate/resolve (automated) + ack/mitigate (operator,
  `incidents ack|mitigate`) for the write side, open/period/verify/metrics for
  the read side — and the MTTA/MTTM metrics (P2.24) now have a real operator
  source.
