# ADR-0165: `crossengin retention effective` CLI action (Phase 2 M6.7.zz.tenant.opt-out.cli.effective)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0159 (M6.7.zz.tenant.dashboard effectiveRetention), ADR-0164 (M6.7.zz.tenant.opt-out.cli `retention expiring`) |

## Context

ADR-0164 / M6.7.zz.tenant.opt-out.cli introduced the `retention` top-level CLI subcommand with its first action `expiring`. ADR-0159 Q5 lined up the natural sibling action:

> Q5: CLI exposure. `crossengin retention effective <tenant> <table>` subcommand mirroring the M5.9 sessions pattern. Defer to a later CLI milestone.

The ADR-0159 / M6.7.zz.tenant.dashboard resolver returns a 4-variant discriminated union: `tenant`, `tenant_opt_out`, `platform`, `none`. Operators answering "what's the retention policy for tenant X on table Y right now?" need a CLI surface — direct SQL queries against the two underlying tables miss the resolution semantics (precedence, expiry filtering, the discriminated union shape).

M6.7.zz.tenant.opt-out.cli.effective closes ADR-0159 Q5 with a new action `effective` under the `retention` subcommand. Wraps the resolver one-for-one with a discriminated-union-aware output renderer.

## Decision

Add `effective` action to the `retention` switch in `apps/architect-cli/src/retention.ts`. Takes two positional args:

```
crossengin retention effective <tenant-id> <table-name> [--format human|json]
```

### Output rendering — discriminated union aware

The resolver returns one of four variants; the CLI renders each distinctly so operators see the actual semantic at a glance.

**`source: "tenant"`:**

```
Tenant override (active)
  Tenant:     <uuid>
  Table:      workflow_traces
  Retention:  30 day(s)
  Enabled:    yes
```

**`source: "tenant_opt_out"`:**

```
Tenant opt-out (active)
  Tenant:     <uuid>
  Table:      workflow_traces
  Until:      2027-01-01T00:00:00.000Z
  Reason:     legal_hold:case#42
```

Indefinite opt-outs (null `optOutUntil`) render as `Until: indefinite`. Null `optOutReason` renders as `Reason: <no reason>` — same convention as the `expiring` action from ADR-0164.

**`source: "platform"`:**

```
Platform default
  Tenant:     <queried-uuid>
  Table:      workflow_traces
  Retention:  90 day(s)
  Enabled:    yes
```

Platform variant doesn't carry a `tenantId` (the policy is platform-wide), so the queried tenant id from the command line is rendered for context.

**`source: "none"`:**

```
No policy configured
  Tenant:     <queried-uuid>
  Table:      workflow_traces
```

The "no policy" variant gives operators an immediate signal — neither tenant nor platform policy exists for this (tenant, table) pair.

### JSON output

```json
{
  "tenantId": "<queried-uuid>",
  "tableName": "workflow_traces",
  "resolution": {
    "source": "tenant_opt_out",
    "retentionDays": null,
    "enabled": false,
    "tenantId": "<uuid>",
    "optOutReason": "legal_hold:case#42",
    "optOutUntil": "2027-01-01T00:00:00.000Z"
  }
}
```

The full resolution union is emitted unchanged — downstream consumers (dashboards, alert systems, compliance reports) get the typed shape via `jq` or programmatic JSON parsing.

