# ADR-0165: operate-web client-side form submit + delete (Phase 3 P3.9)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0164 (operate-web write path), ADR-0156 (client hydration), ADR-0155 (React renderer), ADR-0163 (PG store), ADR-0080 (Phase 3 P3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.9).

## Context

P3.8 (ADR-0164) added the JSON write path (`POST/PATCH/DELETE /ui/...`) with
RBAC + write-mask enforcement, but the hydrated `/app/*` pages were still
read-only: the SSR `FormView` rendered a `<form method="post" action="/app/...">`
that pointed at a non-existent HTML write route, and there was no edit form or
delete control. P3.9 closes the UI loop — the hydrated React forms create / edit
records and the detail page deletes them, all by calling the existing P3.8 JSON
routes from the browser. The package stays hermetic (SSR-only, no jsdom), so the
behavioral logic lives in pure, fetch-injected helpers and the live DOM submit is
a documented manual smoke (consistent with P3.4's `hydrateRoot` smoke).

## Decision

- **`@crossengin/operate-web-react`** gained the client write primitives in
  `page-state.ts` (pure, fetch-injected, fully unit-tested):
  - `buildWriteUrl(entity, id?)` → `/ui/:entity[/:id]`.
  - `coerceFormValues(model, raw)` → a typed write payload from raw input values
    (number hints → `number`, booleans from checkboxes, read-only + empty-optional
    fields dropped, unknown keys ignored — the server write mask is still
    authoritative).
  - `WriteFetcher` / `defaultWriteFetcher` (a `fetch`-backed JSON writer reading
    `{ record }` / problem `detail`), `submitFormWrite({entity, entityId?, payload,
    fetcher})` (POST create / PATCH edit), `submitDelete(entity, id, fetcher)`.
  - `WebPageState`'s `form` variant gained optional `entityId` + `values` (edit
    target + prefill); the `detail` variant gained `canEdit` + `canDelete`.
  - `FormView` gained `values` (prefill), `onSubmit`, `submitting`, `statusNode`.
  - `page.tsx` gained two stateful client components the SSR renders and the
    client hydrates: **`FormSection`** (collects `FormData` → `coerceFormValues`
    → `submitFormWrite`; on success navigates to the record detail, on a 4xx shows
    the server's problem `detail` — e.g. a write-mask 422 — inline) and
    **`DetailSection`** (`DetailView` + an Edit link when `canEdit` + a Delete
    button when `canDelete`; delete navigates back to the entity table).
    `PageRoot` routes the `form`/`detail` branches to them. Navigation +
    `FormData` are injectable (`writeFetcher`, `onNavigate`) so tests stay
    DOM-free.
- **`apps/operate-web`** computes the affordance flags + serves the edit form:
  - `serveDetailHtml` resolves `canEdit`/`canDelete` via the
    `EntityFieldResolver.canPerform("update"/"delete")` grants and embeds them, so
    an unauthorized caller's page never even renders the control (the server still
    enforces RBAC on the eventual request — defense in depth, not just hiding).
  - A new `GET /app/:entity/:id/edit` route renders the edit form prefilled with
    the redacted record + the PATCH target id.
  - `renderDetailPage` / `renderFormPage` gained the permission flags / edit args.

## Cross-cutting invariants enforced

- **The client never bypasses the server's authority.** `coerceFormValues` drops
  read-only/unknown fields, but the server's RBAC + write mask (P3.8) remain the
  source of truth — a 403/422 is surfaced inline, not worked around. The
  Edit/Delete affordances are gated by server-computed grants, so a cashier's
  detail page shows neither (and the request would 403 anyway).
- **Prefill carries only redacted data.** The edit form's `values` are the
  `redactRecord`-ed record, so a field the caller can't read is never prefilled
  (and the form omits it — the compiler dropped it).
- **Hermetic tests.** The submit/delete orchestration is tested with a fake
  `WriteFetcher` (create→POST, edit→PATCH, delete→DELETE, 422 surfaced); the
  affordance gating + edit prefill are asserted in the SSR markup. Live
  `hydrateRoot` DOM submit is a manual browser smoke.

## Alternatives considered

- **HTML form POST to a new `/app` write route.** No — the write API is the JSON
  `/ui` path (P3.8); a parallel HTML-form write route would duplicate RBAC + the
  write mask. Submitting the JSON route via `fetch` reuses it exactly.
- **Always show Edit/Delete and let the server 403.** No — gating by the
  server-computed grant is better UX and avoids dangling controls; the server
  still enforces, so it's not security-by-hiding.
- **Full client-side routing (SPA navigation after write).** Deferred — a
  `window.location` navigation to the SSR detail/table page is enough to close
  the loop; an SPA router is a later increment.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 6,947 offline tests + 45 gated
  real-Postgres integration tests + five CI gates.** operate-web's UI is now
  fully interactive: a user creates, edits, and deletes records from the browser
  (against the P3.8 RBAC/write-mask-enforced JSON routes), with affordances gated
  by their grants and server errors surfaced inline. No new META_ tables. Full
  client-side routing stays the follow-up.
