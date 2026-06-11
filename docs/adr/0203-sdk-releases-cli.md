# ADR-0203: sdk-releases read + verify CLI (Phase 3 P3.48)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0200 (sdk-clients-pg ledger), ADR-0201 (ledger CLI persistence), ADR-0159 (operate-server slo subcommand), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.45/P3.46 persist `ClientRelease` + `CompatibilityEntry` rows to the SDK ledger
(`meta.sdk_client_releases` + `meta.sdk_compatibility_entries`), but there was no
operator surface to read or audit it — unlike `meta.incidents` (`incidents` CLI) and
the SLO tables (`slo` CLI), both of which have a read + drift-verify subcommand.

## Decision

An `sdk-releases` read + verify CLI, mirroring the `incidents` / `slo` subcommands.

- **`@crossengin/sdk-clients-pg` `query.ts`** — the framework-neutral runner:
  `parseSdkReleasesArgs` + `runSdkReleases` over a structural `SdkLedgerSource`
  (`listReleases` / `listCompatibility`, satisfied by the two stores). `list` lists
  releases (filter `--language`/`--channel`/`--status`); `compat` lists compatibility
  entries (`--api-version`); `verify` runs `verifySdkLedger` and **exits 1 on any
  drift** (the CI-gate contract, like `slo verify`). `verifySdkLedger` is a pure
  cross-table consistency sweep — checks neither table can enforce per-row: a
  **published** release must have a matching compatibility entry at its API version
  (`release_without_compatibility`), every compatibility entry must correspond to a
  known release (`compatibility_without_release`), and a published release whose
  compatibility is `unsupported`/`blocked` is a contradiction
  (`published_release_incompatible`). `--format human|json`. `PostgresSdkCompatibilityStore`
  gained a bounded `list({apiVersion?, limit?})` read for the sweep.
- **`apps/operate-server`** — `sdk-releases-cli.ts` re-wraps the package's
  `parseSdkReleasesArgs` (translating its `CliUsageError` to operate-server's), and
  `node.ts`'s `executeSdkReleases` opens a conn, builds an `SdkLedgerSource` over
  `PostgresClientReleaseStore` + `PostgresSdkCompatibilityStore`, runs the query, and
  exits the code; the bin gained an `argv[2] === "sdk-releases"` one-shot branch
  (alongside `incidents` / `slo` / `openapi-client`).

## Consequences

- **65 packages + 4 apps, 126 meta-schema tables, ~7,239 offline tests + 54 gated
  real-Postgres integration tests + five CI gates.** New offline tests:
  `query.test.ts` (the verify cross-checks — clean / missing-compat / orphan-compat /
  incompatible-published / drafts-ignored; the parser; the runner's exit codes) + an
  operate-server `sdk-releases-cli.test.ts` (the re-wrap). No new META_ tables; the
  parser is reused, not re-implemented.
- The persistence ↔ read+verify symmetry now holds for all four audit ledgers
  (`meta.incidents`, the gateway executions, the SLO tables, and now the SDK ledger).
  A CI gate running `sdk-releases verify` (once a deployment persists releases) is a
  natural follow-up.
