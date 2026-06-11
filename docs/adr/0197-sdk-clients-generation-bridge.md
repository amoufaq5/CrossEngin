# ADR-0197: sdk-clients generation bridge (Phase 3 P3.42)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0193/0195/0196 (TS/Python/Go client emitters), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.38/P3.40/P3.41 added three pure client emitters (TS, Python, Go) off the
operate-server OpenAPI document. `@crossengin/sdk-clients` models the SDK release
contract — a 10-language matrix, a `GenerationRun` lifecycle (queued → … →
succeeded, with an `outputArtifactSha256` build-proof), `GeneratorConfig`, compat
matrix. The emitters and the contract were unconnected: nothing turned an emitted
client into a contract-typed release artifact.

## Decision

A **pure bridge** in `@crossengin/operate-runtime` connecting the emitters to the
sdk-clients contract.

- **`client-generation.ts`** — `generateClient(doc, language, {triggeredBy,
  clientName?, now?, runId?, specUrl?})` runs the built-in emitter for a
  `TargetLanguage` over an `OpenApiDocument` and returns
  `{ run: GenerationRun, source: string | null }`. For a supported language
  (`typescript`/`python`/`go`) it emits the source, computes its `sha256`
  (`@crossengin/crypto`) as the run's `outputArtifactSha256` build-proof, and parses
  a **`succeeded` `GenerationRun`** through `GenerationRunSchema` (config
  `tool: "custom_template"` + `customTemplatePath`, spec `openapi_3_1` with the
  doc's own sha + size, zeroed test/lint counters). For an unsupported language
  (`java`/`rust`/…) it returns a **`failed`** run (with `failureReason`) + `null`
  source. `clientLanguageSupported` + `SUPPORTED_CLIENT_LANGUAGES` expose the
  coverage. Pure + deterministic given a fixed `now`. operate-runtime gains
  dependencies on `sdk-clients` + `crypto` (the latter already transitively present
  via api-gateway-runtime).
- **`apps/operate-server openapi-client --emit-run`** — the CLI now routes source
  emission through `generateClient`, and `--emit-run` additionally writes the
  `GenerationRun` JSON (to `<out>.run.json`, or stdout when there's no `--out`) — so
  a release pipeline gets both the artifact and its lifecycle record in one call.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,192 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New tests:
  `client-generation.test.ts` (schema-valid succeeded runs for all three languages,
  determinism, sha-derived run id, failed run for an unsupported language, custom
  name) + an `openapi-client-cli.test.ts` parser test (incl. `--emit-run` / `--lang`
  validation / mutual exclusion). The committed reference clients are byte-identical
  (the CLI routes through the same emitters). No new META_ tables.
- The emitters now produce contract-typed release artifacts; the remaining
  `sdk-clients` pipeline pieces (semver `releases.ts`, `compatibility.ts` matrix
  entries, registry publication) can consume a `GenerationRun` directly. Adding a
  fourth-language emitter only extends `EMITTERS`.
