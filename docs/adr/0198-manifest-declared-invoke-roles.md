# ADR-0198: Manifest-declared invoke roles

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0197 (per-action invoke roles), ADR-0196 (job-invoke role gating), ADR-0077 (P2) |

## Context

ADR-0197 let an operator restrict job invocation per action via `--job-invoke-action-role`. But who may
run a job is really a property of the *job* — the pack author knows `reindex-catalog` is a
catalog-admin task, not the operator wiring the deployment. Requiring every deployment to re-declare
that on the command line is error-prone (forget a flag → an open sensitive action). This lets the
manifest declare it, so the requirement travels with the pack; the operator override stays as an
escape hatch.

## Decision

- **`JobDeclaration.invokeRoles`** (`@crossengin/jobs`) — an optional non-empty `string[]` on a job.
  For a `userInvoked` job it names the roles permitted to invoke that job's action. Additive + optional,
  so existing manifests parse unchanged.
- **`invokeRolesByAction(jobs)`** (pure, `@crossengin/jobs`) — builds `{action → roles}` from every
  non-deprecated `userInvoked` job that declares `invokeRoles` (unioning roles when several jobs share
  an action). This is the manifest-derived counterpart of ADR-0197's operator map.
- **Merge, operator wins per action.** `operate-server` composes the effective gate as
  `mergeActionRoleMaps(invokeRolesByAction(manifestJobs), buildActionRoleMap(--job-invoke-action-role))`
  — the manifest is the baseline, and an operator's `--job-invoke-action-role` **overrides** a given
  action's roles entirely (an escape hatch to tighten or retarget in a specific deployment). The
  combined map feeds the same `rolesByAction` gate from ADR-0197, so the handler is unchanged.

## Consequences

- A pack author writes `invokeRoles: ["catalog_admin"]` on the `reindex-catalog` job and every
  deployment that installs the pack gates that action to `catalog_admin` automatically — no CLI flag
  required. The requirement is now schema, not deployment config, which is where it belongs.
- The operator override remains for deployment-specific needs (a tenant that wants a different role, or
  to lock down an action the pack left open); it wins per action, so it can only be applied
  deliberately.
- Fully backward compatible and composable: no `invokeRoles` anywhere + no CLI overrides ⇒ the
  ADR-0194 open behavior; CLI-only ⇒ ADR-0197; manifest-only ⇒ this; both ⇒ operator-overrides-
  manifest. The gate resolution (`rolesByAction.get(action) ?? allowedRoles`) is unchanged.
- 7,012 tests pass (+4: `invokeRolesByAction` — map by action, skip non-userInvoked/no-roles/deprecated,
  union on shared action; `mergeActionRoleMaps` — override-per-action + no-mutate-base). Full build +
  typecheck green.
- Follow-ups: a manifest cross-validator that `invokeRoles` reference declared roles; surfacing the
  effective gate on an introspection endpoint; the P2 exit-criterion end-to-end against a live Postgres.
