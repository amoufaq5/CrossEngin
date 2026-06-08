# ADR-0162: operate-web kanban + calendar view models (Phase 3 P3.6)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0080 (Phase 3 P3 renderer plan), ADR-0078 (operate-runtime serving), the operate-web arc: ADR for P3.1 (view-model compiler), ADR-0154/0155/0156/0158 (P3.2–P3.5 edge/React/hydration/poller) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.6).

## Context

P3.1 shipped `@crossengin/operate-web` — a framework-neutral, redaction-aware
view-model compiler — but it only compiled three of the manifest's eight view
kinds: `list` → `TableModel`, `record` → `DetailModel`, `form` → `FormModel`. The
manifest's `views` discriminated union (`@crossengin/views`) already declares
`kanban`, `calendar`, `map`, `dashboard`, and `pivot`; a pack could author a
`kanban`/`calendar` view and operate-web would silently ignore it. The two
view kinds that are **backed purely by entity data** (no reporting/dashboard
substrate) — kanban (group records by a state field) and calendar (place records
on date fields) — are the natural next compile targets. This was the deferred
"richer view kinds (kanban / calendar / dashboard)" follow-up called out in P3.1.

## Decision

- **Two new serializable models** in `operate-web`'s `model.ts`:
  - `KanbanModel` — `{ entity, title, stateField, columns: KanbanColumnModel[],
    cardFields: CardFieldModel[], allowedTransitions: string[], groupBy? }`.
    `KanbanColumnModel = { state, label, color?, wipLimit? }`;
    `CardFieldModel = { field, label, type }` (pure layout intent, no value).
  - `CalendarModel` — `{ entity, title, startField, endField?, titleField,
    colorField?, defaultView }` over `CALENDAR_DEFAULT_VIEWS`
    (`day|week|month|agenda`).
  - `EntityNav.views` widened from `[table|detail|form]` to also allow
    `kanban|calendar`.
- **Two new compile functions** in `compile.ts`, mirroring the existing
  `compileTableModel`/`compileDetailModel`/`compileFormModel` signature
  (`(manifest, entity, viewer, options?)`):
  - `compileKanbanModel(...) → KanbanModel | null`
  - `compileCalendarModel(...) → CalendarModel | null`
  Both return `null` when the entity declares **no** view of that kind — unlike
  list/detail/form there is **no fallback** (you can't guess a state field or a
  date field). Both throw only on an unknown entity (parity with the others).
- **Redaction is structural, fail-closed, and reuses the same
  `EntityFieldResolver`** the other models use:
  - Display fields (`cardFields`) are filtered to the viewer's readable set — a
    card field the viewer can't read is dropped from the model.
  - Optional *axis* fields (`groupBy`, calendar `endField`/`colorField`) are
    **omitted** when unreadable.
  - Required *axis* fields are fail-closed: if the kanban `stateField`, or the
    calendar `startField`/`titleField`, is unreadable, the whole view is
    **withheld** (`null`) — otherwise the grouping/placement axis would leak
    which column/day each record sits in even with its value redacted.
- **`compileWebApp` nav now reflects reality**: an entity's `views` array gains
  `"kanban"`/`"calendar"` only when a view of that kind is declared **and**
  compiles non-null for *this* viewer — so a board withheld for redaction never
  even appears in the nav for that caller.
- **Two additive serving routes** in `apps/operate-web`'s `OperateWebServer`
  (`dispatchUi`), reusing the exact per-caller compile + `redactRecord` + store
  read as the existing `/ui/:entity` route:
  - `GET /ui/:entity/kanban` → `{ kanban, page: { data, nextCursor } }`
  - `GET /ui/:entity/calendar` → `{ calendar, page: { data, nextCursor } }`
  Both `404` when the entity declares no view of that kind (the compile returns
  `null`). The card/event data page is redacted identically to the table page.

## Cross-cutting invariants enforced

- **No field the viewer can't read ever appears** — in the card-field model, the
  calendar axis fields, or the data page. Proven in tests: a `store_manager`'s
  Product board card fields include the `commercial_sensitive` `unit_cost` and
  the data row carries it; a `cashier`'s board omits it from **both** the model
  and the data; a board whose `stateField` is the classified `unit_cost` is
  `null` for the cashier (fail-closed) and the nav drops `kanban` for that caller.
- **Pure data models.** `KanbanModel`/`CalendarModel` are plain serializable zod
  shapes (no functions/DOM), JSON-serializable to any frontend, consistent with
  the rest of operate-web.
- **No new META_ tables.** Pure rendering over existing entity stores.

## Alternatives considered

- **Compile `map`/`dashboard`/`pivot` too.** No — `dashboard`/`pivot` reference
  reports/dashboards (a reporting substrate operate-web doesn't yet surface), and
  `map` needs geo rendering. Kanban + calendar are the entity-data-backed pair;
  the others are a later increment.
- **Fall back to a synthesized board when no kanban view exists** (e.g. group by
  the entity-lifecycle status). No — a board needs an authored state field +
  column labels; a silent synthesis would surprise. `null` + a `404` is honest.
- **Include the state/title axis even when unreadable, redacting only the value.**
  No — the axis *position* itself is information (which column/day a record is
  in); fail-closed withholding the whole view is the only non-leaking choice.
- **SSR HTML pages for kanban/calendar** (like P3.3's `/app/*`). Deferred — this
  increment ships the JSON view-model + compiler; the React board/calendar
  components + `/app/:entity/kanban` HTML routes are a follow-up.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 6,911 offline tests** (+~22:
  operate-web compiler + apps/operate-web routes) **+ 39 gated real-Postgres
  integration tests + five CI gates** — unchanged (pure rendering, no DB). The
  operate-web compiler now covers 5 of 8 manifest view kinds (list, record, form,
  kanban, calendar); map/dashboard/pivot remain.
- A pack that authors a `kanban`/`calendar` view now gets a redaction-aware board
  / calendar view-model + a serving route for free, with the nav reflecting which
  view kinds each caller may actually see.
