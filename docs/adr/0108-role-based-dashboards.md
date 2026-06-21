# ADR-0108: Role-based dashboards + navigation

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0106 (department modules), ADR-0105 (manifest-driven UI), ADR-0107 (finance depth) |

## Context

The console (ADR-0105/0106) showed every entity and department to every user,
regardless of role. With 50 entities, 15 roles, and 19 workflows, a warehouse
clerk and a financial controller saw the same wall of links. The manifest already
declares per-entity permissions and per-transition role grants — the UI just
wasn't using them. Each user should land on a workspace scoped to what their role
can actually do.

## Decision

Drive navigation and the dashboard from the authenticated principal's role,
sourced declaratively from the manifest — no per-user UI config.

**Runtime (`operate-runtime/ui-schema.ts`)** — the UI schema now carries:
- `UiEntitySchema.access` — the roles permitted per operation (list/read/create/
  update/delete), derived from `manifest.permissions`.
- `UiTransitionSchema.roles` — the roles that may fire each lifecycle transition.
- `UiSchema.roles` — the role catalog (name + label + description) from
  `manifest.roles`.
- The `/v1/meta/schema` handler computes a per-request `viewer`
  (`{primaryRole, roles}`) from the same `principalRoles` bridge the gateway uses,
  so the response is tailored to the caller.

**Web (`operate-web`)** — pure, fail-open helpers in `lib/schema.ts`
(`viewerRoles`, `canAccess`, `accessibleEntities`, `viewerActions`, `roleLabel`):
- The **sidebar** lists only departments/entities the viewer can read, and shows
  the viewer's role.
- The **dashboard** greets the user by role and shows: stats over *their* areas,
  a **Quick create** row (entities they can create), a **Workflows you own**
  panel (entities with transitions their role may fire, with the action chips),
  and **Your departments** (accessible entities grouped, each marked
  create-able vs read-only).
- The **list page** hides the *New* button and the create form when the role
  lacks `create`, and honours a `?new=1` deep link from Quick create.

With no `viewer` (unauthenticated / dev), every helper is fail-open — the full
console renders, so local development is unchanged.

## Consequences

- A controller lands on ~20 finance/accounting/asset/tax entities; a warehouse
  clerk on ~5 inventory/shipment entities — verified against a live server with
  two API keys.
- Access is **advisory in the UI, enforced at the gateway**: the dashboard hides
  what a role can't do, but RBAC (`rbacCheck`) + classification redaction still
  guard every request, so a hand-crafted call is rejected regardless of UI state.
- Adding a role or changing a permission in the manifest reshapes every user's
  workspace with zero UI code.
- 6,5xx tests pass, zero type errors, `operate-web` build green.
- Follow-ups: a role switcher for admins (preview another role's workspace),
  count badges (open items per entity) on the dashboard, and a cross-department
  approvals inbox (#6) built on `viewerActions`.
