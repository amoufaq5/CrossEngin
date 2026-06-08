# ADR-0160: SLO enforcement drift CI gate (Phase 3 P2.48)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0157 (SLO read API + crossengin-slo CLI), ADR-0153 (gateway-execution gate), ADR-0145/0135/0136 (the other CI gates), ADR-0061 (SLO enforcement persistence), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.48).

## Context

P2.46 (ADR-0157) gave `@crossengin/observability-runtime-pg` a `crossengin-slo`
bin whose `slo verify` runs `verifyEnforcementHistory` over the persisted SLO
enforcement actions and exits 1 on drift — the same exit-1-on-drift contract as
`incidents verify` (ADR-0135), `encrypt --verify` (ADR-0136), `crossengin-pg
drift` (ADR-0145), and `crossengin-gateway-pg executions verify` (ADR-0153). But
it was never gated in CI. Meanwhile the operate-server gated SLO suite (P2.33,
`--slo-persist`) writes real enforcement actions + evaluation snapshots to
`meta.slo_enforcement_actions` / `meta.slo_evaluations` via the persistent SLO
engine — so the data is already there to gate on. P2.48 wires the fifth gate.

## Decision

- A new **`SLO enforcement drift gate`** step in `.github/workflows/ci.yml`'s
  `integration` job, after the gated suites, running `node
  packages/observability-runtime-pg/dist/bin/crossengin-slo.js slo verify --since
  2000-01-01`. The bin propagates the verify exit code, so any
  enforcement-history drift (ongoing/recovered-without-open, duplicate-open,
  paged-without-channels, kill-switch-without-flag) **fails the build**; an
  empty/clean table verifies clean (exit 0).
- The **gateway-execution gate comment was refreshed** in the same file: it had
  said the gate was vacuous, but P2.45 (ADR-0153) made operate-server persist
  executions under `--slo`/`--persist-executions`, so that gate now audits real
  rows too — the stale note is corrected.
- CI-workflow-only change — the `slo verify` logic + bin shipped + were tested in
  P2.46; no source/test/table change here.

## Cross-cutting invariants enforced

- **Real rows, not an empty table.** Validated locally: after the operate-server
  gated suite populated `meta.slo_enforcement_actions` (1 action) +
  `meta.slo_evaluations` (1 snapshot), `crossengin-slo slo verify --since
  2000-01-01` reported `1 enforcement action(s): no drift` / exit 0.
- **Drift fails.** The bin's exit-1-on-drift contract (offline-tested in P2.46's
  `query.test.ts`: `ongoing_without_open` / `recovered_without_open`) carries
  through to the gate.

## Alternatives considered

- **Run the gate as a vitest test.** No — the value is exercising the shipped
  `crossengin-slo` operator path and a non-zero CLI exit, consistent with the
  four existing gates.
- **Gate `slo summary` / `actions` too.** No — only `verify` has a
  pass/fail contract; the read commands are for humans.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 6,872 offline tests + 39 gated
  real-Postgres integration tests** (unchanged — CI-workflow-only). The
  `integration` job now runs **five** self-policing gates: schema-drift,
  incident-drift, PHI-encryption, gateway-execution, and SLO-enforcement-drift —
  every persisted audit surface (`meta.incidents`,
  `meta.gateway_pipeline_executions`, the SLO enforcement tables) plus the
  schema + PHI-at-rest invariants are verified against a live Postgres on every
  push/PR.
