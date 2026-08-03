# ADR-0199: invokeRoles cross-validator

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0198 (manifest-declared invoke roles), ADR-0058 (pack-erp-core), ADR-0077 (P2) |

## Context

ADR-0198 added `JobDeclaration.invokeRoles` so a pack author declares which roles may invoke a
`userInvoked` job. But the kernel didn't validate those references: a typo (`catalog_admn`) or a role
that isn't in the manifest would pass `validateManifest` and only surface at serve time as a job that
*no one* can invoke (fail-closed 403 for everyone) — a silent, hard-to-diagnose gate. A cross-validator
catches it at authoring time, like every other manifest cross-reference (permission grants, workflow
triggers, relation targets).

## Decision

Extend `validateJobs` (which already runs inside `validateManifest`) with the manifest's `rolesMap`
(from `validateRoles`) and two checks per job that declares `invokeRoles`:

- **Declared-role reference.** Every role in `invokeRoles` must exist in `manifest.roles`; an unknown
  role throws `ManifestValidationError` at `jobs.<key>.invokeRoles` — mirroring the existing
  permission-grant role check (`grants role '…' which is not declared`).
- **userInvoked-only.** `invokeRoles` is only meaningful on a `userInvoked`-trigger job (that is the
  only trigger with an `action` to gate); declaring it on a `scheduled` / `event` / etc. job is a
  no-op mistake and throws.

Because `validateManifest` runs on the *resolved* manifest, an `invokeRoles` in an extending pack is
checked against the merged role set (core + overlay), so a job can reference a role its parent pack
declared.

## Consequences

- A pack that gates `reindex-catalog` to a mistyped or undeclared role now fails validation at author /
  CI time (`crossengin validate`) instead of shipping a silently-unreachable action. The class of bug
  — "the invoke endpoint 403s everyone and no one knows why" — is caught statically.
- Consistent with the manifest's other cross-validators (roles/permissions/workflows/relations all
  reference-check); `invokeRoles` is no longer the one job field that could dangle.
- Backward compatible: no manifest in the repo declares `invokeRoles` yet, so the check is dormant for
  existing packs; it only constrains manifests that opt into ADR-0198's field.
- 7,015 tests pass (+3: accepts all-declared invokeRoles, rejects an undeclared role, rejects
  invokeRoles on a non-userInvoked job). Full build + typecheck green.
- Follow-ups: an introspection endpoint surfacing the effective per-action gate; the P2 exit-criterion
  end-to-end against a live Postgres.
