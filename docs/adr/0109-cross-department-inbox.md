# ADR-0109: Cross-department approvals / requests inbox

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0108 (role-based dashboards), ADR-0106 (departments), ADR-0107 (finance depth) |

## Context

ADR-0108 told each user *which* workflows their role owns, but not *what is
actually waiting on them*. A controller knew they owned the tax-return lifecycle;
they still had to open every entity list to find the records sitting in a state
they could advance. An ERP needs a single work queue — "everything across every
department that needs my action right now" — that turns role + workflow metadata
into a live to-do list.

## Decision

A cross-department **My Inbox**, composed from data the platform already exposes.

**Composition (`operate-web/lib/inbox.ts`)** — for each entity the viewer's role
can advance (`inboxEntitySpecs`: entities with a lifecycle transition the role may
fire, derived from `viewerActions`), fetch a page of records and keep those whose
current `state` is a `from` state of a fireable transition. Each surviving record
becomes an `InboxItem` carrying the exact actions the viewer may take. Filtering is
client-side so it works regardless of whether the state column is server-filterable;
per-entity calls run in parallel and a denied/empty entity can't sink the queue.

**UI (`app/inbox/page.tsx`)** — items grouped by department, each row showing the
record, its state badge, and one button per available transition that fires
`runTransition` and refreshes. The sidebar gains a **My Inbox** link with a live
count badge; the dashboard shows a pending-items banner. Empty state is an
explicit "all caught up."

**Enabling fix — literal defaults on create (`operate-runtime/defaults.ts`).**
The inbox surfaced a latent gap: the create path applied `sequence` defaults
(document numbers) but **not `literal` defaults**, so a created record never got
its declared `state: "draft"` — leaving the lifecycle (and therefore the inbox and
the detail-page action bar) inert. `literalDefaultPlans` + `applyLiteralDefaults`
now fill any omitted literal-defaulted field on create (caller values, including
explicit `null`, always win), wired through `compileOperateServer` exactly like the
sequence plans. A created record now carries its baseline state, enums, and flags.

## Consequences

- A controller/tax-manager opens My Inbox and sees every record awaiting them
  across departments, acts in one click, and the item clears on refresh — verified
  end-to-end: three created tax returns default to `draft`, surface with
  `mark_ready`, and firing it advances `draft → ready`.
- The fix is general: every entity with a literal-defaulted lifecycle state now
  works through the live API (create → defaulted state → transitions), not just in
  the inbox.
- Still gateway-enforced: the inbox only *shows* actions the role may fire, and
  each transition is re-checked by `rbacCheck` + the lifecycle `from`-state guard
  server-side, so a stale or hand-crafted call is rejected.
- 6,5xx tests pass, zero type errors, `operate-web` build green.
- Follow-ups: server-side state filtering when the column is filterable (avoid the
  client-side scan at scale), an SLA/age column (oldest-waiting first), and
  assignee-scoped inboxes (records routed to a specific user, not just a role).
