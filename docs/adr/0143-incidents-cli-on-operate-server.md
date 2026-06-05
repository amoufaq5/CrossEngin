# ADR-0143: `incidents` CLI subcommand on operate-server (Phase 3 P2.34)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0131 (incidents CLI subcommand on workflow-worker), ADR-0134 (incidents ack/mitigate write CLI), ADR-0140 (incident-response-pg package extraction), ADR-0141 (operate-server SLO incidents), ADR-0087 (apps/operate-server — the runnable serving binary), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.34).

## Context

P2.31 (ADR-0140) extracted the incident sink / replayer / metrics / runner
into `@crossengin/incident-response-pg`. P2.32 (ADR-0141) made
`apps/operate-server` the second consumer of that package: its SLO loop now
declares serving-availability incidents into `meta.incidents` alongside the
worker's stale-worker incidents. But the operator surface — the
`workflow-worker incidents <open|period|verify|metrics|ack|mitigate>`
subcommand built across P2.22 / P2.23 / P2.24 / P2.25 / P2.30 (ADRs 0131,
0132, 0133, 0134, 0139) — was only reachable from the **worker** binary.
An operator running an operate-server-only deployment (or one debugging a
freshly-declared serving incident) had to install/run the worker binary
just to ask "what serving incidents are open?". P2.34 mirrors the same
subcommand surface onto `apps/operate-server`, so either binary can drive
the same `meta.incidents` table.

## Decision

- **A subcommand split in the bin.** `operate-server incidents …` (i.e.
  `process.argv[2] === "incidents"`) routes to a one-shot query that *exits*;
  every other invocation is the unchanged `serve` long-running loop. The
  serve help text gains one line pointing to `operate-server incidents
  --help`. No change to any existing serve flag or default behavior.
- **`incidents-cli.ts` mirrors `apps/workflow-worker/src/incidents-cli.ts`
  one-for-one.** Same `parseIncidentsArgs(argv)` semantics, same six
  commands (`open|period|verify|metrics|ack|mitigate`), same flag set
  (`--from`/`--to`/`--limit`/`--actor`/`--schema`/`--format`), same
  `CliUsageError` integration (uses operate-server's `CliUsageError` from
  `cli.ts`, not the worker's). The runner + types (`runIncidents`,
  `runIncidentWrite`, `IncidentsCliOptions`, `IncidentQuerySource`,
  `IncidentWriteSink`, `RunIncidentsResult`, `DEFAULT_INCIDENT_ACTOR`,
  `formatIncidentList`, `formatVerifyReport`) are re-exported from
  `@crossengin/incident-response-pg` — no fork, no second implementation.
  Help text is operate-server-flavored (the verb in every usage line).
- **`executeIncidents(options, out?)` in `node.ts`** — the thin DB wiring:
  opens a `PgConnection` from the `PG*` env vars (via
  `parsePgEnvConfig()`), builds a `PostgresIncidentReplayer` for the read
  commands (open/period/verify/metrics) or a `PostgresIncidentSink` for
  the write commands (ack/mitigate), dispatches through `runIncidents` /
  `runIncidentWrite`, closes the connection in a `finally`, and returns
  the exit code (verify returns 1 on drift). Mirrors
  `apps/workflow-worker/src/node.ts`'s `executeIncidents` byte-for-byte
  semantics.
- **Bin dispatch.** `bin/operate-server.ts` adds a `runIncidentsCommand`
  helper (parse argv slice 3 → `executeIncidents`) and an `argv[2] ===
  "incidents"` short-circuit at the top of `main()`. `--help` on the
  subcommand prints the incidents help and exits 0; a `CliUsageError`
  exits 2; the subcommand `process.exit`s on completion (it does **not**
  fall through into the keep-alive serve loop).

## Cross-cutting invariants enforced (by tests)

- **Parsing.** Mirrors `apps/workflow-worker/src/incidents-cli.test.ts`
  one-for-one: no command → help; `open --limit N --format json` (spaced
  + inline); `period`/`verify`/`metrics` require `--from`+`--to`;
  `ack`/`mitigate` require a positional incident id (+ optional
  `--actor`); unknown command / format / argument → `CliUsageError`;
  invalid `--limit` (non-integer or `<1`); missing flag value; custom
  `--schema` (spaced + inline) carried. The operate-server help text is
  verified to mention `operate-server incidents` and the
  `MTTP/MTTA/MTTM/MTTR` KPI set.
- **Re-export shape.** The runner + types are re-exported from
  `@crossengin/incident-response-pg` (one source of truth); the parser is
  the only operate-server-local logic, tied to operate-server's
  `CliUsageError`.
- **Bin split.** No behavioural change to `serve` — the existing 81
  offline tests continue to pass unchanged.

## Alternatives considered

- **A separate `operate-incidents` binary.** No — the serving app already
  owns one of the two incident producers (the SLO loop) and connects with
  the right `PG*` env; a subcommand reuses that wiring and keeps one
  deployable artifact per app (mirroring the worker's choice in P2.22).
- **Promote `parseIncidentsArgs` into `@crossengin/incident-response-pg`
  so both apps share one parser.** No — each app's parser is tied to its
  app-local `CliUsageError` (so misuse errors print the right help text),
  and the parsing is trivial enough that mirror-duplication is cheaper
  than a structural-error abstraction. If a third consumer lands we can
  revisit.
- **A gated PG integration test for the operate-server CLI path.** No —
  `runIncidents` / `runIncidentWrite` are fully offline-tested over a
  fake source/sink in `@crossengin/incident-response-pg` (P2.31), the
  parser is fully offline-tested here, and the bin's `executeIncidents`
  wiring is thin and identical-shape to the worker's gated-tested
  equivalent. A second gated CLI test would be marginal.

## Consequences

- **62 packages + 3 apps, 124 meta-schema tables, ~6,626 offline tests +
  29 gated real-Postgres integration tests** (17 worker + 12 serving;
  +13 offline; 0 new tables/columns/packages). The serving app's SLO
  incidents are now operable from one binary (`operate-server incidents
  open|period|verify|metrics|ack|mitigate`) — the same surface
  `workflow-worker` ships, both backed by `@crossengin/
  incident-response-pg`. An operator running an operate-server-only
  deployment no longer needs the worker binary just to query incidents.
- **The P2.31 extraction continues to pay off** — adding the second
  binary's subcommand was four files (`incidents-cli.ts` +
  `incidents-cli.test.ts` + a new `executeIncidents` in `node.ts` + a
  bin split), no logic duplication. Future incident-response-pg
  consumers can ship the same operator surface the same way.
