# ADR-0294: Asking the rows which incident is already open (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0293 (SLO incident persistence), ADR-0289 (incident record persistence), ADR-0288 (integrity incident escalation) |

## Context

ADR-0289 opened this and ADR-0293 left it open again, both times with the same analysis:

> Ids no longer collide across a restart, but `IntegrityEscalator.open` is in memory, so a restart
> re-declares a still-present tamper under a *new* id. Hydrating it from the store needs a way to ask
> "which open incident did this signal open?", and `IncidentRecord` has no `surface` field — the
> surface lives in the declaration entry's metadata. A column outside the record would break the
> property the replayer depends on (the row *is* the record), so this wants either a contract field or
> a JSONB-path query, and deserves the decision rather than a quick column.

ADR-0293 made the SLO loop persist its incidents, which turned a latent annoyance into a visible
defect: every surface that declares now holds its open episode in memory and writes a row, so a
restart mid-breach produces **one episode, two incidents** — in three places (the availability
engine, the latency engine, the integrity escalator). A tamper stays tampered and a burn stays
burning, so a crash-looping deployment would emit an incident per restart and train everyone to
ignore the alert, which is the exact failure ADR-0288's "declare once, not every pass" rule exists to
prevent.

The deferred question had two candidate answers and they are not equivalent:

- **A JSONB path into the declaration entry's metadata**, where the surface already lives. Nothing to
  add. But `metadata` is `Record<string, unknown>`, so nothing makes a second declarer spell the key
  the same way — a typo would produce duplicate incidents forever and no test would see it — and
  keying idempotency off an untyped blob sits badly beside "zod schemas are the source of truth".
- **A field on the record**, typed, validated, and indexable.

## Decision

- **A contract field, not a metadata path.** `IncidentRecord.autoDeclaredFor: string | null` is the
  automated signal an incident was declared for, and the idempotency key for declaring it. On the
  record rather than beside it, which is what keeps ADR-0289's property intact: the row *is* the
  record, so the replayer still re-parses every column it reads. Null for anything a human declared.
- **The key is namespaced `signal:subject`,** built by `autoDeclaredForKey`. An availability SLO and a
  latency SLO watch the same surface and are different breaches that must be able to be open at once;
  one key for both would let the latency engine adopt the availability incident and leave the latency
  breach silently unreported. The composer refuses a `:` in the signal, so the namespace cannot be
  forged from the subject side.
- **At most one open incident per signal, enforced by the database.** A **partial** unique index —
  `WHERE auto_declared_for IS NOT NULL AND status NOT IN ('closed', 'cancelled')` — makes the
  duplicate impossible rather than merely unintended, the same move ADR-0289 made with
  `incidents_year_sequence_key`. Partial and therefore an index and not a constraint: a *closed*
  episode must be able to be declared again, and a human-declared incident has no key to constrain.
  Hydration prevents the duplicate; the index guarantees it; and the two compose, because a refused
  insert surfaces as a declaration error, leaves the surface unopened, and the next tick hydrates and
  finds the incident it should have adopted. The failure mode self-heals.
- **Ask before declaring, not at startup.** `IncidentDeclarer.findOpen(key)` is called only when a
  breach is detected and nothing is active locally — so a healthy surface costs no query, there is no
  boot-time hydration step to order correctly, and a surface that was never breaching is never looked
  up. An adopted breach is reported as `breach_ongoing`, which is what it is: opened, and opened
  before this process started.
- **An adopted incident is not paged again.** The page went out when it was declared. Paging on every
  restart is the same noise as declaring on every pass.
- **A failed lookup declares anyway.** It is reported and read as "nothing open": that risks a
  duplicate incident, never a missed breach, and the index refuses the duplicate. The opposite
  default would let an unreachable store suppress escalation entirely — the one outcome worse than a
  duplicate.
- **A declarer with no store answers null.** Nothing it declared outlived the process, so there is
  genuinely nothing to adopt, and claiming otherwise would have an engine adopt an incident that
  exists nowhere.
- **An adopted breach claims no kill switch.** Nothing persists a `KillSwitch`, so a restart cannot
  know which flag was rolled back; `killSwitchId` is null on a recovery from an adopted breach rather
  than guessed.

## Consequences

