# ADR-0210: `crossengin retention history --actor-id-not` repeatable for multi-value OR-semantic exclusion filter (Phase 2 M6.7.zz.tenant.opt-out.cli.history.actor-not.multi)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0206 (--actor-id-not single-value filter), ADR-0186 (--actor-id positive filter), ADR-0199 (diff-timeline multi-actor precedent), ADR-0207 (diff-timeline multi-actor-not precedent), ADR-0183 (multiFlags infrastructure) |

## Context

ADR-0206 shipped `--actor-id-not <uuid>` as a single-value substrate-side WHERE NOT filter on `retention history`. The Q1 future Q explicitly listed widening to multi-value via repeated flag using the `multiFlags` infrastructure from ADR-0183:

> 1. `--actor-id-not` multi-value via repeated flag using multiFlags from ADR-0183 (operators with cohort-exclusion needs would benefit).

The single-value semantic intentionally matched the existing single-value `--actor-id` filter from ADR-0186 (also retention history). At the time ADR-0206 documented that divergence with diff-timeline (which by ADR-0207 had landed multi-value `--actor-id-not` matching ADR-0199's multi-value `--actor-id`). Operators with cohort-exclusion workflows ("exclude these 3 service accounts" / "exclude this audit reviewer + the migration SA + the test bot") couldn't express the OR-semantic exclusion in one command — they chained multiple `retention history --format json | jq` runs and concatenated.

Real cohort-exclusion use cases motivate the widening:

1. **Service-account allowlist audit** — operators auditing human activity on a regulated tenant want to exclude N known service accounts (CI bot, migration SA, sweep SA, support-tool SA) in one command, with LIMIT correctness + cursor-pagination correctness preserved.
2. **Self-exclude reviewer cohort** — incident responder auditing the response activity wants to exclude their own actor_id + the on-call lead + the SRE who deployed the fix — three actors, one command.
3. **Compliance non-automation filter** — regulatory "human review" event lists excluding migration SA + scheduled-job SA + automated-recovery SA (typically 3-5 SAs in a mature deployment).
4. **Cohort negative attestation** — auditor produces "every mutation NOT made by the platform-admin cohort" with the admin cohort expressed as 4-5 actor UUIDs.

M6.7.zz.tenant.opt-out.cli.history.actor-not.multi closes ADR-0206 Q1 by widening `--actor-id-not` to multi-value via repeated flag — same shape as ADR-0207's multi-value on diff-timeline (the precedent that established the multi-value OR-semantic exclusion pattern across surfaces).

## Decision

### CLI surface

```
crossengin retention history [--actor-id <uuid>]
                             [--actor-id-not <uuid> ...]   # NEW: repeatable
                             [--system-only | --no-system]
                             [other flags from ADR-0186/0196/etc.]
                             [--format human|json]
```

- `--actor-id-not <uuid>` is now repeatable via the `multiFlags` infrastructure from ADR-0183.
- Single occurrence: `--actor-id-not <a>` excludes one actor (equivalent to ADR-0206 single-value behavior).
- Multi occurrence: `--actor-id-not <a> --actor-id-not <b> --actor-id-not <c>` builds OR-semantic NOT IN ($1, $2, $3) clause.
- Empty (zero occurrences): treated as filter-not-set (no WHERE clause emitted) — backward compat.
- Composes with `--actor-id <uuid>` (positive filter; stays single-value this milestone) and `--system-only` / `--no-system` (from ADR-0209) without restriction.

### Adapter changes

`ListOptOutHistoryInput` field rename — breaking change for direct adapter consumers (session-recent code, no external consumers, contained scope):

```ts
// Before (ADR-0206):
readonly actorIdNot?: string;

// After (this milestone):
readonly actorIdsNot?: ReadonlyArray<string>;
```

One-shot clean break beats permanent two-field surface. Same pattern as ADR-0199's `actorId → actorIds` rename on diff-timeline.

SQL changes from single-value `(h.actor_id IS NULL OR h.actor_id != $N)` to multi-value `(h.actor_id IS NULL OR h.actor_id NOT IN ($N1, $N2, ...))`:

```ts
if (input.actorIdsNot !== undefined && input.actorIdsNot.length > 0) {
  const actorNotPlaceholders = input.actorIdsNot
    .map((actorId) => {
      params.push(actorId);
      return `$${params.length}`;
    })
    .join(", ");
  conditions.push(
    `(h.actor_id IS NULL OR h.actor_id NOT IN (${actorNotPlaceholders}))`,
  );
}
```

Single-element array yields `NOT IN ($N)` — PG treats this identically to `!= $N` (no observable behavior change for single-value callers; same query plan).

Empty array treated as filter-not-set matching ADR-0199/0207 convention — `actorIdsNot: []` produces no WHERE clause, equivalent to omitting the field entirely.

### Why explicit `IS NULL OR` prefix

Preserved from ADR-0206 — `actor_id NOT IN ($1, $2, ...)` in PostgreSQL returns NULL (not FALSE) when `actor_id IS NULL`, which silently filters system events OUT of results. Operator intent for `--actor-id-not` is "everything except these actors" which INCLUDES system events; explicit `IS NULL OR` prefix restores correct inclusion. Same trap that ADR-0206 documented, now extended to the multi-value form.

### Why duplicates are not deduplicated at adapter

If operator passes `--actor-id-not <a> --actor-id-not <a>`, adapter builds `NOT IN ($1, $2)` with both placeholders set to the same value. PG handles duplicates fine in IN lists (semantic identical to single-value). Substrate doesn't need to dedup — operator's duplicates pass through verbatim, matches ADR-0207 stance.

### CLI changes

`runRetentionHistory` reads via `getMultiFlag("actor-id-not")` instead of `getStringFlag("actor-id-not")`:

```ts
const actorIdsNotFlags = getMultiFlag(command, "actor-id-not");
const actorIdsNot: ReadonlyArray<string> | undefined =
  actorIdsNotFlags.length > 0 ? actorIdsNotFlags : undefined;
```

Threads `actorIdsNot` to adapter. No mutual-exclusivity check needed (multi-value via repeated flag is the natural extension of single-value; one occurrence = single-value behavior preserved).

### JSON envelope rename

```json
{
  "tenantFilter": null,
  "tableFilter": null,
  "eventKind": null,
  "actorId": null,
  "actorIdsNot": ["uuid-a", "uuid-b"],   // RENAMED: was actorIdNot
  "systemOnly": false,
  "noSystem": false,
  ...
}
```

Breaking JSON envelope rename — `actorIdNot: string | null` → `actorIdsNot: string[] | null`. Operators parsing the envelope:
- Single-occurrence: `actorIdsNot: ["<uuid>"]`.
- Multi-occurrence: `actorIdsNot: ["<a>", "<b>", ...]`.
- Not set: `actorIdsNot: null`.

Same shape as ADR-0207's diff-timeline envelope rename — array-or-null is the canonical multi-value envelope shape across the family.

### Composition with positive `--actor-id` filter

The positive `--actor-id` filter from ADR-0186 stays SINGLE-VALUE this milestone. This creates a documented within-surface asymmetry on retention history:

| Filter | Shape | ADR |
|---|---|---|
| `--actor-id` | single string | ADR-0186 |
| `--actor-id-not` | string array | ADR-0210 (this milestone) |
| `--system-only` / `--no-system` | boolean pair | ADR-0209 |

The asymmetry is documented as a future Q — widening `--actor-id` to multi-value on retention history would close ADR-0186's similar deferred future Q and restore within-surface symmetry. Deferred to a follow-up milestone to keep this milestone's scope focused on closing ADR-0206 Q1 specifically (as requested).

Within-surface asymmetry is acceptable here because:
1. Positive filter `--actor-id` and negative filter `--actor-id-not` are semantically distinct dimensions (the negative path benefits more from multi-value since "exclude these N noise actors" is a more common pattern than "include exactly these N specific actors").
2. The diff-timeline surface has BOTH multi-value (ADR-0199 + ADR-0207) — operators wanting multi-value positive filtering can use the diff-timeline surface, then narrow with retention history on per-actor pages.
3. The asymmetry is operator-visible via helpText + JSON envelope shape — no silent behavior change.

## Use cases unblocked

**1. Service-account allowlist audit**

```bash
# Audit human activity on regulated tenant excluding 3 known service accounts:
crossengin retention history --tenant <regulated> \
  --actor-id-not <ci-sa> --actor-id-not <migration-sa> --actor-id-not <sweep-sa> \
  --since 2026-04-01 --with-actor-names --format json > human-only.json
```

**2. Self-exclude reviewer cohort during incident**

```bash
# Forensic review excluding the response team itself:
crossengin retention history --tenant <suspect> \
  --actor-id-not $MY_ACTOR_ID --actor-id-not $ONCALL_ACTOR_ID --actor-id-not $SRE_ACTOR_ID \
  --since incident-start --until incident-end --with-actor-names
```

**3. Compliance non-automation filter**

```bash
# Quarterly compliance attestation: humans only, no automation cohort:
crossengin retention history --tenant <regulated> --no-system \
  --actor-id-not <ci-sa-1> --actor-id-not <ci-sa-2> --actor-id-not <migration-sa> \
  --since 2026-04-01 --until 2026-06-30 --format json > q2-2026-human-cohort.json
```

**4. Compose with --no-system for fine-grained "human cohort excluding subset"**

```bash
# Human events excluding 4 admin actors:
crossengin retention history --no-system \
  --actor-id-not <admin-1> --actor-id-not <admin-2> \
  --actor-id-not <admin-3> --actor-id-not <admin-4> \
  --with-actor-names
```

## Drawbacks

1. **Breaking adapter field rename `actorIdNot → actorIdsNot`** — direct adapter consumers (Node scripts calling the adapter without the CLI layer) need to update. Contained scope, session-recent code (ADR-0206 shipped recently), no external consumers, no production surface affected. One-shot clean break beats permanent two-field surface.
2. **Breaking JSON envelope rename `actorIdNot → actorIdsNot`** — operator jq scripts parsing the envelope need to update. Same justification as adapter rename. Operators reading either path can detect the rename via the array-vs-string shape.
3. **Within-surface asymmetry with single-value `--actor-id`** — positive filter stays single-value while negative filter goes multi-value (documented above). Acceptable until the natural-symmetric milestone widens `--actor-id` too. Documented future Q.
4. **No OR-semantic positive equivalent on retention history this milestone** — operators wanting "include any of these N actors" still run multiple commands or use the diff-timeline surface (which has multi-value positive via ADR-0199). Defer; pairs with the within-surface asymmetry future Q.
5. **No CLI-side dedup** — operators passing `--actor-id-not <a> --actor-id-not <a>` get a duplicate placeholder in SQL; PG handles fine but operator confusion possible. Defer; same stance as ADR-0207.
6. **No null-actor exclusion via this flag** — operators wanting "exclude system events" use `--no-system` (ADR-0209), not `--actor-id-not null` sentinel (would overload the UUID-string semantic). Composition with `--no-system + --actor-id-not <uuid>` is the canonical "human mutations excluding specific actors" pattern.
7. **PG IN-list at very large scale** — operators passing 100+ `--actor-id-not` flags hit PG parser limits; substrate doesn't chunk. Defer until measured slow. Realistic operator cohorts have <20 excluded actors.
8. **No CLI-side UUID validation per flag occurrence** — invalid UUIDs surface as PG errors with clearer messages. Matches ADR-0175/0186/0193/0206 deferred decision.

## Alternatives considered

1. **Two-field adapter surface (`actorIdNot: string` + `actorIdsNot: ReadonlyArray<string>`)** — permanent two-field surface invites operator confusion ("which one wins when both set?"). One-shot rename cleaner, matches ADR-0199 precedent.
2. **`--actor-id-not <a,b,c>` comma-separated single flag** — fragile with shell-quoted UUIDs containing punctuation; multi-flag via repeated flag is the established `multiFlags` pattern from ADR-0183. Operators with `$VAR` substitution + commas hit edge cases.
3. **`--actor-id-not-list <file.txt>` file-based input** — adds file-reading code path. Operators chain shell pipelines for very large lists. Defer.
4. **Keep single-value, document jq-workaround for multi-value** — fails LIMIT + pagination correctness arguments from ADR-0186/0206 (substrate-side WHERE is the only way to get both right). Rejected.
5. **Widen `--actor-id` to multi-value in the same milestone** — would close ADR-0186 future Q simultaneously and restore within-surface symmetry, BUT exceeds the user's requested scope ("multi-value --actor-id-not on retention history"). Documented as future Q for follow-up milestone.
6. **Substrate-side IN-list deduplication** — PG handles duplicates fine; CLI doesn't need to filter. Matches ADR-0207 stance.
7. **CLI-side validation of UUID format per flag occurrence** — PG errors are clearer; matches deferred-validation pattern across the family.
8. **`--actor-id-not <a>|<b>|<c>` pipe-separated alternative** — same shell-quoting concerns as comma-separated; repeated flag is the canonical multiFlags shape.
9. **Two ENV-style flag names `--exclude-actor` / `--exclude-actors`** — verbose; `--actor-id-not` matches ADR-0205/0206/0207 family naming.
10. **Adapter-side empty-array rejection** (throw on `actorIdsNot: []`) — operators may legitimately compute the list at the call site producing an empty array (e.g., when allowlist is empty). Treating empty as filter-not-set is operator-friendly and matches ADR-0199/0207.

## Open questions

1. **Widen `--actor-id` (positive filter) to multi-value via repeated flag on retention history** — closes ADR-0186 future Q + restores within-surface symmetry. Natural follow-up milestone. Defer.
2. **`--actor-id-not @file.txt` for very large exclusion lists** — operators jq-build from JSON or use shell `$(cat ...)` substitution for now. Defer.
3. **CLI-side UUID validation per flag occurrence** — defer matching ADR-0175/0186/0193/0206 pattern.
4. **Substrate-side deduplication of duplicate values in `actorIdsNot`** — defer; PG handles fine, no measured perf issue.
5. **Composite index on `(actor_id, occurred_at)`** for large-scale actor-scoped exclusion pagination — defer until measured slow.
6. **`--actor-name-not <name>` exclusion via meta.users.display_name JOIN** — pairs with ADR-0185 Q2. Defer.
7. **PG IN-list chunking at substrate level** for 1K+ excluded actors — defer until measured.

## Implementation outline

Two-file additive code change + one breaking adapter rename:

1. **`packages/kernel-pg/src/trace-retention.ts`**:
   - `ListOptOutHistoryInput.actorIdNot?: string` → `actorIdsNot?: ReadonlyArray<string>` (breaking rename).
   - Adapter SQL change from `params.push(input.actorIdNot)` + `(h.actor_id IS NULL OR h.actor_id != $N)` to multi-placeholder NOT IN construction matching ADR-0207's diff-timeline pattern.

2. **`apps/architect-cli/src/retention.ts`**:
   - `runRetentionHistory` reads via `getMultiFlag(command, "actor-id-not")` instead of `getStringFlag`.
   - Threads `actorIdsNot: ReadonlyArray<string> | undefined` to adapter.
   - JSON envelope renamed `actorIdNot: string | null` → `actorIdsNot: string[] | null`.

3. **`apps/architect-cli/src/cli.ts`**:
   - `retention history` usage line updated from `[--actor-id-not <uuid>]` to `[--actor-id-not <uuid> ...]` indicating repeatable.
   - Description block extended explaining "repeatable" + OR-semantic NOT IN + system-events-included.

## Tests

Adapter test block rewritten + expanded from 8 → 11 tests covering single + multi-value cases under the renamed "actorIdsNot filter" describe block:

1. Single-element NOT IN ($1) verified via SQL substring + params.
2. Multi-element NOT IN ($1, $2) verified via two placeholders.
3. Omits clause when not set.
4. Empty array treated as filter-not-set (NEW).
5. Includes system events (null actor_id IS NULL prefix preserved).
6. Composes with tenantId (multi-actor cohort exclusion + tenant filter).
7. Composes with actorId (positive + negative both threaded).
8. Composes with joinActor (LEFT JOIN + NOT IN both present).
9. Composes with all filter dimensions (full param array).
10. Returns rows excluding listed actors (mock row + adapter result).
11. Duplicate actorIdsNot values produce duplicate placeholders (NEW; PG dedupes via NOT IN semantic).

Plus update to one cross-reference test in the system-only describe block (`composes with actorIdNot + no_system` → `composes with actorIdsNot + no_system`) — no count change.

CLI test block rewritten + expanded from 6 → 8 tests covering single + multi-value cases:

1. Threads `actorIdsNot: [ACTOR_A]` as single-element array when set once.
2. Threads multi-element array when `--actor-id-not` repeated (NEW).
3. Omits when NOT set backward compat.
4. Composes with `--actor-id` positive + negative both threaded independently.
5. Composes with `--tenant` + `--with-actor-names` + multi `--actor-id-not`.
6. JSON envelope echoes single-element array.
7. JSON envelope echoes multi-element array (NEW).
8. JSON envelope `actorIdsNot=null` when not set.

cli.ts helpText extended for retention history usage line — `[--actor-id-not <uuid> ...]` notation + description updated to "repeatable" + OR-semantic NOT IN + system-events-included.

Test count: 8,955 → 8,960 (+5 net: adapter +3, CLI +2). The block rewrites kept existing single-value coverage while adding multi-value coverage.

## Acceptance

- `pnpm --filter @crossengin/kernel-pg test` green.
- `pnpm --filter @crossengin/architect-cli test` green.
- `pnpm -r typecheck` green (no new errors from this milestone; pre-existing `labelForIndex` + `chat.ts` errors unchanged).
- `pnpm -r test` green across the workspace.

## Forward-looking

The retention history surface now has a documented within-surface asymmetry on the actor filter dimension:

| Dimension | Shape on retention history | Shape on diff-timeline |
|---|---|---|
| Positive `--actor-id` | single string (ADR-0186) | multi-value (ADR-0199) |
| Negative `--actor-id-not` | multi-value (this milestone) | multi-value (ADR-0207) |

Widening `--actor-id` to multi-value on retention history closes ADR-0186 future Q + restores within-surface symmetry. Natural follow-up milestone.

The `--actor-id-not` family is now multi-value uniformly across both filter surfaces:

- `retention history` — substrate-side multi-value NOT IN filter (this milestone, ADR-0206 closed via Q1).
- `retention diff-timeline` — substrate-side multi-value NOT IN filter across all 3 paths (ADR-0207).
- `retention diff-history` — expectation check single-value (ADR-0205; multi-value tuple defer per ADR-0205 Q1).

The retention CLI now has 18 actions with multi-value `--actor-id-not` support on the two list-style audit-log filter surfaces (retention history + retention diff-timeline) plus single-value expectation check on the cross-event diff surface (retention diff-history) — operators get cohort-exclusion ergonomics with surface-appropriate semantics under one consistent flag name.
