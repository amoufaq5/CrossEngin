# ADR-0304: A declarer that falls back, so a page is never lost to a database (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0293 (SLO incident persistence), ADR-0294 (open-episode hydration), ADR-0297 (close-out and one declarer) |

## Context

ADR-0293 named its own sharpest cost: declaring an SLO incident requires the database, which is itself
the kind of outage an SLO breach describes. A failed declaration leaves the surface unopened and the
next tick retries, so the page is *delayed* rather than lost — but delayed during a database outage is
exactly when it is wanted. The ADR sketched the remedy: "the escalator's fallback — an unpersisted
record so the page still goes out — would fit as a wrapping declarer and trades a possibly-colliding id
for a timelier page."

`operate-server`'s integrity escalator already had that fallback inline (ADR-0297): it declares through
the shared `IncidentDeclarer` and, when the record cannot be stored, falls back to
`CountingIncidentDeclarer` so the page still goes out. Inline, it was not reusable and not separately
testable.

## Decision

`FallbackIncidentDeclarer` wraps a primary declarer and a fallback, implementing `IncidentDeclarer` so
anything taking a declarer can take it. Three methods, three different rules, and the differences are
the decision:

- **`declare` falls back.** This is the point: a page that goes out under a possibly-colliding id beats
  no page.
- **`findOpen` propagates the failure.** It does *not* fall back. A fallback declarer finds nothing —
  nothing it declared survived the process — so answering "no open incident" when the primary is simply
  unreachable would turn hydration (ADR-0294) into a duplicate-declaration machine: every tick during
  an outage would read "nothing open" and declare again. Failing is the honest answer, and the caller
  already treats a failed `find_open` as a reason to skip the surface this tick.
- **`closeOut` routes by origin.** `servedBy(incidentId)` remembers which declarer minted each id, so a
  recovery closes out the incident where it actually lives. Closing a fallback-declared id against the
  primary would try to update a row that was never written.

The id tells you where the record is only because the wrapper keeps the map; the ids themselves are not
distinguishable, which is the trade ADR-0293 described.

**The SLO engines are not wired to it.** Only the integrity escalator uses a fallback today. An SLO
breach retries on the next tick and the engine is designed around that (`declaring` guard, hydration,
`closeOut` on recovery); an integrity compromise is a one-shot finding where a missed page is a missed
page. Adding the wrapper to the SLO path would introduce colliding ids into a flow that *does* have a
retry, for no gain — so the wrapper exists, is tested, and stays opt-in.

## Alternatives considered

- **Option A: leave the fallback inline in the escalator.**
  - **Pros:** no new public type; it already worked.
  - **Cons:** untestable in isolation, and the ADR-0293 follow-up stays open by construction. The
    `findOpen`-must-not-fall-back rule in particular was not expressible inline, because the inline
    version never called it.
  - **Why not:** the rule is subtle enough to deserve a named home and its own tests.

- **Option B: make every declarer fall back by default.**
  - **Pros:** no caller has to opt in; a page is never lost anywhere.
  - **Cons:** silently introduces unpersisted, possibly-colliding incident ids into the SLO path, which
    has a working retry. An id that names nothing is worse than a delayed page when a delay is bounded.
  - **Why not:** the trade is only worth it where there is no second chance.

- **Option C: have the fallback also answer `findOpen` from its own memory.**
  - **Pros:** a long outage would adopt its own earlier fallback incident rather than declaring afresh
    each tick.
  - **Cons:** that memory is per-process, so a restart loses it anyway, and it would mask a primary
    that is reachable-but-erroring — the case where hydration must not guess.
  - **Why not:** propagating is correct; the duplicate-page risk during an outage is bounded by the
    escalator's once-per-episode rule.

## Consequences

- **Positive:** the ADR-0293 follow-up is closed as a reusable, tested seam, and the escalator's
  behaviour now has a name.
- **Negative:** a fallback-declared incident carries an id that may collide with a later persisted one,
  and nothing in the record says which. The wrapper knows, in memory, for as long as the process lives.
- **Neutral:** nothing changed for the SLO engines. The wrapper is available if the trade ever becomes
  worth making there.
- **Reversibility:** additive. Removing it means putting the fallback back inline.

## Implementation notes

- `packages/incident-response-runtime/src/fallback-declarer.ts`, exported from the barrel — a subpath
  import would not resolve, since the package's `exports` map has only `"."`.
- `servedBy` returns `"primary" | "fallback" | "unknown"`; `"unknown"` is an id this wrapper never
  minted, which `closeOut` routes to the primary because a persisted incident is the only thing another
  process could have written.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Should a fallback-declared incident be marked as such in its record, so a later reader can tell? It would need a field on `IncidentRecord`. | amoufaq5 | _unscheduled_ |
| A failed `closeOut` is still not retried (ADR-0293) and leaves the row open, in either declarer. | amoufaq5 | _unscheduled_ |

## References

- ADR-0293, ADR-0294, ADR-0297.
