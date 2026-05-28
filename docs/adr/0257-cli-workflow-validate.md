# ADR-0257: `crossengin workflow validate` CLI gate

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-26 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0256 (the validator the gate exposes), ADR-0181 (`--exit-on-divergence` exit-3 CI-gate convention this milestone follows), ADR-0051 (architect-cli baseline) |

## Context

ADR-0256 (M8.8) shipped `validateDefinition(def)` in
`@crossengin/workflow-engine` as a structured authoring-time
validator returning `{ok, issues[]}` with 5 stable codes and JSON-
pointer-like paths. The function is the right API surface, but
operators don't have a one-command path to invoke it. Today the
options are:

1. Author a TypeScript script that imports `@crossengin/workflow-
   engine`, reads JSON, calls `validateDefinition`, prints. Every
   operator writes the same boilerplate.
2. Wire validation into a custom CI step that re-implements file-
   read + JSON-parse + schema-parse + format. Three bespoke
   pipelines per operator.

Both paths reinvent the same wheel. M8.8's substrate gain was the
operator-time complement to the M8.7 driver, but without a CLI gate
operators can't actually run it.

## Decision

Add `crossengin workflow validate <def.json> [--strict]` as a new
top-level subcommand action. `workflow` joins the existing nine
subcommands (`init`, `validate` (legacy manifest validator),
`diff`, `patch`, `hash`, `apply`, `chat`, `sessions`, `gateway`,
`retention`).

```
$ crossengin workflow validate path/to/def.json
workflow validate: ok — wfd_invoice42 (invoice.approval)

$ crossengin workflow validate broken.json
workflow validate: wfd_x (broken.flow) — 2 error(s), 1 warning(s)
  error[unknown_variable_in_action] transitions[0].preTransitionActions[0].parameters.variableName: set_variable references undeclared variable ghost
  error[dead_end_state] states[2]: non-terminal state pending has no outgoing transitions (instance would be stuck)
  warning[unreachable_state] states[3]: state orphan is not reachable from initialState start
```

**Pipeline.** `readFile → JSON.parse → WorkflowDefinitionSchema
.safeParse → validateDefinition → render`. Exit codes follow the
established CrossEngin CLI convention:

| Exit | Cause |
|------|-------|
| 0    | Valid (no errors). Warnings allowed unless `--strict`. |
| 1    | I/O failure (file unreadable). Runtime error. |
| 2    | CLI misuse OR schema rejection (parse-time errors). |
| 3    | Validation errors (ADR-0256 issues with severity=error) OR `--strict` with any warning. |

The exit-3 convention is the same one ADR-0181 established for
`retention diff --exit-on-divergence` — keeps drift/validation
signal distinguishable from runtime errors (exit 1) and misuse
(exit 2) so CI scripts can route by status code:

```bash
case $? in
  0) echo "ok" ;;
  1) echo "runtime — investigate"; exit 1 ;;
  2) echo "misuse — fix the call"; exit 2 ;;
  3) echo "validation failed — fix the definition"; exit 1 ;;
esac
```

**`--strict`** promotes warnings to exit-3 territory. Default
treats `unreachable_state` (the only warning) as non-fatal; ops
preferring zero-tolerance enable strict in CI.

**Output formats.** Two modes mirror the established retention-CLI
pattern:

- **human** (default): one-line `ok` on success; multi-line
  `error[code] path: message` / `warning[code] path: message` on
  failure with a header summary.
- **json**: structured envelope
  `{action: "workflow.validate", path, ok, definitionId,
  definitionKey, errorCount, warningCount, issues[]}` for
  pipeline integration. Schema-rejection emits a distinct
  `{schemaError: true}` envelope so consumers can branch on the
  cause.

**Schema-error pre-pass.** Definitions failing
`WorkflowDefinitionSchema.safeParse` exit 2 (parse-time) before
the validator runs. Operators see zod issue paths + messages in
the same structured shape as ADR-0256 issues with
`code: "schema_error"` — uniform tooling consumption.

**No new exports.** The CLI consumes `validateDefinition` +
`WorkflowDefinitionSchema` + `WorkflowValidationIssue` already
exported from `@crossengin/workflow-engine`; the architect-cli
package gets a new `workflow-engine` workspace dep.

## Alternatives considered

- **`crossengin validate-workflow <path>` (flat subcommand).**
  - **Why not:** breaks the action-verb pattern (`sessions list`,
    `gateway routes register-pack`, `retention diff-history`).
    `workflow validate` reserves namespace for future actions like
    `workflow lint --rules`, `workflow apply` (engine-side
    publication CRUD when M9 lands).

