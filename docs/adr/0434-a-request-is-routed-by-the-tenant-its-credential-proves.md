# ADR-0434: A request is routed by the tenant its credential proves, and a refused re-activation keeps the last applied manifest

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0314 (per-tenant schema and the JSONB fallback), ADR-0396 (the both-literals fence over `buildOperateHttpServer`), ADR-0397 (a manifest-source throw is a refusal), ADR-0359 (a refused per-tenant gateway is a 503, not the deployment's gateway), ADR-0368 (lineage resolution in the gateway cache), ADR-0386 (required JWT claims), ADR-0338 (refuse only when nothing correct breaks) |

## Context

The external due-diligence audit's **H-27** named three defects in per-tenant manifests: bearer
requests bypassed the tenant's manifest, per-tenant gateways lost the rate limiter and the
idempotency store, and a refused re-activation flipped a tenant's store. The verified report marked
it `partly_fixed` at `f6faf05`: ADR-0396/0397 had passed the idempotency store and rate limiter to
per-tenant gateways, and three things remained. All three were real.

1. **Bearer routing.** `resolveRequestTenant` read only API keys and never decoded a JWT. The web
   console's session token carries `tenant_id` and sends no `x-tenant-id` (`operate-web`'s proxy
   sends only `Authorization: Bearer`), so every console session was served the **boot manifest**
   rather than the tenant's activated one — on the shipped compose, since `--ai-design` implies
   per-tenant manifests. Worse, any bearer the router could not resolve — an unknown token or a
   forged non-JWT string — plus a UUID `x-tenant-id` hint made the cache read and build that
   tenant's manifest **before any verification**, so an unauthenticated caller could tell a tenant
   with a refused activation (503) from the rest (401).
2. **`billingPortal`.** It is a gateway route (`meta.billing-portal.create`), so it can match only
   inside the gateway that receives the request, and it was not passed to per-tenant gateways: a
   tenant on its own manifest got a 404. ADR-0396's fence missed it because `notPassed[1]` exempted
   it as *"served by the default server"*, which is false and which nothing checked.
3. **A refused re-activation.** Measured live on PG 16 with version 1 applied and 1 row in the
   tenant's own schema, then a refused version 3 (a text → integer column change): list reads
   through the router returned **0 rows** (they went to the JSONB fallback) and a new write landed
   in the fallback while the tenant schema still held 1 row. So reads lost the data and writes went
   elsewhere — worse than the audit's "flip".

## Decision

**Routing uses only what a credential has proved.** `bearerTenantVerifier` runs `verifyBearerJwt`
with the same key set, issuer, audience and required claims the gateway uses; routing then takes
the verified `tenant_id` claim, or the `x-tenant-id` hint only once the token has verified. An
unverified bearer goes to the default gateway, which answers 401. Under `--credential-login` the
deployment's own signing key is in the key set, so the verifier is wired on the shipped compose.

**Routing reads credentials in the gateway's order.** The gateway's `parseAuthHeader` reads
`Authorization: Bearer` first; routing had read `x-api-key` first. Through real compiled gateways,
key-a (tenant 1) together with a valid tenant-2 session answered **200 on tenant 1's `/v1/widgets`
while authenticated as tenant 2** — on Postgres, tenant 2's data handled under tenant 1's manifest.
`bearerToken` applies the gateway's exact rule (trimmed, lowercased, starts with `"bearer "` with a
literal space), and `x-api-key` is consulted, trimmed, only when there is no bearer. A `\s+` match
would have reopened it the other way, since the gateway treats `Bearer<TAB>…` as no bearer.

**`billingPortal` is passed at the per-tenant site**, and the fence now rejects a per-tenant
exemption unless the field is genuinely served ahead of the gateway: it must not be forwarded into
`buildOperateGateway` in `server.ts`, and it must appear in the `new OperateHttpServer` literal.

**The registry keeps the last applied manifest and store**, and a refused re-activation does not
overwrite them. `ensureServing` answers one of four:

- `applied` — the new manifest was applied;
- `retained` — the last applied manifest is served, **and the gateway is compiled for that manifest
  too**;
- `refused` — nothing was ever applied and the schema holds no tables, so ADR-0314's JSONB fallback
  is kept;
- `stranded` — this process never applied anything but the schema already holds tables:
  `tenant_schema_stranded`, a 503 instead of the fallback.

The activation poller uses `forgetApplication`, which keeps the retained pair; erasure still uses
`forget`, which drops it.

Two behaviour changes refuse something that answered before, both under ADR-0338's rule: a stranded
tenant gets a 503 where the fallback answered with no rows, and an unverified bearer plus a hint
gets the default gateway's 401 where it used to build the hinted tenant's gateway. Neither answer
being replaced was correct, so no hatch is offered.

## Alternatives considered

- **Route by the principal the gateway resolves.** Refused: authentication happens inside the
  gateway already chosen, and re-entering another gateway's pipeline after the fact has no point.
  The cost of verifying first is one extra Ed25519 verify per bearer request.
