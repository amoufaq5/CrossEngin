# ADR-0129: Aging screen — asOf date control

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0127 (console aging screen + historical aging backend), ADR-0126 (aging report) |

## Context

ADR-0127 added historical aging to the backend (`GET /v1/meta/aging?asOf=YYYY-MM-DD`
returns a back-dated snapshot) but the console aging screen always requested the
current snapshot — the capability was unreachable from the UI. This exposes it.

## Decision

**`fetchAging(asOf?)` (`lib/api.ts`)** takes an optional date string and appends an
encoded `?asOf=` query when present; absent, it requests "today" as before.

**Aging screen (`app/reports/aging/page.tsx`)** gains an `asOf` state (empty string
= server clock) and a native `<input type="date">` control. The data-loading effect
depends on `asOf`, so changing the date refetches; loading/error/forbidden states
reset on each change. A **Today** button clears the override back to the live
snapshot. The Topbar subtitle already echoes the returned `asOf`, so the rendered
date confirms which snapshot is shown.

## Consequences

- The same invoice ages into different buckets at different `asOf` dates, now
  selectable from the console — no API change, the backend support has existed since
  ADR-0127.
- `operate-web` build green.
- Follow-ups (unchanged): a console screen for the period-close revaluation run;
  line-level tax codes.
