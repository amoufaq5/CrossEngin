# ADR-0154: operate-web edge / Workers fetch adapter + JWT/JWKS auth (Phase 3 P3.2)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0080 (operate-web renderer), ADR-0089 (operate-server edge adapter), ADR-0097 (operate-server JWT identity), ADR-0099 (remote JWKS), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). 0080 anchors the P3 renderer arc (operate-web); this is its second
> increment (P3.2), taking the next free ADR number.

## Context

P3.1 (ADR-0080) shipped `@crossengin/operate-web` (the view-model compiler) and
`apps/operate-web` — a Node `http` shell that serves redaction-aware UI view
models as JSON under `key:role:tenant` API-key auth. It deliberately deferred
"JWT/edge auth" as a follow-up, exactly mirroring the gap `apps/operate-server`
closed in P1.9 (edge adapter, ADR-0089) + P1.17/P1.19 (JWT/JWKS, ADR-0097/0099).

This increment brings operate-web to parity over the existing
`OperateWebServer.dispatch(RawWebRequest) → RawWebResponse` core, with no fork of
that core: (1) a Fetch API adapter so the renderer runs on Cloudflare Workers /
Deno / `undici` / any WinterCG runtime, and (2) production JWT/JWKS identity so a
verified Bearer token resolves a viewer statelessly from its claims, coexisting
with dev API keys.

Unlike operate-server, operate-web does **not** run the api-gateway pipeline —
it resolves its own principal (`ApiKeyRegistry.resolve(req) → WebViewer`). So JWT
verification is wired at the principal-resolution seam (a new
`WebPrincipalResolver`), reusing the gateway's already-tested
`verifyBearerJwt` / `JwksProvider` / `InMemoryJwksProvider`
(`@crossengin/api-gateway-runtime`, EdDSA over `@crossengin/crypto`) rather than
re-implementing the verify.

## Decision

Two additive modules + threading, over the same `dispatch`:

### Part 1 — `edge.ts` (Fetch/Workers adapter)
- **`fetchToRaw(request: Request)`** — maps a Fetch `Request` → the app's
  `RawWebRequest` (headers copied via `Headers.forEach`, client IP available via
  `cf-connecting-ip`/`x-forwarded-for`). The UI routes are GET-only, so no body
  is read.
- **`rawToFetchResponse(response)`** — `new Response(bytes, { status, headers })`.
- **`createFetchHandler(server)`** — `(Request) → Promise<Response>`, the edge
  counterpart of `createNodeRequestListener`, both over `dispatch`.
- **`buildEdgeFetchHandler({ manifest, store?, apiKeySpecs, jwt?, now? })`** —
  composes a ready handler; store defaults to `InMemoryEntityStore` (socket-less
  runtimes), scheme is `https`.
- **`asModuleWorker(handler)`** — the Cloudflare module-worker `{ fetch }` shape.

### Part 2 — `principals.ts` (+ `jwks.ts`)
- `dispatch` now resolves through a `WebViewerResolver` (async-tolerant). A new
  **`WebPrincipalResolver`** tries the `ApiKeyRegistry` first (a registered key
  wins); otherwise, when a `JwtVerifyConfig` is wired and the Bearer token is a
  3-part JWT, it calls `verifyBearerJwt` (signature + iss/aud/exp/nbf) and turns
  the claims into a `WebViewer`: **scopes → roles** (`scopesToRoles`: an explicit
  `roles` array claim wins, else the OIDC `scope` string / `scp` array, else `[]`
  — a roleless viewer sees only public fields, fail-closed), `sub` → a UUID
  (`subjectToUuid`, mirroring operate-server), tenant from the `tenant_id` claim
  (else the `x-tenant-id` header). The operate-web "principal" is just
  `{ roles, tenantId }`, and the compiler keys redaction off
  `ViewerContext.roles`, so scopes → roles is the whole bridge.
- **`jwks.ts`** lifts operate-server's module largely verbatim: `buildJwksProvider`
  (in-memory), `RemoteJwksProvider` (caching + rotation + resilient-on-failure),
  `parseJwksDocument` / `base64UrlToBase64`, and the `JwksRefreshPoller`.
- **CLI** gains `--jwks-key kid:base64` (repeatable) / `--jwks-file` / `--jwks-url`
  / `--jwt-issuer` / `--jwt-audience`. Issuer + audience are required when any
  JWKS source is configured; sources are mutually exclusive. `serve()`'s
  `buildJwtConfigFromOptions` assembles the `JwtVerifyConfig` (file/url reads live
  in `node.ts`); the config threads through both the Node `serve()` and the edge
  `buildEdgeFetchHandler`.

The Fetch globals are ambiently typed via `@types/node`; the only new deps are
the workspace `@crossengin/api-gateway-runtime` (verify + JWKS types) and
`@crossengin/crypto` (test JWT minting).

## Cross-cutting invariants enforced (by tests)

- **Same redaction, different runtime.** Through the Fetch handler: a
  `store_manager`'s `/ui/Product/p1` JSON carries `unit_cost`, a `cashier`'s omits
  it, an unauthenticated request is 401 — identical to the Node path because both
  call the one `dispatch`. Tests build genuine `new Request(...)` and read
  `Response.json()` (undici globals), and `asModuleWorker` yields a `{ fetch }`.
- **JWT scope → role → redaction, end-to-end.** A real Ed25519-signed JWT
  (`generateEd25519Keypair` + `signEd25519`) with `scope: store_manager` gets
  `unit_cost`; `scope: cashier` has it redacted — the scope drives the role drives
  the compiled view. Unknown-kid / wrong-issuer / expired / bad-signature → 401
  (fail-closed); with no JWT config, an unknown Bearer token → 401.
- **API key + JWT coexist.** A registered api key resolves even when JWT config is
  present; a JWT only resolves when no api key matches.
- **CLI validation.** Issuer+audience required with a JWKS; JWKS sources mutually
  exclusive.

## Alternatives considered

- **Run operate-web through the api-gateway pipeline (like operate-server).**
  - **Decision.** No — operate-web is a read-only renderer with its own light
    principal model; threading the 17-stage pipeline in would be a large
    refactor. Reusing only `verifyBearerJwt` + the JWKS providers keeps the verify
    battle-tested without adopting the pipeline.
- **A separate edge package.**
  - **Decision.** No — `edge.ts` is one small module over `dispatch`; the
    Node-only bits (`node:http`, `node:fs`) stay in `node.ts`.
- **Re-implement the JWKS module instead of lifting operate-server's.**
  - **Decision.** No — the providers are runtime-neutral; lifting them keeps one
    behavior (caching/rotation/resilience) across both apps. A shared package is a
    later refactor if a third consumer appears.

## Consequences

- **63 packages + 4 apps, 125 meta-schema tables** (unchanged), **6,804 offline
  tests** (was 6,764; +40 in `apps/operate-web`, now 73 from 33). No new META_
  tables (pure auth + adapter wiring).
- **operate-web runs on Node and any Fetch/WinterCG runtime**, and accepts
  production JWTs from an IdP (inline keys, a JWKS file, or a caching remote JWKS),
  with dev API keys still working — parity with operate-server's serving edge.
- **No regression risk to the existing path.** `edge.ts` is additive; the api-key
  resolver is unchanged and still wins; the dispatch core is untouched (only its
  resolver field generalized from `ApiKeyRegistry` to a `WebViewerResolver`).
