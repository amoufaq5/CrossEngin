# ADR-0145: schema drift CI gate (Phase 3 P2.36)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0047 (kernel-pg — `drift` subcommand), ADR-0135 (incident timeline drift CI gate), ADR-0136 (PHI at-rest encryption CI gate), ADR-0109 (CI integration job), ADR-0074 (crossengin-pg CLI shape), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.36).

## Context

`crossengin-pg drift` (the third subcommand on the kernel-pg bin, shipped
with M1/ADR-0047) introspects the live `meta` schema and diffs it against
`META_TABLES` — the in-process source-of-truth the bootstrap DDL is emitted
from. It exits 1 on any drift (added/removed/modified table, column, index,
policy, or RLS toggle), with `--exit-zero-on-drift` to suppress for read-only
inspection. The exit contract is the same shape `encrypt --verify` (ADR-0074)
ships, which was wired into CI in P2.27 (ADR-0136), and `incidents verify`
(ADR-0131), which was wired in P2.26 (ADR-0135) — but `drift` itself was
never gated.

A regression that changed `META_TABLES` without re-emitting the bootstrap
DDL the setup script applies (or vice-versa) would pass CI silently. The
verifier exists and the populated database is sitting right there in the
`integration` job; this increment connects the wire.

## Decision

- **A new `Schema drift gate` step** in `.github/workflows/ci.yml`'s
  `integration` job, running
  `node packages/kernel-pg/dist/bin/crossengin-pg.js drift` against the
  job's standard `PG*` env. The bin propagates the diff exit code, so
  **any meta-schema drift fails the job**; a clean schema verifies exit 0.
- **Placement: immediately after `Provision the integration database`,
  *before* the gated test suites.** This is the load-bearing decision —
  see "Alternatives considered" below. Rationale: the setup script bootstraps
  `meta` from `META_TABLES` via `scripts/emit-bootstrap.mjs` →
  `emitMetaBootstrapSql()`, then the suites run as data writes (rows,
  `withTenantContext`, `SELECT … FOR UPDATE`, etc.) — they do **not** migrate
  `meta`. Gating immediately after provision exercises the **freshly-
  provisioned baseline**, so the drift the gate catches is a real
  bootstrap-vs-`META_TABLES` divergence, not test pollution; it also fails
  the build faster than letting it run after the suites + the two existing
  gates would.
- **Reuses the job's existing service + provisioned DB** — no new fixture,
  no new env, no new bin build step (`pnpm -r build` earlier in the job has
  already produced `packages/kernel-pg/dist/bin/crossengin-pg.js`, the same
  artifact the P2.27 `encrypt --verify` step invokes).

## Cross-cutting invariants enforced

- **Clean bootstrap passes.** The setup script emits DDL via
  `emitMetaBootstrapSql()` and `psql`-applies it; `diffSchema(META_TABLES,
  introspectSchema(conn, "meta"))` compares the live schema against the
  exact same `META_TABLES` array — no drift expected, exit 0.
- **Bootstrap-vs-meta-schema drift fails.** A future change to
  `META_TABLES` without re-emitting the bootstrap (or vice versa) makes the
  introspector see a tables/columns/policy delta → `diff.hasDrift = true` →
  the bin exits 1 → the job fails.
- **Order.** The gate runs *before* any data write, so it can never be
  fooled by a row insert; it gates *DDL structure*, the thing it is for.
  The `_meta_migrations` housekeeping table that `MigrationApplier`
  normally maintains is **not** created by the integration setup path
  (which uses raw `psql`, not the applier), so it does not appear as a
  drift hit.

## Alternatives considered

- **Run the gate *after* the gated suites (mirror the P2.26 / P2.27
  placement).**
  - **Decision.** No — the existing two gates verify *what the suites
    wrote* (incident timelines, encrypted PHI columns); schema drift is a
    property of the *bootstrap*, which the suites don't touch. Running
    after the suites would still work (no test mutates `meta`'s structure),
    but it would only delay an inevitable failure and burn the gated-suite
    runtime for nothing.
- **Run as a Vitest test in the `build-test` (offline) job.**
  - **Decision.** No — `drift` needs a live Postgres + an applied schema;
    it belongs in the `integration` job. Asserting `META_TABLES` is
    self-consistent in an offline test is a different (and weaker) check
    than asserting the live schema matches it.
- **Make the `Provision the integration database` step itself run `drift`
  on success.**
  - **Decision.** No — keeping the gate a discrete CI step makes the
    failure mode visible in the workflow UI (a red "Schema drift gate"
    step), and keeps the setup script focused on provisioning.
- **Run `drift --json` and parse the output.**
  - **Decision.** No — the exit-1-on-drift contract is exactly the CI
    shape we already use for `encrypt --verify` and `incidents verify`;
    consistency wins.

## Consequences

- **62 packages + 3 apps, 124 meta-schema tables, 6,613 offline tests + 29
  gated real-Postgres integration tests** (unchanged — a CI-workflow-only
  change; the `drift` logic + bin shipped and were tested in
  M1/ADR-0047). CI now **fails the build** on any divergence between
  `META_TABLES` and the schema the bootstrap DDL produces — the
  meta-schema-vs-applier sibling of the P2.26 incident-drift + P2.27
  PHI-encryption gates.
- **The meta-schema applier path is now self-policing in CI** — declare
  table → meta-schema test (tenant_id RLS + FK ordering) → bootstrap emit
  → drift verify. The kernel's "source-of-truth" guarantee is enforced on
  every push/PR.
