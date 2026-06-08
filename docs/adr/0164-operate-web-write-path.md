# ADR-0164: operate-web write path — RBAC + write-mask-enforced mutations (Phase 3 P3.8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0163 (operate-web PG store), ADR-0162 (kanban/calendar), ADR-0067 (classification write mask), ADR-0078/0087 (operate-runtime RBAC handlers), ADR-0080 (Phase 3 P3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.8).

## Context

`apps/operate-web` (P3.1–P3.7) was read-only: `dispatch` rejected every non-GET
with 405, so the hydrated `/app/*` forms and the `/ui/...` JSON API could
describe a create/edit form but never submit it. The write path was the biggest
deferred UI item. The pieces existed: the `EntityStore` already had
`create`/`update`/`remove` (operate-runtime/-pg), `@crossengin/auth`'s `rbacCheck`
enforces entity-level grants, and operate-web's `EntityFieldResolver` already
computed a per-field `{read, write}` access map (used to mark form fields
`readOnly`). P3.8 turns that into enforced mutations — and goes one step stricter
than operate-server's gateway handlers, which enforce entity-level RBAC but write
`parsedBody` verbatim: operate-web also enforces the **per-field write mask**, so
a caller can't set a field they aren't allowed to write.

## Decision

- **Three mutation routes** on `OperateWebServer` (the JSON `/ui` API; `/app/*`
  HTML pages stay GET-only):
  - `POST   /ui/:entity`      → 201 `{ record }` (create)
  - `PATCH  /ui/:entity/:id`  → 200 `{ record }` (update)
  - `DELETE /ui/:entity/:id`  → 204 (delete)
  `dispatch` now routes GET/POST/PATCH/DELETE (others → 405); the public client
  bundle stays a GET-only pre-auth asset. PATCH/DELETE ignore the reserved GET
  sub-route words (`new`/`kanban`/`calendar`) so they're never mistaken for a
  record id.
- **Two-layer authorization** on every write:
  1. **Entity-level RBAC** — a new `EntityFieldResolver.canPerform(operation)`
     wraps `rbacCheck` against the manifest's `create`/`update`/`delete` grants;
     a denial is `403` with the RBAC reason. Fail-closed for an unknown viewer.
  2. **Per-field write mask** — a new pure `unwritableFields(record, access)`
     returns every payload key the viewer can't write (a read-only/redacted field,
     or a key that isn't a manifest field at all — so an arbitrary column can't be
     smuggled past). Any violation is `422` listing the blocked fields. `id` is
     always permitted (it identifies the row, not a writable attribute).
  The returned record is `redactRecord`-ed for the caller, so the write response
  never leaks a field the viewer can't read either.
- **Body plumbing.** `RawWebRequest` gained an optional `body`. The Node listener
  (`createNodeRequestListener`) collects the request stream into a `Uint8Array`
  for non-GET methods; the edge adapter `fetchToRaw` became async and reads
  `request.arrayBuffer()` for writes (GET/HEAD carry no body). A missing/invalid
  JSON body, or a non-object body, is `400`.

## Cross-cutting invariants enforced

- **A field you can't write, you can't set.** A cashier creating a `SalesOrder`
  with the `pii` `customer_email` (no write grant) gets `422`; without it, `201`.
  A manager writing `Product.unit_cost` (a `commercial_sensitive` field they're
  granted) succeeds. This closes the loop the read-side redaction opened.
- **Delete is as privileged as the manifest says.** Retail `Product` delete is
  admin-only — a `store_manager`'s DELETE is `403`, a `retail_admin`'s is `204`.
- **No field leaks on the write response.** The created/updated record is
  redacted for the caller before it's returned.

## Alternatives considered

- **Mirror operate-server exactly (entity RBAC only, write `parsedBody`).** No —
  operate-web compiles forms that already mark fields `readOnly` per the write
  mask; enforcing that same mask on submit is the consistent, fail-closed
  contract (and a genuine hardening over the gateway handlers).
- **Strip unwritable fields silently instead of 422.** No — silently dropping a
  field a caller tried to set hides a bug/permission problem; an explicit 422
  naming the fields is honest.
- **A separate `/api` write prefix.** No — REST verbs on the existing
  `/ui/:entity[/:id]` paths are cohesive and need no new route namespace.
- **Form-driven submit (HTML POST from `/app/*`).** Deferred — the write path is
  the JSON API; wiring the hydrated client form to POST it is a follow-up.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 6,933 offline tests + 45 gated
  real-Postgres integration tests** (17 worker + 22 operate-server + **6
  operate-web**, the new one a create→update→delete round-trip with RBAC +
  write-mask over real PG) **+ five CI gates**. operate-web is no longer
  read-only: a manifest's UI can create/update/delete records, with RBAC + the
  classification write mask enforced server-side and the response redacted —
  reusing the same auth primitives as the read path. No new META_ tables.
