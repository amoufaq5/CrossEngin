# @crossengin/kernel

The CrossEngin substrate. Per **ADR-0002**, the kernel knows about
tenancy, sessions, and the lifecycle of every request that crosses
into a tenant's data.

## Implemented

### `@crossengin/kernel/tenancy`

Tenant resolution per **ADR-0002 § Tenant routing and context**.

Given an incoming request — a URL and an optional already-verified
session tenant — the resolver yields a `TenantId` and the source
that produced it.

```ts
import { createTenantResolver } from "@crossengin/kernel/tenancy";

const resolver = createTenantResolver({
  directory,                     // your TenantDirectory implementation
  baseDomain: "crossengin.io",   // for subdomain extraction
  pathPrefix: "/t",              // for path-prefix extraction
});

const { tenantId, source } = await resolver.resolve({
  url: new URL(request.url),
  sessionTenantId: session?.tenantId,
});
```

Resolution order:

1. **URL — subdomain** (e.g., `acme-pharma.crossengin.io`).
2. **URL — path prefix** (e.g., `/t/acme-pharma/...`).
3. **Session** (`sessionTenantId` passed by the caller).

If URL and session both yield a tenant ID and they disagree, the
resolver throws `ConflictingTenantSourcesError`. If no source
yields, the resolver throws `TenantNotResolvedError`.

To prevent information leakage, the same `TenantNotResolvedError`
covers both "slug not in directory" and "no tenant context at all"
— callers can't distinguish a stale tenant URL from a tenant-less
request.

The `TenantDirectory` interface is caller-provided. Production
implementations live in adapter packages
(`@crossengin/kernel-supabase`); tests use in-memory fakes.

## Slug rules

Tenant slugs (extracted from subdomains or path prefixes) must
match `/^[a-z0-9][a-z0-9-]*$/` — lowercase letters, digits, and
hyphens; no leading hyphen; no dots.

Multi-level subdomains are rejected in v1: `eu.acme.crossengin.io`
yields no tenant.

## Not yet implemented

- Connection management (Postgres pool, `SET ROLE`, `SET search_path`,
  `SET LOCAL app.current_tenant_id`) — ADR-0010 +
  `@crossengin/kernel-supabase`.
- Meta-schema operations (DDL diff, manifest application) — ADR-0003.
- Workflow runtime — ADR-0007.
- Audit emission — ADR-0008.
- Security primitives (encryption, signing) — ADR-0009.

## Run tests

```bash
pnpm --filter @crossengin/kernel test
```
