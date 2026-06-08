# ADR-0159: `slo` CLI subcommand on operate-server (Phase 3 P2.47)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0157 (SLO enforcement read API + `crossengin-slo` CLI), ADR-0143 (incidents CLI subcommand on operate-server), ADR-0141 (operate-server SLO incidents), ADR-0142 (operate-server SLO evaluation persistence), ADR-0087 (apps/operate-server — the runnable serving binary), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.47).

## Context

P2.46 (ADR-0157) gave `@crossengin/observability-runtime-pg` a
framework-neutral read+verify surface over the SLO enforcement audit
tables: a pure `query.ts` (`parseSloArgs` + `runSloQuery` over a
structural `SloQuerySource`), a windowed `PostgresSloEnforcementActionStore.
listSince`, and a `crossengin-slo` bin (`slo actions|summary|verify`). At
the same time, `apps/operate-server`'s own `--slo --slo-persist` loop is a
**producer** of those very rows — every served request's burn-rate /
latency decision writes a `meta.slo_enforcement_actions` row (P2.33 /
ADR-0142, M8.5). But the only way to *read them back* from a shell was the
standalone `crossengin-slo` tool. An operator running an
operate-server-only deployment (the binary that produced the data, with the
right `PG*` env already in place) had to install/run a second tool just to
ask "what enforcement actions fired?" or "is the enforcement history clean?".

P2.34 (ADR-0143) already established the pattern for this exact gap on the
incident side: `operate-server incidents <...>` mirrors the
`@crossengin/incident-response-pg` runner onto the serving binary. P2.47
does the same for the SLO enforcement tables.

## Decision

- **A second subcommand split in the bin.** `operate-server slo …` (i.e.
  `process.argv[2] === "slo"`) routes to a one-shot query that *exits*,
  alongside the existing `incidents` branch; every other invocation is the
  unchanged `serve` long-running loop. The serve help text gains one line
  pointing to `operate-server slo --help`. No change to any existing serve
  flag or default behavior.
- **`slo-cli.ts` is a thin re-wrapper, not a fork.** Unlike
  `incidents-cli.ts` (which re-implements its parser tied to the local
  `CliUsageError`), the package's `parseSloArgs` is fully framework-neutral
  — so `slo-cli.ts` *delegates* to it and only re-wraps its thrown
  `CliUsageError` (the package's own class, exported from `query.ts`) as
  operate-server's `CliUsageError`. This is the one place the error type
  matters: the bin's catch (`err instanceof CliUsageError` → print help,
  exit 2) is keyed on the operate-server class, so the package's class must
  be translated for misuse to map to exit 2 (rather than the generic
  fatal-error exit 1). The runner + types (`runSloQuery`, `SloQuerySource`,
  `RunSloResult`, `SloCliOptions`, `formatSloActions` / `formatSloSummary` /
  `formatSloVerify`) are re-exported from
  `@crossengin/observability-runtime-pg` — no second implementation. Help
  text is operate-server-flavored.
- **`executeSlo(options, out?)` in `node.ts`** — the thin DB wiring: opens a
  `PgConnection` from the `PG*` env vars (via `parsePgEnvConfig()`), builds
  the same `StoreSloQuerySource` adapter the `crossengin-slo` bin builds
  (`PostgresSloEnforcementActionStore` for the reads — `listSince` when
  `--since` is set, else `listRecent` — plus the pure
  `verifyEnforcementHistory` for `verify`), dispatches through
  `runSloQuery`, closes the connection in a `finally`, and returns the exit
  code (`verify` returns 1 on drift). Mirrors `executeIncidents` (P2.34).
- **Bin dispatch.** `bin/operate-server.ts` adds a `runSloCommand` helper
  (parse argv slice 3 → `executeSlo`) and an `argv[2] === "slo"`
  short-circuit at the top of `main()`. `--help` on the subcommand prints
  the slo help and exits 0; a `CliUsageError` exits 2; the subcommand
  `process.exit`s on completion (it does **not** fall through into the
  keep-alive serve loop).

## Cross-cutting invariants enforced (by tests)

- **Parsing.** `slo-cli.test.ts`: `actions` defaults; `summary --since
  --limit` (spaced + inline); `verify --format json|human`; `--help`/`-h`
  → help (with and without a command); unknown command / invalid format /
  non-positive `--limit` / missing flag value → `CliUsageError`. One test
  asserts the re-wrap: the package's `CliUsageError` surfaces as the
  operate-server `CliUsageError` instance. The help text is verified to
  mention `operate-server slo`, `actions`, and `--slo-persist`.
- **Re-wrap, not re-implement.** Because the package's `parseSloArgs` is
  framework-neutral, the operate-server parser is a four-line `try/catch`
  delegate — strictly less app-local logic than the incidents mirror.
- **Bin split.** No behavioural change to `serve` or to the existing
  `incidents` subcommand — the prior offline tests pass unchanged.

## Alternatives considered

- **Re-implement `parseSloArgs` locally (as `incidents-cli.ts` does).** No
  — the package's parser is already framework-neutral and throws a
  catchable `CliUsageError`. Reusing it (re-wrapping only the error) is
  strictly less code and the single source of truth for SLO flag parsing.
  The incidents parser is duplicated only because it was already
  app-local-and-`CliUsageError`-tied before the package extraction; the SLO
  parser was designed framework-neutral from the start (P2.46).
- **A separate `operate-slo` binary.** No — the serving app already
  produces the enforcement actions and connects with the right `PG*` env; a
  subcommand reuses that wiring and keeps one deployable artifact per app
  (mirroring P2.34 / the worker's choice in P2.22).
- **A gated PG integration test for the operate-server `slo` CLI path.** No
  — `runSloQuery` is fully offline-tested over a fake source in
  `@crossengin/observability-runtime-pg` (P2.46), the parser is fully
  offline-tested here, and `executeSlo`'s wiring is thin and identical-shape
  to the gated-tested `crossengin-slo` bin. A second gated CLI test would be
  marginal.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables** (no new
  tables/columns/packages; +11 offline tests on `apps/operate-server`). The
  serving app's SLO enforcement audit is now operable from one binary
  (`operate-server slo actions|summary|verify`) — the same surface
  `crossengin-slo` ships, both backed by `@crossengin/
  observability-runtime-pg`. An operator on an operate-server-only
  deployment no longer needs the standalone tool to read or verify the
  enforcement actions the server itself wrote.
- **The P2.46 framework-neutral runner pays off twice over** — adding the
  second consumer's subcommand was three files (`slo-cli.ts` +
  `slo-cli.test.ts` + a new `executeSlo`/`StoreSloQuerySource` in `node.ts`
  + a bin split), with the parser fully reused (only its error re-wrapped).
  The persistence ↔ read+verify symmetry now holds for the SLO enforcement
  tables from *both* the worker's `crossengin-slo` and the serving binary.
