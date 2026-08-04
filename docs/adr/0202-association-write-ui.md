# ADR-0202: Association write UI — link / unlink from the detail view (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0201 (m2m related lists — read), ADR-0095 (store link/unlink API), ADR-0080 (renderer), ADR-0077 (P3) |

## Context

ADR-0201 rendered a record's many-to-many associations read-only. The store's `link` / `unlink` API has
existed since P1.15 (ADR-0095), but there was no HTTP write route and no UI, so a user couldn't add or
remove an association. This adds the write path — the association panel becomes editable.

## Decision

- **Manifest-derived association write routes** (`operate-runtime`, `association.ts`).
  `manifestAssociationWriteRoutes` turns each `many_to_many` relation into `PUT` (link) + `DELETE`
  (unlink) routes per direction: `/v1/<owner>/{id}/<related>/{relatedId}` (an `AssociationWriteRouteSpec`
  with the extra `{relatedId}` path param), registered in `compileOperateServer`.
- **`buildAssociationWriteHandler`** RBAC-checks **`update` on the *owner***  (managing a record's
  associations is part of updating it — a different, stricter gate than the read side's `list` on the
  *related*), maps `{id}` + `{relatedId}` to the relation's (left, right) via `ownerIsLeft`, and calls
  the store. Idempotent — `link` no-ops if already linked, `unlink` returns `204` either way; both
  return `204`. `501 associations_unsupported` when the store can't write.
- **`AssociationWriter`** (structural `link` / `unlink`) + `isAssociationWriter` — the capability seam,
  matching the read side's `AssociationReader`; the column store satisfies it, others get `501`.
- **The renderer panel becomes editable** (`operate-web`). When the viewer can `update` the owner, each
  association row gets a **Remove** (unlink) button and the panel gains an **add** control — the
  existing `ReferencePicker` for the related entity + a **Link** button — both refreshing the list.
  The panel now shows even when empty (so associations can be added); it still hides entirely on a
  read failure / unsupported store. `linkAssociation` / `unlinkAssociation` API helpers issue the
  `PUT` / `DELETE`.

## Consequences

- A user can now curate a record's m2m associations directly from its detail page — the manifest's
  full relational model is not just visible (ADR-0200/0201) but editable, with zero per-entity code.
- The authorization split is deliberate: **reading** associations needs `list` on the related entity;
  **writing** needs `update` on the owner. So a viewer who can see a record's tags can't add/remove
  them unless they can also edit the record.
- Works on the column store (join tables); other stores return `501` and the write controls'
  operations no-op-fail, consistent with the read side's honest degradation.
- 7,032 tests pass (+6: write-route derivation — link/unlink both directions + `{relatedId}` param;
  `isAssociationWriter`; handler — 401 / 403-on-owner-update / link-maps-left-right / unlink / 501).
  `operate-web` verified by strict `tsc`. Full build + typecheck green.
- Follow-ups: an `AssociationWriter` for the JSONB store; optimistic UI + inline errors on link/unlink;
  bulk link; relation counts.
