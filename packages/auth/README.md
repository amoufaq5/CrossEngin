# @crossengin/auth

RBAC v2 + ABAC + audit primitives for CrossEngin.

Per ADR-0008:

- **RBAC v2** — coarse role-to-permission mapping. Roles are
  manifest-defined; permissions are kernel-defined verbs over kernel
  resources.
- **ABAC** — attribute-based predicates evaluated per request via
  OPA Rego (compiled to WASM through `opa-wasm`). Predicates can
  reference tenant attributes, user attributes, resource attributes,
  and request context.
- **Audit** — every authorization decision, every state transition,
  every signature, every export emits an immutable audit record.
- **Sessions** — short-lived JWTs + refresh; bound to a session
  record server-side so revocation is immediate.

## What this package does NOT do

- It does not embed Supabase Auth. The Supabase adapter
  (`@crossengin/kernel-supabase`) is the place that bridges Supabase
  sessions into a `KernelContext`. This package's surface is
  storage-agnostic.

## Status

Skeleton. Implementation lands in Phase 2 alongside the kernel.
