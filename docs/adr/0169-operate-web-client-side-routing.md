# ADR-0169: operate-web client-side SPA routing (Phase 3 P3.13)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0156 (client hydration), ADR-0165 (form submit), ADR-0168 (interactive kanban), ADR-0080 (Phase 3 P3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.13).

## Context

The `/app/*` pages were SSR + hydrated, but every navigation — a row link to a
detail page, a board/calendar link, a create/edit/delete/transition redirect
(`window.location.assign`) — did a full browser reload. P3.13 turns those into
in-page state swaps: a single-page-app router that fetches the target page's
already-compiled, redacted `WebPageState` and re-renders, with no reload.

The key enabler: the server already builds a `WebPageState` for each `/app`
route (it embeds it in the SSR page for hydration). P3.13 exposes that state as
JSON under `?__state=1`, so the client reuses the **exact** server
compile/redaction for every page kind (including edit forms) — no client-side
re-assembly, no redaction logic on the client.

## Decision

- **Server (`apps/operate-web`)**: `?__state=1` on any `/app/*` route returns the
  `WebPageState` as JSON instead of the HTML document. `html.ts`'s `pageFor`
  gained a `stateOnly` flag (→ `jsonResponse(200, state)` vs
  `renderHydratablePage`); every `renderXPage` + `serve*Html` threads it;
  `dispatchApp` sets it from `query["__state"] === "1"`. The state is the same
  redacted models + data the HTML embeds — RBAC affordance flags
  (`canEdit`/`canDelete`), edit prefill, redacted rows, all already computed.
- **Client (`@crossengin/operate-web-react`)**: pure, fetch-injected helpers in
  `page-state.ts` — `appStateUrl(href)` (adds `__state=1`, preserving query),
  `fetchPageState(href, fetcher?)`, `isInternalAppHref(href, origin)` (same-origin
  `/app/...` gate) — plus a new `AppRouter` component (`router.tsx`). `AppRouter`
  renders the **same** `PageRoot` the SSR did (so `hydrateRoot` attaches cleanly),
  holds the current `WebPageState`, and on mount (in an effect) intercepts clicks
  on internal `/app` links + `popstate` (Back/Forward): it `fetchPageState`s the
  target, swaps the rendered page, and `history.pushState`s. The router's
  `navigate` is threaded as `PageRoot.onNavigate`, so the P3.5/P3.9/P3.12 write
  redirects (create/edit/delete/transition) become SPA transitions too.
- `client.tsx` now `hydrateRoot`s `AppRouter` (was bare `PageRoot`). All browser
  interaction (document listeners, `history`, `fetch`) lives in the effect /
  handler — never in SSR render — so the server still renders just `PageRoot`.

## Cross-cutting invariants enforced

- **The client never re-derives redaction.** Every navigated page's state comes
  from the server's `?__state=1` (the same compile + `redactRecord` as the HTML),
  so a field the caller can't read is absent client-side exactly as server-side —
  proven: a cashier's `/app/Product/p1?__state=1` omits `unit_cost` and reports
  `canEdit:false`, a manager's includes it + `canEdit:true`.
- **Hydration parity.** `AppRouter`'s initial render is byte-identical to
  `PageRoot`'s for the same state (a unit test asserts `renderToStaticMarkup`
  equality), so hydration attaches without mismatch.
- **Graceful fallback.** External / non-`/app` / modified-click / `_blank` /
  download links fall through to a normal browser navigation; without the flag
  the server still serves HTML, so the pages work with JS disabled.

## Alternatives considered

- **Re-assemble the state client-side from `/ui/...` JSON.** No — that would
  duplicate the page-state shaping (which model, basePath, canEdit/canDelete,
  edit prefill) on the client and has no JSON source for the edit form.
  `?__state=1` reuses the server path verbatim, covering all page kinds.
- **A dedicated `/state/...` route namespace.** No — a query flag on the existing
  `/app` routes keeps one routing table and one auth/compile path.
- **A history/router library.** No — the surface is small (intercept clicks +
  popstate, fetch + setState); a hand-rolled `AppRouter` keeps the package
  dependency-light and the pure parts unit-testable.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 6,983 offline tests + 46 gated
  real-Postgres integration tests + five CI gates.** `/app/*` navigation is now a
  single-page experience — link clicks, Back/Forward, and write redirects swap
  pages over each route's `?__state=1` JSON without a reload, reusing the server's
  exact compile + redaction. No new META_ tables. Live click/popstate DOM
  behavior is a manual browser smoke (the package is jsdom-free); the pure
  helpers + SSR parity are unit-tested.