- **Verified live** against a real Postgres, 28 checks plus a real-server restart:
  - **the migration path**, which is what ADR-0290–0292 were built for: a database holding incident
    rows and the *pre-change* table shape planned exactly
    `add_column incidents.auto_declared_for` + `create_index incidents.idx_incidents_auto_declared_open`,
    applied them in **21 ms** with 0 failed, and then reported **no drift**. A fresh install applies
    841 statements (840 + the new index). Postgres rendered the predicate as
    `status <> ALL (ARRAY['closed'::text, 'cancelled'::text])` — the deparser rewrite ADR-0292
    exists to compare — and the diff read it as matching;
  - a second open incident for one signal was **refused by `idx_incidents_auto_declared_open`**;
  - a breach declared `INC-2026-0002` under `availability:surface.restart`, and a **second and a
    third** freshly-built wiring over the same database both reported `breach_ongoing` under that
    same id, leaving **one row**;
  - the adopting process **closed out what it had adopted** — `cancelled`, revision 2 — with
    `killSwitchId` null;
  - once cancelled, a new episode declared a **new** incident, two rows for the signal with exactly
    one open: the partial index allowing what a total one would have blocked forever;
  - availability and latency on **one surface** declared two separate incidents, and a latency
    restart adopted the latency one and not the availability one;
  - the integrity escalator declared and paged once, a **restarted** escalator adopted the open
    incident, **did not page again**, declared nothing, and still cancelled it on recovery;
  - with no store, a restart re-declared and left no rows, which is the honest outcome;
  - no signal anywhere in the table had two open incidents.
- **Verified in the real server**, across two process lifetimes: `erp-retail --store pg
  --slo-config`, with `meta.operate_entity_records` renamed away so `GET /v1/products` genuinely
  failed. The first server logged `breach_opened … incident=INC-2026-0001` and wrote one row. The
  server was **killed and restarted with the breach still present**, and the new process logged
  `breach_ongoing … incident=INC-2026-0001` — not a second declaration — leaving the table at one
  row, revision 1. Restoring the table produced `recovered … closeOut=cancelled` from the process
  that had never declared it. Across both lifetimes: **1 `breach_opened`, 150 `breach_ongoing`,
  1 `recovered`.**
- **Test files are not typechecked anywhere in this repo** (`tsconfig.json` excludes `**/*.test.ts`,
  and vitest transpiles without checking), which this change had to be careful about: a stub
  `IncidentDeclarer` missing the new `findOpen` method throws a `TypeError` that
  `findOpenEnforcementIncident` catches by design, so the suite went green while the new path was
  never exercised. Every stub was updated deliberately and each adoption path has a test that fails
  if it is not taken. Worth fixing properly, but not here.
- No new table; still **139**. `meta.incidents` gains one column and one index.
- +47 tests (incident-response 116 → **124**, incident-response-runtime 116 → **118**, -pg 115 →
  **123**, observability-runtime 148 → **166**, kernel 586 → **588**, operate-server 1,706 →
  **1,715**; workspace **9,926** across 600 files). Full workspace build + typecheck + test green.

## Follow-ups

- **An adopted breach's threshold is the current one, not the one it was declared under.** The
  recovery message names whichever threshold is breaching now, because the declaring threshold is not
  on the record. It is a message, not a decision, so this was left rather than given a column.
- **Nothing persists a `KillSwitch`,** so a flag rolled back before a restart stays rolled back with
  nothing in the process knowing which flag it was. `meta.feature_flag_kill_switches` exists and the
  SLO loop does not write it — the same reconcile-or-delete question ADR-0289 answered for
  `meta.incidents`, and the reason `killSwitchId` is null on an adopted recovery.
- **A `failed` close-out is still not retried** (ADR-0293), but hydration now partly covers it: the
  row stays open, so the next breach of that signal adopts it rather than declaring a second. It is
  still never cancelled without a human.
- **Declaring still requires the database** (ADR-0293), and so now does adopting.
- **`IntegrityEscalator` still has its own declaration path** — a per-process counter plus
  `planIncidentDeclaration` — rather than the shared `IncidentDeclarer` (ADR-0293). Both now set the
  same key by the same rule, which is the duplication this makes worth removing.
- **The replayer does not check the one-open-per-signal invariant.** The index enforces it on write,
  and `findOpenFor` refuses a second row if it ever sees one, but a drift report would be the place to
  notice it without a declaration happening first.
