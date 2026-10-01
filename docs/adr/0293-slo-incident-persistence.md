# ADR-0293: Letting the store name the incident (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0289 (incident record persistence), ADR-0288 (integrity incident escalation), ADR-0060 (SLO enforcement runtime) |

## Context

ADR-0289 named this as the next increment and said exactly what blocked it:

> `SloEnforcementEngine.evaluate()` is synchronous and mints ids from a per-process counter, so its
> `INC-2026-0001` would collide with a database-allocated one. Persisting under a second,
> store-allocated id would leave the log line and the stored row naming different incidents — worse
> than not persisting.

Measured on a real database, the collision is not hypothetical. The integrity proof declares first
and takes `INC-2026-0001`; an SLO breach minting `INC-2026-0001` from its counter is refused by
`incidents_year_sequence_key`. Nothing was persisting, so nothing failed — which is the whole
problem. The SLO loop had three surfaces of the same gap:

- **`meta.incidents` never saw an SLO incident.** The loop declared, logged, paged and forgot.
- **Neither did the three tables built for it.** `slo_evaluations`, `slo_enforcement_actions` and
  `slo_latency_evaluations`, and the `buildPersistent*` engines that write them, had **no consumer
  in `apps/`** — `operate-server` built the bare engines. The same dead-declaration shape ADR-0284,
  0285 and 0289 each resolved by making the declared thing the real one.
- **An auto-declared incident had no end.** Nothing closed one out, so a recovered breach would have
  left a row open forever.

Two defects surfaced while closing it, both invisible before because only one declaration ever
happened per pass:

- **Allocation and insert were two locked steps.** `allocateIncidentId` took `MAX(sequence_number)+1`
  under an advisory lock and *released it*, then `declare` inserted. Two declarers that both read
  before either wrote compute the same sequence. The SLO loop can open several breaches in one pass,
  and every allocation in that pass happened before any insert — so it was not a race, it was a
  certainty.
- **Nothing stopped two passes declaring the same breach.** A surface is recorded as active only
  once its id comes back. With a synchronous `evaluate()` there was no window; with an awaited
  declaration there is one, and a slow store widens it.

## Decision

- **The store chooses the id, and the engine uses what it is given.** `IncidentDeclarer` (in
  `incident-response-runtime`, beside the `IncidentExecutor` it wraps) has one job: take a
  declaration without an id and return the record it stored. The engine then builds the page and the
  kill switch from `record.id`. Nothing in the loop ever constructs an `INC-YYYY-NNNN`, so the id in
  the log line, the id on the row, the id in the enforcement action and the id the pager carries are
  the same string by construction, not by agreement. This is the arrangement the integrity escalator
  has used since ADR-0289, lifted into a seam both can share.
- **`evaluate()` is async; `recordOutcome` is not.** Declaring means asking the store, so the pass
  that declares waits. Recording an outcome stays an in-memory window append on the hot path.
- **A declaration that cannot be recorded leaves the surface unopened.** It is reported through
  `onDeclarationError` and the next tick declares it. Throwing would abandon every surface after this
  one in the same pass, so one unreachable store would hide every other breach — worse than a page
  delayed by a tick. The cost is a coupling worth naming: the database being down is itself the kind
  of event that breaches an SLO, and the incident for it cannot be declared until the database is
  back.
- **A recovery closes the incident out, and the decision says what became of it.** The `recovered`
  decision carries `closeOut`: `cancelled`, `human_owned` (triaged — left to its responders),
  `unpersisted` (nothing stored it), or `failed` (the store refused; the row stays open where
  `listOpen` surfaces it). Cancelling rather than resolving is ADR-0289's rule, unchanged: `triaged`
  requires the on-call roles assigned, so an automated resolve would claim a response that never
  happened.
- **Allocation and insert are one locked step.** `PostgresIncidentStore.insertAllocated(year, build,
  at)` holds `INCIDENT_SEQUENCE_LOCK` across both and refuses a builder that returns a record under a
  different id — the row's `year`/`sequence_number` are derived from the id, so that would store
  columns contradicting it. `PersistentIncidentEngine.declare` now takes this path, which closes the
  window for the integrity escalator too.
- **A surface with a declaration in flight is skipped, and a tick that overlaps a pass is dropped.**
  The engine tracks `declaring` so a second pass cannot declare the same breach twice; the scheduler
  refuses to start a pass while one is running, because piling passes up behind a slow store
  multiplies the work it is already struggling with.
- **`operate-server` wires the persisting engines when it has a connection.** One
  `PostgresIncidentDeclarer` serves both signals, so a burn breach and a latency breach cannot be
  handed the same id. Without a connection the loop still runs, on a
  `CountingIncidentDeclarer`, and the server **says so at boot** rather than looking persisted.
  The counter is safe there for one reason only: nothing stores what it names.
