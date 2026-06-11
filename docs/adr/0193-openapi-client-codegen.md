# ADR-0193: OpenAPI-driven TypeScript client codegen (Phase 3 P3.38)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0187–0188 (OpenAPI component schemas + refinements), ADR-0192 (typed client author's guide), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.32/P3.33 made operate-server's `GET /v1/openapi.json` codegen-grade (typed
component schemas, nullability, RFC 9457 errors), and P3.37's guide showed how to
feed it to external tools. The payoff — and the proof the document is actually
codegen-grade — is generating a real typed client. Pulling in
`openapi-generator` (Java) or `openapi-typescript` (a devDep + non-hermetic build
step) is off-pattern for this codebase, which prefers small purpose-built emitters
(cf. the P3.35 zod→OpenAPI converter).

## Decision

A **pure, deterministic OpenAPI 3.1 → TypeScript client emitter**, plus a CLI and a
committed reference client.

- **`@crossengin/operate-runtime` `openapi-codegen.ts`** — `emitOperateClientModule(doc,
  {clientName?})` turns an `OpenApiDocument` into a single self-contained `.ts`
  module: a transport preamble (`ClientOptions` / `ListResult<T>` / `OperateApiError`
  / `buildQuery`), an `export interface`/`export type` per component schema
  (`schemaToTsType` maps the JSON-Schema subset — `$ref`→name, scalars, arrays,
  enums→string-literal unions, nullable→`| null`, `oneOf`→union, objects), and a
  `createOperateClient(options)` factory with one method per operation
  (`operationMethodName` camelCases the operationId; path params → typed args;
  `requestBody` → a `body` param; the list `{data,page}` envelope → `ListResult<T>`,
  `204` → `void`, report → `ReportData`). Works purely off the document — no
  internal descriptor coupling, no external tool, no runtime dep beyond global
  `fetch`.
- **`apps/operate-server` `openapi-client` subcommand** —
  `operate-server openapi-client (--pack <alias> | --manifest <file>) [--out <file>]
  [--client-name <name>]` compiles the manifest's OpenAPI document (over an in-memory
  store + a no-op report runner so the report route + `ReportData` appear, matching
  what `serve()` exposes) and emits the client to a file or stdout.
- **Committed reference client** — `apps/operate-server/src/generated/retail-client.ts`,
  generated for the retail pack, checked in. It is **typechecked by `tsc`** as part
  of the package build (the strongest validity guard the emitter could have), and a
  `generated.test.ts` **drift guard** regenerates + asserts equality (so an emitter
  or manifest change without regeneration fails CI).

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,137 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New tests: `openapi-codegen.test.ts`
  (the type mapper + the full module emit — interfaces with required/nullable
  fidelity, typed methods, path-param substitution, custom client name) +
  operate-server `generated.test.ts` (drift + smoke). The committed client compiles.
  No new META_ tables.
- A developer gets a real, typed, dependency-free client off any deployment's
  OpenAPI document — the validation that the schema work (P3.32/0187, P3.33/0188)
  pays off. Multi-language emitters (the `sdk-clients` matrix) and a
  `WebApiDescriptor` client are the natural follow-ups.
