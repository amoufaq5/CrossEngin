# ADR-0197: Per-action role requirements for job invocation

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0196 (job-invoke role gating), ADR-0194 (userInvoked HTTP endpoint), ADR-0077 (P2) |

## Context

ADR-0196 role-gated `POST /v1/meta/jobs/invoke` with a single allow-list — one role set governs *every*
invokable action. But actions differ in sensitivity: `reindex-catalog` might be a catalog-admin task
while `export-report` is an analyst task, and a bulk `purge` should be tighter still. A single list
can't express that. This adds per-action role requirements that override the default.

## Decision

- **`JobInvokeGateOptions.rolesByAction`** — a `ReadonlyMap<string, ReadonlySet<string>>` keyed by
  action. When an action is present, **its** role set governs that action, *replacing* the default
  `allowedRoles` (override, not intersection — so a specific action can require a role the default
  doesn't grant). An action absent from the map falls back to `allowedRoles`; if neither applies, the
  action is open. `effectiveAllowedRoles(action, gate) = rolesByAction.get(action) ?? allowedRoles`.
- **The role check moves after action-parse** (401 no-tenant → 400 blank-action → 403 role →
  404/202), because the effective rule now depends on the action. The probe-safety property is
  preserved: the 403 still runs **before** the invoke, so an unauthorized caller never learns whether
  a job exists — only that the action (which they named) is gated.
- **Fail-closed, unchanged.** An effective role set with no `principalRoles` bridge denies everyone.
- **Wiring.** A `jobInvokeActionRoles?: ReadonlyMap<...>` gateway option feeds `rolesByAction`;
  `operate-server` parses repeatable `--job-invoke-action-role <action:role>` specs (accumulating
  roles per action) into the map via the pure `buildActionRoleMap`, gated behind `--enable-job-invoke`.

## Consequences

- An operator can now scope invocation per action:
  `--job-invoke-role ops_admin --job-invoke-action-role reindex-catalog:catalog_admin` lets `ops_admin`
  run everything *except* `reindex-catalog`, which only `catalog_admin` may run. Actions with no rule
  and no default stay open — the override model lets a deployment gate just the sensitive actions.
- Composes cleanly with ADR-0196: `allowedRoles` is the default, `rolesByAction` the per-action
  exception. Omitting both keeps the ADR-0194 open behavior; omitting only `rolesByAction` is exactly
  ADR-0196.
- The override (not AND) semantics is deliberate — a per-action rule can *grant* a role the default
  omits, which an AND-with-a-coarse-pre-gate could not. The trade-off: a per-action list must be
  complete for that action (it fully replaces the default there).
- 7,008 tests pass (+7: handler — per-action override beats default / default fallback for un-listed /
  gate-only-that-action-leaving-others-open; operate-server — `buildActionRoleMap` parse + malformed,
  CLI parse + malformed + requires-enable). Full build + typecheck green.
- Follow-ups: reading per-action role requirements from the manifest's job declarations (so the pack
  author, not the operator, declares them); auditing invocations; the P2 exit-criterion end-to-end
  against a live Postgres, still gated on real infrastructure.