- **No new table; no meta-schema change.** Still **139**. The four tables this needed already
  existed; three of them simply had no caller.

## Consequences

- **Verified live** against a real Postgres (840 statements applied, 140 tables), 27 checks:
  - an integrity-style incident took `INC-2026-0001` and the SLO breach came back as
    **`INC-2026-0002`** — the collision ADR-0289 refused to ship, gone;
  - the row carries `declared_by = 'system-slo-enforcer'`, `severity = sev2`,
    `category = availability`, `year/sequence = 2026/2` — **the insert the pre-ADR-0289 UUID FK made
    impossible**;
  - the enforcement action and the burn-evaluation snapshot name that same incident, with
    `paged = true`, `page_channel_count = 1`, `threshold_id = fast-burn`;
  - a **fresh engine instance** continued at `INC-2026-0003` where a counter would have restarted at
    `0001`;
  - **two surfaces breaching in one pass** got `0004` and `0005`, both stored — the certainty the
    old allocate-then-insert would have turned into a unique-violation;
  - **two concurrent `evaluate()` calls declared once**, leaving one row;
  - a recovery left the row `cancelled` at revision 2 with
    `cancelled_reason = 'error-budget burn on surface.r is back within its fast-burn threshold'`;
  - an incident a human had **triaged** was reported `human_owned` and its status stayed `triaged`;
  - the latency engine stored a `performance` incident with its action tagged `signal = latency` and
    a `worst_percentile = p95` snapshot;
  - every row's id matched its `year`/`sequence_number` columns, and the **replayer re-parsed them
    with no drift**;
  - without a connection the wiring reports `persisted: false`, still declares from the counter, and
    reports `closeOut: 'unpersisted'`.
- **Verified in the real server**, end to end over the real request path: `operate-server --pack
  erp-retail --store pg --slo-config`, with `meta.operate_entity_records` renamed away so
  `GET /v1/products` genuinely failed. The loop logged `breach_opened … incident=INC-2026-0001` once
  and `breach_ongoing` on every tick after, wrote one incident row
  (`SLO burn alert: product-list-availability on product.list`), one `breach_opened` action plus
  seven `breach_ongoing` actions and one evaluation. Restoring the table produced
  `recovered … closeOut=cancelled` and left the row `cancelled` at revision 2 with the reason.
  Booting the same config over `--store memory` printed the unpersisted warning.
- Three previously app-dead tables are now written by a deployed server. `meta.incidents` gains its
  second producer.
- +62 tests (incident-response-runtime 104 → **116**, -pg 100 → **115**, observability-runtime
  124 → **148**, -pg 46 → **53**, operate-server 1,702 → **1,706**; workspace **9,879** across 600
  files). Full workspace build + typecheck + test green, no type errors.

## Follow-ups

- **`closeOut` is logged, not stored.** `slo_enforcement_actions` has no column for it, so "was the
  recovery clean?" is answerable from `meta.incidents.status` but not from the action row. A column
  would be the obvious fix and is not obviously worth a meta-schema change yet.
- **A `failed` close-out is not retried.** The breach is forgotten, so the next tick will not try
  again and the row stays open until a human closes it. Retrying needs somewhere to remember the
  incident after the engine stopped tracking it — the same per-process-state problem below.
- **Open-breach state is still per-process**, as it is for the integrity escalator (ADR-0289). A
  restart mid-breach re-declares under a *new* id — ids no longer collide, but one episode can
  produce two incidents. Hydrating it needs a way to ask "which open incident did this surface
  open?", and `IncidentRecord` still has no `surface` field; the surface lives in the declaration
  entry's metadata, so this wants either a contract field or a JSONB-path query.
- **An unreachable store delays the page.** Declaring needs the database, and the database being
  unavailable is exactly the kind of outage an SLO breach describes. The escalator's answer — fall
  back to an unpersisted record so the page still goes out — is available here as a wrapping
  declarer, and was left out rather than guessed at: it trades a possibly-colliding id for a timelier
  page, and which of those matters more is a deployment's call.
- **`IntegrityEscalator` still has its own declaration path**, with a per-process counter for the
  unpersisted case and `planIncidentDeclaration` for the record. Both now have a shared equivalent;
  moving it onto the seam would delete the duplicate, and its `disposition` vocabulary overlaps
  `IncidentCloseOut` closely enough that the two should probably become one.
- **Nothing exposes any of this over HTTP** — incidents, evaluations, enforcement actions and audit
  verdicts are all still read in SQL (ADR-0287, 0289).
- `incident_runbook_executions`, `incident_postmortems` and `incident_communications` remain dead
  (ADR-0289).
