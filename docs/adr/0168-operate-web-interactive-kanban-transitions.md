# ADR-0168: operate-web interactive kanban — drag → workflow transition (Phase 3 P3.12)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0162 (kanban view model), ADR-0166 (SSR kanban page), ADR-0164/0165 (write path + client submit), ADR-0078 (operate-runtime transitions), ADR-0080 (Phase 3 P3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.12).

## Context

P3.10 rendered a static SSR kanban board; the model carried `allowedTransitions`
as bare names. P3.12 makes the board interactive: dragging a card between columns
fires the corresponding `entityLifecycle` transition through a new operate-web
write route, RBAC- and from-state-enforced server-side. This is the kanban
analogue of P3.9's form submit — the client offers only the transitions the
viewer may fire, and the server stays authoritative.

## Decision

- **`@crossengin/operate-web`** enriched `KanbanModel` with resolved,
  RBAC-gated `transitions: KanbanTransitionModel[]` (`{ name, toState,
  fromStates }`) alongside the raw `allowedTransitions`. `compileKanbanModel`
  resolves the view's `allowedTransitions` against the entity's
  `entityLifecycle` (via operate-runtime's canonical `manifestRouteSpecs` →
  `TransitionSpec`), keeping only transitions whose `toState` is a declared
  column **and** that the viewer may fire (`EntityFieldResolver.canTransition` —
  a new method wrapping `rbacCheck` with `{kind:"transition", name}`). So the
  board only offers a drag the server would authorize.
- **`apps/operate-web`** added `POST /ui/:entity/:id/transition` (`serveTransition`)
  with body `{ transition: <name> }`: resolves the `TransitionSpec` from the
  manifest (404 if undeclared), checks the per-transition RBAC grant (403),
  validates the record's current `stateField` against the transition's
  `fromStates` (409 on an invalid current state), applies the `stateField ->
  toState` update via the store, and returns the redacted record. `"transition"`
  is a reserved 3-segment POST route (it doesn't collide with the `/:id` PATCH).
- **`@crossengin/operate-web-react`** gained the client primitives in
  `page-state.ts` (`buildTransitionUrl`, pure `planCardTransition(transitions,
  from, to)` → the bridging transition name or `null`, `submitTransition`) and a
  stateful **`KanbanSection`** (replacing the static `KanbanView` in `PageRoot`'s
  kanban branch): when the model carries transitions it renders draggable cards +
  drop-target columns; dropping a card resolves the transition, POSTs it, and on
  success moves the card into the target column in local state — a 403/409/no-op
  surfaces inline and leaves the card put. The SSR renders the same markup
  (`data-interactive`, `draggable`) so hydration matches; live drag is a manual
  browser smoke (the package is jsdom-free).

## Cross-cutting invariants enforced

- **The board offers only authorized drags.** A cashier's SalesOrder board
  carries `place` (granted to sellers) but not `fulfill` (managers only), proven
  in the compiler tests; the server independently enforces the grant (403) so a
  hand-crafted request can't bypass it.
- **From-state is enforced.** A `fulfill` on an order still in `cart` is a 409
  (it's only valid from `placed`) — proven over real Postgres in the gated test.
- **No leak.** The transition response record is `redactRecord`-ed for the
  caller; `planCardTransition` is a no-op on a same-column drop or an unbridged
  pair.

## Alternatives considered

- **Per-card transition buttons instead of drag.** Drag was the requested UX;
  the pure `planCardTransition` + `submitTransition` helpers are transport, so a
  button affordance could reuse them later. Drag is a manual smoke; the logic is
  unit-tested.
- **Reuse the static `KanbanView` and layer drag on top.** No — the drag handlers
  must attach to the cards/columns, so `KanbanSection` renders the interactive
  board directly (the same class names + structure, so it reads identically);
  `KanbanView` stays the pure component for non-interactive use + its own tests.
- **Fire the transition as a plain `stateField` PATCH.** No — a transition is a
  guarded lifecycle step (RBAC grant + from-state), distinct from a field update;
  it deserves its own route and the 409 semantics.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 6,975 offline tests + 46 gated
  real-Postgres integration tests** (17 worker + 22 operate-server + **7
  operate-web**, the new one a place/fulfill transition round-trip over real PG)
  **+ five CI gates.** The kanban board is now interactive — a drag fires a
  workflow transition through an RBAC + from-state-enforced route, with the board
  offering only authorized moves. No new META_ tables. A full calendar grid +
  per-card transition buttons stay later refinements.
