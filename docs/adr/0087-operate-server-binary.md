# ADR-0087: apps/operate-server — the runnable serving binary (Phase 3 P1.7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0078 (operate-runtime serving), ADR-0079 (gateway body parsing), ADR-0086 (operate-runtime-pg), ADR-0051 (architect-cli), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.7), so it takes the next free
> number after ADR-0086.

## Context

P1 (ADR-0078) compiled a manifest into a `GatewayRuntime`; P1.5 (ADR-0079)
closed the gateway gaps so the full CRUD + lifecycle surface runs through the
pipeline; P1.6 (ADR-0086) gave it a Postgres `EntityStore` under tenant RLS.
What was still missing — ADR-0078 **Q4** — was the actual *process*: an HTTP
binary that loads a resolved manifest at boot, binds a socket, and serves it.
Everything was a library; nothing ran.

This increment delivers `apps/operate-server` — the second app under `apps/`
(after `architect-cli`), a thin HTTP shell over `buildOperateGateway` that turns
the P1 stack into a running, multi-tenant server.

## Decision

`@crossengin/operate-server` (an app with an `operate-server` bin), six source
modules, all serving logic unit-tested offline (no socket required):

- **`http.ts`** — the framework-neutral request/response shapes
  (`RawHttpRequest` / `RawHttpResponse`), `parseMethod` (uppercase + validate
  against the gateway's `HTTP_METHODS`), `splitTarget` (path + decoded query,
  repeated keys → arrays), and `rawToIncoming` (maps a raw request + body bytes
  into a gateway `IncomingRequest` via `buildIncomingRequest`).
- **`principals.ts`** — `parseApiKeySpec` (`key:role:tenant[:principalId]`) +
  `buildPrincipalWiring`: from a set of API keys, an `OpaqueTokenLookup` (token →
  principal ref, fail-closed: unknown token → null → 401), an
  `InMemoryPrincipalResolver`, and the scope→role bridge.
- **`manifest-source.ts`** — `loadBuiltinPack` (builds a vertical pack and
  **fully resolves its `meta.extends` lineage** against a registry of all packs,
  so retail → core and grocery → retail → core merge before serving) and
  `loadManifestFromJson` (parse + `ManifestSchema` + `tryValidateManifest` for a
  pre-resolved document). Both cross-validate or throw.
- **`server.ts`** — `OperateHttpServer.dispatch(raw, body)`: the serving core
  that maps → runs `handleRequest` → projects the `OutgoingResponse` back to a
  `RawHttpResponse` (an unknown method short-circuits to a 405 problem
  document). `buildOperateHttpServer` composes manifest + store + API keys into
  a ready server.
- **`cli.ts`** — `parseServeArgs` (`--pack` / `--manifest` exactly one, `--port`,
  `--store memory|pg`, `--schema`, `--scheme`, repeatable `--api-key`,
  `--help` / `--version`) + `helpText`. Misuse → `CliUsageError` (exit 2).
- **`node.ts`** — the thin Node `http` binding: `createNodeRequestListener`
  (collects the body, dispatches, writes the response; a throw → 500 problem
  doc, never a hung socket) and `serve(options)` (loads the manifest, builds the
  store — `InMemoryEntityStore` or a `PostgresEntityStore` over
  `parsePgEnvConfig()` — wires the keys, and listens; returns a handle with
  graceful `close`).

The bin is a dispatcher: parse argv → help/version → `serve` → log the listen
URL → graceful shutdown on SIGINT/SIGTERM.

## Cross-cutting invariants enforced (by tests)

- **It actually boots.** A test calls `serve(--pack erp-retail --port 0)`,
  makes a **real loopback HTTP request**, and gets `200` — the binary serves a
  resolved pack end-to-end over a socket, then shuts down cleanly.
- **The HTTP edge preserves every P1 guarantee.** Through `dispatch`: a manager
  `POST /v1/products` creates (201), a cashier `GET /v1/products` gets
  `unit_cost` redacted while a manager gets it (same route), a cashier create is
  403, an unknown method is 405, an unknown/absent key is 401, and a query
  string doesn't break routing — all the manifest-derived behavior, now over raw
  HTTP.
- **Auth is fail-closed.** A token absent from the API-key set resolves to null;
  the gateway returns 401. No key, no access.
- **The manifest is resolved at boot.** `--pack erp-grocery` serves the full
  three-level lineage (grocery + retail + core entities); a malformed or
  unresolvable manifest throws before the socket binds.
- **Offline-testable.** Every module except the real-loopback case is tested
  against `RawHttpRequest` / mock Node req-res objects, so CI needs no network.

## Alternatives considered

- **Build on a web framework (Express/Fast/Hono).**
  - **Decision.** No — the gateway *is* the framework (17-stage pipeline, auth,
    redaction, problem details). A 60-line Node `http` adapter over `dispatch` is
    all that's needed; a framework would duplicate routing + middleware the
    gateway already owns. The `RawHttpRequest` seam keeps an edge/Workers adapter
    a future drop-in.
- **Embed the HTTP server in `operate-runtime`.**
  - **Decision.** No — `operate-runtime` stays a pure library (the composition);
    the socket-binding process lives in an app under `apps/`, mirroring the
    `architect-cli` split. Tests of the composition stay offline.
- **A config file instead of `--api-key` flags.**
  - **Decision.** Flags now (simple, scriptable); a richer auth source (JWKS /
    SSO / a tenant directory) slots in behind the same `PrincipalWiring` shape
    later. The dev API-key form is explicitly a bootstrap, not the production
    identity story.
- **Hot-reload on pack install.**
  - **Decision.** Deferred (ADR-0078's startup-interpret decision already makes
    a reload cheap). The binary loads one manifest at boot; the marketplace
    install → reload path is later Phase 3 work.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,254 tests** (was 59 / 1 app /
  6,217; +1 app, +37 tests, 0 new packages/tables). **ADR-0078 Q4 is resolved** —
  the serving keystone is a running process. The P1 arc (compile → gaps → store
  → server) is complete but for Q5.
- **The headline is real.** `operate-server --pack erp-retail --api-key
  key:store_manager:<tenant>` answers `GET /v1/products` with per-caller
  redaction and `POST /v1/sales-orders/{id}/place` with lifecycle enforcement,
  from the manifest, over HTTP, persisted (with `--store pg`).
- **Q5 (list pagination/filtering) is the one remaining P1 follow-up.** The edge
  adapter (Workers/edge runtime) and a production identity source are natural
  next steps behind the existing seams.
