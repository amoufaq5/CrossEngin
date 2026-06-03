# ADR-0089: operate-server edge / Workers fetch adapter (Phase 3 P1.9)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0087 (operate-server binary), ADR-0078 (operate-runtime serving), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.9), taking the next free
> number after ADR-0088.

## Context

P1.7 (ADR-0087) deliberately split the serving binary into a framework-neutral
core — `OperateHttpServer.dispatch(RawHttpRequest, body) → RawHttpResponse` —
and a thin Node `http` adapter (`node.ts`). The stated payoff was that "the
`RawHttpRequest` seam keeps an edge/Workers adapter a future drop-in." This
increment cashes that in: a Fetch API adapter so the same gateway runs on
Cloudflare Workers / Deno / `undici` / any WinterCG runtime, with **zero**
change to the gateway, handlers, redaction, or pagination.

Proving the seam now (a) validates the P1.7 abstraction with a second real
adapter rather than a hypothetical one, and (b) unblocks edge deployment for P6
(multi-region) without re-plumbing serving.

## Decision

A new `edge.ts` module in `apps/operate-server` (no new package), over the same
`dispatch` core:

- **`fetchToRaw(request: Request)`** — maps a Fetch API `Request` into
  `{ raw: RawHttpRequest, body }`: copies headers via `Headers.forEach`, reads
  the body as bytes for non-GET/HEAD (once), and takes the client IP from
  `cf-connecting-ip` (or `x-forwarded-for`). The full `request.url` flows
  straight into `splitTarget` (which resolves path + query).
- **`rawToFetchResponse(response)`** — `new Response(bytes, { status, headers })`.
- **`createFetchHandler(server)`** — `(Request) → Promise<Response>`, the edge
  counterpart of `createNodeRequestListener`, both over `dispatch`.
- **`buildEdgeFetchHandler({ manifest, store?, apiKeys, now? })`** — composes a
  ready handler; the store defaults to `InMemoryEntityStore` (a socket-less
  runtime can't open node-postgres), `defaultScheme` is `https`.
- **`asModuleWorker(handler)`** — adapts the handler to the Cloudflare
  module-worker `{ fetch }` default-export shape.

The Fetch globals (`Request` / `Response` / `Headers`) are ambiently typed via
`@types/node`, so no DOM lib or extra dependency is added.

## Cross-cutting invariants enforced (by tests)

- **Same guarantees, different runtime.** Through the Fetch handler: a manager
  `POST /v1/products` creates (201), `GET /v1/products` lists, a cashier's list
  has `unit_cost` redacted while a manager's doesn't, an unknown key is 401, and
  `?limit=2` paginates with an opaque `nextCursor` — identical behavior to the
  Node adapter, because both call the one `dispatch`.
- **Real Fetch types.** Tests build genuine `new Request(...)` objects and read
  genuine `Response.json()` / `.status` (Node's `undici` globals), not mocks —
  so the adapter is exercised against the actual Fetch contract a Worker sees.
- **Mapping fidelity.** `fetchToRaw` is unit-tested for method/url/header/IP
  mapping and for reading a POST body into bytes; a GET carries no body.
- **Worker entry shape.** `asModuleWorker` yields a `{ fetch }` object a
  Cloudflare module worker can default-export directly.

## Alternatives considered

- **A separate `operate-server-edge` package.**
  - **Decision.** No — it's one ~90-line module over the existing `dispatch`;
    a package would duplicate deps for no isolation benefit. The Node-only bits
    (`node:http`, `node:fs`, node-postgres) live in `node.ts`, so importing
    `edge.ts` doesn't pull them in.
- **Return a structural response object instead of a real `Response`.**
  - **Decision.** No — a Worker must return a real `Response`; constructing one
    via the global keeps the handler usable as-is. The Fetch types are already
    available, so there's no typing cost.
- **A WHATWG `ReadableStream` body passthrough (streaming responses).**
  - **Decision.** Deferred — the gateway assembles a complete `bodyBytes` today
    (redaction rewrites the JSON), so a buffered `Response` body is correct.
    Streaming is a later refinement if large list responses warrant it.
- **Bundle a `wrangler` config + deploy target.**
  - **Decision.** Out of scope — this ships the adapter (the code seam); the
    deployment packaging belongs with P6 (multi-region) / `deploy`.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,281 tests** (was 6,274; +7,
  0 new packages/tables). The serving stack now runs on **both** Node and any
  Fetch/WinterCG runtime from one `dispatch` core — the P1.7 framework-neutral
  seam is proven, not just asserted.
- **Edge deployment is unblocked.** A Cloudflare Worker is
  `export default asModuleWorker(buildEdgeFetchHandler({ manifest, apiKeys }).fetch)`
  — the same manifest-derived routes, RBAC, redaction, and pagination, at the
  edge. A Postgres-at-the-edge store (HTTP driver) slots in behind the existing
  `EntityStore` injection.
- **No regression risk to the Node path.** `edge.ts` is additive; `node.ts` and
  `dispatch` are untouched.
