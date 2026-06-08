# ADR-0166: operate-web SSR kanban + calendar pages (Phase 3 P3.10)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0162 (kanban/calendar view models + JSON routes), ADR-0155 (React SSR renderer), ADR-0156 (hydration), ADR-0165 (client form submit), ADR-0080 (Phase 3 P3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.10).

## Context

P3.6 (ADR-0162) compiled the manifest's `kanban` + `calendar` views into
redaction-aware view models and served them as JSON (`/ui/:entity/kanban`,
`/ui/:entity/calendar`), but the SSR React layer (P3.3–P3.5) only rendered HTML
pages for `table`/`detail`/`form` (`/app/...`). A board or calendar was
data-available but had no server-rendered page. P3.10 adds the two React
components + the `/app/:entity/kanban|calendar` HTML routes, completing the P3.6
view kinds visually — reusing the same per-caller compile + redaction + store
read as the JSON siblings.

## Decision

- **`@crossengin/operate-web-react`** gained two presentational components
  (typed by the operate-web models, pure SSR):
  - **`KanbanView`** ({model, rows, basePath}) — renders one column per declared
    state, grouping rows by `stateField`, each card showing only the model's
    (already redacted) `cardFields` and linking to the record's detail. The column
    header shows the card count (+ the WIP limit when declared); a record whose
    state matches no column is dropped (the board shows declared lanes only).
  - **`CalendarView`** ({model, rows, basePath}) — renders an agenda list: one
    entry per record ordered by `startField`, showing the title (linked) + start
    (+ end / a color swatch when the model carries `endField`/`colorField` — so an
    axis the viewer can't read is simply absent). A full calendar grid is a later
    refinement; the agenda is the framework-neutral SSR baseline.
  - `WebPageState` gained `kanban` + `calendar` variants (model + the redacted
    rows); `PageRoot` renders them inside the app shell. They are static (no
    client state) — the data page is server-rendered, like detail.
- **`apps/operate-web`** added `renderKanbanPage` / `renderCalendarPage`
  (`html.ts`) + `serveKanbanHtml` / `serveCalendarHtml` (`server.ts`) and routed
  `GET /app/:entity/kanban` + `/app/:entity/calendar` in `dispatchApp` (before the
  `/:id` detail catch, so the reserved words aren't read as record ids). Both
  reuse the exact `compileKanbanModel` / `compileCalendarModel` + `redactRecord` +
  store `listPage` as the JSON `/ui/...` routes, and `404` when the entity
  declares no such view (the compile returns `null`).

## Cross-cutting invariants enforced

- **Redaction is structural in the markup.** A board renders only the model's
  `cardFields`; a cashier's Product board HTML omits the `commercial_sensitive`
  `unit_cost` (dropped from both the card model and the redacted data row) while a
  manager's includes it — proven over HTTP. A calendar omits a `colorField` the
  viewer (or the model) doesn't carry.
- **Same compile + redaction as the JSON routes.** No auth/redaction/pagination
  logic is duplicated; the HTML serve methods are thin renderers over the same
  per-caller model + redacted page.
- **No fallback.** A missing kanban/calendar view is a `404` (the compiler returns
  `null`), consistent with the JSON routes.

## Alternatives considered

- **A full calendar grid (month/week cells).** Deferred — an agenda list is the
  honest framework-neutral SSR baseline; a grid is a client-rendering refinement.
- **Interactive board (drag-to-transition).** Deferred — drag → a workflow
  transition is a richer client feature; P3.10 ships the read-only SSR board. The
  `allowedTransitions` the model already carries is the hook for it later.
- **Hydrate the board/calendar with pagination (like the table).** Deferred —
  the board/calendar render the first data page statically (like detail); keyset
  pagination over the board is a later refinement.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 6,955 offline tests + 45 gated
  real-Postgres integration tests + five CI gates.** All 5 of operate-web's
  compiled view kinds (table/detail/form/kanban/calendar) now have both a JSON
  view-model route and a server-rendered HTML page; `map`/`dashboard`/`pivot`
  remain uncompiled. No new META_ tables. An interactive board + a full calendar
  grid stay the follow-ups.
