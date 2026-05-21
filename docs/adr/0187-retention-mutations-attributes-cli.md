# ADR-0187: `--attributes <json>` flag on retention mutation CLI actions (Phase 2 M6.7.zz.tenant.opt-out.cli.history.attributes)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0170 (retention history substrate), ADR-0171 (retention restore), ADR-0185 (--with-actor-names), ADR-0186 (--actor-id filter) |

## Context

ADR-0170 shipped the append-only retention history audit log with an `attributes JSONB NOT NULL default '{}'::jsonb` column for structured audit context. All 4 mutation adapter methods (`setTenantOptOut`, `clearTenantOptOut`, `setTenantRetention`, `deleteTenantPolicy`) plus `restoreTenantPolicy` (ADR-0171) accept `attributes?: Record<string, unknown>` as optional input. The substrate has been ready since the beginning — but the CLI never exposed a flag to populate it.

ADR-0170 listed Q10:

> Q10: `--attributes` CLI flag exposing structured audit context from mutation commands.

Real operator workflows piling context they want to capture:
- "I'm opting out tenant X for legal hold case#42, ticket INC-2026-001" — want to attach `{ticket: "INC-2026-001"}` to the history row
- Tier migration script: "I want every retention-set call during this migration to carry `{migration_id: "MIG-Q2-2026"}` for auditor traceability"
- Compliance review: "Show me every mutation made during the SOC 2 audit window with the auditor reference" — needs structured attributes to filter on later via `WHERE attributes ? 'audit_ref'`

Until now, operators couldn't write structured audit context from the CLI — they wrote raw SQL with embedded JSON, defeating the substrate's clean abstraction.

ADR-0186 added `--actor-id` filtering on history. ADR-0185 added actor display. M6.7.zz.tenant.opt-out.cli.history.attributes closes the third side of the audit-metadata triangle: arbitrary structured context flowing in from the CLI.

## Decision

### CLI surface

```
crossengin retention opt-out  <...> [--attributes '<json-object>']
crossengin retention opt-in   <...> [--attributes '<json-object>']
crossengin retention set      <...> [--attributes '<json-object>']
crossengin retention delete   <...> [--attributes '<json-object>']
crossengin retention restore  <...> [--attributes '<json-object>']
```

`--attributes` is a string flag accepting a JSON object string. The CLI parses + validates it, then threads `Record<string, unknown>` through to the existing adapter method which writes it into the history row's `attributes` JSONB column.

