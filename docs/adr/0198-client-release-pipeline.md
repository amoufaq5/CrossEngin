# ADR-0198: client release + compatibility pipeline (Phase 3 P3.43)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0197 (sdk-clients generation bridge), ADR-0193/0195/0196 (client emitters), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.42 bridged the emitters to sdk-clients' `GenerationRun` (the build step). The
contract's downstream stages — `ClientRelease` (semver + channel + publish
lifecycle) and the `CompatibilityEntry` matrix — were still unconnected: a
`GenerationRun` couldn't become a publishable release.

## Decision

Extend the bridge with `planClientRelease`, closing the publish pipeline
(generate → release → compatibility).

- **`@crossengin/operate-runtime` `client-generation.ts`** — `planClientRelease(result,
  {version, channel?, registryPackageUri?, changelogUrl?, publishedBy?,
  breakingChanges?, id?, now?})` turns a **succeeded** `ClientGenerationResult` into
  `{ release: ClientRelease, compatibility: CompatibilityEntry }`. The release carries
  the run's `artifactSha256` build-proof, the artifact's actual byte size, a
  `generationRunId` back-link, the run's `apiVersion`, and a semver/channel (default
  `stable`); it's a `draft` unless `publishedBy` is given (then `published` with a
  stamped `publishedAt`). The compatibility entry is `fully_compatible` at the
  client version + the API version it was emitted from. Both parse through their
  contract schemas, so all the contract invariants apply (stable channel forbids
  pre-release versions, beta requires them, critical advisories block, …). Throws on
  a non-succeeded run.
- **`apps/operate-server openapi-client --release-version <v> [--publish-by <actor>]`**
  — when set, the CLI also emits `{ release, compatibility }` (to `<out>.release.json`,
  or stdout); `--publish-by` requires `--release-version` and publishes the release.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,197 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New tests: `client-generation.test.ts`
  release cases (schema-valid draft release + fully_compatible entry, sha/run-id
  carry-through, publish stamping, beta pre-release, non-succeeded rejection, stable
  pre-release rejection) + an `openapi-client-cli.test.ts` parser case
  (`--release-version`/`--publish-by`). No new META_ tables.
- The full SDK pipeline now runs off one document: **OpenAPI doc → emit (TS/Python/Go)
  → `GenerationRun` → `ClientRelease` + `CompatibilityEntry`**, all contract-typed and
  schema-validated. Actual registry publication (npm/PyPI/Go proxy) + a persisted
  release ledger are the deployment-side follow-ups.
