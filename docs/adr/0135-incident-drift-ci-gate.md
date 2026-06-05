# ADR-0135: incident timeline drift CI gate (Phase 3 P2.26)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0131 (incidents CLI / verify), ADR-0130 (incident replayer), ADR-0074 (crossengin-pg encrypt --verify gate), ADR-0109 (CI integration job), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.26).

## Context

P2.22 (ADR-0131) gave `incidents verify` an exit-1-on-drift contract — the same
CI-gate shape as `crossengin-pg encrypt --verify` (ADR-0074) — but it was never
wired into CI, so a regression that wrote a malformed incident timeline (e.g. a
resolve that forgot to append its timeline entry, the exact pre-P2.19 bug) would
pass CI silently. P2.26 wires the gate into the existing `integration` job.

## Decision

- **A new `Incident timeline drift gate` step** in `.github/workflows/ci.yml`'s
  `integration` job, **after** the gated suites. The gated worker/serving suites
  declare/escalate/resolve/ack/mitigate real incidents into `meta.incidents`
  during the run; the gate then runs
  `node apps/workflow-worker/dist/bin/workflow-worker.js incidents verify --from
  2000-01-01 --to 2100-01-01` over a wide window. The bin propagates the verify
  exit code, so **any timeline drift fails the job**; an empty/clean table
  verifies clean (exit 0).
- **Reuses the job's `PG*` env + provisioned DB** — no new service, no new
  fixture. The gate runs against the same database the integration tests just
  populated, so it checks *real* persisted timelines, not synthetic ones.

## Cross-cutting invariants enforced

- **Clean population passes.** Validated locally: after truncating
  `meta.incidents` and re-running the gated worker suite (which repopulates with
  current-code incidents), `incidents verify` reported `5 clean, 0 issues`
  (exit 0).
- **Drift fails.** Validated locally: inserting a `resolved` incident with no
  `resolved` timeline entry made the gate report
  `resolved_status_without_timeline_entry` and **exit 1** — the job would fail.
- **Order.** The step runs after the gated suites so the table is populated; on a
  job where no incidents were written, the gate still passes (empty = clean).

## Alternatives considered

- **Run the gate as a Vitest test instead of a CLI step.**
  - **Decision.** No — the value is exercising the *shipped* `incidents verify`
    operator path (the same command an on-call runs), and a non-zero CLI exit is
    the gate. A test would re-implement the assertion and not cover the bin.
- **A dedicated fixture of known-good + known-bad incidents.**
  - **Decision.** No — gating on the timelines the integration suite *actually*
    writes catches a real regression in the write path (sink/monitor); a static
    fixture would only test the verifier, which the unit tests already cover.
- **Gate in the `build-test` (offline) job.**
  - **Decision.** No — `incidents verify` needs a live Postgres; it belongs in the
    `integration` job beside the gated suites that populate the table.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,600 offline tests + 27 gated
  real-Postgres integration tests** (unchanged — this is a CI-workflow-only
  change; the verify logic + bin were already shipped and tested in P2.21/P2.22).
  CI now **fails the build** if any incident the integration suite persists has a
  drifted timeline — the regression guard the `verify` contract was built for.
- **The incident audit trail is now self-policing in CI** — declare/escalate/
  resolve/ack/mitigate write it, `verify` gates it on every push/PR.
