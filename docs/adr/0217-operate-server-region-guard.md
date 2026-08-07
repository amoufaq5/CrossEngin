# ADR-0217: operate-server data-residency edge routing (Phase 3 P6.6)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0216 (residency-runtime), ADR-0087 (operate-server), ADR-0098 (JWT/tenant cross-check), ADR-0077 (P3 plan — P6) |

## Context

ADR-0216 shipped the pure region-routing engine but nothing enforced it at the serving edge. This wires
it into `operate-server` so a running instance, knowing its own region, redirects a tenant to its home
region (or denies) when residency forbids serving here — the live P6 enforcement point.

## Decision

- **Pre-dispatch region guard** (`operate-server`, `server.ts`). `OperateHttpServer` gains an optional
  `regionGuard = {region, directory, tenantHeader?}`. Before building the gateway request (after the
  webhook bypass), `checkResidency` reads the request's tenant hint header (default `x-tenant-id`),
  resolves the tenant's `ResidencyProfile` from the directory, and runs `decideRegionRouting` (ADR-0216):
  - `redirect` → **`421 Misdirected Request`**, a `misdirected-region` problem doc naming the home region
    in an `x-crossengin-region` header + a `correctRegion` extension;
  - `deny` → **`403`** `residency-violation`;
  - `serve` (or no hint / no profile) → returns `null`, dispatch proceeds to the gateway.
- **Hint used only to route, never to grant.** The tenant hint is unverified (pre-auth), so it only
  *redirects* or *denies* — a spoofed hint can at worst misdirect the attacker's own request; the gateway
  still authenticates authoritatively (and its ADR-0098 cross-check rejects a hint that disagrees with
  the credential's tenant). A tenant with **no profile is unconstrained** (fail-open for routing:
  residency only binds tenants that declare a profile), while a profiled tenant is fail-closed (served
  only from an allowed region).
- **Wiring** (`node.ts` + `cli.ts` + `residency-source.ts`). `--region <id>` (validated against the
  `residency` region catalog) sets the serving region; `--residency-file <file>` (requires `--region`)
  loads a `{tenants:[{tenantId, profile}]}` directory via `loadResidencyDirectory` (each profile
  validated through `ResidencyProfileSchema` at boot). Both present → the guard is wired into
  `buildOperateHttpServer`.

## Consequences

- Data residency is now enforced live: `operate-server --region us-east --residency-file r.json` bounces
  an `eu-only` tenant's request to `eu-central` with a `421` + `x-crossengin-region: eu-central`, so a
  load balancer / client can re-route to the correct region — an EU tenant's data is never served from a
  US instance.
- The guard sits ahead of the gateway (like the Stripe webhook), so it costs nothing when unconfigured
  and adds one directory lookup when on. It is orthogonal to auth: routing by hint, enforcement by the
  gateway.
- Enforcement is per-request and stateless beyond the directory; a `421` (not a `3xx`) is used because
  the instance doesn't know peer regions' hostnames — it names the region and lets the edge route.
- 7,263 tests pass (+9: guard redirect-421-with-home-region / serve-in-allowed-region / no-hint-proceeds
  / no-profile-proceeds; `loadResidencyDirectory` parse + malformed-profile reject; `--region` +
  `--residency-file` CLI parse / invalid-region / requires-region). Full build + typecheck green.
- Follow-ups: a Postgres `TenantResidencyDirectory` (P6.5) so the directory isn't a static file;
  deriving the region into the marketplace `tenantContext` (P5.6 follow-up); active-active failover
  wiring `selectServingRegion` to a live-region set.