- **The audit's remedy, keep the last good store.** Refused as stated: alone it pairs the old
  store with a gateway compiled for the *new* manifest. The gateway is compiled for the retained
  manifest instead.
- **Keep serving the JSONB fallback for a stranded tenant.** Refused: the fallback holds none of
  that tenant's rows, so it answers empty and absorbs writes the tenant's schema never sees, which
  is the defect above.

## Consequences

- **Positive:** a console session is served the tenant's activated manifest; an unauthenticated
  caller can no longer distinguish a refused activation; a tenant on its own manifest has the
  billing portal; a refused re-activation keeps reads and writes on the tenant's schema.
- **Negative:** retention is per process, so after a restart or on another replica a tenant whose
  re-activation was refused gets a 503 rather than its last good manifest, and replicas can differ.
  Routing and the gateway verify separately and can disagree across a key-set or clock boundary in
  either direction: an `nbf` arriving or a key appearing between the two calls has routing refuse a
  token the gateway accepts, so that one request gets the boot manifest. The window is
  microseconds.
- **Neutral:** a Bearer-position api key is read as a JWT and refused 401 `credential_malformed` by
  the gateway; routing it only decides which gateway says so.
- **Reversibility:** in-process code only; no catalog change.

## Implementation notes

Changed: `packages/operate-runtime-pg/src/tenant-store-registry.ts`,
`apps/operate-server/src/tenant-gateway-cache.ts`, `apps/operate-server/src/node.ts`, and their
tests. Three wiring choices — `verifyBearer` at the per-tenant dispatch, `manifest` being the
served manifest, and `forgetApplication` in the poller — each typechecked and left every unit test
green when broken, so `node.test.ts` carries three text fences over them; the stranded-refusal
throw is fenced too.

In-process: `operate-runtime-pg` 790/790, `operate-server` 5566/5566 (148 files), `@crossengin/testing`
796/796, typecheck clean. Mutation checks, each failing its tests and reverted: refusal deleting the
applied pair (4), `forget` keeping it (3), `stranded` reported as `refused` (1), unverified-bearer
check removed (2), verified claim ignored (4), `billingPortal` back in `notPassed[1]` (2), api-key-first
ordering (the both-credentials test), `\s+` bearer match (the tab test), and each of the four node
fences.

Live on PG 16 in compose order, the API as `crossengin_app` on `--store pg` and as the owner on
`--store pg-columns` (which cannot boot as `crossengin_app`):

- A tenant's bearer session with no `x-tenant-id`, after her design was activated: `/v1/meta/schema`
  200 with 53 entities including the activated one; the same through the web proxy's session cookie.
  The control tenant: 51 entities and 404 for the other tenant's route.
- A non-JWT bearer plus a hint: 401 `credential_malformed`; a token with its `tenant_id` rewritten:
  401 `invalid_signature`; a bearer plus the platform api-key: the bearer wins.
- A tenant with a refused activation: its valid session 503, a forged bearer with its hint 401, and
  three forged requests on a cold cache built no gateway.
- `pg-columns`, a refused re-activation with 2 rows in the tenant schema: list 2 rows, POST 201, the
  tenant schema then 3 rows and the fallback 0, logged as still serving the last applied manifest.
  After a restart: list and POST 503 `tenant_schema_stranded`.

The live before/after row counts come from two runs: the implementer's (1 row, then 2) and the
later verification at HEAD (2 rows, then 3). They differ only in setup; both show reads and writes
on the tenant schema with the fallback untouched. The billing-portal arm was not run live: it needs
Stripe credentials and `--billing-portal-return-url`.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Retention is per process: a restart or a replica that never applied the manifest gives a 503 rather than rebuilding the last good manifest. A durable "last applied" record is a product decision. | Platform | _Open_ |
| On restart the `[tenant-schema]` line still says "REFUSED; serving from the JSONB fallback" immediately before the stranded 503, which is false. | Platform | _Open_ |
| HMAC and mTLS requests still route to the default gateway (the boot manifest); latent, since no compose passes `--hmac-key` or `--mtls-client`. Routing by key id or certificate before verification would reopen the 503-versus-401 oracle, so it needs verify-before-route like the bearer fix. | Platform | _Open_ |
| Routing lowercases the tenant id while the gateway's `ctx.tenantId` keeps the claim or hint verbatim, so an uppercase id from a foreign IdP would miss `registry.storeFor` and fall back to the JSONB store. The in-repo mint emits lowercase. | Platform | _Open_ |
| The gateway's 30-second clock skew is restated in `tenant-gateway-cache.ts` because the runtime does not export it. | Platform | _Open_ |

## References

- `apps/operate-server/src/tenant-gateway-cache.ts` (`bearerTenantVerifier`, `bearerToken`,
  `resolveRequestTenant`), `node.ts`, `node.test.ts`;
  `packages/operate-runtime-pg/src/tenant-store-registry.ts` (`ensureServing`,
  `forgetApplication`).
- Corrected in passing: the `node.ts` comments claiming the billing portal stays on the default
  server and that HMAC and mTLS requests route to a tenant's own gateway; the `notPassed[1]` reason
  in `node.test.ts`; a stale poller comment.