- **Fold into the existing `crossengin validate <path>` (manifest
  validator).**
  - **Why not:** `validate` currently runs the kernel manifest
    validator (`tryValidateManifest`). Workflow definitions are a
    different schema with a different validator. Auto-detecting by
    file content is magical + surprising. The new namespace is
    clearer.

- **Exit 1 on validation errors instead of exit 3.**
  - **Why not:** collides with runtime errors. Distinguishability is
    the explicit ADR-0181 convention; we follow it here.

- **`--quiet` flag to suppress output.**
  - **Why not:** premature. Operators piping to /dev/null can do
    that explicitly. Add when measured.

- **Auto-invoke on `crossengin apply --pack ...` (workflows in the
  pack get validated before SQL emit).**
  - **Why not:** scope creep. Pack-level workflows aren't yet
    materialized through the engine schema (packs declare
    `entityLifecycle` workflows in the manifest, not as
    `WorkflowDefinition`). When M9 brings engine-side workflow
    publication, the gate composes naturally.

- **Read multiple paths in one invocation
  (`crossengin workflow validate def1.json def2.json ...`).**
  - **Why not:** shell loops cover it. The exit-code semantic gets
    muddier (worst exit? sum?). Single-path keeps the contract
    sharp.

## Consequences

- **Positive:** one-command CI gate. Operators wire
  `crossengin workflow validate **/*.json --strict` into pre-commit
  / GH Actions / pre-publish hooks without writing boilerplate.
- **Positive:** structured JSON output for pipeline integration.
  Consumers branch on `schemaError` vs `errorCount > 0` distinctly.
- **Positive:** the workflow namespace is now established; future
  actions (`workflow lint`, `workflow inspect`, `workflow apply`)
  fit naturally without breaking the established subcommand
  vocabulary.
- **Neutral:** architect-cli gains a `@crossengin/workflow-engine`
  workspace dep (was previously absent — kernel + ai-* + api-* +
  pack-* only).
- **Neutral:** SUBCOMMANDS grows from 11 to 12 entries.
- **Reversibility:** trivial — delete `workflow.ts` + revert the
  three bin/dispatcher edits + the cli.ts SUBCOMMANDS / helpText
  entries.

## Implementation notes

- The `runWorkflow` dispatcher reads `command.positional[0]` for the
  action verb (`validate`); future actions add a `case` branch.
  Unknown action → exit 2 with "unknown action 'X'" mirroring
  `sessions` + `gateway routes` dispatchers.
- File-read errors return exit 1 (runtime). JSON-parse + schema-
  reject return exit 2 (misuse). Validation errors return exit 3
  (CI gate). `--strict` + warnings also exit 3.
- The CLI smoke-tested end-to-end:
  `crossengin workflow validate sample-def.json` returns
  `workflow validate: ok — wfd_sampleok1 (sample.workflow)` and
  exit 0; `--format json` emits the structured envelope.
- 13 new tests in `apps/architect-cli/src/workflow.test.ts` cover:
  dispatch missing/unknown action exits 2; missing path exits 2;
  unreadable file exits 1; invalid JSON exits 2; schema rejection
  exits 2 with `schema_error`; clean ok exits 0; validator errors
  exit 3 with code in stdout; unreachable warning exits 0 by
  default; `--strict` promotes warning to exit 3; `--format json`
  on success/failure/schema-error each emits the expected
  envelope shape.
- architect-cli test count 1,214 → **1,227** (+13). Workspace test
  count 9,462 → **9,475**.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Bulk path — `crossengin workflow validate <glob>` validating every JSON in a directory tree (or repeated positional args) with aggregate exit | platform | _deferred_ |
| `--rule <code> off|warn|error` overrides — operators tune individual codes per-repo (e.g. promote `unreachable_state` to error project-wide) | platform | _deferred_ |
| Auto-detect workflow vs manifest format from file content + dispatch to the right validator (`crossengin validate <any-path>`) | platform | _deferred_ |
| `crossengin workflow lint <path>` — separate action for stylistic warnings (naming conventions, label completeness) distinct from semantic errors | platform | _deferred_ |
| Integration with `crossengin apply --pack` to validate every embedded workflow definition before SQL emit (needs M9 engine-side workflow publication first) | platform | _deferred_ |
| `--diff <baseline.json>` — compare a definition to its previous version, flag breaking changes (state removal, transition rename) | platform | _deferred_ |

## References

- ADR-0256 — the underlying validator this gate exposes.
- ADR-0181 — exit-code convention (exit 3 for CI-gate failures).
- ADR-0051 — architect-cli baseline subcommand pattern.
- `apps/architect-cli/src/workflow.ts` — the dispatcher.
- `apps/architect-cli/src/cli.ts` — SUBCOMMANDS + helpText.
- `apps/architect-cli/bin/crossengin.ts` — switch wiring.
