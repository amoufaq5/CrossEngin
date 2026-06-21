# ADR-0113: Inbox polish — record timestamps, age/SLA, server-side filtering

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0109 (cross-department inbox), ADR-0108 (role dashboards) |

## Context

The cross-department inbox (ADR-0109) listed pending items but in arbitrary order,
with no sense of how long each had waited, and it scanned a full page per entity
and filtered entirely client-side. Two gaps: no age/SLA signal, and no use of
server-side filtering even where the column supports it.

## Decision

**Record timestamps (`operate-runtime/handlers.ts`).** The handler now stamps
`created_at` + `updated_at` (ISO, via the injectable clock) on create, and bumps
`updated_at` on every update and transition. Caller-supplied `created_at` is
preserved; `updated_at` always reflects the last write. This is generally useful
audit metadata and is what powers the inbox's age. (The JSONB/in-memory stores
persist the fields as-is; the typed column store drops any it doesn't declare, so
nothing breaks where the columns aren't modeled.)

**Age / SLA (`operate-web`).** Each `InboxItem` now carries `waitingSince`
(`updated_at` → `created_at` fallback) and `ageMs`. The inbox sorts **oldest-
waiting first** (items without a timestamp last), renders a compact age
(`formatAge`: "just now" / "5m" / "3h" / "4d" / "2w"), and flags anything past a
3-day threshold with a ⏰ overdue tone.

**Server-side state filtering (`operate-web/lib/inbox.ts`).** When an entity's
lifecycle `stateField` is in its `filterableFields`, the inbox pushes the filter
into the list call as `?<state>[in]=<fireable states>` so the server returns only
candidate rows; the client-side state check is always re-applied as a correctness
net (and is the sole filter when the column isn't filterable). A larger per-entity
page cap complements the narrower query.

## Consequences

- The inbox is now a real work queue: oldest items surface first, each shows how
  long it's waited, and overdue ones stand out — verified that timestamps stamp on
  create/update and that `?state[in]=draft` returns only draft rows server-side
  (3 invoices → 2 draft) for filterable entities.
- Timestamps benefit the whole platform (audit, "recently updated" views), not
  just the inbox.
- Correctness is unchanged where state isn't filterable — the client net still
  applies — so no pack needs a views change to be correct, only to get the
  server-side speedup.
- 6,5xx tests pass (+1 handler timestamp case), zero type errors, `operate-web`
  build green.
- Follow-ups: declare `state` filterable + `updated_at` sortable in the lifecycle
  packs' ListViews so the inbox can also paginate/sort server-side; per-entity SLA
  targets (vs the flat 3-day threshold); surface age on the entity list too.
