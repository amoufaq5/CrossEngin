# @crossengin/kernel

The CrossEngin substrate.

The kernel knows nothing about pharmacies, registries, admissions,
or construction. It knows about **entities, relations, states,
workflows, roles, audits** — and how to provision, run, and govern
those primitives per tenant.

Domain-specific behavior lives in **manifests**; the kernel
interprets manifests and materializes them as running applications.

## Responsibilities (per ADRs)

- **Multi-tenancy** — tenant resolution, isolation, lifecycle. ADR-0002.
- **Meta-schema** — dynamic entity engine, per-tenant Postgres provisioning. ADR-0003.
- **Manifest interpretation** — applies declarative bundles. ADR-0004.
- **Workflow runtime** — orchestrates state transitions. ADR-0007.
- **Audit** — immutable record of every meaningful action. ADR-0008.
- **Security** — encryption, secrets handling, RLS enforcement. ADR-0009.

## Adapters

Database access is adapter-driven. The primary adapter is
`@crossengin/kernel-supabase` (Round 1 decision); a Prisma-backed
adapter is used internally for on-prem and BYOC packaging.

## Status

Skeleton. Real implementation lands in Phase 2-3.
