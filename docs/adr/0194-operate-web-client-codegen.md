# ADR-0194: WebApiDescriptor TypeScript client codegen (Phase 3 P3.39)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0193 (OpenAPI client codegen), ADR-0189–0191 (operate-web discovery schemas), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.38 shipped a typed client emitter for operate-server's OpenAPI document. operate-web's
discovery surface — `GET /ui/_describe` — is a custom `WebApiDescriptor` (per-entity
field schemas, view-model shapes, route envelope schemas, P3.34–P3.36), not OpenAPI,
so it can't use the same OpenAPI codegen. The parity deliverable is a view-model
client emitter for the descriptor.

## Decision

A **pure, deterministic `WebApiDescriptor` → TypeScript client emitter**, plus a CLI
and a committed reference client — the operate-web sibling of P3.38.

- **`@crossengin/operate-web` `web-codegen.ts`** — `emitWebClientModule(descriptor,
  {clientName?})` produces one self-contained `.ts` module: a transport preamble
  (`ClientOptions` / `WebApiError` / `buildQuery`), an interface per view-model
  (`descriptor.models`) **and** per-entity field shape (`entities[].schema`), and a
  `createWebClient(options)` factory with a method per route. It reuses
  operate-runtime's `schemaToTsType` + the newly-exported `emitNamedTsType` (so the
  field→type mapping is identical to the OpenAPI emitter), and the route
  `responseSchema`s' `#/models/<Name>` `$ref`s resolve to the emitted model
  interfaces. `webMethodName` names routes `<entity><Kind>` (`productTable`,
  `productDetail`, …) and transitions `<entity><Transition>` (`salesOrderPlace`,
  baking the transition name into the POST body); `create`/`update` take a typed
  entity `body`; `delete` → `void`; the `describe` route is skipped.
- **`apps/operate-web` `web-client` subcommand** —
  `operate-web web-client (--pack <alias> | --manifest <file>) [--role <name>]...
  [--out <file>] [--client-name <name>]` builds the per-caller descriptor for the
  given `--role`s and emits the client. (The descriptor is per-caller, so the
  generated client reflects what that viewer can see + do.)
- **Committed reference client** — `apps/operate-web/src/generated/retail-web-client.ts`,
  generated for the retail pack as `retail_admin` + `store_manager`, **typechecked by
  `tsc`** in the build + drift-guarded by `generated.test.ts`.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,150 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New tests: `web-codegen.test.ts`
  (method naming, the fixture emit — model + entity interfaces, typed methods with
  `$ref`-resolved envelopes, transition body baking, custom name; + a real-retail
  smoke) + operate-web-app `generated.test.ts` (drift + smoke). The committed client
  compiles. No new META_ tables.
- Both discovery surfaces now have a typed client generator. The data rows inside a
  view envelope are typed `Record<string, unknown>` (the descriptor types the row
  shape separately as `entities[].schema`); tightening the envelope's `data`/`record`
  to the entity interface is a possible refinement.
