# ADR-0074: `crossengin-pg encrypt` CLI command (Phase 2 M7.8.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0070 (at-rest encryption + coverage applier), ADR-0071 (encrypt-on-write migration), ADR-0047 (kernel-pg) |

## Context

M7.8 (ADR-0070) shipped `EncryptionApplier.coverage/verify` and M7.8.5 (ADR-0071) shipped `EncryptionMigrator.planSchema/migrateSchema` — the library surface for reporting and fixing plaintext PHI columns. But they were only reachable from code. The `crossengin-pg` CLI exposed `apply` / `drift` / `inspect` but not encryption. An operator running a HIPAA "is PHI encrypted at rest?" check, or applying the migration, had no command. ADR-0071 Q4 named the follow-up.

M7.8.6 surfaces the encryption applier + migrator as a `crossengin-pg encrypt` subcommand.

## Decision

A new `encrypt` command on the `crossengin-pg` CLI plus two pure formatters (in `kernel-pg/src`, so they're unit-tested while the bin stays thin).

### Formatters (testable, in `src`)

- **`formatEncryptionCoverage(report)`** — renders an `EncryptionCoverageReport`: schema + hinted-column count, `pgcrypto installed: yes/no`, ciphertext/plaintext counts, and one line per `EncryptionDriftIssue` (`[plaintext_at_rest] …` / `[pgcrypto_missing] …`), or an `OK` line when fully covered, or a "no columns hinted" note.
- **`formatEncryptionPlan(plans)`** — renders the `ColumnMigrationPlan[]` from M7.8.5: a header + `-- <table>.<column> (<class>)` + its statements per column, or a "nothing to migrate" message.

### CLI command

`crossengin-pg encrypt` with three actions (default `--plan`):

- **`--verify`** → `EncryptionApplier.coverage(schema)`; prints the coverage report (or `--json`); **exits 1** when issues exist (unless `--exit-zero-on-drift`) — so CI can gate on "zero plaintext PHI columns".
- **`--plan`** (default) → `EncryptionMigrator.planSchema(schema, keyRef)`; prints the encrypt-on-write SQL **without executing** (a dry-run).
- **`--apply`** → `EncryptionMigrator.migrateSchema(schema, keyRef)`; runs the migration. Guarded by the same `looksLikeProductionDatabase` + `--confirm` check as `apply`; `--provision` first runs `CREATE EXTENSION pgcrypto`.

Flags: `--schema=<name>` (default `meta`; real use targets a tenant schema), `--key-ref=<sql>` (default `current_setting('app.column_encryption_key')` — a SQL reference, never a raw key). The bin's flag parser was extended to read `--k=v` values alongside the existing bare `--flag` set.

## Cross-cutting invariants enforced

- **Verify gates CI.** `encrypt --verify` exits non-zero on any encryption drift (plaintext PHI or missing pgcrypto), mirroring `drift`'s contract — a pipeline step can fail the build if PHI isn't encrypted.
- **Plan is a dry-run; apply is guarded.** `--plan` never touches the database; `--apply` honors the production-database `--confirm` guard, so the destructive column rewrite can't run unconfirmed against prod.
- **Keys stay references.** `--key-ref` defaults to and only ever passes a SQL key *reference* into the migration; the CLI never accepts or echoes a raw key (consistent with ADR-0070/0071).
- **Thin bin, tested logic.** The decision/SQL logic lives in tested `src` modules (`EncryptionApplier`, `EncryptionMigrator`, `formatEncryptionCoverage`, `formatEncryptionPlan`); the bin only parses flags + wires a connection — matching the existing `apply`/`drift` bin shape (the bin itself isn't unit-tested, the helpers are).
- **Idempotent apply.** `migrateSchema` plans plaintext columns only, so `encrypt --apply` re-run after success migrates nothing and prints "No plaintext columns to encrypt."

## Alternatives considered

- **Put the encrypt logic directly in the bin.**
  - **Decision.** No — the formatters + the applier/migrator stay in `src` where they're unit-tested. The bin is a thin dispatcher, like `runApply`/`runDrift`.
- **Fold encryption coverage into `drift`.**
  - **Considered.** One command reports schema + encryption drift.
  - **Decision.** Separate `encrypt` command. `drift` compares the live schema to `META_TABLES` (platform schema); encryption operates on tenant entity schemas with a `--schema` target and has its own actions (plan/apply). Conflating them would muddy both. A future `drift` could *also* call `EncryptionApplier.verify` as a convenience, but the dedicated command is clearer.
- **Require `--schema` (no default).**
  - **Decision.** Default `meta` for consistency with the other commands; real PHI lives in tenant schemas, so operators pass `--schema=t_<tenant>`. A default avoids a footgun-free no-op (meta has no classified columns → "no columns hinted").
- **Accept the raw key as a flag (`--key=<secret>`).**
  - **Decision.** Never — only `--key-ref` (a SQL expression). A raw key on the command line leaks into shell history, process listings, and logs.
- **A separate `migrate`/`verify` top-level command instead of `encrypt --action`.**
  - **Decision.** One `encrypt` command with action flags keeps the encryption surface grouped and discoverable under one help entry.

## Consequences

- **55 packages + 1 app, 122 meta-schema tables, 6,120 tests** (was 55 / 122 / 6,115; +5 tests, 0 new packages/tables). The encryption arc is now operable from the CLI end-to-end.
- **The HIPAA control is a command.** `crossengin-pg encrypt --schema=t_clinic --verify` answers "is this tenant's PHI encrypted at rest?" with a report and an exit code — runnable in CI or an audit.
- **The migration is a guarded command.** `encrypt --plan` shows the SQL; `encrypt --apply --provision --confirm` provisions pgcrypto and runs the rewrite — the M7.8.5 migrator made operable without writing code.
- **The data-classification arc is fully operable.** Declare `phi` → emitted comment/audit/mask/redaction → at-rest coverage + migration → **CLI to verify and apply**. Every link is now reachable by a human at a terminal.

## Open questions

- **Q1:** Should `encrypt --plan` accept `--json` for tooling?
  - _Current direction:_ `--verify` has `--json`; adding it to `--plan` (emit the `ColumnMigrationPlan[]`) is a trivial follow-up if a pipeline wants to diff plans.
- **Q2:** A decrypting-view command (`encrypt --view`)?
  - _Current direction:_ `emitDecryptingViewSql` exists (M7.8.5); exposing `encrypt --view --schema --table` to print/create it is a small addition once the read-path convention is settled.
- **Q3:** Multi-schema sweep (`--all-tenant-schemas`)?
  - _Current direction:_ Single `--schema` for now. A sweep that enumerates tenant schemas and verifies/migrates each is a fleet-operations follow-up.
- **Q4:** Key-rotation command (`encrypt --rotate --old-key-ref --new-key-ref`)?
  - _Current direction:_ Deferred with the rotation policy (ADR-0071 Q3). The `pgp_sym_encrypt(pgp_sym_decrypt(col, old), new)` emitter + a `--rotate` action follow the same shape.
