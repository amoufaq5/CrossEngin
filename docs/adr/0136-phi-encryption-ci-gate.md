# ADR-0136: PHI at-rest encryption CI gate (Phase 3 P2.27)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0074 (crossengin-pg encrypt CLI), ADR-0070 (at-rest encryption mechanism), ADR-0091 (column-store transparent encryption), ADR-0135 (incident drift CI gate), ADR-0109 (CI integration job), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.27).

## Context

P2.26 (ADR-0135) wired the `incidents verify` drift check into CI. Its sibling —
`crossengin-pg encrypt --verify` (ADR-0074), which prints an
`EncryptionCoverageReport` and exits 1 on `plaintext_at_rest` / `pgcrypto_missing`
drift — was built explicitly so "CI can gate zero plaintext PHI columns", but was
never gated. A regression that provisioned a `phi`/`regulated` column without
encrypting it (or dropped pgcrypto) would pass CI silently, breaking the HIPAA
control the whole classification → encryption arc exists to enforce. P2.27 wires
the encryption coverage gate into the `integration` job.

## Decision

- **A new `PHI at-rest encryption gate` step** in `.github/workflows/ci.yml`'s
  `integration` job, after the gated suites, running `crossengin-pg encrypt
  --verify` over **two schemas**:
  - **`--schema=meta`** — the 124-table platform catalog. It carries no PHI
    columns today, so the gate asserts *zero plaintext PHI in the platform
    schema* (an invariant: no future meta-schema change may add an unencrypted
    `phi`/`regulated` column).
  - **`--schema=public`** — where the operate-server column-store suite
    provisions encrypted PHI tables (e.g. `Patient.mrn` → BYTEA). The gate
    verifies the column store *actually* encrypted the PHI it provisioned (real
    ciphertext columns, not a trivial empty check).
  The bin `process.exit`s the coverage exit code, so **any plaintext PHI column
  (or missing pgcrypto) fails the job**; an un-hinted schema verifies clean.
- **Reuses the job's `PG*` env + provisioned/populated DB** — no new service or
  fixture. `public` is populated by the operate-server gated suite that runs
  immediately before (the column-store tests don't drop their tables).

## Cross-cutting invariants enforced

- **Clean platform schema passes.** Validated locally: `encrypt --verify
  --schema=meta` reported `0 column(s) hinted` → exit 0.
- **Real encrypted PHI passes.** Validated locally after the operate-server
  suite: `--schema=public` reported `4 column(s) hinted encrypt=at_rest,
  ciphertext: 4, plaintext: 0` → exit 0 — the column store's PHI is BYTEA at
  rest.
- **Plaintext PHI fails.** Validated locally: a `phi`-hinted `TEXT` column made
  the gate report `[plaintext_at_rest] … stored as text, not bytea ciphertext`
  and **exit 1** — the job would fail.

## Alternatives considered

- **Gate only `meta`.**
  - **Decision.** No — `meta` has no PHI columns, so that alone is a forward-only
    guard. Adding `public` exercises the coverage path on the *real* encrypted
    PHI columns the column store provisions, proving the encrypt-on-write path
    end-to-end in CI.
- **Provision a dedicated PHI fixture schema in the gate step.**
  - **Decision.** No — the operate-server column-store suite already provisions a
    real encrypted PHI schema (`public`); gating on what the suite actually wrote
    catches a regression in the *store's* DDL, not just the verifier.
- **Run in the offline `build-test` job.**
  - **Decision.** No — `encrypt --verify` needs a live Postgres + the provisioned
    PHI tables; it belongs in the `integration` job beside the suites that write
    them.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,600 offline tests + 27 gated
  real-Postgres integration tests** (unchanged — a CI-workflow-only change; the
  `encrypt --verify` logic + bin shipped and were tested in M7.8/M7.8.6). CI now
  **fails the build** on any plaintext PHI column (or missing pgcrypto) in the
  platform catalog or the provisioned column-store schema — the HIPAA "zero
  plaintext PHI at rest" control is enforced on every push/PR, the encryption
  sibling of the P2.26 incident-drift gate.
- **The data-classification arc is now self-policing in CI** — declare `phi` →
  comment → mask → BYTEA → encrypt-on-write → `encrypt --verify` gate.
