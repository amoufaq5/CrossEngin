# ADR-0196: Role-gating the job-invoke endpoint

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-02 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0194 (userInvoked HTTP endpoint), ADR-0087 (operate-server), ADR-0077 (P2) |

## Context

ADR-0194 shipped `POST /v1/meta/jobs/invoke` open to any authenticated tenant principal — anyone with a
valid token for a tenant could fire that tenant's `userInvoked` jobs. Some on-demand jobs are
privileged (reindex, bulk export, data repair), so an operator needs to restrict who may invoke them.
This adds optional role-gating, modeled on the existing admin-settings gate.

## Decision

- **`buildJobInvokeHandler(invoker, gate?)`** gains an optional `JobInvokeGateOptions`:
  `allowedRoles?: ReadonlySet<string>` + a `principalRoles` bridge (principal → its role names). When
  `allowedRoles` is set, the caller must hold one of those roles (primary or secondary) or gets `403
  forbidden`; when unset, the endpoint stays open (backward-compatible with ADR-0194). The role check
  mirrors `admin-handlers`' `authorize` (roles = `[primaryRole, ...secondaryRoles]`, membership test).
- **Fail-closed.** A configured `allowedRoles` with **no** `principalRoles` bridge denies everyone
  (`403`), rather than silently falling open — a misconfiguration can't accidentally expose the
  endpoint.
- **Wiring.** A `jobInvokeRoles?: readonly RoleName[]` option on the gateway builder becomes the gate's
  `allowedRoles` (threaded through `buildOperateHttpServer`); `serve()` passes it from a repeatable
  `--job-invoke-role <role>` flag (requires `--enable-job-invoke`). No roles ⇒ open, as before.

## Consequences

- An operator can now scope on-demand job invocation: `--enable-job-invoke --job-invoke-role ops_admin`
  lets only `ops_admin` principals hit the route; every other role gets `403`. Omitting the flag keeps
  the ADR-0194 behavior (any authenticated tenant principal), so existing deployments are unaffected.
- Ordering is deliberate: `401` (no tenant) → `403` (role) → `400`/`404` (request shape / no match), so
  an unauthorized caller can't probe which actions exist. Own-tenant authority is unchanged — the
  principal's tenant is still authoritative over any body field.
- The gate lives entirely in the handler + its wiring; `JobDeclaration` is untouched (no per-job role
  field), so a single allow-list governs the endpoint. Per-*action* role requirements (a map from
  action → roles) are the natural next refinement.
- 7,001 tests pass (+7: handler — 202 in-list, 403 out-of-list, fail-closed-without-bridge, open-without-
  list; operate-server CLI — `--job-invoke-role` parse + default-empty + requires-enable). Full build +
  typecheck green.
- Follow-ups: per-action role requirements; auditing invocations (who invoked what); and the P2
  exit-criterion end-to-end against a live Postgres, still gated on real infrastructure.
