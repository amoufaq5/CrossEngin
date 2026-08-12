# ADR-0243: Third-party pack authoring HTTP routes in operate-server (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0241 (submission engine), ADR-0242 (submission persistence), ADR-0215 (marketplace admin install routes), ADR-0077 (Phase 4) |

## Context

The third-party submission pipeline exists (ADR-0241) and is durable (ADR-0242), but was reachable only
in-process. This exposes it over HTTP — the author-facing edge that completes the marketplace-author
arc, mirroring the existing admin install routes (ADR-0215).

## Decision

- **`marketplace-authoring.ts`** — author + reviewer HTTP handlers over the
  `PersistentPackSubmissionEngine` + `PostgresPackVersionStore`, injected via the gateway's `extraRoutes`
  hook (`buildMarketplaceAuthoringRoutes`):
  - `POST /v1/authoring/packs` — submit a signed version (author role) → `draft` (`201`).
  - `POST /v1/authoring/packs/{packId}/versions/{version}/submit-for-review` (author) → `in_review`.
  - `POST /v1/authoring/packs/{packId}/versions/{version}/review` (reviewer) — record pass/fail.
  - `POST …/publish` (reviewer) — `in_review → published`, gated.
  - `POST …/withdraw` (author) — retire with a reason.
  - `GET …/versions` + `GET …/versions/{version}` — list / fetch.
  - **Role split**: `authorRoles` gate submit/withdraw/reads, `reviewerRoles` gate review/publish —
    separation of duties, so an author can't approve their own pack. Both fail-closed (empty set ⇒
    nobody).
  - Errors map cleanly: unauthenticated → `401`, wrong role → `403`, missing version → `404`, a bad
    signature → `400`, an illegal transition / publish-gate failure → `409`. The pure engine's
    validation is the gate; the handler translates the outcome.
- **`--marketplace-authoring` flag** (needs `--store pg`): `serve()` builds the persistent engine + store
  and appends the authoring routes to `extraRoutes` (composed with the admin routes when both are on —
  the wiring now accumulates into one route list). Default roles `pack_author` / `marketplace_reviewer`.

## Consequences

- The marketplace author flow is now reachable end-to-end over HTTP: a third-party author signs and
  `POST`s a pack version, a reviewer walks it through security review → publish, all persisted to
  `meta.pack_versions` — the deployed server is the submission surface, not just the install surface.
- Separation of duties is enforced at the edge (author ≠ reviewer role), matching the platform's
  four-eyes posture; the publish gate + signature check live in the pure engine, so the HTTP layer only
  authorizes + translates.
- Reuses the same `extraRoutes` seam and handler shape as the admin routes, so the two marketplace
  surfaces compose without special-casing; the gateway pipeline (auth, audit, problem docs) wraps them
  like any route.
- +9 tests (submit accept/deny/bad-signature; the full submit → review → publish flow; author-can't-
  review + failed-review-can't-publish; 404 on a missing version; get/list; CLI parse + requires-pg).
  `serve()` stays offline-untestable, like the admin routes. Full build + typecheck + workspace tests
  green. No META tables, no new package.
- Follow-ups (open): a bundle-upload endpoint (the routes take the bundle hash today, not the bytes);
  author key registration / onboarding; review-history rows beyond the current version row.