The envelope echoes the queried `tenantId` + `tableName` so consumers can correlate even when the resolution itself omits one (e.g., the `platform` variant doesn't include a tenantId).

### Why echo the queried tenantId in the envelope vs preserve only the resolution

The resolution union is shape-determined — `platform` and `none` variants don't include `tenantId`. JSON consumers piping multiple resolutions through `jq` lose track of which tenant each resolution belongs to. Echoing the queried fields in the envelope keeps every output self-contained.

### Why action-verb pattern

Mirrors ADR-0164's design rationale. `retention effective` slots into the same namespace as `retention expiring`; future actions (`retention opt-out`, `retention opt-in`, `retention list-policies`) continue the pattern.

### Why no `--clock` flag

Considered `--clock <iso-timestamp>` to override the application clock for resolution. Rejected — `effectiveRetention` is read-time semantic; operators wanting "what would this have resolved to last week?" need a history-aware substrate (deferred to a future milestone per ADR-0162 Q3). Clock injection is a testing concern; production CLI runs use `Date.now()` via the default `PostgresTraceRetention` constructor.

### Why no positional table-name validation

The resolver returns `source: "none"` for unknown tables — operators see "No policy configured" with the queried table name and get a clear signal. CLI-side validation against `META_PRUNABLE_TABLES` would duplicate the resolver's behavior; trust the substrate.

## Use cases unblocked

**1. Operator debugging "why isn't tenant X getting their custom retention?"**

```bash
$ crossengin retention effective <uuid> workflow_traces
Platform default
  Tenant:     <uuid>
  Table:      workflow_traces
  Retention:  90 day(s)
  Enabled:    yes
```

Surfaces "platform default" — operator now knows the per-tenant override isn't taking effect. Checks the database; finds the row has `enabled = false` or `opt_out_until` in the past.

**2. Compliance audit "is tenant X in active legal hold?"**

```bash
$ crossengin retention effective <uuid> llm_call_traces --format json | jq '.resolution.source'
"tenant_opt_out"
```

One-line check; pipes into compliance audit scripts.

**3. Tier migration verification**

```bash
$ for table in workflow_traces llm_call_traces; do
    crossengin retention effective <uuid> "$table"
  done
```

Verify the tenant resolves consistently across all tables after a policy migration.

**4. Dashboard tooltip integration**

```bash
crossengin retention effective <uuid> workflow_traces --format json
```

Web dashboard renders the badge directly from the JSON shape; no separate dashboard query needed.

## Drawbacks

1. **One (tenant, table) pair per invocation.** Bulk lookups across many tenants require a shell loop. Operators with that scale-up need will benefit from the deferred `effectiveRetentionBatch` resolver (ADR-0159 Q2) + a corresponding `--all-tables` / `--all-tenants` CLI flag (defer).
2. **Output column width.** Human format assumes a wide terminal (UUIDs are 36 chars). JSON output is the answer for narrow terminals.
3. **No "why" diagnostics.** When a tenant policy doesn't take effect (returns `platform`), the CLI doesn't explain why. Operators query the raw row to see `enabled = false` or `opt_out_until < now()`. A future `--explain` flag could surface this; defer.
4. **Discriminated union complexity in operator memory.** Operators must know that `platform` doesn't carry a tenantId but `tenant` does. The output rendering hides this by always showing a Tenant line — but operators reading JSON output see the shape difference. Acceptable; matches the resolver's design.

## Alternatives considered

1. **Flat positional args `retention effective --tenant <uuid> --table <name>`.** Rejected — verbose for a query taking exactly two required args; positional matches the sessions/gateway-routes `<id>` patterns.
2. **Default to all tables when `<table-name>` is omitted.** Rejected — pattern inconsistency with `sessions show <id>`. Defer to a future `retention effective <tenant> --all-tables` if operators ask.
3. **Print the resolver's raw struct field-by-field.** Rejected — operators read `source: "tenant_opt_out"` and have to mentally decode; the variant-aware rendering surfaces the semantic immediately.
4. **CSV / TSV output format.** Rejected this milestone — defer to a global `--format csv` for all retention CLI actions if needed.
5. **`retention effective <tenant>` (no table) returns all tables.** Rejected — semantic differs from single-pair query; bulk mode deserves its own action (e.g., `retention list-effective <tenant>`).
6. **Auto-fill `<table>` to a default like `workflow_traces`.** Rejected — operators querying without specifying table likely have a typo; failing fast with "missing arguments" is clearer.

## Open questions

1. **Bulk lookup.** `retention effective <tenant> --all-tables` or `retention list-effective <tenant>` returning a row per table. Pairs with the deferred `effectiveRetentionBatch` resolver. Defer.
2. **`--explain` flag for diagnostics.** Surface the raw row state ("tenant override exists but enabled=false") when the resolver falls through to platform. Useful for operator debugging. Defer.
3. **History flag.** `--at-time <iso>` would require a history-aware substrate (ADR-0162 Q3). Deferred along with that milestone.
4. **Exit code by source.** Operators wanting CI gates ("fail if no policy configured") could use `--exit-on none` to make the CLI exit 1 when `source: "none"`. Same shape as ADR-0164 Q4. Defer.
5. **Sibling mutation actions.** `retention opt-out <tenant> <table> [--until DATE] [--reason TEXT]` + `retention opt-in <tenant> <table>` would close the end-to-end CLI workflow. Defer to M6.7.zz.tenant.opt-out.cli.mutate.
6. **Comparison query.** `retention diff <tenant-a> <tenant-b> <table>` showing policy differences between two tenants. Useful for tier migration verification. Defer until requested.