5 mutation/restore sites (the 4 from ADR-0170 Q10's question plus restore from ADR-0171 which already accepts attributes via the adapter). Uniform flag across all 5.

### Validation rules

| Condition | Exit | Message anchor |
|---|---|---|
| `--attributes` not set | 0 | (passes `undefined` to adapter) |
| Valid JSON object | 0 | — |
| Invalid JSON syntax | 2 | `not valid JSON: <reason>` |
| Valid JSON but array | 2 | `must be a JSON object (not array, primitive, or null)` |
| Valid JSON but primitive (string/number/boolean) | 2 | same |
| Valid JSON but `null` | 2 | same |
| Empty object `{}` | 0 | (valid, no attributes added) |

Validation fires BEFORE the adapter call — invalid `--attributes` returns exit 2 without any PG queries. CI logs that say "exit 2" are immediately recognizable as CLI misuse.

### Why JSON-object-only

JSON arrays + primitives + null are valid JSONB values that PG accepts. The substrate's CLI surface is opinionated about shape because:
- `attributes` is conceptually a record (key-value bag) — arrays/primitives don't compose with `attributes.restored_from` (ADR-0171) or compliance queries like `WHERE attributes ? 'audit_ref'`
- The default substrate value is `{}::jsonb` — operators expect to extend that record, not replace it with a non-record type
- Future merge patterns (e.g., adapter-injected `restored_from`) only work on objects

Operators with array-shape data wrap it: `{"items": ["a", "b"]}` instead of `["a", "b"]`.

### Shared private helper

`parseAttributesFlag(command)` returns a discriminated union:

```ts
type AttributesParseResult =
  | { ok: true; attributes: Record<string, unknown> | undefined }
  | { ok: false; error: string };
```

All 5 runner functions call it after parsing other flags, before adapter invocation. The helper handles all 5 validation cases uniformly — no duplicated parsing logic per action.

### Adapter unchanged

All 5 adapter methods already accept `attributes?: Record<string, unknown>` from ADR-0170 / ADR-0171. The CLI just stops passing `undefined` always. Zero substrate changes. The history row gets the attributes JSONB column populated via the existing CTE chain.

### Restore merges attributes

`restoreTenantPolicy` from ADR-0171 deliberately merges `{restored_from: historyId}` with any operator-supplied attributes. So `crossengin retention restore <id> --attributes '{"ticket": "INC-001"}'` produces a history row with `attributes = {restored_from: "<historyId>", ticket: "INC-001"}`. Operators querying for "every restore with ticket X" use `WHERE attributes ->> 'restored_from' IS NOT NULL AND attributes ->> 'ticket' = 'X'`.

This was already in the substrate; this milestone just exposes the operator-supplied half via CLI.

### Help text

A 4-line common-flag note follows the 5 mutation/restore usage lines:

```
                          All 5 mutation/restore actions accept --attributes '<json>'
                          where <json> is a JSON object merged into the history row's
                          attributes JSONB column. Restore merges {restored_from:
                          historyId} with operator-supplied attributes. Invalid JSON or
                          non-object value returns exit 2.
```

## Use cases unblocked

**1. Incident-ticket attribution**

```bash
crossengin retention opt-out <legal-hold-tenant> workflow_traces \
  --until 2026-12-31 \
  --reason "subpoena_response" \
  --actor "<ops-user-uuid>" \
  --attributes '{"ticket":"INC-2026-001","jurisdiction":"NY","attorney":"alice.smith"}'

# History row: attributes = {ticket: "INC-2026-001", jurisdiction: "NY", attorney: "alice.smith"}
# Operator queries later: WHERE attributes ->> 'ticket' = 'INC-2026-001'
```

**2. Bulk migration with shared marker**

```bash
MIG_ID="MIG-Q2-2026"
for tenant in $(cat tier-migration-list.txt); do
  crossengin retention set "$tenant" workflow_traces --days 90 \
    --actor "$migration_bot_uuid" \
    --attributes "{\"migration_id\":\"$MIG_ID\",\"batch\":\"tier-promotion\"}"
done

# Later audit: "Show me every retention set during MIG-Q2-2026":
# WHERE attributes ->> 'migration_id' = 'MIG-Q2-2026'
```

**3. Compliance audit closing context**

```bash
crossengin retention delete <free-trial-tenant> workflow_traces \
  --actor "$compliance_officer" \
  --attributes '{"offboarding":"trial_expiry","retention_review":"closed","auditor":"ext-firm-X"}'
```

**4. Forensic restore with context**

```bash
crossengin retention restore "$accidental_delete_history_id" \
  --actor "$ops_lead" \
  --attributes '{"undo_reason":"customer_complaint","escalation":"INC-2026-007","approval":"director"}'

# History row attributes: {
#   restored_from: "<source-history-id>",
#   undo_reason: "customer_complaint",
#   escalation: "INC-2026-007",
#   approval: "director"
# }
```

## Drawbacks

1. **JSON-object-only restriction** — operators with array-shape data wrap it in a record. Documented.
2. **Shell-quoting gotchas** — embedded quotes in JSON need shell escaping. Operators using `--attributes "{\"key\":\"value\"}"` instead of `'{"key":"value"}'` may hit shell-substitution issues. Standard for CLI tools accepting JSON strings; documented.
3. **No `--attributes-file <path>`** for large JSON. Operators wanting that wrap in shell `--attributes "$(cat ctx.json)"`. Future Q if requested.
4. **No schema validation on attributes content** — substrate accepts any JSON object shape. Operators wanting "every restore must have a ticket field" enforce at workflow/policy layer, not in the substrate.
5. **No multi-attributes merge from multiple flags** — operators wanting "base attributes from env + per-call additions" merge in shell before invocation. Defer.
6. **Validation happens per-runner** — 5 mutation runners each call `parseAttributesFlag` independently. Acceptable since per-runner error messages prefix the action name (`retention opt-out:`, `retention set:`, etc.), giving operators crisp error context.

## Alternatives considered

1. **Substrate-side JSON validation** — adapter rejects non-object attributes. Rejected — substrate stays permissive; CLI is the right boundary for shape enforcement.
2. **Accept any JSON value** (arrays/primitives/null allowed) — would diverge from the `attributes` JSONB column's conceptual contract (key-value bag). Rejected.
3. **`--attribute <key>=<value>` repeated flag** for shell-friendly key=value pairs using ADR-0183 `multiFlags` infrastructure — keys are limited to strings (no nested objects), and operators with structured context lose expressiveness. Could ship as a sibling flag later (`--attribute key=value` for simple cases, `--attributes <json>` for structured). Defer the simpler-syntax variant.
4. **Auto-merge environment-variable attributes** (`CROSSENGIN_DEFAULT_ATTRIBUTES`) — implicit context invites surprises in pipelines. Operators control via shell.
5. **`--attributes-file <path>` instead of inline JSON** — adds file-reading code path; operators chain with `cat`. Defer.
6. **Restore auto-merge order** — `{restored_from: historyId, ...operator}` vs `{...operator, restored_from: historyId}`. Substrate already chose operator-after-restored (operator can't override the system field). Rejected the opposite.
7. **JSON Schema validation hook** for operator-defined attribute contracts — out of scope for v1; operators wrap with their own jq pre-validation if needed.
8. **Strip `restored_from` from operator-supplied attributes on restore** to prevent forging the audit reference. Rejected — adapter merges operator + system attributes; system-key wins on conflict, so operators can't forge. Current behavior is safe.

## Open questions

1. **`--attribute key=value` simpler-syntax sibling flag** using `multiFlags` infrastructure for non-structured cases. Defer.
2. **`--attributes-file <path>`** for large JSON. Defer.
3. **`--attributes-env <var-name>`** reading from environment variable for CI-secret-like values. Defer.
4. **JSON Schema validation hook** per-tenant or per-action. Operator-policy concern; substrate doesn't enforce.
5. **Merge semantics in `retention set` when row already has attributes** (currently history row is per-event; live policy row has no attributes column). Tracked but substrate-design-bound; no Q to defer.
6. **Surface `attributes` in `retention history` human output** for inline auditing. Currently only JSON output shows it; human-format omits for terminal width. Future Q.
7. **`--require-attributes-keys <list>`** CLI gate forcing operators to provide certain keys (e.g., `--require-attributes-keys ticket`). Operator-policy; defer.
