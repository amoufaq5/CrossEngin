# ADR-0106: apps/workflow-worker — the runnable distributed worker binary (Phase 3 P2.3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0105 (activity retry executor), ADR-0104 (timer claim), ADR-0103 (workflow-worker), ADR-0087 (apps/operate-server), ADR-0049 (workflow-runtime), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.3).

## Context

P2 (ADR-0103/0104/0105) built the distributed-worker **library** in
`@crossengin/workflow-worker` — `WorkflowWorker` (advisory-lock bulk tick),
`ClaimingTimerWorker` (parallel per-unit timer claim), and
`RetryExecutorWorker` (parallel activity retry), each over a claim store + the
engine's per-unit primitives (`fireTimer` / `retryActivity`). But nothing *ran*
them: like `operate-runtime` before `apps/operate-server` (ADR-0087), the worker
was a set of composable classes with no deployable artifact. P2.3 ships that
artifact — a `workflow-worker` binary that wires `buildPersistentEngine` + the
selected workers over the standard `PG*` env config, the third app under
`apps/`.

## Decision

- **`apps/workflow-worker`** — a new app (`@crossengin/workflow-worker-app`,
  third under `apps/` after `architect-cli` + `operate-server`) shipping the
  `workflow-worker` bin. 4 src modules + a bin, all offline-testable:
  - **`cli.ts`** — `parseWorkerArgs(argv) → WorkerCliOptions`. `--mode
    tick|claim|retry|all` (default `all` — the parallel claim + retry combo); a
    random `--worker-id` when omitted (the lease owner); `--schema` (default
    `meta`); per-loop poll intervals `--tick-interval-ms` (5000) /
    `--claim-interval-ms` (1000) / `--retry-interval-ms` (5000); `--batch-size`
    (50) + `--lease-ms` (30000) for the claims; `--definitions <file>` (a JSON
    array of `WorkflowDefinition`s); `--help` / `--version`. Space + inline
    (`--flag=value`) forms; integer flags validated against a minimum;
    `CliUsageError` on misuse.
  - **`runner.ts`** — `buildWorkerSet(input) → WorkerSet` is the framework-neutral
    core: it constructs the worker(s) for the selected mode over one
    `PgConnection` + one `WorkerEngine` (the structural union of `TimerTickEngine`
    + `FireTimerEngine` + `RetryActivityEngine`, all satisfied by the engine
    `buildPersistentEngine` returns) — `tick` → `WorkflowWorker`; `claim` →
    `ClaimingTimerWorker` over `PostgresTimerClaimStore`; `retry` →
    `RetryExecutorWorker` over `PostgresActivityRetryClaimStore`; `all` → claim +
    retry. Each worker polls on its own interval; `start()` / `stop()` drive them
    together. The scheduler + `onError` are injectable, so the wiring is tested
    with fakes (no DB).
  - **`node.ts`** — `run(options)` opens a `createNodePgConnection(
    parsePgEnvConfig())`, loads the `--definitions` file
    (`parseDefinitionsJson` validates each via `WorkflowDefinitionSchema`, keys
    by `id`), builds the persistent engine (so every fire/retry projects through
    the event log), builds + starts the worker set, and returns a `close()` that
    stops the workers and closes the connection. `parseDefinitionsJson` is a pure,
    tested seam.
  - **`bin/workflow-worker.ts`** — the thin Node entry: parse → help/version →
    `run` → print the running labels. Since every poll loop runs on an **`unref`'d**
    timer (so tests never hang), the bin holds the event loop open with a
    referenced keep-alive that `SIGINT`/`SIGTERM` clears before `close()`.

The worker connects with a role that sees **all tenants'** workflow rows
(BYPASSRLS / table owner), as documented on the claim stores — one worker drains
every tenant.

## Cross-cutting invariants enforced (by tests)

- **Mode selects the right workers.** `buildWorkerSet` wires exactly `[tick]` /
  `[claim]` / `[retry]` / `[claim, retry]` per mode, each polling its configured
  interval; `start()` registers one interval per worker, `stop()` clears them
  all (verified with a recording scheduler — no DB).
- **CLI parse is total.** Every flag parses in space + inline form; an unknown
  mode / argument, a non-integer or below-minimum numeric flag, and a
  value-less flag all raise `CliUsageError`; a random worker id is distinct per
  invocation; `--help` / `--version` short-circuit.
- **Definitions parse + validate.** `parseDefinitionsJson` turns a JSON array
  into an `id → definition` map (each through `WorkflowDefinitionSchema`),
  rejects a non-array document and a malformed definition.
- **Invalid schema rejected at wiring.** A bad `--schema` is rejected by the
  claim store constructor (only a validated identifier reaches SQL).

## Alternatives considered

- **Add a subcommand to `operate-server` instead of a new app.**
  - **Decision.** No — the worker is a different process with a different
    lifecycle (no HTTP listener, a poll loop, a BYPASSRLS role) and a different
    dependency set (no `operate-runtime` / manifest). A separate binary keeps
    each app's surface coherent, mirroring `architect-cli` vs `operate-server`.
- **Default `--mode` to `all` = tick + claim + retry.**
  - **Decision.** No — `tick` (advisory-lock bulk) and `claim` (per-unit) both
    fire timers; running both wastes work (the bulk tick fires what the claim
    would). `all` = claim + retry is the parallel production combo; `tick` stays
    the single-worker simple default for those who want it.
- **Embed definitions in the binary / load from the DB.**
  - **Decision.** Deferred — a `--definitions` JSON file is the minimal, testable
    enabler (the engine needs the definition to run on-entry actions + match
    transitions). Loading published definitions from `workflow_definitions` is a
    natural follow-up behind the same `ReadonlyMap` seam.
- **Keep the process alive with a referenced poll timer.**
  - **Decision.** No — the workers `unref` their timers on purpose (so the
    library never hangs a test or a short-lived embed). The bin owns the
    keep-alive (a referenced no-op interval cleared on shutdown), so liveness is
    the *app's* concern, not the library's.

## Consequences

- **60 packages + 3 apps, 123 meta-schema tables, 6,437 tests** (was 6,416;
  +21, all in the new app; 0 new tables/packages — apps don't add to the package
  count, but `apps/` grows to three). P2 now has a **deployable artifact**:
  `workflow-worker --mode all` runs the parallel claim + retry loops over the PG
  event log; `--mode tick` runs the advisory-lock bulk worker; scale by running
  N processes.
- **The P2 arc is functionally complete** — engine per-unit primitives
  (`fireTimer` / `retryActivity`), claim stores (`FOR UPDATE SKIP LOCKED` +
  lease), workers (bulk + parallel), and now a binary that runs them. The deeper
  P2 work named in ADR-0105 remains: a full async activity *queue* (decouple
  schedule from execute), backoff `next_retry_at` population, and timeout
  sweeping — all behind the same claim/lease + per-unit-execute pattern.
- **`apps/` is now three binaries** — `architect-cli` (authoring),
  `operate-server` (serving), `workflow-worker` (background progression) — the
  three process shapes a deployed CrossEngin tenant runs.
