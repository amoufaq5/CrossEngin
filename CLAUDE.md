# CLAUDE.md

Project state snapshot for AI assistants resuming work on this
codebase. Concise on purpose. Read top to bottom once, then keep
nearby.

## What this is

CrossEngin: AI-native multi-tenant platform. Three layers — a
kernel (multi-tenancy + meta-schema + DDL emit), declarative
manifests, and an AI Architect agent that authors them. ERP and
healthcare verticals ride on top.

## Where we are

Phase 2 M1 + M2 + M2.5 + M2.6 + M2.7 + M2.8 + M2.8.5 + M2.8.6 +
M2.9 + M2.9.5 + M2.9.6 + M2.9.7 + M2.9.8 + M2.9.8.x + M2.X +
M2.X.5 + M2.X.5.x + M2.X.5.y + M2.X.5.z + M2.X.5.aa +
M2.X.5.aa.x + M2.X.5.aa.x.1 + M2.X.5.aa.y + M2.X.5.aa.z +
M2.X.5.aa.z.1 + M2.X.5.aa.z.2 + M2.X.5.aa.z.3 + M2.X.5.aa.z.4 +
M2.X.5.aa.z.5 + M2.X.5.aa.z.6 + M2.X.5.aa.z.7 + M2.X.5.aa.z.8 +
M2.X.5.aa.z.9 + M2.X.5.aa.z.10 + M2.X.5.aa.z.11 +
M2.X.5.aa.z.12 + M2.X.5.aa.z.13 + M2.X.5.aa.z.14 +
M2.X.5.aa.z.15 + M2.X.5.aa.z.16 + M2.X.5.aa.z.17 + M2.X.5.aa.z.18 + M2.X.5.aa.z.19 + M2.X.5.aa.z.20 + M2.X.5.aa.z.21 + M2.X.5.aa.z.22 + M2.X.5.aa.z.23 + M2.X.5.aa.z.24 + M2.X.5.aa.z.25 + M2.X.5.aa.z.26 + M2.X.5.aa.z.27 + M2.X.5.aa.z.28 + M2.X.5.aa.z.29 + M2.X.5.aa.z.30 + M2.X.6 + M2.X.11 + M2.X.11.x + M2.X.12 + M2.X.13 + M2.X.14 + M2.X.15 + M2.X.16 + M5.10.5 + M6.6.x + M6.6.y + M6.7 + M6.7.x + M6.7.y + M6.7.z + M6.7.z.embed + M6.7.zz + M6.7.zz.dry-run + M6.7.zz.tenant + M6.7.zz.tenant.dashboard + M6.7.zz.tenant.opt-out + M6.7.zz.tenant.opt-out.reason + M6.7.zz.tenant.opt-out.expiry + M6.7.zz.tenant.opt-out.alerts + M6.7.zz.tenant.opt-out.cli + M6.7.zz.tenant.opt-out.cli.effective + M6.7.zz.tenant.opt-out.cli.mutate + M6.7.zz.tenant.opt-out.cli.list + M6.7.zz.tenant.retention-set + M6.7.zz.tenant.retention-delete + M6.7.zz.tenant.opt-out.history + M6.7.zz.tenant.opt-out.cli.restore + M6.7.zz.tenant.opt-out.history-retention + M6.7.zz.tenant.opt-out.cli.diff-history + M6.7.zz.tenant.opt-out.cli.prune + M6.7.zz.tenant.opt-out.cli.history.cursor + M6.7.zz.tenant.opt-out.cli.restore.dry-run + M6.7.zz.tenant.batch + M6.7.zz.tenant.opt-out.cli.diff + M6.7.zz.tenant.opt-out.cli.diff.vs-platform + M6.7.zz.tenant.opt-out.cli.diff.cross-table + M6.7.zz.tenant.opt-out.cli.diff.exit-on-divergence + M6.7.zz.tenant.opt-out.cli.effective-batch + M6.7.zz.tenant.opt-out.cli.diff.add-tenant + M6.7.zz.tenant.opt-out.cli.diff.threshold + M6.7.zz.tenant.opt-out.history.actor-join + M6.8 + M6.8.x + M6.8.x.trace + M6.8.y + M8 + M8.1 + M8.2 +
M2.X.6.x + M2.X.7 + M2.X.8 + M2.X.9 + M2.X.10 + M3 +
M3.5 +
M3.6 + M3.7 + M4 + M4.5 + M4.6 + M4.7 + M4.7.5 + M4.7.6 + M4.8 +
M4.8.x + M4.8.y + M4.10 + M4.10.x + M5 + M5.5 + M5.6 + M5.7 +
M5.8 + M5.9 + M5.11 + M6 + M6.5 + M6.5.5 + M6.5.6 + M6.6 + M7 + M7-wire
+ M7.5 + M7.6.5 + M7.7 + M7.8 + M7.9 landed:
**56 packages + 1 app, 129 meta-schema tables, 8,564 tests**,
all green, no type errors. M6.7.zz.tenant.opt-out.history.actor-join
closes ADR-0170 Q9 by adding `--with-actor-names` flag to
`retention history` + LEFT JOIN meta.users in the
listOptOutHistory adapter when joinActor:true. Operators
reading audit logs previously saw raw UUIDs in every row
(actor=00000000-...) and had to copy each one + SELECT
from meta.users to find the actual person. Now one flag
surfaces 'display_name (uuid)' format alongside email
fallback. Adapter ListOptOutHistoryInput gains optional
joinActor?: boolean field; when set, SQL adds LEFT JOIN
meta.users u ON u.id = h.actor_id + SELECT adds u.display_name
AS actor_display_name + u.email AS actor_email; result
entries include actorDisplayName + actorEmail fields
(string | null). LEFT JOIN deliberately preserves history
rows when actor has been deleted from meta.users (orphan
FK) or when actor_id is NULL (system actors) — audit
context never lost. History table now aliased as h
consistently with all WHERE-clause column references
prefixed h. — JOIN-vs-no-JOIN paths share same query
shape modulo LEFT JOIN + extra SELECT columns; cursor-
pagination inline subquery stays unqualified (own FROM,
no alias). CLI rendering rules — actor_id NULL → <system>,
actor_id + actorDisplayName present → 'display_name
(uuid)', actor_id + actorDisplayName null + actorEmail
present → 'email (uuid)' fallback, actor_id + both null
(orphan FK) → raw UUID, actor_id without --with-actor-
names (fields absent) → raw UUID (existing behavior).
name (uuid) format gives operators both human-readable
name AND UUID for unambiguous forensic accuracy. JSON
output conditionally emits actorDisplayName + actorEmail
ONLY when --with-actor-names is set (otherwise fields
absent); operators detect feature use via
entries[0].actorDisplayName !== undefined. Backward
compat preserved — pre-flag callers see identical
behavior. Cross-schema join cost negligible at typical
scales — meta.users.id is primary key index-only lookup,
LEFT JOIN no row-count expansion (1:1 by actor_id),
bounded by LIMIT clause. Use cases unblocked — audit-
review readability (Alice Smith (uuid) immediately
recognizable), per-actor compliance report via jq
.actorDisplayName // .actorEmail // "system" producing
human-readable changelog, orphan-actor detection via jq
filter on actorId != null + actorDisplayName == null +
actorEmail == null surfacing FK orphans, backward-compat
for raw-UUID consumers (fields absent without flag). Why
LEFT JOIN not INNER JOIN — INNER would silently drop
orphan-FK rows + system-actor rows losing audit
completeness. Why opt-in flag not always-on — adds query
cost to every history call; opt-in keeps default cheap.
Why name (uuid) format — operators need both for forensic
accuracy stale audit logs reviewed years later still show
UUID even if user renamed. Why conditional JSON emission
— preserves existing envelope shape for backward compat
consumers detect feature via undefined check. Rejected
alternatives — CLI-side --users-file JSON map (substrate
stays uncoupled but meta.users exists already as
canonical path), INNER JOIN (drops orphans loses audit
completeness), substrate change always-on JOIN (adds
cost to every call; opt-in cheaper default), add
actorDisplayName to JSON envelope unconditionally null
when no lookup (changes shape for backward-compat
callers conditional preserves), new retention history-
with-actors action (adds CLI surface; flag-on-existing
matches --vs-platform etc. precedent), return only
actorDisplayName omit actorEmail (operators wanting email
fallback can't get it), display_name <email> format
(mixes with <system> placeholder syntax), display only
display_name without UUID (strips forensic context),
cache user lookups across paginated calls (operator-side
concern substrate stays stateless). Drawbacks — cross-
schema dependency adapter SQL now references meta.users
directly (if operators deploy history table without
meta.users very unusual but possible in custom test
fixtures --with-actor-names fails at query time;
substrate ships both tables together so not regression),
no multi-tenant filtering on users meta.users is
platform-wide (cross-tenant actor like platform admin
appears with same display_name in all tenants' history
matches operator intent), no email fallback in JSON
envelope shape — caller composes preference order
(adapter returns both fields CLI rendering picks one
programmatic consumers via JSON make own choice), always
uses h. SQL aliasing existing test assertions checking
bare-column SQL substrings broke and were updated (minor
migration cost), no --actor-name <name> filter (operators
filter at jq layer for now), one JOIN per query operators
iterating with pagination + --with-actor-names get JOIN
cost N times across N pages (bounded — meta.users lookup
index-only — future Q if measured). 9 new adapter tests
in trace-retention.test.ts — omits LEFT JOIN when
joinActor false/not set, emits LEFT JOIN meta.users when
joinActor=true with u.display_name AS actor_display_name
+ u.email AS actor_email in SELECT, returns
actorDisplayName + actorEmail when joinActor=true and
user row exists (Alice Smith + alice@example.com),
returns null for both when joinActor=true but actor has
no user row (orphan FK), returns null for both when
actor_id is null (system actor), omits actorDisplayName
+ actorEmail fields when joinActor is false (TypeScript
undefined), LEFT JOIN preserves history rows even when
user has been deleted (mixed Alice present + Bob orphan),
composes with other filters (tenantId + tableName +
joinActor with h. prefix verified), composes with cursor
pagination (joinActor + afterId both present). 11 new
CLI tests in retention.test.ts — threads joinActor=true
to adapter when --with-actor-names is set, omits
joinActor from adapter input when flag NOT set (backward
compat), human-format renders 'Alice Smith (uuid)' when
actorDisplayName populated, human-format falls back to
'email (uuid)' when display_name null, human-format
falls back to raw UUID when both null (orphan FK),
human-format renders <system> for null actor_id
regardless of --with-actor-names, human-format without
--with-actor-names renders raw UUID no display lookup
(no paren-wrap), JSON envelope includes actorDisplayName
+ actorEmail fields when entries carry them, composes
with other filters --tenant + --kind + --with-actor-
names (joinActor:true threaded with all other inputs);
formatActor helper unit tests — renders display_name
(uuid) when both display_name and email present, falls
back to email when display_name null. 4 existing tests
updated to assert h.-prefixed SQL (ORDER BY h.occurred_at
DESC, h.id DESC; (h.occurred_at, h.id) < cursor). cli.ts
helpText extended with --with-actor-names flag note +
2-line description explaining LEFT JOIN meta.users +
display_name + email surfacing alongside raw UUIDs.
fakeRetention listOptOutHistory mock already captures
input so joinActor flag flows through automatically.
ADR-0185 documents the design + 9 rejected alternatives
+ 7 future Qs (--actor-id filter, --actor-name-equals
filter, show user status alongside name, display user's
tenant_membership role would need additional JOIN, surface
actor names in other audit surfaces like restore history
rows future audit logs, --actor-name-pattern regex,
pretty-printed actor format without UUID for narrow
terminals). The retention CLI now has 17 actions with
audit-readability across the history surface — operators
get human-readable actor attribution via opt-in flag
without changing the default cheap query path.
M6.7.zz.tenant.opt-out.cli.diff.threshold
closes ADR-0181 Q2 + ADR-0183 Q5 by adding `--threshold N`
string flag to `retention diff` (all 4 variants) for fuzzy
CI-gate thresholds — only fail when N+ fields/variations
diverge. Tier-migration tolerance and cohort-consistency
gates with minor-drift tolerance previously required jq +
length-check post-processing; one flag now handles it.
Without `--threshold` (default), `--exit-on-divergence`
fires exit 3 on ANY drift (semantic from ADR-0181); with
`--threshold N` it fires exit 3 only when fieldDiffs.length
or fieldVariations.length >= N. N=1 is equivalent to
default behavior; N>=2 enables fuzzy semantic. `>=` (at-or-
above-threshold) comparison matches operator intuition
"fail when at least N differ". Validation at the TOP of
runRetentionDiff before dispatcher routes — invalid
--threshold returns exit 2 (misuse) without any PG
queries; --threshold without --exit-on-divergence rejected
with 'requires --exit-on-divergence' error (strict rejection
prevents silent no-op masking misuse); --threshold 0 /
negative / non-integer / non-numeric → exit 2 with
'positive integer' error. Pure CLI enhancement — single
divergenceExitCode helper extended to read --threshold,
no adapter changes, no result-type changes, no JSON
envelope changes; same fieldDiffs/fieldVariations arrays
emitted unchanged so operators inspecting JSON apply
custom filter logic on top. Applies uniformly to all 4
diff variants — cross-tenant default uses
fieldDiffs.length, --vs-platform uses fieldDiffs.length,
--cross-table uses fieldDiffs.length, --add-tenant N-way
uses fieldVariations.length (number of fields with
variation, not the cross-product of distinct value
groups — matches operator intent "how many fields differ
across the cohort"). Use cases unblocked — cohort drift
gate tolerating minor variations (5-tenant cohort with
--threshold 3 tolerates 1-2 minor field variations,
fails on structural drift), tier migration tolerance
(--threshold 2 tolerates single expected-field difference
like updated_at timestamp, fails on multi-field drift),
graduated CI gates with multiple --threshold values
wired into staged pipelines (strict stage 1: --threshold
1, lenient stage 2: --threshold 5). Rejected
alternatives — --max-diffs N alternate name (--threshold
more idiomatic for "fail when N+"), strict > semantic
(counterintuitive — operators counting "fail when 2+
fields differ" expect --threshold 2 not 1), silent no-op
when --threshold without --exit-on-divergence (masks
misuse), accept --threshold 0 to mean "fail on any"
(equivalent to default redundant — reject to keep
semantic clean), --ignore-fields <list> for per-field
allowlist (broader feature defer — operators use jq for
now), --threshold-percentage X% for fractional thresholds
(operators compute expected count themselves defer),
apply threshold per-field "fail when retention_days alone
differs" (different mental model whole-record threshold
matches user intent), default N=2 instead of N=1 (breaks
backward compat with ADR-0181 callers — default of 1
preserves prior semantics), N-way threshold against
value-cell count sum of distinct values across varying
fields (over-counts confuses operators thinking "how
many fields differ"). Drawbacks — --threshold requires
--exit-on-divergence operators passing --threshold 3
without --exit-on-divergence get exit 2 (documented but
could surprise; strict-rejection over silent no-op chosen
deliberately), no per-field threshold or per-field
allowlist operators wanting "ignore enabled field count
everything else" wrap with jq on JSON then check length
(threshold uniform across field types), >= semantic at-
or-above operators wanting strict-above need --threshold
N+1 (documented matches at-least-N intuition), no
fractional threshold operators wanting "fail when 50%+
of fields differ" compute expected count themselves (out
of scope), N-way uses field-variation count not value-
cell count for 10-tenant cohort with 3 fields each having
2 distinct values fieldVariations.length is 3 not 6
(documented matches operator intent), validation happens
at parent dispatcher variant-specific helpers trust
threshold is valid future variants must call
divergenceExitCode at end. 14 new CLI tests in retention.
test.ts — --threshold without --exit-on-divergence exit
2 with 'requires --exit-on-divergence' message,
--threshold 0 exit 2 with 'positive integer' message,
--threshold -1 exit 2, --threshold 1.5 non-integer exit
2, --threshold abc non-numeric exit 2, --threshold 1
behaves like default (exit 3 on any diff = behavior from
ADR-0181 preserved), --threshold 2 + fieldDiffs=1 exit 0
(below threshold), --threshold 2 + fieldDiffs=2 exit 3
(at threshold), --threshold 2 + fieldDiffs=3 exit 3
(above threshold), --threshold 5 + fieldDiffs=0 exit 0
(no drift at all), --threshold integrates with --vs-
platform variant (threshold=3 + 2 diffs → exit 0),
--threshold integrates with --cross-table variant
(threshold=2 + 2 diffs → exit 3), --threshold integrates
with --add-tenant N-way variant using fieldVariations.
length not fieldDiffs.length (threshold=3 + 2 variations
→ exit 0), validation happens BEFORE PG adapter call
verified via diffTenantCapture length 0 with invalid
--threshold 0. cli.ts helpText extended with 3-line note
under existing exit-on-divergence note explaining
--threshold N default 1 + requires --exit-on-divergence
+ invalid values exit 2. ADR-0184 documents the design +
9 rejected alternatives + 7 future Qs (--ignore-field
repeated flag using multiFlags from ADR-0183,
--threshold-percentage X%, per-field severity weighting
overcomplicated, --threshold on retention diff-history,
--threshold semantic for retention prune separate ADR,
output annotation 'threshold met X >= Y' defer,
default threshold via environment variable defer). The
retention CLI now has 17 actions with 4 diff variants
in 'diff' action all supporting --exit-on-divergence
[--threshold N] — operators have first-class CI-gate
ergonomics with both strict (any drift) and fuzzy (N+
fields) modes across pair-wise AND N-way comparison
matrices.
M6.7.zz.tenant.opt-out.cli.diff.add-tenant
closes ADR-0178 Q2 by adding `--add-tenant <uuid>` repeated
flag to `retention diff` for N-way cross-tenant comparison
across 3+ tenants on the same table. Operators with 5-tenant
compliance cohorts previously ran 10 pair-wise diff commands
and manually correlated the outputs into a per-field
variation matrix; now one command. New diffTenantPoliciesNway
adapter method composes on effectiveRetentionBatch (canonical
pattern from ADR-0177/0178/0180; only ADR-0179 deviated with
documented reason); passes N pairs to batch resolver → 2
queries total regardless of N. Variation analysis groups
tenants by JSON-stringified value per field, filters to
fields with 2+ distinct values, sorts alphabetically. New
computeFieldVariations pure helper exported alongside
existing computeFieldDiffs + normalizeResolutionForDiff;
fully unit-testable with no DB dependency. parseArgs
extended additively with multiFlags ReadonlyMap tracking
repeated string-valued flag occurrences in argv order;
new getMultiFlag helper reads from it; existing flags map
keeps last-write-wins semantics so all extant callers
unaffected. CLI dispatcher checks for --add-tenant
presence + rejects combo with --vs-platform or
--cross-table (3-way mutual exclusivity); base call still
requires 2 positional tenants + 1 positional table
matching cross-tenant default from ADR-0178. Result type
DiffTenantPoliciesNwayResult carries tenantIds (input
order), tableName, resolutions[] (one per input tenant),
fieldVariations[] (per-field distinctValues with tenant
attribution). Human output renders 'N-way diff between N
tenants (table: <name>):' header + per-tenant row 'Tenant
<label>: <uuid> <summary>' with labels A/B/C... (T27+ at
high N), blank line, then either 'No differences — all N
tenants have the same effective retention policy.' OR
'Field variations (M):' header + per-field line
'fieldname value1 (A) | value2 (B, C) | ...' with
tenant labels by index. JSON envelope {action: "diff",
nway: true, result: DiffTenantPoliciesNwayResult} where
nway:true is the discriminator — operators now have 4
diff envelope shapes (cross-tenant default no
discriminator, vsPlatform:true, crossTable:true,
nway:true) all mutually exclusive at CLI boundary.
--exit-on-divergence from ADR-0181 integrates uniformly —
passes result.fieldVariations.length to
divergenceExitCode; non-zero → exit 3. Resolution-side no
deduplication — input tenantIds=[A,A,B] returns 3
resolutions matching input order (1:1 contract from
ADR-0182). Use cases unblocked — compliance cohort drift
detection in single CI command replacing 10 pair-wise
commands + manual correlation for 5-tenant cohorts, tier
migration verification across N tenants via jq filter
on .result.fieldVariations[].field == "source", legal-
hold cohort verification ensuring all hold-tenants
opted out via length-0 check on filtered resolutions,
operator dashboards rendering per-field cohort variation
directly from JSON. Rejected alternatives — comma-
separated --tenants <a,b,c,d> (fragile + breaks for
embedded commas + harder shell quoting), auto-promote to
N-way when more than 3 positional args (magical;
operators may pass accidental args), new action
retention diff-nway (adds CLI surface; --add-tenant
matches --vs-platform/--cross-table precedent), pair-
wise output for N tenants A vs B + A vs C + B vs C ...
(operators read N×(N-1)/2 outputs manually correlating —
per-field variation is right abstraction), JSON-only no
human format (N-way visualizations useful in terminals),
restrict to N <= 10 (arbitrary; PG IN list handles
thousands), return Map<tenantId, Resolution> instead of
ordered array (loses input order), --limit N to truncate
variation rendering (operators pipe through head/jq),
separate adapter method not composing on
effectiveRetentionBatch (duplicates batch resolver
logic). Drawbacks — output dense at high N (5 variations
× many tenants per group wraps narrow terminals;
operators pipe to less or jq), tenant labels A..Z then
T27+ less readable above 26 (unusual case), parseArgs
interface change adding multiFlags field (additive but
existent ParsedCommand consumers see new field;
backward compat preserved), no grouping in variation
rendering fields sorted alphabetically each independent
(operators wanting "group by retention_days then by
source" use jq), no deduplication of duplicate tenantIds
(1:1 contract may confuse), N-way is pair-wise-superset
2-tenant N-way works but output wordier (operators
deliberately use --add-tenant for N-way semantics),
mutual-exclusivity error lists 3 flag candidates when
more than one set (clear message but more complex
error path). 15 new adapter tests + 13 new CLI tests =
28 total covering: adapter rejects fewer than 2
tenantIds with 'at least 2 tenantIds' error, composes
on effectiveRetentionBatch with exactly 2 queries for 3
tenants verified via capture.length, returns resolutions
ordered by input + empty fieldVariations when all
match, returns fieldVariations when 3 tenants have 3
different sources covering source + retention_days +
opt_out fields, source variation distinctValues
includes tenant attribution verified ([TENANT_A] for
tenant + [TENANT_B, TENANT_C] for platform), supports
2-tenant N-way degenerate-but-valid call equivalent to
diffTenantPolicies, handles 5-tenant comparison with
all platform default no variations, clock-aware expiry
preserved across N tenants (expired opt_out on TENANT_A
falls through to platform), preserves duplicate
tenantIds in resolutions order (input [A,A,B] →
resolutions length 3 same order); computeFieldVariations
helper unit tests — empty array for <2 entries, empty
when all entries agree, single variation when one
field differs, groups tenants by distinct value
(tenant→[a], platform→[b,c]), treats absent field on
one entry as undefined distinct from null on another,
sorts variations alphabetically by field name; CLI
tests — exit 2 when --add-tenant + --vs-platform both
set with 'mutually exclusive' error, exit 2 when
--add-tenant + --cross-table both set, exit 2 missing
required positionals with --add-tenant in error
message, calls diffTenantPoliciesNway with [A,B,C]
from positionals + 1 --add-tenant verified via capture,
collects multiple --add-tenant flags in order
[A,B,C,D] via repeated flag occurrences, human-format
'No differences' message when fieldVariations empty,
human-format renders per-field variations with tenant
attribution + A/B/C labels + retention_days '30 (A) |
90 (B, C)' + source '"tenant" (A) | "platform" (B,
C)', JSON envelope nway:true discriminator + result
.tenantIds + result.resolutions length 3,
--exit-on-divergence + non-empty fieldVariations
returns exit 3, adapter errors propagate exit 1;
formatTenantNwayDiff helper unit tests — 'No
differences' message for empty, A/B/C labels in tenant
rows + variation lines '"tenant" (A) | "platform" (B)
| "none" (C)' across 3 distinct sources, 'absent' for
undefined values in variation groups (e.g.,
opt_out_reason variation has undefined for tenant on
platform vs string for tenant opt_out). cli.ts
helpText extended with retention diff <a> <b> <table>
--add-tenant <c> [--add-tenant <d> ...] usage line +
5-line description explaining N-way semantic + mutual
exclusivity with --vs-platform/--cross-table. ADR-0183
documents the design + 9 rejected alternatives + 8
future Qs (--exclude-tenant for set-subtraction,
--input-file reading tenant IDs from JSON/text file,
--add-tenant <slug> resolving via meta.tenants.slug,
render variations grouped by tenant in addition to
per-field, --threshold N combined with --exit-on-
divergence pairing with ADR-0181 Q2, N-way --vs-
platform adding platform default as synthetic tenant,
N-way --cross-table comparing one tenant across N
tables pairing with ADR-0180 Q1, tagged-union JSON
envelope across 4 diff variants would simplify jq
scripts but break backward compat). The retention CLI
now has 17 actions with 4 diff variants in 'diff'
action (cross-tenant default + --vs-platform +
--cross-table + --add-tenant) all supporting
--exit-on-divergence — operators have first-class CI-
gate ergonomics across pair-wise AND N-way comparison
matrices.
M6.7.zz.tenant.opt-out.cli.effective-batch
closes ADR-0177 Q1 by adding `crossengin retention
effective-batch --pairs-file <path>` action exposing the
ADR-0177 batch adapter at the CLI. Pure CLI delivery — no
adapter changes; wraps existing
PostgresTraceRetention.effectiveRetentionBatch one-for-one.
Operators wanting ad-hoc bulk lookups previously wrote
Node scripts calling the adapter directly. Now one command.
Input format JSON-only for v1 — array of {tenantId,
tableName} objects; CSV deferred to future Q (operators
generating pairs from another command get JSON for free
via jq, and JSON's typed shape maps cleanly to the
adapter's EffectiveRetentionBatchPair without per-field
type inference + quoting rules). Layered validation —
missing --pairs-file flag exit 2, file unreadable exit 1
(runtime), invalid JSON exit 2, not-an-array exit 2, entry
not-an-object at index N exit 2, missing tenantId/
tableName at index N exit 2 with index-aware error
messages so operators with 1000-pair files find bad entry
by line. Output ordering preserves input — adapter
deduplicates internally (returns ReadonlyMap keyed by
effectiveRetentionKey), but CLI iterates ORIGINAL input
pairs and looks up each in Map emitting one output row
per input entry; duplicates in input → duplicates in
output (1:1 contract, predictable ordering, duplicate
visibility). Human output renders 'Effective retention
for N pair(s):' header + per-pair line '<tenantId>
<tableName-padded-20> <summary>' with summary via
internal summarizeBatchResolution helper covering 4
resolution variants (tenant/tenant_opt_out/platform/none)
with established 'indefinite'/'<no reason>'/'(no policy
configured)' conventions; empty input prints '0 pair(s):
(empty input)' on exit 0 (not an error). JSON envelope
{action: "effective-batch", count, results: [{tenantId,
tableName, resolution}]} with count field echoing
results.length for jq scalar filters that want quick
count without traversing array. Use cases unblocked —
compliance audit across watchlist via jq filter on
.resolution.source=="tenant_opt_out" length count,
migration verification via jq filter on .resolution.source
!= "tenant" or .resolutionDays != expected surfacing
deviations, spreadsheet export via jq -r @csv pipe,
reconciliation against upstream tier system via diff
of sorted JSON outputs. Rejected alternatives — stdin
support via --pairs-file - (platform-specific stdin
handling; defer until requested), inline --pairs '[...]'
flag (flag-value-as-JSON unwieldy past 2-3 pairs; file
is right scale boundary), CSV in v1 (tokenizer + quoting
+ type-inference complexity; jq one-liners convert),
auto-detect file format by extension (magic; explicit
JSON-only contract simpler), deduplicate output to
match adapter's internal dedup (breaks 1:1 input/output;
operators preferring dedup wrap with jq .results |
unique), return adapter Map shape directly as JSON
object {"<tenantId>:<tableName>": resolution} (JSON
property ordering implementation-defined + colon-as-
key-separator fragile; array of records cleaner),
pre-deduplicate before calling adapter (adapter already
dedupes; CLI dedup redundant), --max-pairs N validation
at CLI boundary (operator policy choice; PG IN-list
limit is real constraint; CLI doesn't second-guess),
auto-chunking for very large inputs (deferred to
ADR-0177 Q2 substrate work; not a CLI concern).
Drawbacks — JSON-only no CSV in v1 (operators convert
with jq; documented), no streaming output (all pairs
held in memory; bounded by ADR-0177 chunking Q —
acceptable at typical scales), no per-pair validation
against PRUNABLE_TABLES allowlist (operators passing
unknown tables get source:"none" surfacing typos but
not as error; matches retention effective non-validation
stance), no dedup in CLI output (operators with
accidentally-duplicated pairs see duplicates —
by-design 1:1 contract may confuse operators expecting
dedup), output ordering preserves input no --sort flag
(operators use jq sort_by or sort on tabular text),
file-based input only no --pairs <json> inline arg or
stdin (operators with one-off ad-hoc queries write
temp file; future Q). 17 new CLI tests in retention.
test.ts — missing --pairs-file flag exit 2 with
'missing --pairs-file' message, file path doesn't exist
exit 1 with 'failed to read' message, file content not
valid JSON exit 2 with 'not valid JSON' message, JSON
not an array exit 2 with 'must be a JSON array'
message, entry missing tenantId at index 0 exit 2 with
index-aware 'index 0' + 'tenantId' in error, entry
missing tableName exit 2 with 'tableName' in error,
threads pairs to adapter in input order verified via
effectiveBatchCapture (TENANT_A workflow_traces then
TENANT_B llm_call_traces), empty input array prints '0
pair(s) (empty input)' + exit 0, human-format renders
one row per input pair preserving order (idxA<idxB
verified in output), human-format includes 'Effective
retention for 2 pair(s):' header + tenantId + tableName
+ retention=Nd + source=tenant/source=platform per
pair, JSON envelope shape {action:
"effective-batch", count, results[]} with results[0]
fully populated, duplicate input pairs appear in
output as duplicates (count=2 + results.length=2 for
identical pairs preserving 1:1 contract), adapter
errors propagate exit 1 ('PG connection refused' in
stderr); formatEffectiveBatch helper unit tests — 0
pair(s) (empty input) message for empty array, count
header + per-pair rows with summary lines + 'source=
tenant'/'source=platform', tenant_opt_out variant
inline with 'reason=legal_hold:case#42' + 'until=2099-
01-01T00:00:00.000Z', 'indefinite' for null
optOutUntil + '<no reason>' for null optOutReason
('until=indefinite' + 'reason=<no reason>' verified),
'none' variant with '(no policy configured)'
annotation. fakeRetention extended with
effectiveRetentionBatch method + effectiveBatchResults
+ effectiveBatchCapture options for test injection.
cli.ts helpText extended with retention effective-batch
--pairs-file <path> usage line + 5-line description
explaining JSON array file format + 2-query batch
optimization + preserved input order in output;
dispatcher case + missing-action + unknown-action
error messages all updated to include effective-batch.
ADR-0182 documents the design + 9 rejected alternatives
+ 8 future Qs (CSV input format, stdin support via -,
inline --pairs JSON, --sort flag for output ordering,
--include-only source filter for CI gates, auto-
chunking for >10K pairs, pretty-printed JSON output,
per-pair source-attribution PostgresCostCeilingResolver
style returning tier/override/global signal). The
retention CLI now has 17 actions covering forensic +
recovery + comparison + performance workflows
comprehensively: 3 read (expiring/effective/list-
policies) + 1 batch-read (effective-batch from this
milestone) + 4 write (opt-out/opt-in/set/delete) + 1
audit (history) + 1 restore (with --dry-run) + 3 diff
(diff-history + diff with cross-tenant default + --vs-
platform + --cross-table variants + --exit-on-
divergence flag on all 3) + 1 maintenance (prune with
--dry-run) — all substrate adapters now have at least
one CLI surface; ADR-0177's substrate-only deferral
is closed.
M6.7.zz.tenant.opt-out.cli.diff.exit-on-divergence
closes ADR-0179 Q6 + ADR-0180 Q3 by adding `--exit-on-
divergence` boolean flag to `retention diff` (all three
variants — cross-tenant default + --vs-platform +
--cross-table). When set, exit code 0 if fieldDiffs is
empty (no drift) or exit code 3 if fieldDiffs is non-
empty (drift detected; CI gate fail). When NOT set,
diff returns exit 0 regardless — backward compatible.
Output (human or JSON) STILL emitted on exit 3 — flag
controls only the exit code, operators reading scripts
see what diverged. Exit code 3 chosen deliberately —
existing CLI codes are 0 (success), 1 (runtime error),
2 (misuse); exit 3 for "completed successfully but
CI-gate fail" stays distinguishable from runtime errors
so CI logs differentiate "drift detected" from "PG
connection refused" — operators route exit 1 to on-call
+ exit 3 to compliance. Single flag for all 3 diff
variants — no per-variant naming
(--cross-tenant-exit-on-divergence etc.); uniform
contract. Runtime errors take precedence — existing
`return 1` from catch blocks fires before
divergenceExitCode is reached. Pure CLI enhancement,
no adapter changes — each runner now branches output
emission then returns divergenceExitCode(command,
result.fieldDiffs.length); shared private helper checks
getBooleanFlag(command, "exit-on-divergence") &&
fieldDiffsLength > 0. Workaround being replaced —
operators currently wrap with `jq -e '.result.fieldDiffs
| length > 0'` whose exit-1 collides with retention-
diff's runtime-error exit-1 making CI logs ambiguous
between "drift detected" and "PG connection refused" +
the wrap is boilerplate replicated per CI pipeline +
operators write 3 jq branches across the 3 envelope
shapes. Use cases unblocked — direct bash idiom for CI
cohort consistency gate (`if ! crossengin retention
diff --exit-on-divergence; then ...`), per-tenant drift
detection from platform default for regulated tenants
that MUST stay on default (exit 3 → tenant has its own
override which violates policy), per-tenant cross-table
consistency gate for legal-hold completeness (exit 3 →
hold applied to one table but not the other), pipeline
runners differentiate exit 1 vs exit 3 via bash case
statement routing to on-call vs compliance team
respectively. Rejected alternatives — exit code 1
matching diff(1) (collides with existing runtime-error
exit 1), exit code 2 matching git diff --exit-code
(collides with existing misuse exit 2), --ci flag
naming (too vague doesn't name semantic),
three per-variant flags --cross-tenant-exit-on-
divergence etc (verbose; one flag works on all 3
variants), implicit exit-on-divergence when stdout
isn't a TTY (magical), stderr "drift detected" warning
in addition to exit code (noisy when piped; output
already shows diff), --threshold N parameter for N+
field-diff exit (overkill for v1; operators chain with
jq), adapter-side method returning exit signal (exit
codes are CLI concern; adapter stays uncoupled from
process exit). Drawbacks — new exit code 3 added to
substrate's CLI vocabulary operators reading existing
scripts may not realize the new code exists (mitigated
by opt-in flag — pre-M6.7.zz.tenant.opt-out.cli.diff.exit-
on-divergence callers never see exit 3), no
--exit-on-no-divergence inverse flag (operators wrap
with bash !), no --threshold N for fuzzy thresholds
(jq covers), no per-field allowlist (jq filter then
check length), exit code 3 is CrossEngin-specific
convention operators porting scripts from diff(1) which
uses exit 1 need to translate (documented in helpText),
output still emitted on exit 3 CI systems grepping
stderr for errors won't see drift output on stdout
(operators redirect appropriately). 9 new CLI tests
covering: cross-tenant exit 0 when fieldDiffs empty
and --exit-on-divergence set, cross-tenant exit 3 when
fieldDiffs non-empty and flag set, cross-tenant exit 0
when fieldDiffs non-empty but flag NOT set (backward
compat verified), cross-tenant output still emitted on
exit 3 in JSON mode (parsed envelope checked +
fieldDiffs length 1), --vs-platform exit 3 on non-empty
fieldDiffs with flag, --vs-platform exit 0 on empty
fieldDiffs with flag, --cross-table exit 3 on non-empty
fieldDiffs with flag, --cross-table exit 0 on empty
fieldDiffs with flag, runtime errors exit 1 take
precedence over --exit-on-divergence (adapter throws
PG connection refused returns exit 1 even with flag
set). cli.ts helpText extended with 3-line note after
the three diff usage lines explaining all three
variants accept --exit-on-divergence returning exit 3
instead of 0 when fieldDiffs non-empty for CI gates.
ADR-0181 documents the design + 8 rejected alternatives
+ 7 future Qs (--exit-on-no-divergence inverse,
--threshold N, --field allowlist, --quiet to suppress
output, distinguished exit codes per variant,
--exit-on-divergence on retention diff-history,
apply same flag to retention list-policies). The
retention CLI now has 16 actions with all 3 diff
variants supporting --exit-on-divergence — operators
have first-class CI-gate ergonomics across the full
diff matrix (cross-tenant + tenant-vs-platform +
cross-table-within-tenant), with the deliberate exit-3
convention keeping drift-detection signal distinguishable
from runtime errors.
M6.7.zz.tenant.opt-out.cli.diff.cross-table
closes ADR-0178 Q3 by adding `--cross-table` flag to
`retention diff` + diffTenantTables adapter method.
Completes the diff matrix — after ADR-0173 (same-tenant
cross-event diff-history) + ADR-0178 (cross-tenant
same-table diff) + ADR-0179 (tenant-vs-platform), this
milestone ships the orthogonal cross-table-within-tenant
axis. Operators auditing a single tenant want to answer
"is this tenant's retention consistent across all the
trace tables they have data in?" — e.g., is the legal
hold applied to workflow_traces ALSO applied to
llm_call_traces? Previously: two retention effective
commands + mental-diff. Now one command. Flag-on-
existing-action chosen over new retention diff-tables
action — matches the --vs-platform precedent operators
already learned. With --cross-table set, dispatcher
expects 3 positional args (tenant + 2 tables) instead
of default cross-tenant shape (2 tenants + 1 table).
--vs-platform and --cross-table mutually exclusive at
the CLI boundary — both set returns exit 2 with clear
"mutually exclusive" error. New diffTenantTables adapter
composes on effectiveRetentionBatch (RESTORES the
canonical composition pattern from ADR-0177/0178 that
ADR-0179 documented as its exception); single call
with pairs [{tenantId, tableNameA}, {tenantId,
tableNameB}] runs 2 queries total — tenant lookup with
both pairs in IN tuple, platform lookup with both
table names in IN — Promise.all parallelized; looks up
both resolutions from returned Map via exported
effectiveRetentionKey helper. Identical diff-computation
flow to ADR-0178 — computeFieldDiffs after
normalizeResolutionForDiff on both sides, alphabetical
sort, 'indefinite'/'<no reason>' conventions, 'absent'
placeholder for undefined values. Result type
DiffTenantTablesResult carries {tenantId, tableNameA,
tableNameB, resolutionA, resolutionB, fieldDiffs}.
Human output renders 3-section format — 'Diff between
tables for tenant <uuid>:' header, per-table summary
line via shared summarizeResolutionForDiff helper from
ADR-0178 with 20-char table-name padding for column
alignment ('Table A: workflow_traces      source=...',
'Table B: llm_call_traces      source=...'), blank line,
then either 'No differences — both tables resolve to
the same effective retention policy for this tenant.'
for empty fieldDiffs OR 'Field changes (N):' header
followed by 'fieldname valueA → valueB' lines. JSON
envelope {action: "diff", crossTable: true, result:
DiffTenantTablesResult} where crossTable:true is the
discriminator distinguishing from ADR-0178's cross-
tenant variant + ADR-0179's vs-platform variant.
Operators now have 3 diff envelope shapes — cross-
tenant (no boolean discriminator), vsPlatform:true,
crossTable:true — boolean discriminators are mutually
exclusive at CLI boundary; JSON parsers branch on
discriminator first. Use cases unblocked — cross-table
consistency audit for one tenant (one command vs two
retention effective + mental-diff), legal hold
completeness check via jq filter on resolutionA.source=
"tenant_opt_out" vs resolutionB.source!="tenant_opt_out"
surfacing incomplete holds, compliance migration
verification via shell loop across table pairs, CI gate
for cohort consistency failing build when cross-table
drift detected. No validation on tableNameA===tableNameB
matching diffTenantPolicies pattern from ADR-0178 —
substrate doesn't enforce semantic constraints unless
critical; identical resolutions + empty fieldDiffs
surface the typo immediately. Rejected alternatives —
new retention diff-tables action (cleaner separation
but adds CLI surface and divides diff vocabulary across
three action names), implicit detection if positional
args look like tenant+table+table (heuristic fragile
when table names look like UUIDs), compose on two
single-pair effectiveRetention calls (4 queries vs 2
batch), N-way diff via --add-table (overkill for v1;
pair-wise canonical), cross-table without flag (magic),
retention compare-tables returning all-pairs combinations
(operator-unrequested; defer), allow --cross-table +
--vs-platform to mean "compare two tables' platform
defaults for one tenant" (semantic stretch; mutual
exclusivity cleaner), return Map<tableName, Resolution>
instead of A/B labels (more general but breaks pair-
wise diff shape from ADR-0178). Drawbacks — three
positional-arg shapes on one action (cross-tenant +
--vs-platform + --cross-table), mutual-exclusivity
error at CLI boundary not automatic disambiguation,
JSON envelope discriminator proliferation operators
write 3 jq branches (could be unified via tagged union
but breaks ADR-0178+0179 compat — defer), N-way table
diff out of scope, same-tenant constraint (operators
wanting tenant A on table X vs tenant B on table Y
run two retention effective commands manually). 8 new
adapter tests + 13 new CLI tests = 21 total covering:
adapter composes on effectiveRetentionBatch issuing
exactly 2 queries, returns metadata + resolutions +
empty fieldDiffs when both resolve to none, empty
fieldDiffs when both identical platform retention,
fieldDiffs when retention differs across tables (tenant
override on A vs platform on B), fieldDiffs comparing
tenant_opt_out on A vs tenant on B covering source +
opt_out + opt_out_reason + opt_out_until, resolutionA
carries A's data and resolutionB carries B's verified,
clock-aware expiry preserved across both table
resolutions, supports same tenant on same table for
both axes (degenerate but valid empty fieldDiffs);
CLI — missing tenant exit 2, missing table-a exit 2,
missing table-b exit 2, both --vs-platform + --cross-
table exit 2 with 'mutually exclusive' message, calls
diffTenantTables NOT diffTenantPolicies or
diffTenantVsPlatform verified via three separate
captures (diffTenantCapture length 0, diffTenantVsPlatformCapture
length 0, diffTenantTablesCapture length 1 with
{tenantId, tableNameA, tableNameB}), human-format
'No differences' message + 'Diff between tables for
tenant' header, human-format renders Table A + Table B
headers + 'Field changes (N):' with arrow-formatted
diff lines + 30 → 365 number diff, JSON envelope
crossTable:true discriminator + result.tenantId +
result.tableNameA + result.tableNameB, adapter errors
propagate exit 1; formatTenantTablesDiff helper unit
tests — 'No differences' message for empty, Table A +
Table B headers with per-table summary lines + retention=
Nd, tenant_opt_out variant inline with reason+until,
source=none with '(no policy configured)' annotation.
cli.ts helpText extended with retention diff <tenant>
<table-a> <table-b> --cross-table usage line + 5-line
description explaining 2-query optimization + mutually
exclusive with --vs-platform. ADR-0180 documents the
design + 8 rejected alternatives + 7 future Qs (N-way
diff via repeated --add-table flag, --all-tables for
one-tenant-across-every-prunable-table, --exit-on-
divergence for CI gates, JSON envelope unification
across all 3 diff variants via tagged union, table-name
validation against PRUNABLE_TABLES allowlist, combined
cross-table + diff-history --at-time DATE for point-in-
time cross-table comparison, --field name filter on
JSON output). The retention CLI now has 16 actions
covering forensic + recovery + comparison + performance
workflows comprehensively: 3 read (expiring/effective/
list-policies) + 4 write (opt-out/opt-in/set/delete)
+ 1 audit (history) + 1 restore (with --dry-run) + 3
diff (diff-history same-tenant + diff with cross-
tenant default + --vs-platform variant + --cross-table
variant) + 1 maintenance (prune with --dry-run) + 1
batch substrate-only (effectiveRetentionBatch).
M6.7.zz.tenant.opt-out.cli.diff.vs-platform
closes ADR-0178 Q1 by adding `--vs-platform` flag to
`retention diff` + diffTenantVsPlatform adapter method.
Operators wanting "how does this tenant differ from
platform default?" previously ran two retention effective
commands and mental-diffed; now one command. Flag-on-
existing-action chosen over new `retention diff-platform`
action — operators learn --vs-platform more naturally
than new action name. With flag set, diff dispatcher
branches before positional validation and expects 2
positional args (tenant, table) instead of 3. New
diffTenantVsPlatform adapter runs 2 parallel queries via
Promise.all — one tenant lookup + one platform lookup —
single wall-clock round-trip. FIRST adapter method in
retention substrate NOT composing on effectiveRetention/
effectiveRetentionBatch — documented exception because
the batch resolver returns only the EFFECTIVE resolution
per pair (hides whether tenant fell through to platform
or has its own policy), losing the distinction --vs-
platform must surface. Algorithm — parallel queries,
build platformResolution from platform row (or {source:
"none"} when absent), build tenantResolution using same
opt-out/enabled/fallback logic as effectiveRetention but
falling back to the platformResolution we already
computed, compute fieldDiffs via reused computeFieldDiffs
from ADR-0173 after normalizeResolutionForDiff on both.
Same clock() source as effectiveRetention for opt-out
expiry boundary. Result type DiffTenantVsPlatformResult
carries {tenantId, tableName, tenantResolution,
platformResolution, fieldDiffs}. Human output renders
3-section format — 'Diff between tenant and platform
default (table: <name>):' header, tenant row with
tenantId + summary line via shared summarizeResolutionForDiff
helper, platform row (no tenantId since platform policy
isn't tenant-scoped), blank line, then either 'No
differences — tenant has the same effective retention
policy as the platform default.' for empty fieldDiffs
OR 'Field changes (N):' header followed by 'fieldname
valueA → valueB' lines reusing established conventions.
JSON envelope {action: "diff", vsPlatform: true, result:
DiffTenantVsPlatformResult} where vsPlatform:true is
the discriminator distinguishing from ADR-0178's cross-
tenant variant for downstream jq consumers. Use cases
unblocked — one-command "is this tenant on the default?"
check, compliance audit shell loop filtering tenants
whose effective retention deviates from default, tier
migration verification via jq on .result.tenantResolution.source,
pre-deletion safety check showing what would change
when policy reverted to platform default. Rejected
alternatives — new action retention diff-platform
(cleaner separation but adds CLI surface, divides diff
vocabulary), sentinel --platform token in positional
arg (magical), always 3 positionals + --vs-platform
ignores 3rd (silent ignore of operator-supplied tenant
ids is error-prone), compose on effectiveRetentionBatch
with sentinel tenant (semantic awkward), return only
platform + fieldDiffs without tenantResolution echo
(operators re-query for tenant side redundantly),
implicit fallback when only 2 positionals (surprising —
explicit flag clearer), retention vs-default standalone
action (diverges from diff-* naming), JSON unified shape
with sentinel string "platform" for tenant-b (type
pollution + sentinel-string discrimination instead of
typed). 10 new adapter tests + 10 new CLI tests = 20
total covering: adapter issues exactly 2 queries in
parallel with tenant query against meta.tenant_retention_policies
+ platform query against meta.retention_policies + params
verified, returns both resolutions as none + empty
fieldDiffs when neither row exists, returns identical
resolutions + empty fieldDiffs when tenant falls back to
platform (no per-tenant policy + platform exists),
returns fieldDiffs when tenant override differs from
platform default (source + retention_days), renders
tenant_opt_out as tenantResolution when active opt-out
present with opt_out + opt_out_reason + opt_out_until
fields in diff, platformResolution always reflects
platform table independent of tenant verified via
tenant=7d + platform=365d enabled=false case,
platformResolution=none when no platform row exists,
expired opt-out falls through to platform on tenantResolution
clock-aware, tenant row with enabled=false + opt_out=false
falls through to platform; CLI tests — missing tenant
arg exit 2 with 'missing arguments' + '--vs-platform'
mention, missing table arg exit 2, calls diffTenantVsPlatform
NOT diffTenantPolicies verified via separate captures,
human-format 'No differences' message + 'Diff between
tenant and platform default' header, human-format 'Field
changes (N)' for non-empty diff with arrow + count
header, JSON envelope vsPlatform:true discriminator +
result.tenantId + result.platformResolution.source,
adapter errors propagate exit 1; formatTenantVsPlatformDiff
helper unit tests — 'No differences' message for empty,
tenant row with tenantId + summary line + retention=Nd,
tenant_opt_out with reason + until inline, platform=none
variant with '(no policy configured)' annotation. cli.ts
helpText extended with retention diff <tenant> <table-
name> --vs-platform usage line + 5-line description
explaining 2-query optimization + one-command vs two-
effective workflow benefit. ADR-0179 documents the
design + 8 rejected alternatives + 7 future Qs (--vs-tier
flag for tenant-vs-tier-default, --all-tables for one-
tenant across all prunable tables, combined retention
diff <tenant> defaulting to --vs-platform without flag,
table format output, bulk --bulk file.csv variant,
--exit-on-divergence for CI gates, JSON envelope
unification with cross-tenant diff via tagged union).
The retention CLI now has 15 actions covering forensic
+ recovery + comparison + performance workflows: 3 read
(expiring/effective/list-policies) + 4 write (opt-out/
opt-in/set/delete) + 1 audit (history) + 1 restore
(with --dry-run) + 2 diff (diff-history + cross-tenant
diff with both --vs-platform AND cross-tenant variants)
+ 1 maintenance (prune with --dry-run) + 1 batch
substrate-only (effectiveRetentionBatch).
M6.7.zz.tenant.opt-out.cli.diff
closes ADR-0165 Q6 by adding `crossengin retention diff
<tenant-a> <tenant-b> <table>` action + diffTenantPolicies
adapter method + normalizeResolutionForDiff pure helper.
Cross-tenant policy comparison answers tier-migration
verification ('did Tenant A's freshly-migrated retention
match reference Tenant B's?'), drift detection ('two
tenants on same plan — divergent?'), compliance audit
('why HIPAA cohort tenant A retaining 365d while tenant B
retains 90?'). Adapter calls effectiveRetentionBatch
internally with the two (tenant, sameTable) pairs — single
canonical batch-resolver pattern: any future comparison/
aggregation operation needing multiple resolutions should
compose on top of effectiveRetentionBatch rather than
issuing its own queries. 2 queries total (one tenant
lookup, one platform lookup with single table) regardless
of resolution variant — matches the dashboard performance
benefit from ADR-0177. Diff computed via reused
computeFieldDiffs helper from ADR-0173 after normalising
each resolution to a comparable record via new
normalizeResolutionForDiff pure helper — flattens
discriminated-union variant into {source, retention_days,
enabled, opt_out, [opt_out_reason], [opt_out_until]}
record where the last two fields appear only for
tenant_opt_out variant. Same alphabetical-sort diff output
across retention diff-history + retention diff for
uniform forensic format. Same-table constraint enforced
via single tableName field in input/result — cross-table
comparisons (different tables for one tenant) are a
different semantic; future action if requested. CLI takes
three positional args (tenant-a, tenant-b, table-name)
all required exit 2 if missing; no optional flags beyond
--format. Human output renders 3-section format —
'Diff between tenant policies (table: <name>):' header,
per-tenant resolution summary line via private
summarizeResolutionForDiff helper varying by variant
('source=tenant retention=Nd enabled=yes',
'source=tenant_opt_out reason=<r> until=<iso|indefinite>',
'source=platform retention=Nd enabled=yes|no',
'source=none (no policy configured)'), blank line, then
either 'No differences — both tenants have the same
effective retention policy.' for empty fieldDiffs OR
'Field changes (N):' header followed by 'fieldname valueA
→ valueB' lines reusing established conventions
('indefinite' / '<no reason>' for null fields). JSON
envelope {action: "diff", result: DiffTenantPoliciesResult}
preserves full discriminated-union structure for jq.
Use cases unblocked — tier migration verification (single
command vs two retention effective + mental compare),
drift detection across same-tier tenants, compliance
audit for regulated cohorts, migration-script smoke test
CI gates failing build when tenants in same cohort
diverge. Rejected alternatives: two effectiveRetention
calls (4 queries vs 2 batch), deep-equality without
normalization (variant shapes differ — operators see 'all
fields different' misleadingly), cross-table comparison
in same command (different semantic — future action),
N-way diff (pair-wise is canonical; chain commands),
--vs-platform shortcut (defer — operators run two
effective commands), use deferred retention effective-batch
CLI for inputs (focused single-purpose command better),
render resolution variant fields without normalization
(diff wouldn't tell operators which values differ),
include tenant metadata slug+name in result (substrate
stays minimal — operators join meta.tenants at their
layer). 13 new adapter tests + 16 new CLI tests = 29
total covering: adapter uses effectiveRetentionBatch
internally issuing exactly 2 queries, returns metadata +
resolutions + empty fieldDiffs when both none, empty
fieldDiffs when both identical platform, fieldDiffs when
tenant vs platform differ (source + retention_days),
fieldDiffs comparing tenant_opt_out vs tenant (source +
opt_out + opt_out_reason + opt_out_until), fieldDiffs
sorted alphabetically, resolutionA carries A's data and
resolutionB carries B's verified, uses tableName on both
axes (same table for both tenants), clock-aware expiry
preserved (expired opt_out falls through to platform on
diff); normalizeResolutionForDiff helper unit tests
covering all four variants; CLI missing tenantA exit 2,
missing tenantB exit 2, missing table exit 2, threads
three args to adapter, human renders 'No differences' for
empty fieldDiffs with helpful message, human renders
metadata + per-tenant resolutions + field-by-field diff
with arrows + count header, human renders tenant_opt_out
inline with reason+until, JSON envelope shape, adapter
errors propagate exit 1; formatTenantDiff helper unit
tests covering No differences message, Field changes
count header, tenant inline summary, tenant_opt_out
inline with reason+until, 'indefinite' for null until +
'<no reason>' for null reason, platform inline with
enabled flag, none inline with '(no policy configured)'
annotation. cli.ts helpText retention diff usage line +
4-line description explaining effectiveRetentionBatch
reuse + 2-query optimization. ADR-0178 documents the
design + 8 rejected alternatives + 7 future Qs (
--vs-platform flag for tenant-vs-default comparison,
N-way diff via --add-tenant repeated flag, cross-table
retention diff <tenant> <table-a> <table-b>, visual
color highlighting, configurable comparison depth,
--field <name> filter, combined diff-timeline showing
how A vs B evolved over time). The retention CLI now has
14 actions covering forensic + recovery + comparison +
performance workflows: 3 read (expiring/effective/list-
policies) + 4 write (opt-out/opt-in/set/delete) + 1
audit (history) + 1 restore (with --dry-run) + 2 diff
(diff-history + cross-tenant diff) + 1 maintenance
(prune with --dry-run) + 1 batch substrate-only
(effectiveRetentionBatch).
M6.7.zz.tenant.batch closes
ADR-0159 Q2 by adding `effectiveRetentionBatch(pairs)`
adapter method + exported effectiveRetentionKey helper.
The existing single-pair effectiveRetention makes 2 PG
round-trips per call; dashboards rendering 10K tenants ×
3 prunable tables = 30K resolutions per page = 60K
queries was prohibitive. New batch resolver runs exactly
TWO queries total regardless of pair count: one against
meta.tenant_retention_policies with `(tenant_id, table_name)
IN ((..., ...), ...)` tuple-list WHERE clause, one against
meta.retention_policies with `table_name IN (...)` (unique
tables only). Promise.all parallelizes them for single
wall-clock round-trip. Returns ReadonlyMap<string,
EffectiveRetentionResolution> keyed by `${tenantId}:
${tableName}` — exported effectiveRetentionKey(tenantId,
tableName) helper so operators don't need to know the
format; UUID tenant IDs contain hyphens but no colons and
table names match [a-z_]+ per META CHECK constraints so
collision-free. Resolution algorithm matches
effectiveRetention exactly — tenant policy + opt_out=true
+ active (clock-aware) → tenant_opt_out, tenant + enabled
→ tenant, platform → platform, else → none; expired
opt-outs fall through to platform same as single-pair.
Same this.clock() source as effectiveRetention for opt-out
expiry boundary semantics. Algorithm: deduplicate input
pairs by key, collect unique table names, run two queries
in parallel, build lookup maps (by key for tenant policies,
by tableName for platform policies), resolve in-memory per
pair returning ReadonlyMap. Empty pairs returns empty Map
without issuing queries (PG doesn't accept empty IN lists).
Why Map vs Array of triplets — O(1) lookup by key for
dashboard render rows, implicit deduplication, smaller
wire format; Array derivable via [...result.values()].
Why ReadonlyMap return type — prevents accidental mutation,
matches defensive typing of resolution discriminated union.
Why two non-transactional queries vs single UNION ALL —
query plan harder to reason about, in-memory resolution
faster than SQL-side conditional CASE WHEN, JOIN doesn't
translate cleanly given different column shapes. Why no
transaction wrapping both queries — overhead not warranted,
policy tables change rarely (operator-driven), tenant +
platform separate snapshots are fine, race window negligible.
Why no CLI surface in v1 — operators wanting ad-hoc batch
lookups write Node scripts; substrate is the meaningful
win; CLI defer to future milestone if requested. Use cases
unblocked — admin dashboard rendering 10K tenants × 3
tables (30K resolutions → 2 queries instead of 60K),
compliance bulk report (filter resolutions by source +
retentionDays threshold), tier-migration validation
(verify cohort matches expected resolution source),
periodic SLO checks. Rejected alternatives: single query
UNION ALL (plan harder, in-memory faster), per-pair
effectiveRetention in Promise.all (still 2N queries),
JOIN tenant + platform in SQL (column shapes differ),
return Array of triplets (Map is O(1) lookup), wrap both
queries in transaction (unnecessary overhead), stream
results via async iterator (overkill for bounded sizes),
batch resolver accepting tenant-only or table-only filters
(use listPolicies/listTenantPolicies for that pattern),
cache platform-policy lookup at adapter level (operators
wrap caching at their layer, substrate stateless), exotic
separator characters \x1F or :: (`:` is simple and UUIDs
don't contain colons), return resolution + requested pair
shape (Map by key is canonical, helper exists). 13 new
tests covering: empty pairs returns empty Map, issues
exactly 2 queries when pairs present (Promise.all parallel),
tenant query uses (tenant_id, table_name) IN tuple list
with params [tenantA, tableA, tenantB, tableB, ...],
platform query uses table_name IN list with UNIQUE tables
only (dedup verified for same-table different-tenant
pairs), deduplicates input pairs in result Map (3 dup
input → 1 result entry), resolves tenant variant when
tenant policy exists + enabled, resolves tenant_opt_out
when opt_out=true + active (clock-aware), expired opt_out
falls through to platform, resolves platform when no
tenant + platform exists, resolves none when neither
exists, mixed variants in one batch correctly (tenant +
platform + none in single call), Promise.all parallelism
verified (both queries fired before either returns), key
format `${tenantId}:${tableName}` exported helper test.
ADR-0177 documents the design + 10 rejected alternatives
+ 7 future Qs (CLI retention effective-batch --pairs-file
<file>, automatic chunking for >10K pairs, caching
platform-policy table, bulk versions of expiringOptOuts
+ other readers, composable inspectBatch returning
effective + expiring + history-snippets per pair, PG
prepared statements for repeated batch calls, --maxConcurrent
parameter for higher-level orchestration). Substrate-only
milestone — no CLI surface; operators with dashboard
needs write Node scripts calling the adapter directly.
M6.7.zz.tenant.opt-out.cli.restore.dry-run
closes ADR-0171 Q1 by adding `--dry-run` flag to retention
restore + new previewRestoreTenantPolicy adapter method.
Restore is destructive (overwrites current policy state
with historical state); operators want to see what would
change before applying — same safety motif as
retention prune --dry-run from ADR-0174. New adapter
method mirrors the dual-method pattern (prune +
previewPrune) — separate method rather than dryRun?:
boolean parameter on restoreTenantPolicy because the
return shape is fundamentally different (Result vs Preview)
and keeping them separate avoids type-system pollution.
Discriminated RestoreTenantPolicyPreview union has three
variants mirroring restoreTenantPolicy's dispatch branches:
would_delete (prev_state null → would call
deleteTenantPolicy), would_set_opt_out (prev_state.opt_out
true → would call setTenantOptOut with retentionDays +
optOutUntil + optOutReason), would_set_retention
(otherwise → would call setTenantRetention with
retentionDays + enabled). 'would_' prefix matches the
prune dry-run convention ('would_delete=N'). Variants
carry EXACT arguments that would be passed to the
underlying mutation — operators reading preview verify
planned action without ambiguity. Algorithm: same lookup
as restoreTenantPolicy (SELECT source history row) but
NO actorId/attributes parameters (preview is read-only,
no audit row written), NO call to underlying mutation,
same defensive validation of retention_days. CLI branches
at start of runRetentionRestore — --dry-run flag triggers
preview path. --actor silently ignored on --dry-run
(operators may script with both flags always set; ignoring
is friendlier than erroring). Human output renders preview
header 'Restore preview (no changes applied):' + source
history id + tenant + table + action line: 'deleteTenantPolicy
(prev_state was null)' for would_delete, 'setTenantOptOut'
+ indented retention/until/reason for would_set_opt_out
(reuses 'indefinite' / '<no reason>' conventions),
'setTenantRetention' + indented retention/enabled for
would_set_retention. JSON envelope {action: "restore",
dryRun: true, historyId, preview: RestoreTenantPolicyPreview}
preserves discriminated union; live mode emits {action,
dryRun: false, historyId, result} — dryRun boolean is the
canonical discriminator matching prune envelope convention.
Use cases unblocked: pre-restore safety check (two-command
preview then apply), compliance workflow validation (jq
on preview.kind), CI gates asserting restore semantics
before commit, forensic counterfactual investigation,
multi-command analysis comparing preview vs current state.
Rejected alternatives: single restoreTenantPolicy({dryRun:
true}) returning union (type pollution; callers narrow on
every call), previewRestoreTenantPolicy returning same
shape as RestoreTenantPolicyResult (conflates 'what
happened' vs 'what would happen'), --explain instead of
--dry-run (doesn't match apply/prune convention), implicit
preview when stdout is TTY (magic), error on --actor +
--dry-run (silent ignore friendlier), --diff-current flag
(defer to combined-mode milestone), preview accepting
actorId (read-only — actor meaningless without write),
JSON preview field renamed to result (semantically
distinct — preview vs result is correct vocabulary for
read-only vs write split). 9 new adapter tests covering:
throws when history id not found, does NOT issue any
mutation queries (single SELECT only), prev_state=null
returns would_delete with all fields, opt_out=true returns
would_set_opt_out with retention/until/reason, opt_out=true
with null until/reason returns nulls, opt_out=false returns
would_set_retention with days/enabled, opt_out=false +
enabled=false returns enabled:false, throws on missing
retention_days, kind discriminates three dispatch branches
parameterized test. 14 new CLI tests covering: --dry-run
calls previewRestoreTenantPolicy not restoreTenantPolicy,
threads historyId to preview adapter, --dry-run ignores
--actor flag silently, human-format renders preview header
+ source-history + action for would_delete with
'(prev_state was null)' annotation, would_set_opt_out
renders all three fields, 'indefinite' for null until +
'<no reason>' for null reason, would_set_retention renders
retention + enabled, JSON envelope {action, dryRun:true,
historyId, preview} for dry-run, JSON envelope dryRun:false
discriminator for live mode, --dry-run propagates preview-
adapter errors exit 1, formatRestorePreview helper unit
tests rendering all three variants. cli.ts helpText
retention restore usage line extended with [--dry-run]
optional flag + description mentions 'With --dry-run, show
prev_state + planned mutation method without applying.'.
ADR-0176 documents the design + 8 rejected alternatives
+ 6 future Qs (--diff-current flag combining preview with
effectiveRetention, bulk dry-run --bulk file.csv, multi-
version preview showing what restoring to A vs B would
each produce, --from-time DATE walking multiple history
rows pairing with deferred restore --to-time from ADR-0171
Q2, confirmation prompt linking dry-run + live invocations
via session cache, preview integration with retention
diff-history for 'what restoring to A would look like
compared to current'). The retention CLI now has 13
actions with all destructive operations supporting
--dry-run safety preview: 3 read (expiring/effective/
list-policies) + 4 write (opt-out/opt-in/set/delete) + 1
audit (history) + 1 restore (restore with --dry-run) + 1
diff (diff-history) + 1 maintenance (prune with --dry-run)
+ now restore --dry-run completes the safety-preview
coverage for write operations.
M6.7.zz.tenant.opt-out.cli.history.cursor
closes ADR-0170 Q8 by adding cursor pagination to retention
history via --after-id <uuid> flag. At low-scale deployments
the default limit=100 was fine; at >100K-event tenants
operators needed pagination + OFFSET-based pagination is
unstable under concurrent inserts. New compound-cursor SQL
uses `(occurred_at, id) < ((SELECT occurred_at FROM ... WHERE
id = $N), $N)` — single $N param reused for both occurred_at
inline subquery lookup and tiebreaker; (occurred_at, id)
ordered lexicographically handles ties when multiple rows
share occurred_at (concurrent CLI runs producing events at
same wall-clock instant); UUID v7 id is the tiebreaker.
ORDER BY widened from `occurred_at DESC` to `occurred_at
DESC, id DESC` — ensures result rows match cursor's order;
without id tiebreaker PG could return rows sharing
occurred_at in arbitrary order causing same row to appear
on two consecutive pages or skip across pages. When afterId
doesn't exist in the table, the inline subquery returns NULL
→ outer comparison evaluates NULL → row filtered out →
empty result set (operators detect end-of-pagination via
this OR via results.length < limit). Backward compatible —
omitting --after-id produces identical query shape
(modulo new id DESC tiebreaker which is a stability
improvement). CLI adds --after-id <uuid> flag to retention
history action; no boundary validation since PG enforces
UUID format at query time with clearer error than CLI
substring match. JSON envelope gains two new fields:
afterId echoes the cursor passed in (null when omitted),
nextAfterId is the last row's id when results.length ===
limit indicating more pages may exist (null otherwise —
operators interpret as "no more pages"). Human output
gains footer hint when results.length === limit: 'Page
full — next page: crossengin retention history --after-id
<last-id> ...'; omitted when results.length < limit (end
of pagination). nextAfterId is best-effort — accurate at
query time but concurrent inserts may add events later,
operators paginating typically don't care (snapshot
semantics). Why compound cursor (occurred_at, id) over
just occurred_at: ties on shared occurred_at would cause
rows to skip pages. Why occurred_at + id instead of just
id: UUID v7 is mostly time-ordered but PG's index choice
+ concurrent writes could produce out-of-order rows for
same occurred_at; compound cursor is bulletproof. Why
inline subquery for cursor's occurred_at: avoids requiring
operator to pass both id AND occurred_at; substrate
resolves the timestamp server-side from the id. Why no
--before-id for reverse pagination: single forward
direction covers the common case; bidirectional needs
operator-driven demand. Why no totalAvailable count in
envelope: separate COUNT(*) query if needed; not worth
the extra round-trip per page. Why no validate UUID format
at CLI boundary: PG enforces with clearer error. Why no
auto-paginate flag: operators want explicit page control;
shell loops cover the bulk-pagination pattern; auto-
streaming hides pagination from scripts. 7 new adapter
tests + 6 new CLI tests = 13 total covering: --after-id
threads as $N param into compound cursor subquery (single
$N reused twice — verified via regex count $1 appears
twice), compound cursor handles ties via id DESC
tiebreaker in ORDER BY, combines --after-id with other
filters via WHERE AND, returns empty when cursor row
doesn't exist (PG NULL semantic), backward compat omitting
--after-id produces identical query shape; combined-flag
test verifying tenantId + tableName + eventKind + since
+ until + afterId + limit all threaded correctly; CLI
threads --after-id to adapter, human-format prints next-
page hint when results.length === limit, human-format
omits hint when results.length < limit, JSON envelope
emits afterId + nextAfterId fields, JSON nextAfterId is
null when results.length < limit (no more pages), JSON
afterId is null when --after-id not provided. Existing
history tests updated — addedId: undefined now expected
in the captured input shape; the SQL substring assertion
'ORDER BY occurred_at DESC' still passes (new clause is
'ORDER BY occurred_at DESC, id DESC' — contains old as
prefix). cli.ts helpText extended with --after-id flag
doc + retention history usage line gains optional
[--after-id <uuid>] entry; description widened to mention
ORDER BY now includes 'id DESC' tiebreaker + --after-id
semantic. ADR-0175 documents the design + 8 rejected
alternatives (OFFSET-based pagination via --page N,
two-cursor --after-id + --before-id, single-key
occurred_at cursor, single-key id cursor, totalAvailable
count in envelope, CLI-boundary UUID validation, auto-
paginate via streaming, inline subquery rewritten as
JOIN) + 7 future Qs (--before-id reverse pagination,
--page-size alias, server-side opaque cursor encoding,
totalAvailable count, cross-process cursor stability via
PIT snapshot, --all auto-paginate flag, CLI integration
with --since for between-cursor-id-and-timestamp).
M6.7.zz.tenant.opt-out.cli.prune
closes ADR-0172 Q2 by adding `crossengin retention prune
[--dry-run]` action — pure CLI delivery, no new substrate
code. The pruning machinery already existed via
PostgresTraceRetention.prune() (ADR-0143) and previewPrune
(ADR-0153); operators invoked them only through scheduled
jobs. This milestone exposes ad-hoc invocation at the
terminal — debugging stuck prunes, on-demand compliance
sweeps, validation after configuring new policies, CI
gates, post-incident forensic snapshots. Single CLI action
+ one optional flag (--dry-run) wraps the two adapter
methods one-for-one: default calls prune() returning
RetentionRunResult[], --dry-run calls previewPrune()
returning RetentionPreviewResult[]. Two distinct formatter
functions (formatPruneRun / formatPrunePreview) keep
terminology distinct — header 'Retention prune results'
vs 'Retention prune dry-run results', count label
'deleted=N' vs 'would_delete=N', summary verb 'pruned'
vs 'would prune'. Per-row format: <status> <table-name>
<tenant=uuid|(platform)> <count> retention=Nd cutoff=<iso>
with extra reason=X until=Y appended for skipped_opt_out
+ skipped_opt_out_expired statuses (the latter also gets
'(EXPIRED)' marker). Summary line aggregates pruned count
+ row count + categorised skip counts sorted alphabetically:
'Summary: 2 pruned (1042 rows), 1 skipped
(1 skipped_disabled)' or multi-category 'Summary: 0
pruned (0 rows), 3 skipped (1 skipped_disabled, 1
skipped_opt_out, 1 skipped_opt_out_expired)'. JSON
envelope {action: "prune", dryRun: boolean, results: [...]}
preserves discriminator + full typed array. Empty results
print 'no retention policies configured' (or with
'(dry-run)' suffix); exit code 0 — absence of policies is
not an error. Why share formatter scaffolding via private
PruneResultLike interface: two result types differ in two
fields (deletedCount vs wouldDeleteCount) but share the
rest; count-rendering helper takes countLabel parameter
avoiding duplication while keeping public adapter types
separate. Why no --policy <table> or --tenant <uuid>
filter flags: scope creep, filter ambiguity (platform-
default DELETE uses NOT IN subqueries against ALL per-
tenant policies — filtering changes subtle semantics),
operator pattern (scheduled jobs run full prune; ad-hoc
mirrors that). Why no --confirm flag: --dry-run is the
canonical preview pattern, scheduled jobs would bypass
prompts anyway creating asymmetry, prune is destructive
but per-tenant restore action can recreate policies (just
not pruned trace data). 11 new CLI tests + 4 new
formatter tests = 15 total covering: default calls
prune() not previewPrune, --dry-run calls previewPrune()
not prune, human empty result 'no retention policies
configured', --dry-run empty adds '(dry-run)' suffix,
human renders pruned + skipped rows with summary,
--dry-run uses 'would prune' verb + 'would_delete='
label, human renders opt-out skip with reason + until,
skipped_opt_out_expired gets '(EXPIRED)' marker, JSON
envelope dryRun:false default, JSON envelope dryRun:true
with --dry-run, adapter errors propagate exit 1,
formatPruneRun renders header+rows+summary,
formatPrunePreview uses dry-run terminology,
'(platform)' for results without tenantId, summary line
shows multiple skip categories alphabetically sorted.
cli.ts helpText extended with retention prune usage line
+ multi-line description explaining dry-run semantics +
output structure. ADR-0174 documents the design + 8
rejected alternatives (two separate actions retention
prune+preview vs --dry-run flag, filter flags, --confirm
prompt, summary at top vs bottom, aggregate by table_name
grouping, implicit --limit, auto-emit notification on
threshold, CSV output) + 8 future Qs (--actor attribution
pairing with deferred audit-pruning-runs table, filter
flags --filter-table/--filter-tenant, --confirm flag,
progress reporting for long-running prunes, concurrent
invocation safety via advisory locks, --summary-only
flag, --exit-on-pruned for CI gates, CLI integration
with scheduled-job framework). The retention CLI now has
12 actions: 3 read (expiring/effective/list-policies) +
4 write (opt-out/opt-in/set/delete) + 1 audit (history)
+ 1 restore (restore) + 1 diff (diff-history) + 1
maintenance (prune); operators have complete ad-hoc
control over the retention substrate from one binary.
M6.7.zz.tenant.opt-out.cli.diff-history
closes ADR-0170 Q5 by adding `crossengin retention diff-history
<id-a> <id-b>` action + diffHistoryEntries adapter method +
exported computeFieldDiffs pure helper. Operators querying
the audit log via retention history saw a chronological
event list but couldn't easily answer "what changed between
event A and event B?" — current workflow required manual
JSONB comparison via two queries + mental diffing. New
adapter method runs single query `SELECT ... WHERE id IN
($1, $2)` then computes field-by-field diff client-side
via computeFieldDiffs(stateA, stateB) — union of keys
sorted alphabetically, JSON.stringify deep comparison,
returns only differing fields. Result type
DiffHistoryEntriesResult carries idA + idB + tenantId +
tableName + occurredAtA + occurredAtB + eventKindA +
eventKindB + fieldDiffs array of {field, valueA, valueB}.
Same-(tenant, table) constraint enforced — refuses cross-
tenant comparison ("events on different tenants
(<tenantA> vs <tenantB>)") and cross-table comparison
(same shape) because the use case is reconstructing single-
policy state at two moments; cross-tenant/cross-table
comparisons are different workflows (ADR-0165 Q6 separate
milestone). Compares next_state only not prev_state —
each history row has both but cross-event question is
"snapshot A vs snapshot B"; prev_state vs next_state of
single event is covered by retention history rendering
both columns. Client-side diff chosen over PG-side
jsonb_each because the diff logic is small (10 lines),
PG-side would need verbose "sort by key then compare via
text equality" expression, application-side is unit-
testable as pure function with no DB dependency, two
JSONB blobs (~400 bytes each) cheap to move. CLI action
takes positional <history-id-a> <history-id-b> args
(both required exit 2 if missing) + --format flag. Human
output renders metadata header (A: <id> at <iso>
event_kind=<kind>, B: <id> at <iso> event_kind=<kind>,
Tenant + Table) + Field changes (N) section with
'fieldname valueA → valueB' lines (or 'No differences
between the two events' policy states.' when empty);
'absent' placeholder rendered when value is undefined
(e.g., DELETE event's null next_state shows fields as
absent → value). JSON envelope {action: "diff-history",
result: DiffHistoryEntriesResult} preserves full structure
for jq. Use cases unblocked — forensic audit "what
changed between mutations X and Y?", compliance report
"policy state transitions over time" via retention
history + diff-history between consecutive events,
restore validation (diff source-history vs current-state
before running restore), JSON-driven compliance
dashboards via jq pipe. Rejected alternatives —
PG-side diff via jsonb_each (adds SQL complexity for
small win), compare prev_state vs next_state of single
event (covered by retention history rendering both
columns; cross-event use case is priority), allow
cross-tenant comparison (different concern; covered by
future retention diff action), allow cross-table
comparison (same), three-way diff idA+idB+idC
(overengineered; operators chain pair-wise),
--field <name> filter (jq covers), visual color diff
(substrate stays terminal-emoji-free; pipe to delta),
compare full event metadata kind+actor+attributes
(diff focuses on policy state; metadata visible in
headers), implicit restore on diff (conflates two
operations — diff is read-only), auto-sort by occurred_at
(operators may want B-then-A semantics; argument order
preserved). 16 new adapter tests + 8 new CLI tests = 24
total covering: throws when neither id exists with
clear message including both missing ids, throws when
only one id missing with single missing id in message,
throws on different tenants, throws on different tables,
throws on unknown event_kind, returns metadata +
fieldDiffs for valid pair, DELETE event with null
next_state shows 'absent' (valueA: undefined) for fields
present on B, empty fieldDiffs when both states equal,
empty fieldDiffs when both null (both DELETE), SELECT
shape uses WHERE id IN ($1, $2), computeFieldDiffs
returns sorted alphabetical diffs, returns empty array
for equal states, treats null state as empty object,
compares via JSON.stringify deep equality, treats
deep-equal objects as no diff; CLI tests cover missing
idA returns exit 2, missing idB returns exit 2, threads
ids to adapter, human-format 'No differences' when empty,
human-format renders metadata + field-by-field diff with
'A → B' arrow + 'Field changes (N)' header, human-format
renders 'absent' for undefined values, JSON envelope
shape, adapter errors propagate exit 1. cli.ts helpText
extended with retention diff-history usage line +
description explaining next_state vs next_state semantic.
ADR-0173 documents the design + 10 rejected alternatives
+ 7 future Qs (cross-tenant diff retention diff
<tenant-a> <tenant-b> <table> separate milestone closing
ADR-0165 Q6, --field name filter, three-way diff or
n-way merge view, visual color highlighting via opt-in
flag, prev_state vs next_state of single event via
retention show-event action, configurable comparison
depth, diff against current policy state via --current
flag for "what would restore change?" workflows). The
retention CLI now has 11 actions (3 read + 4 write +
1 audit + 1 restore-undo + 1 diff); operators have
full forensic + recovery + comparison workflows
without leaving the CLI.
M6.7.zz.tenant.opt-out.history-retention
closes ADR-0170 Q1 with the mechanically simplest change in
the retention substrate — wires the new audit-log table
into the existing retention machinery. Three additive
changes: META_RETENTION_POLICIES.table_name CHECK widens
from 3 to 4 values adding 'tenant_retention_opt_out_history';
META_TENANT_RETENTION_POLICIES.table_name CHECK widens from
2 to 3 values adding the same; PRUNABLE_TABLES map in
PostgresTraceRetention gains entry {timeColumn:"occurred_at",
hasTenantId:true}. No new adapter methods, no new CLI
surface — the history table inherits the entire ADR-0143
+ ADR-0155 + ADR-0162 retention machinery (window-based
DELETE, per-tenant overrides, opt-outs with expiry, dry-run
preview, effectiveRetention resolver, complete CLI surface).
hasTenantId:true so per-tenant DELETE fires on explicit
overrides, platform DELETE uses tenant_id NOT IN exclusion
for tenants with active overrides or opt-outs, and per-
tenant policies CAN opt out of history pruning (operators
with "retain forever for this tenant" requirements wrap via
opt_out=true on tenant_retention_opt_out_history). Why
include per-tenant retention allowlist not just platform:
schema supports tenant scoping via tenant_id column, real
use cases (VIP "retain 7 years" tier; free-tier "90 days";
legal hold "retain forever for this tenant"); excluding
would be artificial; CHECK widening is additive no
migration friction. Why no retention-on-the-history-table:
recursive concern (audit-log-of-audit-log gets its own
audit log gets... loop); operators wanting that wrap PG
pgaudit at the DB layer. Why no special event_kind for
"history row pruned": pruning DELETEs are maintenance on
the audit log not mutations on per-tenant policies; if we
wrote one it would itself be subject to pruning (loop);
operators auditing pruning runs use the RetentionRunResult[]
return value identifying which tables were swept + row
counts. Why no schema-level append-only enforcement:
substrate documents history as append-only "by convention";
pruning is the documented exception operators explicitly
accept; future REVOKE pattern on hypothetical audit-write
role would enforce except for system role that runs prune
— pairs with deferred roles substrate. Use cases unblocked:
platform-default history retention (INSERT INTO
meta.retention_policies with table_name='tenant_retention_opt_out_history',
retention_days=365), per-tenant VIP history-retention tier
via `crossengin retention set <vip> tenant_retention_opt_out_history
--days 2555` (7-year), opt-out from history pruning entirely
for litigation hold via `crossengin retention opt-out <legal-
hold-tenant> tenant_retention_opt_out_history --reason
ongoing_litigation:case#42`, dry-run via existing
previewPrune adapter (already invoked via scheduled jobs),
effectiveRetention resolver works across all four prunable
tables uniformly. Rejected alternatives: don't add to
retention (table grows unbounded), platform-only not
per-tenant (artificial — schema supports tenant scoping),
special-case prune_history method (existing prune already
does exactly what's needed; reuse > parallel structure),
add pruned_at event to history table (recursive concern),
separate history_retention_policies table (duplicates
existing infrastructure), refuse enabled=false (operators
legitimately want retain-forever), CHECK lower-bound on
retention_days (operator policy choice), cascade pruning
(wrong direction of causation — live policy is source of
truth not history). 5 new tests in trace-retention.test.ts
covering: knownPrunableTables now exposes 4 tables (was 3),
tablesWithTenantId now exposes 3 tables (was 2; adds
tenant_retention_opt_out_history alongside workflow_traces
+ llm_call_traces), prune issues DELETE against
meta.tenant_retention_opt_out_history using occurred_at
column, platform-default DELETE on history table uses
tenant_id NOT IN subquery (hasTenantId=true), per-tenant
retention applies to history table, effectiveRetention
resolves for history table, previewPrune renders count.
Existing tests updated: knownPrunableTables test (3→4),
tablesWithTenantId test (2→3 entries), safety-properties
test (allowed.length 3→4). meta-schema.ts CHECK constraints
on both retention_policies tables widened additively.
ADR-0172 documents the design + 8 rejected alternatives +
6 future Qs (default platform retention shipped row,
crossengin retention prune CLI action for ad-hoc invocation,
meta.retention_pruning_runs audit table for prune-run
metrics, REVOKE-enforced append-only pairing with deferred
roles substrate, lower-bound CHECK on retention_days to
prevent accidental aggressive pruning, compliance-regime-
specific retention defaults HIPAA 6yr / SOX 7yr — operator
encodes in deploy scripts). The retention substrate is now
self-managing — the audit-log table it produces is itself
subject to the retention machinery it provides.
M6.7.zz.tenant.opt-out.cli.restore
closes ADR-0169 Q7 + ADR-0170 Q4 by adding `crossengin
retention restore <history-id>` action +
restoreTenantPolicy adapter method. The audit-log table
shipped in ADR-0170 captured prev_state on every mutation;
this milestone wires undo. Operators making mistakes
(wrong tenant, wrong table, wrong retention days) recover
in one command. Adapter restoreTenantPolicy({historyId,
actorId?, attributes?}) returns discriminated
RestoreTenantPolicyResult: {kind:"restored", policy} when
prev_state had data, {kind:"deleted", tenantId, tableName}
when prev_state was null (restoring to absence — the
policy was originally created by the source event, so
"restore to before-state" means delete it now). Algorithm
two queries — SELECT source history row by id (throws if
not found), then dispatch on prev_state shape: null →
deleteTenantPolicy, opt_out=true → setTenantOptOut with
prev fields, otherwise → setTenantRetention with prev
fields. The restore adds {restored_from: historyId} to
attributes (merged with caller-provided attributes) so the
new history row written by the underlying mutation carries
forensic traceability. Delegates to existing mutation
methods rather than custom restore SQL — reuses their
atomic CTE history-write pattern, inherits their tests +
behavior, no new code path. Why no new policy_restored
event_kind: audit clarity preserved via attributes.restored_from
(operators see actual mutation kind opt_out_set / retention_set
/ policy_deleted plus restore reference in attributes);
restore is meta-operation not new policy state; additive
schema change deferred; operator query `WHERE attributes->>
'restored_from' IS NOT NULL` works without it. Defensive
runtime check on prev_state.retention_days as number (
schema-drift safety). CLI takes positional <history-id>
(exit 2 if missing) + optional --actor flag. Human output
reuses formatPolicyChange("restored", policy) helper for
kind=restored variant; renders "restored from <id>: policy
deleted (prev_state was null) — tenant X / table Y" for
kind=deleted variant. JSON envelope {action: "restore",
historyId, result} where result preserves discriminated
union shape for jq branching on .result.kind. Use cases
unblocked — recover from accidental delete (history --kind
policy_deleted | restore), undo wrong opt-out, roll back
tier migration mistake, compliance audit "restore proof"
via jq filter on attributes.restored_from, CI test recovery
via clean reset. Rejected alternatives: single CTE for
source-lookup + restore (polymorphic apply on event_kind
makes CTE unreadable), generic applyPolicyState method
(duplicates four mutation methods), new policy_restored
event_kind (audit clarity via attributes + restore is meta-
op), dedicated restored_from column (attributes JSONB
designed for this), refuse restore for policy_deleted
events (that IS the headline use case), --dry-run flag
(defer), restore by tenant+table most recent (ambiguous —
operators may want specific historical state), atomic
restore-and-emit-policy_restored CTE (see above),
restore --to-time DATE (would need to walk multiple
history rows — defer to advanced action), cascade restore
across multiple rows (semantics unclear — defer). 10 new
adapter tests + 8 new CLI tests = 18 total covering: throws
when history id not found, looks up source by id with
WHERE id=$1, prev_state=null restores via DELETE
(kind="deleted"), prev_state opt_out=true restores via
setTenantOptOut, prev_state opt_out=false restores via
setTenantRetention, attributes.restored_from added,
caller-provided attributes merged with restored_from,
actorId threaded to underlying mutation, throws when
prev_state missing retention_days, kind="deleted" result
carries tenantId+tableName from source row, CLI missing
history-id arg exit 2, threads historyId (actorId null
by default), --actor threading, human output "Tenant
restored" for kind=restored, human output "restored from
<id>: policy deleted" for kind=deleted, JSON envelope
{action, historyId, result} restored variant, JSON envelope
deleted variant, adapter errors propagate exit 1. cli.ts
helpText extended with retention restore usage line + the
multi-line description explaining prev_state-null
behavior. ADR-0171 documents the design + 10 rejected
alternatives + 7 future Qs (--dry-run, --to-time DATE,
batch restore, confirmation prompt for destructive
restores, restore-from-snapshot cross-tenant, lastPrunedAt
preservation semantic, GUI dashboard integration). The
retention CLI now has 10 actions (3 read + 4 write + 1
audit + 1 restore-undo); the history table is now
operationally complete — capturing every change AND
enabling undo. M6.7.zz.tenant.opt-out.history
closes six prior ADR Qs (ADR-0161 alt-1 + ADR-0162 Q7 +
ADR-0166 Q1+Q2 + ADR-0167 Q3 + ADR-0168 Q6 + ADR-0169 audit
+ restore Qs) by shipping META_TENANT_RETENTION_OPT_OUT_HISTORY
as the 129th meta-schema table + atomic history writes from
all four mutation methods + listOptOutHistory query method
+ `crossengin retention history` CLI action +
`--actor <uuid>` flag threading on all four mutation CLI
actions. New table append-only by convention with id UUID
v7 PK + tenant_id FK CASCADE + table_name + event_kind
CHECK ('opt_out_set'|'opt_out_cleared'|'retention_set'|
'policy_deleted') + actor_id nullable UUID + occurred_at +
prev_state JSONB + next_state JSONB + attributes JSONB
NOT NULL default '{}'; three indexes (tenant timeline +
table timeline + kind analytics) all ordered by
occurred_at; tenant-isolated RLS. Atomic history writes
via CTE chain (existing → mutation → history → SELECT
mutation) — same SQL statement, PG single-statement
atomicity, no race window, no transaction overhead, no
two-round-trip cost. prev_state captured from existing
CTE snapshot at statement start (NULL for new-row INSERT,
populated for UPDATE), next_state from RETURNING (NULL
for DELETE, populated for INSERT/UPDATE). Four mutation
inputs gain optional actorId + attributes fields;
attributes defaults to '{}' JSONB matching workflow_traces
+ llm_call_traces convention. New listOptOutHistory
adapter method with five orthogonal filters (tenantId,
tableName, eventKind, since, until) + LIMIT (default 100,
validated >= 1); ORDER BY occurred_at DESC; strict
event_kind validation on returned rows throwing on
unknown values (defensive against schema drift). New CLI
action `retention history` with --tenant + --table +
--kind + --since + --until + --limit flags; all
validated at boundary (kind against tuple, dates parsed
+ normalised to canonical ISO 8601, limit integer >= 1);
human output renders single-row-per-event table with
'<system>' placeholder for null actorId; JSON envelope
echoes all filters + count + entries for jq correlation.
--actor flag added to opt-out + opt-in + set + delete
actions threading actorId through to history rows.
Why separate table vs columns on live row: only captures
most-recent event in column form, column proliferation
(4 kinds × set_by/set_at/prev = 12 columns of dead weight
on rarely-changed rows), no event-kind distinction.
Why CTE atomic write vs transaction(): same atomicity
guarantee, single round-trip, simpler test mocks. Why
default attributes='{}'::jsonb NOT NULL: matches workflow_traces
+ llm_call_traces convention so downstream jq pipes
always see a JSON object. Why PK on id UUID v7 not
(tenant_id, table_name, occurred_at): concurrent CLI
runs can share an instant; UUID v7 gives time-ordered
collision-free identity. Why append-only by convention
not enforced: REVOKE on audit-write role would enforce
but couples to a not-yet-shipped roles substrate; deferred.
Six prior ADRs converge into this design. 21 new adapter
tests + 18 new CLI tests = 39 total covering: each
mutation SQL contains correct event_kind literal,
captures prev_state via existing CTE for INSERT/UPDATE,
captures prev_state via DELETE...RETURNING for delete,
threads actorId param + attributes JSONB through every
mutation, listOptOutHistory returns entries with no
filters, maps snake_case → camelCase, filters by each
flag dimension, ORDER BY occurred_at DESC + LIMIT $N,
default limit 100, rejects limit < 1 + non-integer,
throws on unknown event_kind in row, CLI history returns
entries, threads all five filter flags through to adapter,
normalises --since + --until to canonical ISO 8601, exit
2 on invalid kind/since/until/limit, human-format empty
result message + table rendering with '<system>'
placeholder for null actor, JSON envelope with all filters,
adapter errors propagate exit 1; --actor flag threading
verified on all four mutation actions; omitting --actor
passes null to adapter. cli.ts helpText extended with
retention history usage line + --actor / --kind / --since
/ --until / --limit flag docs. meta-schema.test.ts table
count 128 → 129 + tenant_retention_opt_out_history added
to alphabetical name list. ADR-0170 documents the design
+ 10 rejected alternatives (audit columns on live row,
transactions vs CTE, PG trigger-based, separate schema,
mandatory actorId, per-field diff, pg_audit WAL, materialized
view, strict CHECK on actor_id format, policy_state enum)
+ 10 future Qs (history-table retention pruning, FK to
meta.users, REVOKE-enforced append-only, retention restore
action, retention diff-history action, backfill tool,
SIEM ingestion hooks, cursor pagination, actor display
join, --attributes CLI flag). The retention CLI now has
9 actions (3 read: expiring/effective/list-policies + 4
write: opt-out/opt-in/set/delete + 1 audit:
history + the implicit `--actor` cross-cutting flag);
substrate-side, 8 PostgresTraceRetention methods backing
them + the new history-table CTE pattern that future
substrate audit-tables can copy. M6.7.zz.tenant.retention-delete
closes ADR-0168 Q1 by adding `crossengin retention delete
<tenant> <table>` action + deleteTenantPolicy adapter
method. The retention CLI is now CRUD-complete on per-
tenant policies: opt-out/opt-in flip the opt_out flag, set
configures active per-tenant override, list-policies +
effective + expiring inspect, and now delete removes the
row entirely. Operators wanting a tenant to inherit
platform-default with no historical baggage previously had
to write raw DELETE SQL. Adapter is the mechanically
simplest method in the substrate: single `DELETE FROM
meta.tenant_retention_policies WHERE tenant_id = $1 AND
table_name = $2` using PG's native rowCount (no RETURNING
since operators inspect pre-deletion state via
effective/list-policies before deleting); returns boolean
where true=row deleted, false=no matching row (idempotent
no-op). No opt_out filter in WHERE clause — distinct from
clearTenantOptOut (which deliberately filters `AND opt_out
= true` to avoid clearing fields on non-opt-out rows);
delete is the hard-delete path with no flag-state filter,
operator's intent is "remove this row regardless of its
state." CLI takes positional tenant + table args only (no
extra flags beyond --format); validates missing args with
exit 2; passes through to adapter. Idempotent — `deleted:
false` is success exit 0, operators safely re-run scripts.
Human output: "deleted per-tenant policy: <uuid> /
<table>" or "no per-tenant policy for tenant <uuid> on
<table> (idempotent no-op)". JSON output emits envelope
{action, deleted, tenantId, tableName} where deleted
boolean discriminates actual deletion from no-op and the
queried tenantId+tableName echo allows correlation across
multiple invocations. No --confirm flag (matches sessions
+ gateway-routes mutation pattern; bounded blast radius —
single policy row, recoverable via retention set or
retention opt-out; operators wanting safety run effective
first). Boolean return chosen over TenantRetentionPolicyRow|null
(deleted row no longer exists post-mutation — returning
pre-deletion state via RETURNING is semantically odd;
boolean sufficient for if-then-log audit scripts).
Use cases unblocked: reset tenant to platform-default
(one command, no audit baggage), tier-migration cleanup
(shell loop over JSON tenant list), compliance audit
closure (jq list-policies | filter | delete stand-by
rows), end-of-engagement offboarding, CI test-tenant
cleanup (idempotent teardown). Rejected alternatives:
DELETE with RETURNING (adds adapter complexity for
boolean question), soft-delete via enabled=false (covered
by retention set --enabled=false), refuse delete on
opt_out=true row (operators explicitly running delete
know intent; substrate doesn't gate on flag states
mirroring set's willingness to overwrite opted-out rows),
--confirm prompt this milestone (defer pattern), bulk
--bulk file.csv (shell loops cover), --all-tables flag
(defer), retention purge naming (implies sweep across
many; delete matches single-row scope),
Promise<TenantRetentionPolicyRow|null> return (semantically
odd), filter on opt_out to mirror clearTenantOptOut (
intentional hard-delete semantic). 5 new adapter tests
covering DELETE WHERE shape, params threading, returns
true when rowCount > 0, returns false when rowCount = 0,
NO opt_out filter (distinct from clearTenantOptOut). 9
new CLI tests covering missing tenant/table exit 2,
threads to adapter, human output "deleted" when removed,
human output "idempotent no-op" when no row, JSON envelope
shape with deleted=true and deleted=false, exit 0 on
idempotent no-op (re-runnable), adapter errors propagate
exit 1. cli.ts helpText extended with retention delete
usage line. The retention CLI surface now has 8 actions
covering full CRUD lifecycle: expiring (list opt-outs
within window) + effective (resolve single pair) +
list-policies (broad audit) on read; opt-out + opt-in
+ set + delete on write; with the retention-set milestone
closing the active-override gap and retention-delete
closing the row-removal gap. ADR-0169 documents the
design + 9 rejected alternatives + future Qs (--confirm
flag matching apply --confirm pattern, --all-tables for
tenant offboarding, REJECT permanently --include-platform
(too dangerous), --exit-on no-op for CI gates,
audit-log integration pairing with deferred history-table
milestone, --before <date> bulk cleanup for time-bound
purge, retention restore <backup-id> requiring deferred
history-table for undo). M6.7.zz.tenant.retention-set
closes ADR-0166 Q7 by adding `crossengin retention set
<tenant-id> <table-name> --days N [--enabled true|false]`
action + setTenantRetention adapter method. Operators
configuring active per-tenant retention overrides (NOT
opt-out — that's ADR-0166) previously had to write raw
INSERT ... ON CONFLICT SQL — now they have a one-command
CLI. Mirrors the M6.7.zz.tenant.opt-out.cli.mutate pattern
for symmetry — same INSERT ... ON CONFLICT DO UPDATE
atomic upsert, same shared formatPolicyChange output
renderer, same exit-code conventions. Adapter
setTenantRetention takes {tenantId, tableName,
retentionDays, enabled?} where enabled defaults to true;
validates retentionDays as integer >= 1 (clearer than DB
CHECK violation); SQL sets opt_out=false unconditionally,
opt_out_until=NULL on UPDATE, preserves opt_out_reason
on UPDATE (omitted from SET clause per ADR-0161
historical audit context preservation); INSERT path
explicitly writes all fields. CLI mandates --days flag
(no default — operators must explicitly state the value);
--enabled defaults to true (common case is "give this
tenant a custom retention"); both flags validated at CLI
boundary with exit code 2 on invalid. opt_out_until
cleared on update because semantically belongs to opt-out
lifecycle — stale value from previous opt-out is more
common than pre-staging operator intent ("set this
tenant's retention, period"). Action verb `set` chosen
over update/configure/override for canonical operator
vocabulary; full command (crossengin retention set ...)
carries enough context. Human output via shared
formatPolicyChange("retention set", policy) — "Tenant
retention set: <uuid> / <table>" header + days + enabled
+ Opt-out:no + conditional Reason line (omitted when
null but persists when historical). JSON output emits
{action: "set", policy: TenantRetentionPolicyRow}. Use
cases unblocked: per-tenant tier upgrade (free→enterprise
365d), per-tenant tier downgrade (free 7d), disable as
stand-by (--enabled=false), end-of-legal-hold workflow
(opt-in then set to restore custom retention), compliance
reset (opt-in then set disabled to inherit platform
default), JSON pipeline for bulk tier migration scripts.
Rejected alternatives: `retention update` (implies row
exists), `retention override` (verbose+specific), make
--days optional (operator may forget on new row creating
inconsistent state), default --enabled=false (common
case is take effect immediately), preserve opt_out_until
(stale-vs-staging trade-off favors clear), clear
opt_out_reason (contradicts ADR-0161), refuse set on
opted-out row (one-shot transition is valid workflow),
reject --enabled=false with --days (staging is valid),
two-query SELECT-then-INSERT-or-UPDATE (race window).
10 new adapter tests covering INSERT ... ON CONFLICT
shape, parameter threading, default enabled=true,
returns camelCase, UPDATE clears opt_out_until,
PRESERVES opt_out_reason (omitted from SET clause),
UPDATE uses EXCLUDED.retention_days + EXCLUDED.enabled,
rejects retentionDays < 1, rejects non-integer, throws
on empty RETURNING. 12 new CLI tests covering missing
tenant/table exit 2, missing --days exit 2, threads
tenantId+tableName+days+default enabled=true to adapter,
--enabled=false threading, --enabled=true threading,
invalid --enabled exit 2, non-integer --days exit 2,
--days<1 exit 2, human output Tenant retention set
header + 30 day(s) + Opt-out:no, JSON envelope {action:
"set", policy} structure, adapter errors propagate exit
1. cli.ts helpText extended with retention set usage
line + --days / --enabled flag docs. ADR-0168 documents
design + 9 rejected alternatives + future Qs (retention
delete action for full removal, --confirm-clear-opt-out
flag for destructive transitions, --days inherit sugar
for DELETE-and-inherit, bulk variant for tier migration
scripts, confirmation prompt for destructive transitions
pairing with apply --confirm pattern, audit columns
set_by/set_at pairing with deferred actor attribution
+ history-table milestones). M6.7.zz.tenant.opt-out.cli.list
adds `crossengin retention list-policies [--tenant <uuid>]
[--table <name>]` action filling the broad-audit gap left
by the four prior CLI actions (expiring/effective/opt-out/
opt-in). The action wraps the existing PostgresTraceRetention.listPolicies
+ listTenantPolicies methods (no new adapter surface needed),
emitting both platform-defaults and per-tenant-policies in
one shot. Compliance audits answering "show me every
retention policy on the platform" no longer need three SQL
queries + manual stitching. Output always renders both
sections with explicit count headers (Platform defaults
(N total) + Per-tenant policies (N total)) — even when
empty (rendered as '(none configured)') giving operators
complete context including the negative space "no platform
default for table X means platform pruning is off". Per-
tenant rows show one of three opt-out states: opt-out=no
(normal per-tenant override), opt-out=yes (until <iso>,
reason: <reason>) (active time-bound opt-out), opt-out=yes
(until indefinite, reason: <reason>) (active indefinite
opt-out). Null optOutReason renders as <no reason>
consistent with the other actions. Two filter flags:
--tenant <uuid> scopes the per-tenant section only (platform
defaults stay visible so tenant audits keep context they
fall back to for unconfigured tables), --table <name>
scopes BOTH sections to one table, both flags AND
together. Filter values appear in (filtered: tenant=...,
table=...) suffix on each section header so saved output
remembers the query parameters. No filter-value
validation against an allowlist — operators passing
--table=typo see empty results and notice (matches
substrate's "doesn't prescribe" stance). JSON output emits
structured envelope {tenantFilter, tableFilter, platform,
tenantPolicies} echoing filter values (or null for unset)
so downstream consumers confirm parameters without
re-parsing command line. Parallel adapter calls via
Promise.all — independent queries, one wall-clock round-
trip. Client-side filtering preferred over adapter-side
WHERE clauses for this milestone since policy table sizes
are bounded (max 3 platform rows + ~2N tenant rows where
N=tenant count; 20K rows at 10K-tenant scale returns in
milliseconds); adapter signatures stay simple. Action name
`list-policies` (hyphenated) chosen over plain `list`
(ambiguous: list what — tenants? opt-outs?) reserving
namespace for future siblings; matches verb-object naming
of `gateway routes register-pack`/`unregister-pack`/`sync-
pack` conventions. Use cases unblocked: one-command
compliance audit (SOC 2 / HIPAA / 21 CFR 11 auditor sees
complete picture in one screenshot), per-tenant retention
summary (customer-success "what's tenant X's retention?"),
per-table compliance check (audit one table's deviations
across tenants), JSON export for quarterly compliance
reports (lastPrunedAt timestamp gives auditors a "was
pruning actually running?" signal), CI sanity check
(crossengin retention list-policies --format json | jq
'.platform | map(select(.enabled == false)) | length'
fails CI when count > 0). Rejected alternatives: single
flat list mixing both row types (mental segmentation
burden; two-section design matches table topology),
`retention list` plain (too generic), `retention
policies` noun-only (inconsistent with action-verb
pattern), adapter-side WHERE filtering (policy tables
are small; client filtering simpler — add if measured),
JSON-only output (ad-hoc terminal use wants readable),
built-in --limit/--offset pagination (bounded data;
pipe through head/jq), single JOIN/UNION query
(orthogonal shapes — preserves typed discriminated
structure), sort flags (jq covers). 17 new tests in
retention.test.ts covering: both sections returned with
no filters, --tenant scopes per-tenant only, --table
scopes both sections, --tenant + --table AND together,
empty platform renders (none configured), empty per-
tenant renders (none configured), filter suffix on
header when flags set, JSON emits structured envelope
with all sections + filters, JSON reflects filter values,
adapter errors propagate as exit 1, formatPoliciesList
renders opt-out=no for normal per-tenant, opt-out=yes
with until + reason for active opt-outs, opt-out=yes
(until indefinite ...) for null optOutUntil, '<no
reason>' for null optOutReason, enabled/disabled flag,
'last pruned <iso>' / 'last pruned never' rendering,
omits filter suffix when both filters null. cli.ts
helpText extended with retention list-policies usage
line + --tenant / --table flag docs. ADR-0167 documents
the design + 8 rejected alternatives + future Qs
(--stale-days N filter, --opt-out-only filter, --include-
history pairing with deferred history table, adapter-
side filtering, sort flags, column-selection flag,
aggregation --summary flag, --format csv).
M6.7.zz.tenant.opt-out.cli.mutate
closes ADR-0160 Q5 + ADR-0161 Q4 + ADR-0162 Q4 by adding
two mutation actions to the retention CLI:
`crossengin retention opt-out <tenant> <table> [--until DATE]
[--reason TEXT] [--retention-days N]` and `retention opt-in
<tenant> <table>`. Operators previously inspected retention
state via expiring/effective but flipping opt_out=true still
required raw SQL. The two new actions complete the read+write
CLI loop. Supporting adapter methods setTenantOptOut +
clearTenantOptOut added to PostgresTraceRetention.
setTenantOptOut uses single-query INSERT ... ON CONFLICT
(tenant_id, table_name) DO UPDATE — atomic upsert eliminating
the race window in two-query SELECT-then-INSERT-or-UPDATE
patterns. Sets enabled=false + opt_out=true unconditionally;
on conflict preserves retention_days (omitted from UPDATE
SET clause), sets opt_out_reason + opt_out_until from
EXCLUDED.* (the new values, including NULL when not
provided). New rows get retention_days=365 by default
(ADR-0160 placeholder semantic) or operator-provided
--retention-days. Validates retentionDays as integer >= 1
at adapter boundary (clearer error than DB CHECK violation).
clearTenantOptOut uses single UPDATE ... WHERE tenant_id=$1
AND table_name=$2 AND opt_out=true setting opt_out=false +
opt_out_until=NULL. PRESERVES opt_out_reason per ADR-0161
historical context — operators lifting an opt-out keep the
audit signal "this tenant was opted out previously due to
X." The AND opt_out=true guard prevents accidentally
clearing fields on non-opt-out rows. Returns null when no
matching opt-out row exists — idempotent semantic; running
opt-in twice is safe. CLI validation at the boundary:
positional args required (exit 2 missing arguments),
--until parses via Date.parse and normalises to canonical
ISO 8601 (operators can pass "2027-01-01" and get
"2027-01-01T00:00:00.000Z" stored), --reason length 1..256
(matches DB CHECK; clearer CLI error), --retention-days
integer >= 1, all four invalid-flag cases exit 2 with
clear messages. Action verbs opt-out/opt-in match operator
vocabulary (chosen over set-opt-out/clear-opt-out which
are accurate but verbose). Sit under `retention` subcommand
so full command carries context. Human output via shared
formatPolicyChange(action, policy) renders verb header +
retention_days + enabled + opt_out + Until (or 'indefinite'
for null on opt-out variant, omitted for opt-in with null
until) + Reason (omitted when null). JSON output emits
envelope {action, policy: TenantRetentionPolicyRow | null}
where null policy is the idempotent no-op signal on opt-in
against a non-opt-out tenant. Use cases unblocked: one-
command legal hold (opt-out --until --reason), one-command
lift (opt-in idempotent), one-command extend (opt-out
--until X --reason X re-pass; UPDATE SET via EXCLUDED.*
overwrites with the new values), bulk via shell loops
(for tenant in $(cat tenants.txt); do opt-out "$tenant"
...), compliance cleanup (expiring --include-expired |
jq | xargs opt-in re-runnable). Rejected alternatives:
single retention set --opt-out=true|false (verbose, less
natural English), auto-clear opt_out_reason on opt-in
(contradicts ADR-0161 documented preservation), DELETE
on opt-in (destroys retention_days + reason), mandatory
--reason (operators may record before fully scoped),
--clear-reason / --clear-until flags (workflow chains
opt-in+opt-out), specialised adapter helpers like
extendOptOut/changeReason (general method covers it),
two-query SELECT-then-INSERT-or-UPDATE (race window),
validate --until against future-date constraint
(operators may pass past dates for backfilling/testing).
16 new adapter tests + 27 new CLI tests = 43 tests total
covering: INSERT ... ON CONFLICT shape verified, retention_days
+ optOutReason + optOutUntil params threaded, defaults to
365 + null + null when not provided, returns camelCase
policy row, UPDATE clause excludes retention_days (preserves),
UPDATE uses EXCLUDED.opt_out_reason + EXCLUDED.opt_out_until,
rejects retentionDays < 1, rejects non-integer, throws on
empty RETURNING, UPDATE shape for clearTenantOptOut sets
opt_out=false + opt_out_until=NULL, preserves opt_out_reason
(not in UPDATE clause), returns camelCase policy row,
returns null when no row, WHERE filters opt_out=true,
threads tenantId+tableName params; CLI tests cover missing
args (exit 2 for both opt-out and opt-in), default flag
threading, --until + --reason + --retention-days threading,
ISO 8601 normalisation, invalid --until / empty --reason /
oversized --reason / non-integer --retention-days /
zero --retention-days all exit 2 with clear errors, human
output renders policy change, JSON envelope shape {action,
policy}, adapter errors propagate as exit 1, opt-in
idempotent no-op message + null policy in JSON,
formatPolicyChange action verb in header, tenantId +
tableName in header, indefinite for null until on opt-out,
ISO timestamp for explicit until, omits Until line on
opt-in with null, renders reason when set, omits Reason
line when null. cli.ts SUBCOMMANDS unchanged (retention
already listed); helpText extended with two new usage
lines + --until / --reason / --retention-days flag docs.
ADR-0166 documents the design + 8 rejected alternatives
+ future Qs (actor attribution columns, append-only
history table, --dry-run flag, bulk action, confirmation
prompt for destructive actions, bulk opt-in --expired
convenience flag, sibling retention set action for non-
opt-out per-tenant policies). M6.7.zz.tenant.opt-out.cli.effective
closes ADR-0159 Q5 by adding `crossengin retention effective
<tenant-id> <table-name>` action under the `retention`
subcommand. Wraps the ADR-0159 effectiveRetention(tenantId,
tableName) resolver one-for-one with a discriminated-union-
aware output renderer. Operators answering "what's the
retention policy for tenant X on table Y right now?" no
longer drop to direct SQL — direct queries miss the
resolution semantics (precedence, expiry filtering, the
4-variant union shape). Each variant renders distinctly so
operators see the actual semantic at a glance: source="tenant"
prints "Tenant override (active)" with retention days +
enabled; source="tenant_opt_out" prints "Tenant opt-out
(active)" with optOutUntil (or "indefinite" for null) +
optOutReason (or "<no reason>" for null — same convention
as the expiring action from ADR-0164); source="platform"
prints "Platform default" with retention days + enabled
flag; source="none" prints "No policy configured".
Platform + none variants don't carry a tenantId from the
resolver (platform policy is platform-wide), so the queried
tenant id from the CLI is rendered for context — keeps the
human output self-explanatory. JSON output emits the full
discriminated union unchanged inside an envelope {tenantId,
tableName, resolution} so downstream consumers correlate
multiple lookups via jq even when individual resolutions
omit one field. Validation: missing tenant or table args
return exit 2 with clear "missing arguments" error. No
table-name validation — resolver returns source="none" for
unknown tables, surfacing "No policy configured" with the
queried name. Use cases unblocked: operator debugging
"why isn't tenant X getting custom retention?" (CLI prints
Platform default → operator checks DB row sees enabled=false
or opt_out_until past), compliance audit "is tenant X in
active legal hold?" (one-line jq pipe), tier migration
verification (shell loop across tables checks consistency),
dashboard tooltip integration (web UI renders badge from
JSON shape). Rejected alternatives — flat positional args
with --tenant/--table flags (verbose for two required args;
positional matches sessions show <id> + gateway routes
unregister <id> patterns), default to all tables when name
omitted (pattern inconsistency with sessions show), print
raw struct field-by-field (operators have to mentally
decode source="tenant_opt_out"; variant-aware rendering
surfaces semantic immediately), CSV/TSV output (defer to
global --format csv if needed), retention effective <tenant>
no-table-arg returning all (bulk mode deserves its own
action), auto-fill table to default like workflow_traces
(likely typo; failing fast clearer), --clock flag for
testing override (read-time semantic; production uses
Date.now via default constructor). 16 new tests in
retention.test.ts: missing tenant arg returns exit 2,
missing table arg returns exit 2, threads tenantId+
tableName through to resolver, human-format renders
source=tenant with retention days, human-format renders
source=tenant_opt_out with reason + until, human-format
renders source=tenant_opt_out with 'indefinite' when
optOutUntil null, human-format renders source=platform
with Enabled:yes, human-format renders source=platform
with Enabled:no when disabled, human-format renders
source=none with clear message, JSON emits structured
envelope with full resolution, propagates resolver errors
as exit 1, formatEffectiveResolution source=tenant uses
resolution.tenantId (not query arg), source=platform
uses queried tenantId (resolution lacks one), source=none
uses queried tenantId, source=tenant_opt_out renders
'indefinite' for null optOutUntil, source=tenant_opt_out
renders '<no reason>' for null optOutReason. cli.ts
helpText extended with retention effective <tenant>
<table> usage line. ADR-0165 documents the design + 6
rejected alternatives + future Qs (bulk --all-tables
lookup pairing with deferred effectiveRetentionBatch
resolver, --explain flag for diagnostics, --at-time
history flag pairing with deferred history substrate,
exit code by source for CI gates, sibling mutation
actions opt-out/opt-in/list-policies, comparison query
retention diff for tier migration verification).
M6.7.zz.tenant.opt-out.cli closes
ADR-0163 Q4 by adding `crossengin retention expiring
[--within-days N] [--include-expired]` CLI subcommand. The
ADR-0163 expiringOptOuts resolver shipped a query surface
but operators were still writing custom scripts to call it
— the binary is the canonical operator surface for the rest
of the substrate (apply, chat, sessions, gateway), retention
belongs in the same place. New top-level `retention`
subcommand added to SUBCOMMANDS list; first action `expiring`
follows the established sessions/gateway-routes action-verb
pattern. Defaults: --within-days=30 (matches monthly review
cadence), --include-expired=false (upcoming-window query is
the common case), --format=human (workspace standard).
Human output renders a table with daysUntilExpiry as 'Nd'
for future or 'EXPIRED Nd ago' for negative + tenant +
table + reason (with <no reason> placeholder when null —
gives operators an immediate signal that audit context
from ADR-0161 is missing). Empty result prints a clear
"no opt-outs ..." message. JSON output emits structured
envelope with withinDays + includeExpired + count + results
array so downstream consumers can pipe through jq for
alerting / per-tier bucketing / spreadsheet export.
Validation at CLI boundary mirrors resolver — --within-days
must parse as Number.isFinite() && >= 0, rejects negative
/ NaN / non-numeric with exit code 2 and clear error
message. PG env required (PGHOST/PGDATABASE/...) matching
sessions / gateway routes patterns; new RetentionContext.retentionOverride
field injects mock for testing (PostgresTraceRetention
override). Action-verb pattern chosen over flat
subcommand (crossengin retention-expiring) because (1)
matches sessions list/show/replay + gateway routes list/
register/... conventions operators already know, (2)
reserves namespace for future actions (retention effective,
opt-out, opt-in, list-policies all wrap existing resolver
methods), (3) help text groups related actions together.
Use cases unblocked: daily cron retention-alerts job
(crossengin retention expiring --format json | jq | send-slack),
pre-flight checks before weekly compliance meetings,
quarterly audit reports (--within-days 365 --include-expired
--format json > audit.json), CI alert gates (count >0 means
alert needed). Rejected alternatives: flat subcommand
(breaks pattern), action under sessions/gateway (retention
is its own substrate concern), default within-days=7 (too
aggressive, monthly 30d more common), default include-expired=true
(upcoming-window is the default query), built-in Slack/email
delivery (couples substrates, operators wire delivery via
notification provider of choice), filter flags --table/
--tenant-id/--reason-pattern (keep surface minimal, jq covers
filtering on JSON output for now), pagination/--limit (opt-out
count bounded in practice), wrap Inngest job definition
(operators have different schedulers — CLI stays scheduler-
agnostic). 20 new tests in retention.test.ts: missing
action returns exit 2, unknown action returns exit 2, missing
PG env returns exit 1, default within-days=30 + includeExpired=false
threaded to resolver, --within-days threads through,
--include-expired threads through, negative --within-days
returns exit 2 with clear error, non-numeric --within-days
returns exit 2, human empty-result success message includes
day count, --include-expired empty wording is 'expired or
expiring', human table renders with all results visible,
JSON emits structured envelope with all flags + count +
results, JSON envelope includes withinDays + includeExpired,
resolver errors propagate as exit 1, formatExpiringTable
renders positive days as 'Nd', renders negative as 'EXPIRED
Nd ago', renders <no reason> for null optOutReason, renders
actual reason when set, uses 'expired or expiring' header
when includeExpired=true, uses 'expiring' header when false.
helpText extended with the new retention expiring usage line
+ --within-days / --include-expired flag docs. SUBCOMMANDS
test in cli.test.ts updated to include 'retention'. Future
Qs in ADR-0164 cover sibling actions (effective, opt-out,
opt-in, list-policies), --tenant-id + --table filter flags,
--exit-on-found CI gate flag, --sort output ordering, CSV
output format, verbose debugging flag. M6.7.zz.tenant.opt-out.alerts
closes ADR-0162 Q2 by adding `expiringOptOuts(input)`
resolver to PostgresTraceRetention. The auto-expiry
semantic shipped in M6.7.zz.tenant.opt-out.expiry lifted
opt-outs without operator intervention but offered NO
advance warning. Legal holds expiring next week are major
operational events — legal extends, compliance reviews,
operations plans pruning, customer success informs the
customer. Without a query surface, operators wrote ad-hoc
SQL, forgot to run it, missed the lead time. The new
method returns a sorted list of opt-outs whose
opt_out_until falls within a configurable window,
optionally including already-expired entries; operators
wire it into their notification pipeline via scheduled
job (cron, Inngest, Kubernetes CronJob). Method signature:
expiringOptOuts({withinDays: number, includeExpired?:
boolean}): Promise<ExpiringOptOut[]> where ExpiringOptOut
= {tenantId, tableName, optOutUntil (ISO 8601 always
non-null), optOutReason (string | null), daysUntilExpiry
(float, positive for future, negative for expired)}.
Returns sorted by opt_out_until ASC (soonest first).
Substrate stays passive — exposes data, operator wires
delivery via their existing notification provider (Slack/
PagerDuty/email/webhook); coupling between substrates
avoided. Three operator workflows covered by one method:
"what expires soon?" (withinDays=30 + includeExpired=false,
the common alert query), "what's already expired?"
(withinDays=0 + includeExpired=true, cleanup audit),
"everything time-bound in the next year" (withinDays=365
+ includeExpired=true, compliance report). daysUntilExpiry
is computed from injected clock() — substrate has authoritative
clock, eliminates off-by-one bugs from operators re-implementing
diff. Float precision preserved so operators bucket
precisely (1d / 7d / 30d urgency tiers). Validation:
withinDays must be finite >= 0; rejects negative, Infinity,
NaN at API boundary with clear error. Excludes rows with
opt_out=false or opt_out_until IS NULL (indefinite — by
definition no expiry to alert on). Returns empty array
when no rows match. Rejected alternatives: active push
via @crossengin/notifications (coupling between substrates;
operator notification provider choice varies; scheduling
logic belongs at workflow/job layer), PG NOTIFY trigger
(hidden behavior, no good 30-days-before event-time
expression, requires LISTEN client), materialized view
(refresh schedule complexity, query fast enough on indexed
column), separate upcomingOptOuts + expiredOptOuts methods
(operators with broad audit needs would call both — one
parameterized method composable), tier bucketing in API
(prescriptive — operator tier definitions vary 60/30/14/7
vs 30/7), stateful alert tracking for dedupe (couples
retention to alert delivery; dedup belongs at notification
layer), return raw rows without daysUntilExpiry
(re-implementing clock-aware diff per dashboard), cursor
pagination (opt-outs bounded in practice, add if measured).
No new schema — pure read-side method. 15 new tests:
returns opt-outs within window with daysUntilExpiry
computed, SQL excludes already-expired by default
(includeExpired=false), SQL includes already-expired when
includeExpired=true, daysUntilExpiry negative for expired
rows, SQL filters opt_out=true + opt_out_until IS NOT
NULL, ORDER BY opt_out_until ASC, withinDays=0 +
includeExpired=false returns empty (strict window),
withinDays=0 + includeExpired=true returns all expired,
withinDays<0 throws, withinDays=Infinity throws,
withinDays=NaN throws, empty result returns empty array,
threads optOutReason from row, threads null optOutReason,
supports tiered alert windows via daysUntilExpiry float
precision. Documented future Qs: partial index on
opt_out_until WHERE opt_out=true (defer until measured),
cursor pagination (defer), alert state tracking table for
dedup (defer to M6.7.zz.tenant.opt-out.alert-state if
demanded), CLI exposure via `crossengin retention
expiring --within-days N`, webhook delivery wrapper,
per-tier convenience method, "recently lifted" reverse
query for missed-notification audits, channel-specific
integrations remain in @crossengin/notifications substrate.
M6.7.zz.tenant.opt-out.expiry
closes ADR-0160 Q2 by adding `opt_out_until TIMESTAMPTZ`
NULLABLE column to META_TENANT_RETENTION_POLICIES with no
CHECK on the date value itself. Opt-outs are now self-
managing: the resolver / prune / preview check expiry at
read time using the application clock (in the adapter) and
PG's `now()` (in the SQL NOT IN subquery). Active opt-outs
still skip pruning entirely; expired opt-outs fall through
to platform-default — automatic at the expiry instant, no
operator intervention. Pain solved: forgotten opt-outs
(operator flips opt_out=true for a 6-month legal hold and
forgets to lift; substrate now auto-lifts at opt_out_until),
calendar-driven holds (legal teams stipulate end dates;
operators record the exact date), audit reports lagging
reality (dashboards no longer show forever-expired opt-outs
as active), compliance theater (data persists past the legal
end-of-hold creating worse posture). Semantic: opt_out=false
→ no opt-out regardless; opt_out=true + opt_out_until=NULL
→ indefinite; opt_out=true + opt_out_until > now → active;
opt_out=true + opt_out_until <= now → expired. Expired rows
are NOT auto-deleted — they persist as audit trail. Operators
query `WHERE opt_out = true AND opt_out_until < now()` to
find expired rows and decide to clear / extend / convert.
EffectiveRetentionResolution tenant_opt_out variant gains
required optOutUntil: string | null field. Resolver only
emits tenant_opt_out when active; expired falls through to
enabled check (false per CHECK constraint) then to platform-
default — self-healing at expiry crossings. New status
"skipped_opt_out_expired" added to RetentionRunStatus +
RetentionPreviewStatus enums; per-tenant iteration picks
status active ? "skipped_opt_out" : "skipped_opt_out_expired"
so operators auditing prune runs see expirations distinctly
from genuinely-disabled rows. Platform-default DELETE +
previewPrune COUNT NOT IN subqueries widen from
`(enabled OR opt_out)` to `(enabled OR (opt_out AND
(opt_out_until IS NULL OR opt_out_until > now())))` —
expired opt-outs are NOT excluded so platform sweep covers
their tenant_id's data. Two clock sources by design — adapter
uses injected clock for testability, SQL uses PG `now()` to
avoid parameter-shape changes; sub-second drift acceptable
for day-grained retention semantics; operators NTP-sync in
practice. Schema choices: NULLABLE not NOT NULL since most
opt-outs are indefinite (legal hold of unknown duration, VIP
contract until customer revocation); no CHECK on date value
since `> created_at` forces future-dated and `> now()` is
nonsensical at INSERT-only evaluation; no CHECK tying
opt_out_until to opt_out=true since operators may pre-stage
expiry before flipping opt_out (mirrors ADR-0161 reason
column decision). Boundary case: opt_out_until == now() is
treated as expired (strict `>` comparison). Backward
compatible additive schema — existing rows get opt_out_until
NULL by default; resolver / prune treat NULL as indefinite
preserving M6.7.zz.tenant.opt-out semantics. Rejected
alternatives: TIMESTAMP not TIMESTAMPTZ (timezone ambiguity),
PG trigger auto-clearing opt_out on expiry (destroys
historical audit signal + implementation complexity),
INTERVAL duration not endpoint (relative-to-what?
ambiguity), separate
meta.tenant_retention_opt_out_expirations table (joins
everywhere; opt_out_until is a property of the opt-out),
opt_out_indefinite BOOLEAN companion column (NULL already
encodes "no expiry"), overloading last_pruned_at for
expiry (path to bugs), PG-side-only resolution (kills
testability — injected clock pattern established in
PostgresLatencyTracker etc.). 13 new tests: opt_out + null
opt_out_until is indefinite (skipped_opt_out), opt_out +
future opt_out_until is active (skipped_opt_out +
optOutUntil populated), opt_out + past opt_out_until is
expired (skipped_opt_out_expired + NO DELETE issued for
tenant), boundary case opt_out_until == clock now treated
as expired, previewPrune surfaces skipped_opt_out_expired,
listTenantPolicies SELECT includes opt_out_until column,
listTenantPolicies maps opt_out_until to optOutUntil camelCase
field, effectiveRetention tenant_opt_out variant with future
opt_out_until populates optOutUntil, expired opt-out falls
through to platform when platform policy exists, expired
opt-out + no platform returns none, null opt_out_until
treated as indefinite/active, clock injection drives expiry
decision (same row resolves differently across clocks),
effectiveRetention SELECT includes opt_out_until column.
M6.7.zz.tenant.opt-out.reason
closes ADR-0160 Q1 by adding `opt_out_reason TEXT` NULLABLE
column to META_TENANT_RETENTION_POLICIES with length CHECK
"opt_out_reason IS NULL OR (char_length(opt_out_reason)
BETWEEN 1 AND 256)". The opt_out flag from M6.7.zz.tenant.opt-out
marks tenants as exempt from retention pruning but operators
had no first-class place to record WHY — audit blind spot
("why is tenant X opted out?" required hunting tickets/
Slack/lawyer emails), onboarding handoff problem (institutional
knowledge leaves with departing operators), compliance
dashboards (SOC 2 / HIPAA / 21 CFR 11 audits ask "show every
deviation and the documented reason"), per-reason metrics
("how many legal holds active?"). NULLABLE not NOT NULL
because most rows (opt_out=false majority) don't need a
reason, operators backfilling pre-M6.7.zz.tenant.opt-out.reason
rows can leave NULL, and forward-compat — tightening to
NOT NULL after backfill period is easier than relaxing.
No CHECK tying reason to opt_out state — operators may
preserve reason as historical context when lifting opt-out
("this tenant WAS opted out due to X"), may pre-stage
reason before flipping opt_out=true (legal team writes
reason during contract review, ops flips flag after sign-
off), and substrate keeps the columns independent
informationally. Length [1, 256] — lower 1 prevents empty
strings (ambiguous: no-reason vs empty-string-reason),
upper 256 caps storage + forces concise classifiers
(long-form context belongs in linked ticket systems).
No pattern constraint — operator taxonomies vary
(structured "legal_hold:case#42" vs free-form "Subpoena
from SEC, see ticket #12345"), substrate doesn't prescribe.
Threading: TenantRetentionPolicyRow gains optOutReason:
string | null surfaced on listTenantPolicies;
RetentionRunResult + RetentionPreviewResult gain optional
optOutReason populated when status === "skipped_opt_out";
EffectiveRetentionResolution tenant_opt_out variant gains
required optOutReason: string | null field — resolver
populates from the row's opt_out_reason column;
listTenantPolicies + effectiveRetention SELECTs both
include opt_out_reason column. No changes to DELETE/UPDATE/
COUNT — reason is purely informational read-path.
Use cases unblocked: compliance dashboard "opt-outs by
category" via CASE WHEN LIKE 'legal_hold:%' THEN 'Legal
Hold' grouping; audit report "every opt-out with documented
reason" via WHERE opt_out=true ORDER BY opt_out_reason
NULLS LAST; dashboard tooltip enrichment showing reason
on badge hover; prune-run audit trail with reason at the
event source. Rejected alternatives: separate audit table
meta.tenant_retention_opt_out_history (cleaner but invasive
trigger-based; defer to unified policy-change audit log
milestone), JSONB reason column (overkill, harder to query),
NOT NULL with empty-string default (semantic ambiguity),
pattern enforcement slug-only (prescribes structure),
typed enum opt_out_kind (same prescription problem).
8 new tests: listTenantPolicies SELECT includes
opt_out_reason column, listTenantPolicies maps to
optOutReason camelCase field, prune threads optOutReason
into skipped_opt_out result, prune threads null when no
reason set, previewPrune threads optOutReason,
effectiveRetention threads into tenant_opt_out variant,
effectiveRetention returns null when no reason,
effectiveRetention SELECT includes opt_out_reason.
M6.7.zz.tenant.opt-out closes
ADR-0159 Q1 by adding `opt_out BOOLEAN NOT NULL DEFAULT false`
column to META_TENANT_RETENTION_POLICIES with cross-column
CHECK `NOT (enabled = true AND opt_out = true)`. The
existing `enabled = false` semantic was overloaded — meant
"this override is disabled, use platform default." Real
compliance scenarios need a distinct semantic: opt-out
tenants must have NO data pruned regardless of platform
default. Use cases unblocked: legal hold tenants
(litigation/subpoena/audit), 21 CFR Part 11 clinical
trials, VIP contracts stipulating "retain until customer
requests deletion." Schema delta is additive — existing
rows get opt_out=false by default, no migration friction.
The cross-column CHECK rejects the contradictory state
(enabled=true AND opt_out=true) at INSERT/UPDATE time.
Operators encode opt-out as enabled=false, opt_out=true;
active policy as enabled=true, opt_out=false; fall-back-to-
platform as enabled=false, opt_out=false. EffectiveRetentionResolution
discriminated union grows from 3 to 4 variants with new
`tenant_opt_out` (retentionDays=null + enabled=false +
tenantId). Resolution algorithm extended: tenant row found
+ opt_out=true → return tenant_opt_out variant (skip
platform query, highest priority); else enabled=true →
tenant variant; else fall through to platform. retention_days
stays NOT NULL with CHECK >= 1 even for opt-out rows — the
column stores a placeholder (typically the previously-
configured value), so flipping opt_out back to false
restores the prior policy without re-prompting operators
for a number. The resolver's tenant_opt_out variant returns
retentionDays=null because semantically there IS no
retention applied — emitting the placeholder would mislead
consumers reading the output. Prune semantics: per-tenant
loop gains opt-out branch BEFORE enabled check —
RetentionRunStatus + RetentionPreviewStatus enums gain
"skipped_opt_out". Platform-default DELETE's NOT IN
subquery extends from `enabled = true` to `(enabled = true
OR opt_out = true)` — opt-out tenants are excluded from
platform pruning too. Same change in previewPrune COUNT
subquery. Three rejected alternatives: retention_days = -1
sentinel (overloads numeric semantics), make retention_days
NULLABLE (operators lose placeholder when toggling), replace
enabled BOOLEAN with policy_state TEXT enum (breaking
schema change). 9 new tests: prune skipped_opt_out + no
DELETE issued for opt-out tenant, opt_out=true takes
precedence over enabled state, platform DELETE NOT IN
subquery extended to opt_out, previewPrune skipped_opt_out
+ no COUNT for opt-out tenant, previewPrune platform COUNT
NOT IN extended, disabled-and-not-opt-out tenant still
falls back to platform-default (baseline preserved),
effectiveRetention returns tenant_opt_out, opt_out
precedence over platform fallback (single round-trip —
platform query skipped), TypeScript discriminated union
narrowing on source='tenant_opt_out' asserting retentionDays:
null + tenantId: string + enabled: false. M6.7.zz.tenant.dashboard closes
ADR-0155 Q6 by adding `effectiveRetention(tenantId,
tableName)` to PostgresTraceRetention — single resolver
method returning a discriminated-union
EffectiveRetentionResolution with three variants: tenant
(source="tenant" + retentionDays + enabled=true + tenantId),
platform (source="platform" + retentionDays + enabled),
none (source="none" + retentionDays=null + enabled=false).
Operator pain solved: dashboard "show retention by tenant",
compliance audit "is tenant X compliant?", GDPR Article 15
"include retention policy in evidence pack", admin UI
"badge tenant as Custom Policy vs Platform Default vs No
Policy". Resolution algorithm: query
meta.tenant_retention_policies WHERE tenant_id = $1 AND
table_name = $2; if row exists AND enabled = true → return
source="tenant" + skip platform query (single round-trip
happy path); else query meta.retention_policies WHERE
table_name = $1; if row exists → return source="platform"
+ enabled reflects platform row (operators distinguish
platform-policy-disabled from no-policy-at-all); else
return source="none". Semantic alignment with prune:
enabled=true requirement on per-tenant policy matches
ADR-0155's prune semantics where disabled per-tenant
policies fall back to platform-default. Discriminated
union over flat shape because: (1) source="tenant"
guarantees tenantId is present — TypeScript narrowing
gives type-safety, flat shape forces optional handling;
(2) source="tenant" guarantees retentionDays is number not
null — flat shape forces nullable handling everywhere;
(3) future variants (e.g., compliance_override for
HIPAA-strict overriding tenant policies) extend the union
additively without breaking forward-compat for narrowing
consumers. Method on PostgresTraceRetention (not separate
class) because retention has no router-side hot path —
this is a CLI/dashboard concern; co-locating keeps SQL
parameterization (SCHEMA + table names) consistent and
avoids per-call class instantiation. Two PG round-trips
worst case; one best case. Works for llm_latency_samples
even though no tenant override possible (DB CHECK
constraint excludes that table) — resolver naturally
returns source="platform" or "none" since tenant query
finds nothing. Returns source="none" for unknown table
names — operators see "this isn't a prunable table"
distinctly from "no policy configured". No schema change,
no new dependencies, pure code addition.
11 new tests in trace-retention.test.ts: tenant-source
happy path with enabled override, fallback to platform
when per-tenant disabled, fallback when no per-tenant
exists, platform-source with disabled flag preserved,
none-source on neither, llm_latency_samples works (no
tenant possible — always platform or none), unknown
table returns none, query parameters threaded correctly
((tenant_id, table_name) PK lookup), single-round-trip
on happy path (platform query skipped), two-round-trips
on disabled-tenant fallback, TypeScript discriminated
union narrowing test asserts source="tenant" branch
gives tenantId: string + retentionDays: number +
enabled: true. M6.8.y closes ADR-0145 Q5 by
adding the `setExactTags` operator helper to
`@crossengin/ai-providers-bedrock`. New tagging-helpers.ts
file hosts a standalone exported function (not a
BedrockProvider method — preserves the substrate's three-
tier layering: tagging-api.ts pure code, provider.ts raw
transport, tagging-helpers.ts operator composition).
Signature: setExactTags(provider, {resourceArn,
desiredTags}) returns {added, removed, unchanged}.
Algorithm: pre-flight validation (non-empty arn + no
duplicate desired keys) → listTagsForResource → diff
(added/removed/unchanged) → tagResource (additions) →
untagResource (removals). Minimum API calls based on
diff: 1 call (list-only when converged), 2 (add-only or
remove-only), 3 (mixed). AWS's tagResource OVERWRITES
existing values — no untag-then-tag round-trip needed for
value updates. Tag-then-untag ordering preserves operator
mental model "add what I want, then prune what I don't" +
gives clearer audit on partial failures. Idempotent: re-
running with same desired set is a 1-call list-only no-op
returning unchanged=desired. Operator pain solved:
convergence to desired state without diff logic, minimum
API calls vs naïve tag-all + untag-all, idempotent CI/
workflow integration, audit trail via the result object.
Substrate layering preserved — BedrockProvider stays a
1:1 wrapper of AWS endpoints; helpers compose above; if
helpers proliferate (>5 functions) could split into
@crossengin/bedrock-helpers package. Index exports
cleanup as a side effect: previously-missing exports
(tagging-api, provisioned-throughput-api,
foundation-models-api) added alongside tagging-helpers
so operators importing from @crossengin/ai-providers-bedrock
now see the full type surface. 14 new tests in
tagging-helpers.test.ts: empty-current+non-empty-desired
(all additions), non-empty-current+empty-desired (all
removals), exact-match noop (1 API call), value-update on
existing key (treated as add since value differs),
mixed add/remove/unchanged, tag-then-untag ordering,
resourceArn-blank pre-flight (no list issued), duplicate-
desired-key rejection pre-flight, value-update single-call
(no untag), idempotent two-run convergence, error
propagation (404 from list), empty-value support (AWS
allows empty values), result audit shape, BedrockError
class identity. M6.8.x.trace closes ADR-0154 Q1
by emitting a new `ceiling_resolved` RouterInstrumentation
event automatically from DefaultLlmRouter.enforceCeilingPreflight.
ROUTER_INSTRUMENTATION_KINDS grows 6 → 7 with ceiling_resolved
at slot 7. Operators previously had source attribution via
PostgresCostCeilingResolver.resolveDetailed() (synchronous),
but no automatic audit trail — they had to wrap the resolver
themselves. Four additive changes: (1) new kind in the
ROUTER constant; (2) new types CostCeilingSource +
CostCeilingResolution in @crossengin/ai-router/cost-tracker.ts
with router-side enum widening to include "global" (the
router's own costCeiling) — the resolver-side enum only
emits "override"|"tier"|"none" but the router's source enum
adds "global" for the costCeiling fallback case; (3) new
optional callback getTenantCostCeilingDetailed?: (tenantId)
=> Promise<CostCeilingResolution> on
DefaultLlmRouterOptions — operators wire
PostgresCostCeilingResolver.resolveDetailed directly here;
detailed callback takes PRECEDENCE over basic
getTenantCostCeiling when both wired; if detailed returns
source="none" the router falls back to global; if only
basic is wired and returns a ceiling, source degrades to
"override" (can't disambiguate from tier without the
detailed shape); (4) META_LLM_CALL_TRACES.kind CHECK
constraint extended additively — no migration. Resolution
precedence walks 4 levels: detailed→basic→global→none. The
event fires BEFORE the ceiling check so even when
CostCeilingExceededError throws, operators see the resolution
in their audit trail (critical for debugging blocked
requests). Event attributes are TypeScript discriminated-
union shaped: {source, hasCeiling} always present; ceiling
present only when hasCeiling=true; tierId present only when
source==="tier". Wire ordering: ceiling_resolved →
llm_call_started → llm_call_completed (matches the logical
ordering of enforceCeilingPreflight at the start of
complete()). Three operator workflows unblocked: compliance
audit dashboards answering "did Tenant X get the expected
policy at this moment?", tier migration verification (did
pro promotion take effect on the next request?),
forensic reconstruction of blocked requests by correlating
ceiling_resolved with llm_call_failed kind="cost_ceiling_exceeded"
via session_id. PostgresRouterInstrumentation handles the
new kind transparently since the wire format is unchanged.
No breaking change: existing 6 kinds preserved; new callback
is opt-in; legacy getTenantCostCeiling callback continues
working with degraded "override" source. embed() doesn't
currently call enforceCeilingPreflight so ceiling_resolved
doesn't fire there — adding embed ceiling enforcement is a
separate milestone. 12 new tests in router.test.ts:
source="none" emission when no ceiling, source="global"
emission with router costCeiling only, source="override"
emission via basic callback, source="global" fallback when
basic returns undefined, source="tier" emission with tierId
via detailed callback, source="override" via detailed
(tierId absent), fall-back-to-global when detailed returns
source="none", emit BEFORE first llm_call_started ordering,
field threading (tenantId/sessionId/task/providerId/modelId),
durationMs is null, event still fires when ceiling
exceeded + throws CostCeilingExceededError, detailed
callback takes precedence over basic when both wired.
Three existing tests updated to include ceiling_resolved
in the expected event sequence + kinds.length=7. M8.2 adds
timer_set + timer_cancelled
to WORKFLOW_INSTRUMENTATION_KINDS (14 → 16) closing the timer
lifecycle observability gap. Before M8.2, operators saw
timer_fired events but not timer_set creations or
timer_cancelled removals — couldn't observe timer-set-to-fire
latency, timer creation throughput, or cancellation rates.
Three additive changes: (1) ROUTER kinds grows 14→16 with
timer_set at slot 8 (before timer_fired) and timer_cancelled
at slot 10 (after) — symmetric verb pair around the existing
timer_fired. (2) applyScheduleTimer in engine.ts emits
timer_set BEFORE the timer_scheduled event-log append —
matches M8.1 activity_started ordering; instrumentation
captures intent even when persistence fails. Attributes:
{timerId, timerName, fireAt, relativeSeconds}. Same timerId
flows into both the instrumentation event AND the subsequent
timer_scheduled event-log entry → operators correlate
timer-set-to-fire latency via `attributes.timerId`. (3)
META_WORKFLOW_TRACES.kind CHECK constraint extended
ADDITIVELY to allow both new values — no migration needed
for pre-existing data still in original 14 kinds. KEY
NUANCE: timer_cancelled is kind-defined + CHECK-allowed but
NOT YET EMITTED. The engine's cancel_timer action handler
currently throws "not implemented in M3" (engine.ts line
600-603); no code path produces cancellation events.
Reserving the kind NOW means the future milestone that
wires cancel_timer doesn't need a schema migration —
additive forward-compat. Documented as future Q2. Three
operator workflows unblocked: timer creation throughput
observability ("how many timers per workflow instance?"),
timer-set-to-fire latency dashboards (`fired.occurredAt -
set.occurredAt` correlated via timerId), compliance audit
("every timer scheduled by this workflow"). Naming choice
timer_set (not timer_scheduled) deliberately disambiguates
from the event-log kind timer_scheduled which represents
persistence — different surfaces, different consumers; the
verb timer_set/timer_fired/timer_cancelled mirrors operator
language. Instrumentation never crashes engine (same error-
swallowing pattern as M8). No new transport, no new
dependency, no breaking change. PostgresWorkflowInstrumentation
handles the new kinds transparently since the wire format is
unchanged. 6 new tests in engine.test.ts: timer_set emitted
on schedule, attributes populated correctly (timerId +
timerName + fireAt computed from clock + relativeSeconds),
tenantId/instanceId/definitionId threaded, SAME timerId
across timer_set and timer_fired, multiple timers each emit
their own timer_set with distinct timerIds, both new kinds
present in the constant. instrumentation.test.ts updated
from "14 documented engine events" to "16 documented engine
events" with the new alphabetical-canonical kind list.
M6.7.zz.tenant closes ADR-0143 Q1
by adding META_TENANT_RETENTION_POLICIES (128th table) for
per-tenant retention overrides. Operator workflows unlocked:
long-tail customer compliance (7-year retention for a
regulated tenant while platform default stays 90 days),
cost-shaping per tenant (free-tier 7d / pro 90d / enterprise
365d), GDPR Article 17 (right to erasure) accelerated for
opt-in tenants, A/B testing retention policies before
rolling them platform-wide. Two-table design chosen over
the NULLABLE-tenant_id alternative from the ADR-0143 Q1
sketch — PG-version-portable (no NULLS NOT DISTINCT
requirement), matches META_LLM_TENANT_TIER_MEMBERSHIPS
pattern, cleaner PK semantics. Schema: tenant_id UUID
NOT NULL REFERENCES tenants, table_name TEXT with CHECK
limited to ('workflow_traces', 'llm_call_traces') — NOT
llm_latency_samples since that table has no tenant_id
column per ADR-0140 and per-tenant retention is mechanically
impossible there. PK = (tenant_id, table_name); RLS enabled
with standard TENANT_ISOLATION_USING; FK ensures deleted
tenants don't orphan policies. Adapter changes:
listTenantPolicies() new method, prune() refactored to
iterate tenant policies FIRST then platform-default;
previewPrune() mirrors the same structure; result types
gain optional tenantId field — present on per-tenant
results, absent on platform-default; PRUNABLE_TABLES map
upgraded to {timeColumn, hasTenantId} keeping the schema-
aware allowlist; new static tablesWithTenantId() helper
exposes which tables support per-tenant policies. The
interesting SQL: platform-default DELETE on tables WITH
tenant_id includes a `tenant_id NOT IN (SELECT tenant_id
FROM meta.tenant_retention_policies WHERE table_name = $X
AND enabled = true)` subquery to skip tenants with
overrides — this correctly handles BOTH directions of
tenant-vs-default deviation: tenants with SHORTER
retention (per-tenant DELETE runs first; platform-default
excludes them so newer rows survive) AND tenants with
LONGER retention (platform-default excludes them entirely
so rows aged between platform-cutoff and tenant-cutoff are
PRESERVED — critical for compliance scenarios). Disabled
per-tenant policies fall back to platform-default via the
`enabled = true` subquery filter. Ordering: tenant policies
first, then platform-default — doesn't affect correctness
(NOT IN scopes correctly regardless) but is more intuitive
in the adapter code. No data migration: existing
META_RETENTION_POLICIES rows continue working as platform-
default policies, NOT IN subquery returns empty when no
per-tenant policies exist. 10 new tests in
trace-retention.test.ts: listTenantPolicies SQL shape +
snake-to-camelCase mapping, per-tenant DELETE with
tenant_id+time filter, platform-default DELETE NOT IN
subquery shape, UPDATE on tenant_retention_policies after
prune, skip-disabled, skip-unknown-table for hypothetical
bad row (DB CHECK + adapter both block llm_latency_samples),
previewPrune reports per-tenant + platform counts
independently with NOT IN subquery filtering, multi-tenant
prune with different retention_days, tablesWithTenantId
exposes 2-of-3 (workflow_traces + llm_call_traces, NOT
llm_latency_samples). M6.8.x closes ADR-0144 Q2 +
ADR-0137 Q3+Q4 + ADR-0141 Q3 (four deferred Qs in one
milestone) by adding `resolveDetailed()` to
PostgresCostCeilingResolver. Operators previously saw WHAT
the ceiling was via resolve() — now they see WHY via
resolveDetailed(): the resolution attribution (source +
matched tierId). Returns a structured
CostCeilingResolution with three fields: ceiling
(CostCeiling | undefined as before), source ("override" |
"tier" | "none" — discriminated union), tierId (conditional
string only when source === "tier"). resolve() refactored to
delegate to resolveDetailed() — zero duplication, identical
behavior, legacy callers unchanged. The tier query gains
ONE column (t.tier_id) — additive query change, no schema
change, no breaking change. TypeScript discriminated union
pattern lets operators narrow on source === "tier" and get
tierId as string (not string | undefined). source="none" is
the canonical "no policy at any level" signal — operators
know the router will fall back to its global config.
Operator pain solved: audit clarity (is tenant X's cap from
their tier or an override?), tier migration verification
(did the new tier take effect?), per-tenant debugging (why
is tenant Z still blocked?), dashboard reporting (tier
distribution across tenants). Future enhancement: a
RouterInstrumentation event kind="ceiling_resolved" emitted
automatically from DefaultLlmRouter.enforceCeilingPreflight,
building on this foundation. M6.8.x is the synchronous
foundation; async tracing is additive on top. Rejected
alternatives: emit event instead of method (builds on this),
separate getSourceFor() method (two queries for one fallback
walk), boolean flags (operators infer source), always-
present tierId (redundant checks), include row updated_at
(operator queries tables directly), separate
resolveCeiling+resolveSource (two queries), "global" source
value (resolver doesn't know about router-level config).
10 new tests in cost-ceiling-resolver.test.ts: source=
"override" with per-tenant ceiling, source="tier" with
matched tierId, source="none" with undefined ceiling,
empty-ceiling-object on all-NULL override row, override
precedence (tier query NOT issued), tier query selects
tier_id, NUMERIC precision preserved on tier-source ceiling,
resolve() delegates to resolveDetailed() (same value),
plumbing through resolve() unchanged for legacy callers,
"none" canonical signal. M6.7.zz.dry-run closes ADR-0143 Q4
by adding `previewPrune()` to PostgresTraceRetention. Operator
workflow `preview → review → prune` is now first-class.
Operator pain solved: first-run trepidation (millions of
accumulated rows being deleted cold), policy verification
(did I set the threshold right?), dashboard reporting (how
many rows are pending deletion), CI safety gates (refuse
prune if would-delete-count exceeds a bound). Implementation
mirrors prune() step-by-step but: (a) uses SELECT COUNT(*)
instead of DELETE — read-only; (b) does NOT update
last_pruned_at — preview leaves audit state untouched;
(c) returns distinct RetentionPreviewResult type with
wouldDeleteCount field (not deletedCount) and "previewed"
status enum value (not "pruned") — TypeScript prevents
"meant to prune but called preview" mix-ups at compile
time. Same allowlist + skip semantics as prune (skipped_disabled
+ skipped_unknown_table). Same cutoff computation so
operators sequencing preview → prune get matching counts
(modulo sub-second clock drift in production). PG COUNT(*)
returns BIGINT cast to ::TEXT then parsed via Number()
— same precision pattern as PostgresCostCeilingResolver
+ PostgresLatencyTracker; safely under 2^53-1 for ~285
years at 1M rows/day per table. No schema change, no new
dependencies, pure code addition. Reused REJECTED
alternatives: dryRun: boolean parameter on prune (code
smell + name confusion); reusing RetentionRunResult with
new status (deletedCount field wrong on a preview);
returning actual rows (memory + transport cost); EXPLAIN
estimates (inaccurate). 13 new tests in
trace-retention.test.ts: SELECT COUNT(*) shape for each
of the 3 prunable tables with correct time-column, cutoffMs
threading, NO DELETE issued, NO UPDATE issued,
skip-disabled with status + wouldDeleteCount=0,
skip-unknown-table defensive path, multi-policy preview,
PG BIGINT precision via ::TEXT cast (9_876_543_210 round-
trip), zero-count edge case, empty-policy-list path,
preview+prune same cutoff invariant for same clock. M6.7.z.embed
closes ADR-0141 Q2 by extending RouterInstrumentation to the embed() path. The
complete() path already emitted llm_call_started/completed/
failed events (M6.7.z / ADR-0141); the embed() path was
deferred. Three additive changes: (1)
ROUTER_INSTRUMENTATION_KINDS grows 3 → 6 with
embed_call_started + embed_call_completed +
embed_call_failed. (2) DefaultLlmRouter.embed() wires three
onEvent calls per provider attempt, mirroring complete()
lifecycle: started before fetch with attemptIndex +
totalChoices + inputTextCount attributes; completed on
success with costUsd + tokens + cachedInputTokens +
vectorCount + dim + attempts=1; failed per-provider with
errorKind + errorMessage + willFallback (derived from
remaining choice index). (3) META_LLM_CALL_TRACES.kind CHECK
constraint extended additively to allow the new kinds —
no migration story needed for pre-existing data.
sessionId handling: EmbeddingRequest.sessionId is OPTIONAL
(unlike CompletionRequest.sessionId which is required), so
the embed instrumentation defaults to empty string `""`
when not provided. Empty string is a valid NOT NULL value
that passes PG cleanly and surfaces in audit queries as
"no session set" — alternatives considered: nullable
schema (requires migration), sentinel `<embed-no-session>`
(less standard); chose empty string for migration-free
default. task field is hardcoded to "embedding" on every
embed event (operators filter by task to separate
complete vs embed dashboards). attempts: 1 always since
embed doesn't retry-within-provider (unlike complete()
which wraps in withRetry); fallover produces additional
embed_call_started events for the next provider. Operators
counting "how many providers did this embed call try" count
embed_call_started events with the same (tenantId,
sessionId, occurredAt) correlation window. Same interface
as llm_call_* events (RouterInstrumentationEvent shape
unchanged) — discriminated via the kind enum. PG instrumentation
adapter (PostgresRouterInstrumentation from M6.7.z) handles
the new kinds transparently since the wire format is
unchanged. Three operator workflows unblocked: cost
attribution for embedding-heavy applications (RAG ingest,
semantic search), failure diagnosis for embedding rollouts,
provider comparison for embedding latency. No breaking
change: existing complete-only callers unaffected; new
embed events only flow when operators use embed(). 12 new
tests in router.test.ts: 11 in embed-instrumentation block
(started→completed sequence, field threading, sessionId
fallback to empty string for missing case + reflects
explicit value when provided, started attributes
(attemptIndex/totalChoices/inputTextCount), completed
attributes (costUsd/tokens/vectorCount/attempts),
durationMs null-on-started + non-null-on-completed,
embed_call_failed on non-retryable with willFallback=false,
noop default unchanged, ISO 8601 occurredAt, no-completion-
event-on-failure invariant), 1 in ROUTER_INSTRUMENTATION_KINDS
covering all 6 kinds present + count=6. Crossed the 8K-test
threshold (8003 total). M2.X.5.aa.z.30 adds Bedrock
foundation-model discovery: `getFoundationModel(modelIdentifier)`
+ `listFoundationModels(options?)`. Operators feeding the
CREATE endpoints (inferenceProfile.copyFrom, PT.modelId,
batch.modelId, customizationJob.baseModelIdentifier) need
to know which foundation models are available, what they
support, and which regions expose them. Without substrate-
side discovery, operators drop to AWS Console browsing or
hard-coded model IDs against a static doc reference. Both
drift as AWS releases new models or deprecates old ones.
New foundation-models-api.ts hosts types + builders + parsers.
URI mirrors inference-profiles / PT-inspection: path-based
GET-individual + bare-path list with query filters. Four
enums encode AWS-documented value sets: Modality
(TEXT/IMAGE/EMBEDDING), Customization
(FINE_TUNING/CONTINUED_PRE_TRAINING/DISTILLATION),
InferenceType (ON_DEMAND/PROVISIONED), LifecycleStatus
(ACTIVE/LEGACY). List filters: byCustomizationType,
byInferenceType, byOutputModality, byProvider (length
[1, 256]) — operators find "all Anthropic models", "all
fine-tunable models", "all embedding models", "all PT-capable
models" with one call each. No pagination from AWS (small
model catalog per region; AWS doesn't expose nextToken).
TYPE-ALIAS pattern: BedrockFoundationModelDetail = Summary
(not extended-shape) because AWS returns same fields for
both endpoints. parseFoundationModelDetail defensively
unwraps AWS's {modelDetails: {...}} envelope — handles both
wrapped and flat responses. Strict enum validation on
parser responses: unknown modality/customization/inferenceType/
lifecycle values surface as api_error (loud failure on
undocumented AWS additions). All optional fields preserved
conditionally based on AWS response (no silent default
injection). Bedrock control plane: 22 read + 2 stop + 3
create + 5 delete + 3 tag + 2 update = 37 operations.
Discovery workflows now first-class: PT creation more
reliable (verify model supports PROVISIONED before
calling createPT), inference-profile creation more reliable
(verify foundation model exists before copyFrom), legacy-
model awareness (operators detect modelLifecycle.status ===
LEGACY and plan migrations). No new transport infrastructure
— reuses signedControlPlaneGet. 58 new tests: 40 in
foundation-models-api.test.ts (4 enums × isX predicates,
query builder across 4 filters with rejections, 3 parsers
covering fully-populated + optional-field-omission + all
enum/format rejections + modelDetails envelope unwrap + flat
fallback + non-object/non-array rejections), 18 in
provider.test.ts (GET URL + URI-encoding + Sig v4 headers +
control-plane-not-runtime host + identifier-blank pre-flight
+ detail unwrap behavior + 404/403/parse error propagation
across both methods + filter threading via query string +
429/network errors). M2.X.5.aa.z.29 closes ADR-0147 Q3
+ ADR-0148 Q2 + ADR-0149 Q1 in one operation by adding
`deleteProvisionedModelThroughput(provisionedModelId)`. PT
lifecycle is now 4/4 COMPLETE on the substrate (create from
M2.X.5.aa.z.27 + read from M2.X.5.aa.z.26 + update from
M2.X.5.aa.z.28 + delete this milestone). Single DELETE
endpoint, simple wire shape: DELETE
/provisioned-model-throughput/{id} (singular, matching create
+ update). No pre-flight GET guard — PTs are always
operator-owned (no SYSTEM-vs-APPLICATION distinction like
inference profiles) so no guard needed and no extra round-
trip. Reuses signedControlPlaneDelete transport from
ADR-0136 (no new infrastructure). No mandatory
clientRequestToken — delete doesn't create resources, AWS
doesn't expose token on this endpoint. Interesting AWS-side
semantic surfaces here: 409 ConflictException specifically
when an operator tries to delete a COMMITTED PT mid-
commitment (within the one-month or six-month lock-in
period). Substrate propagates verbatim as conflict_error
with code="ConflictException"; operators handle the
workflow (wait it out, convert via update, or accept the
cost — substrate doesn't try to be clever; AWS rejects
substrate-side "force" anyway). Caller-decided idempotency
via isNotFoundError predicate (same pattern as ADR-0136
delete family). PT ARN stable in get/update/delete since
create. Operator reconciliation workflow now: list →
filter on-demand (no commitment) → delete each → handle
409 on committed → schedule expiry retry. Bedrock control
plane: 20 read + 2 stop + 3 create + 5 delete + 3 tag + 2
update = 35 operations. ADR-0150 marks 150 ADRs since
project bootstrap (124 of them Phase 2 ADR-0047 onward).
11 new tests in provider.test.ts: DELETE URL + URI-encoding
+ Sig v4 headers + control-plane-not-runtime host +
identifier-blank pre-flight + void on 200 + 204 No Content
tolerance + 404 not-found + 409 ConflictException as
conflict_error WITH the committed-mid-commitment context
in the test name and message + 403/429/network errors.
M2.X.5.aa.z.28 closes ADR-0147 Q2
+ ADR-0148 Q1 by adding
`updateProvisionedModelThroughput(provisionedModelId, input)`.
Mid-life PT mutation for model migration OR rename. AWS
contract: PATCH /provisioned-model-throughput/{id} (singular
path matching create); body has two optional fields —
desiredModelId (length [1, 2048]) and desiredProvisionedModelName
(length [1, 63] + slug pattern); at least one must be
provided. Reuses signedControlPlanePatch transport from
ADR-0146 (no new infrastructure). NO mandatory
clientRequestToken — asymmetric from create (ADR-0148):
update doesn't create new resources or extend commitments,
PATCH is naturally idempotent (same body twice = same end
state), and AWS doesn't expose clientRequestToken on this
endpoint anyway. NO pre-flight GET guard: PTs are always
operator-owned (no SYSTEM-vs-APPLICATION distinction like
inference profiles). PATCH semantics — only provided fields
update, omitted fields stay unchanged. Validation order:
identifier blank check → input body builder rejecting empty
input {} → PATCH wire request. After PATCH the PT enters
Updating status with desiredModelArn = target model;
modelArn continues to serve traffic until migration
completes (typically minutes) when AWS atomically sets
modelArn = desiredModelArn and returns the PT to InService.
PT ARN is stable across migration — downstream InvokeModel
calls continue transparently. modelUnits is NOT mutable via
update (AWS doesn't expose it; operators scale via delete +
recreate). commitmentDuration NOT mutable either — operators
convert on-demand to committed via delete + recreate.
Bedrock control plane: 20 read + 2 stop + 3 create + 4
delete + 3 tag + 2 update = 34 operations. Two updates now
on substrate: updateInferenceProfile (ADR-0146) +
updateProvisionedModelThroughput (this). PT lifecycle is
3/4 complete on substrate (create + read + update shipped;
delete remains). 23 new tests: 9 in
provisioned-throughput-api.test.ts (body builder happy paths
for desiredModelId / desiredProvisionedModelName / both,
empty-input rejection, blank/length/pattern rejections,
selective field emission), 14 in provider.test.ts (PATCH
URL + URI-encoding + Sig v4 headers + control-plane-not-
runtime host + body threading for name + modelId +
identifier-blank pre-flight before body builder + empty-
input pre-flight + void on 200 + 404/409/403/429/network
propagation). M2.X.5.aa.z.27 closes ADR-0147 Q1
by adding `createProvisionedModelThroughput(input)` — the
FIRST mutation on PT resources. PT cost weight is 100×-1000×
higher than inference profiles: a one-month committed PT for
claude-3-5-sonnet at 1 model-unit runs ~$5,000/month minimum;
six-month commits lock ~$30K non-cancellable; on-demand PTs
accumulate ~$100/hour. Casual API calls cost more than most
operators' entire monthly LLM bill. The substrate's
guardrail: clientRequestToken is REQUIRED in the input type
(even though AWS docs make it optional). This contract upgrade
forces operators to deliberately mint a token (typically
crypto.randomUUID()) before each create call — trivial for
intentional creates (one-line), prohibitive for casual ones
(typescript error if omitted). Naturally retry-safe: operators
store the token alongside the intent (workflow row, DB record);
retry on failure reuses the same token; AWS dedupes server-
side. This is the FIRST CREATE endpoint in the substrate to
require the token — createBatch (ADR-0108),
createModelCustomizationJob (ADR-0131),
createInferenceProfile (ADR-0142) all leave it optional
because their cost weight is much lower. Boundary validation
in pure buildCreateProvisionedModelThroughputBody enforces 6
documented constraints BEFORE fetch: clientRequestToken
length [1, 256] + pattern ^[a-zA-Z0-9](-*[a-zA-Z0-9])*$,
modelUnits integer [1, 1000] (substrate cap on top of AWS's
higher quota — operators wanting >1000 file a separate
substrate change), provisionedModelName length [1, 63] +
slug pattern, modelId length [1, 2048] (accepts foundation/
custom/imported ARNs or IDs), commitmentDuration must be
"OneMonth" | "SixMonths" if provided (undefined = on-demand
no commit), tags max 200 with per-tag key/value length
checks and index-aware error messages. POST to
/provisioned-model-throughput (singular path; LIST/GET use
plural). Response minimal (provisionedModelArn only);
operators wanting full detail call getProvisionedModelThroughput
next since PT starts in Creating status and reaches InService
after minutes. No auto-token generation (defeats idempotency).
No substrate-side dedup (trust AWS server-side). No commitment
auto-default (operators must explicitly choose). No dryRun /
cost-projection (operators wrap above; AWS doesn't expose it
+ pricing tables drift). No status-polling (operator workflow
concern). Symmetric error propagation 404/409/403/429/402.
Bedrock control plane: 20 read + 2 stop + 3 create + 4 delete
+ 3 tag + 1 update = 33 operations. PT mutation half-done —
create shipped; update + delete remain (easier to add now
that safety pattern is established). 39 new tests: 23 in
provisioned-throughput-api.test.ts (body builder happy path +
optional field threading + 14 boundary-validation rejections
across token/modelUnits/name/modelId/commitmentDuration/tags
+ index-aware tag error messages + response parser), 16 in
provider.test.ts (POST URL + JSON body + Sig v4 headers +
control-plane-not-runtime host + token-blank pre-flight +
modelUnits-zero pre-flight + commitment/tags threading +
404/409/403/429/402 propagation + parse failures + network
errors + idempotent retry semantic where substrate makes
both API calls and AWS dedupes server-side returning the
same ARN). M2.X.5.aa.z.26 adds Bedrock
provisioned-throughput (PT) INSPECTION surfaces:
`getProvisionedModelThroughput(provisionedModelId)` +
`listProvisionedModelThroughputs(options?)`. PTs are paid
dedicated capacity (one-month ~$5K, six-month committed)
backing foundation or custom models. Operators previously
had zero substrate visibility — cost dashboards couldn't
project monthly commitments, reconciliation couldn't find
orphaned PTs leaking $5K-$50K/month each after custom-model
decommissioning, incident response had to drop to AWS
Console. This milestone closes those gaps with read-only
endpoints; mutation (create/update/delete) deliberately
deferred — PT cost per operation is 100×-1000× higher than
inference profiles so creation needs a careful idempotency
+ cost-confirmation story. New provisioned-throughput-api.ts
file hosts types + builders + parsers. AWS contract
preserved verbatim: 4 statuses (Creating / InService /
Updating / Failed), 2 commitment durations (OneMonth /
SixMonths). Three-ARN distinction surfaces clearly:
modelArn (current backing model) vs desiredModelArn (target
after pending update) vs foundationModelArn (foundation
behind any custom variants) — operators reading these
distinguish mid-migration (modelArn !== desiredModelArn)
from steady state. Detail extends summary with optional
failureMessage (only present when status === Failed) for
incident-response context. List filters: statusEquals (find
Failed PTs), modelArnEquals (find PTs for a specific model
= reconciliation primary key), nameContains, sortBy +
sortOrder, maxResults [1, 1000], nextToken. Pure boundary
validation pre-fetch; integer validation on modelUnits
guards against floating-point JSON quirks (rejecting 1.5);
unknown-status surfaces as api_error so undocumented AWS
additions fail loudly. Bedrock control plane: 20 read + 2
stop + 2 create + 4 delete + 3 tag + 1 update = 32
operations. No new transport infrastructure — reuses
signedControlPlaneGet. 58 new tests: 37 in
provisioned-throughput-api.test.ts (enums, query builder
across 8 filter dimensions + boundary rejections, 3 parsers
with required-field + optional-field + integer-validation
+ enum-validation coverage), 21 in provider.test.ts (GET
URL + URI-encoding + Sig v4 headers + control-plane host +
identifier-blank pre-flight + detail return shape +
commitment fields + failureMessage threading + 404/403/parse
propagation across both methods + filter threading via query
+ 429/network errors). M2.X.5.aa.z.25 closes ADR-0142 Q1
by adding `updateInferenceProfile(profileIdentifier, input)`
— the FIRST PATCH operation on the Bedrock control plane.
Operator pain it closes: description drift on existing
APPLICATION profiles. Previously the only path to update
description was delete + recreate, which destroyed the ARN
and broke every downstream reference. Now description is
mutable in-place. AWS contract: PATCH /inference-profiles/{id}
with body {description?: string}. New signedControlPlanePatch
transport mirrors signedControlPlanePost — Sig v4 signing,
content-type application/json, body bytes via TextEncoder.
Validation order (defensive, fail-fast): identifier blank
check → input body builder (rejects empty input `{}` since
"at least one mutable field" must be provided) → pre-flight
GET to verify existence + read type field → APPLICATION-only
guard (mirrors deleteInferenceProfile from ADR-0138; if
type !== "APPLICATION" throws invalid_request_error naming
the profile + type, NEVER issues PATCH) → PATCH wire request.
Description-only by deliberate design (tags have their own
canonical surface from M2.X.5.aa.z.24's tagResource /
untagResource; wiring tags into UpdateInferenceProfile too
would create two paths to the same outcome). PATCH semantics
not PUT (only provided fields update; omitted stays
unchanged). No bypass flag — mandatory guard. No cache —
re-read profile type on every update. Pre-flight cost = 1
extra GET per update; acceptable for operator workflow not
hot path. Race window between GET and PATCH (profile deleted
by another caller): PATCH returns 404, propagated verbatim
as not_found_error — same idempotency-via-isNotFoundError
wrap pattern as ADR-0138 applies. Bedrock control plane: 18
read + 2 stop + 2 create + 4 delete + 3 tag + 1 update = 30
operations. Operator now has FULL APPLICATION lifecycle on
the substrate (create + list + get + update + delete + tag).
PATCH transport reusable for future mutation surfaces
(updateGuardrail if AWS adds one, etc.). 21 new tests: 6 in
inference-profiles-api.test.ts (body builder happy path,
empty-input rejection, blank/length/pattern description
rejection, only-description field emitted), 15 in
provider.test.ts (pre-flight GET then PATCH on APPLICATION,
description threaded into PATCH body, SYSTEM_DEFINED refusal
with NO PATCH issued, guard error message names profile +
type, identifier-blank pre-flight before any GET, empty-input
pre-flight before any GET, identifier-before-input ordering,
ARN URI-encoding both calls, control-plane-not-runtime host,
404 from pre-flight, 404 from PATCH race, 403 from PATCH,
429 from PATCH, void on 200, PATCH content-type +
authorization headers). M2.X.5.aa.z.24 closes ADR-0142 Q2
by adding `tagResource(input)` + `untagResource(input)` +
`listTagsForResource(input)` — the FIRST multi-resource
operations on the Bedrock control plane. Previously every
CREATE method accepted `tags` at creation but operators
couldn't mutate tags post-creation; now they can across every
Bedrock ARN (custom-models + imported-models + guardrails +
inference-profiles + jobs + batches). New tagging-api.ts file
hosts types + builders + parser. AWS contract preserved
verbatim including the WIRE-SHAPE ASYMMETRY (the interesting
part): TagResource POSTs to `/tags?resourceARN={arn}` with
body `{tags:[...]}`, UntagResource POSTs to
`/untag?resourceARN={arn}` with body `{tagKeys:[...]}`,
ListTagsForResource POSTs to `/listTagsForResource` with body
`{resourceARN:"..."}` (note the uppercase ARN in the body!).
AWS doesn't document the reason for the asymmetry but the
substrate doesn't paper over it — operators reading AWS docs
see exactly the same shape they get. signedControlPlanePost
transport extended additively to accept optional query strings
(needed for TagResource + UntagResource); existing callers
unaffected. Pure boundary validation in builders enforces all
documented constraints BEFORE fetch: resourceArn length
[1, 1011] + arn:aws prefix, tag count [1, 200], tag key length
[1, 128] + pattern ^[a-zA-Z0-9\\s_.:/=+@-]*$, tag value length
[0, 256] + same pattern (empty value VALID per AWS contract,
empty key REJECTED), tagKey list count [1, 200]. Error
messages include the index of the bad tag entry for crisp
debugging on 200-tag batches: "invalid tag key at index 2".
BedrockTag is the canonical cross-resource shape; existing
per-resource tag types (BedrockBatchTag,
BedrockInferenceProfileTag, etc.) remain for documentation
clarity since they're structurally identical. Symmetric error
propagation 404→not_found_error / 403→permission_error / 429→
rate_limit_error. Bedrock control plane: 18 read + 2 stop + 2
create + 4 delete + 3 tag = 29 operations. Pattern set for
future cross-resource operations. 53 new tests: 32 in
tagging-api.test.ts (builders for all 3 methods + query
builders + parser with full edge cases including
index-aware error messages, empty tag values valid, 200-tag
boundary), 21 in provider.test.ts (POST URL + query + body
threading + URI encoding + Sig v4 headers + control-plane
host + identifier-blank pre-flight + 404/403/429 propagation +
parse failures + network errors across all 3 methods + the
asymmetry that ListTagsForResource has NO query string).
M6.8 closes ADR-0137 Q2 with a
normalized cost-tier substrate: META_LLM_COST_TIERS (126th)
+ META_LLM_TENANT_TIER_MEMBERSHIPS (127th) + extended
PostgresCostCeilingResolver. Operators with many tenants on a
shared pricing plan previously had to insert N identical rows
into META_LLM_COST_CEILINGS; updating the free-tier policy
required N UPDATEs and was racy. The tier substrate
normalizes: define `free`/`pro`/`enterprise` tiers ONCE, link
tenants via memberships, and adjust tier-wide policy via a
single UPDATE on the tier row that takes effect next request
for every member. META_LLM_COST_TIERS: tier_id TEXT PK
(pattern ^[a-z0-9][a-z0-9_-]{0,63}$ for URL-safe + log-
friendly slugs), display_name, NULLABLE policy columns same
semantics as M6.7.x (NULL = unbounded on that axis),
platform-wide no RLS (tiers are operator-defined policies
not tenant data). META_LLM_TENANT_TIER_MEMBERSHIPS:
tenant_id PK (one tier per tenant — multi-tier resolution
ambiguity blocked at the schema level), tier_id FK with
ON DELETE RESTRICT (a tier can't be deleted while any tenant
references it — forces deliberate migration; CASCADE would
be a footgun silently stripping ceiling protection from all
members), RLS-enabled with TENANT_ISOLATION_USING policy.
Resolver semantic post-M6.8 is three-level fallback: per-
tenant override (M6.7.x semantics preserved — whole-object
override) → tier (whole-object) → global (router constructor
default). Each level wins as a complete CostCeiling, no field-
by-field merge — operator reasoning stays mechanical "tenant
X has policy P, P is the law for that tenant." Field-merge
alternative was considered but rejected because it would
break M6.7.x semantics where NULL means "explicitly unbounded"
(under merge it would mean "fall back to tier"). Implementation:
TWO PG round-trips in the worst case (no per-tenant + no tier
= 2 queries); best case 1 (per-tenant exists, tier lookup
skipped). JOIN-in-one-query alternative rejected because it
forces field-merge OR clutters the SELECT with CASE WHEN
expressions per column. Three operator pains closed: free-tier
policy fan-out (1 UPDATE on the tier row affects all members
vs N UPDATEs on individual ceilings), pricing plan
normalization (tier definitions are O(tiers) rows; memberships
are O(tenants)), per-tenant override expressiveness (a Pro-tier
tenant can still get a custom raise via a row in
META_LLM_COST_CEILINGS that takes precedence over the tier).
8 new tests in cost-ceiling-resolver.test.ts: tier fallback
when no per-tenant row exists, per-tenant precedence (no tier
query issued), undefined when neither exists, JOIN SQL shape
(meta.llm_tenant_tier_memberships INNER JOIN
meta.llm_cost_tiers ON tier_id), tier with NULL fields →
empty ceiling, NUMERIC precision preservation, exactly-one-
query when per-tenant exists, exactly-two-queries when both
absent. M6.7.zz closes ADR-0120 Q5 +
ADR-0140 Q1 + ADR-0141 Q1 in one cross-cutting substrate:
META_RETENTION_POLICIES table (125th) + PostgresTraceRetention
adapter in `@crossengin/kernel-pg`. The three append-only
trace tables shipped over recent milestones —
META_WORKFLOW_TRACES (M8), META_LLM_LATENCY_SAMPLES
(M6.7.y), META_LLM_CALL_TRACES (M6.7.z) — now have a unified
retention story. At 1M LLM calls/day, llm_call_traces adds
~600MB/day after indexes; without retention the substrate
becomes unworkable within months. META_RETENTION_POLICIES
columns: table_name TEXT PK (CHECK IN
('workflow_traces','llm_latency_samples','llm_call_traces')
— the DB rejects unknown values at INSERT time + the
allowlist is the source of truth), retention_days INTEGER
NOT NULL CHECK >= 1 (zero would delete everything immediately
— operators wanting "no retention" disable via enabled
column), enabled BOOLEAN NOT NULL DEFAULT true (kill switch
without losing configured retention), last_pruned_at
TIMESTAMPTZ NULLABLE (NULL = never pruned; audit value),
updated_at TIMESTAMPTZ. No tenant_id, no RLS — retention is
a platform-policy concern (per-tenant retention is a future
Q). PostgresTraceRetention adapter in kernel-pg (most general
home since it operates on meta-schema tables; ai-router-pg
would have created a cross-package dependency for
workflow_traces): listPolicies() returns alphabetically-
ordered policy rows mapped to camelCase API; prune() iterates
policies and for each enabled+known row computes cutoffMs =
clock() - retention_days*86400_000, issues `DELETE FROM
meta.{tableName} WHERE {timeColumn} < to_timestamp($1 /
1000.0)` then updates last_pruned_at; per-policy result
returned with status enum (pruned / skipped_disabled /
skipped_unknown_table) + deletedCount + cutoffMs.
PRUNABLE_TABLES is HARDCODED in the adapter: workflow_traces
→ occurred_at, llm_latency_samples → recorded_at,
llm_call_traces → occurred_at. The hardcoded approach wins on
safety: no SQL injection (table name + column name come from
static map not row data), schema knowledge stays in code
(operators don't need to know `recorded_at` vs `occurred_at`),
defense-in-depth via DB CHECK + adapter allowlist. Adding a
new trace table = update CHECK constraint + add PRUNABLE_TABLES
entry. Adapter is idempotent (re-running prune() finds fewer
rows). Static SQL string assembly even though interpolated —
both table name + column name come from the static map. Clock
injection for testability. No outer transaction across
policies — per-policy autonomy (one prune can succeed while
another fails). 16 new tests in trace-retention.test.ts:
knownPrunableTables exposes the 3 trace tables;
listPolicies SELECTs alphabetically + maps snake-case →
camelCase + empty-array on no rows; prune issues DELETE
against workflow_traces with occurred_at + recorded_at for
latency_samples (not occurred_at) + occurred_at for
call_traces + cutoffMs computed correctly + UPDATE
last_pruned_at + skip-disabled + skip-unknown-table +
multi-policy + zero-deleted-count + default Date.now clock +
no-DELETE-on-no-policies + safety properties (allowlist is
hardcoded). M2.X.5.aa.z.23 closes ADR-0138 Q3
by adding `createInferenceProfile(input)` to BedrockProvider
— the 2nd CREATE on the Bedrock control plane (after
createBatch from M2.X.5.aa.z.6 / ADR-0108 and
createModelCustomizationJob from M2.X.5.aa.z.20 / ADR-0131).
Completes the full APPLICATION-inference-profile lifecycle on
the substrate: create (M2.X.5.aa.z.23 this) + list (M2.X.5.aa.z.9)
+ get (M2.X.5.aa.z.10) + delete (M2.X.5.aa.z.22). AWS contract
faithfully preserved: required fields = inferenceProfileName
(pattern ^([0-9a-zA-Z][_-]?){1,63}$, length [1, 64]) +
modelSource.copyFrom (length [1, 2048] no pattern — accepts
foundation-model ARNs OR system-inference-profile ARNs); optional
fields = description (pattern ^([0-9a-zA-Z][ _-]?)+$, length
[1, 200]), clientRequestToken (pattern ^[a-zA-Z0-9-]+$, length
[1, 256] for AWS idempotency), tags (max 200, per-tag key
length [1, 128] + value length [0, 256]). modelSource is a
structured object (only `copyFrom` variant today) — future AWS
expansion (e.g., hypothetical routingConfig) is an additive
type extension. NO pre-flight guard needed (vs delete which
needs one): AWS only creates type=APPLICATION via this endpoint,
operators can't accidentally create a SYSTEM profile. Response
is minimal — `{inferenceProfileArn, status}`; operators
wanting full detail call getInferenceProfile next.
Boundary validation in pure `buildCreateInferenceProfileBody`
enforces all 8 documented constraints BEFORE fetch (saves
cost + load). Symmetric error propagation: 404 →
not_found_error (copyFrom ARN missing), 409 →
conflict_error (name collision), 403 → permission_error, 429
→ rate_limit_error. clientRequestToken supports AWS's
idempotency contract: repeated POSTs with same token return
same ARN without re-creating. 34 new tests: 19 in
inference-profiles-api.test.ts (body shape happy path,
optional-field threading, all 8 boundary-validation rejections
across name + copyFrom + description + clientRequestToken +
tags-count + tag-key-length + tag-value-length + empty-tag-key,
response parsing happy + unknown status + missing arn +
non-object), 15 in provider.test.ts (POST shape + JSON body +
URL + headers + Sig v4, body bytes contain required fields,
returns parsed shape, control-plane-not-runtime host,
identifier-blank pre-flight × 2 cases, 409/404/403/429 error
propagation, optional fields thread through, parse failure as
api_error, network errors). Bedrock control plane: 18 read +
2 stop + 2 create + 4 delete = 26 operations. M6.7.z adds the
FOURTH ai-router-
pg substrate: `RouterInstrumentation` interface +
META_LLM_CALL_TRACES table (124th) +
PostgresRouterInstrumentation adapter. Closes three deferred
Qs in one milestone: ADR-0135 Q2 (router-scoped
instrumentation), ADR-0137 Q3+Q4 (ceiling audit + observability),
ADR-0140 Q3 (per-LLM-call trace rail). Pattern parity with M8
WorkflowInstrumentation — same onEvent(event):
Promise<void>|void signature, same captureRouterInstrumentation()
+ combineRouterInstrumentations() helpers, same
NoopRouterInstrumentation default (no behavior change for
existing callers — wiring is opt-in). Three event kinds:
llm_call_started (before fetch after preflight; attrs:
attemptIndex, totalChoices), llm_call_completed (on success;
attrs: costUsd, inputTokens, outputTokens, cachedInputTokens,
attempts), llm_call_failed (per-provider failure; attrs:
errorKind, errorMessage, attempts, willFallback — derived
from remaining choices at emit time so terminal short-
circuits from ADR-0091/0133/0134 show willFallback=false).
Per-attempt granularity — a complete() with fallover emits
2N events for N attempts; matches operator mental model "what
happened at each step?". Event sequences documented:
happy path (started→completed), fallover (started→failed→
started→completed), terminal non-retryable (started→failed
willFallback=false), all-exhausted (full chain ending with
AllProvidersExhaustedError). META_LLM_CALL_TRACES table:
audit-optimized (vs LATENCY_SAMPLES which is aggregation-
optimized) — full event context (tenant, session, task,
model, costUsd, tokens, errors), JSONB attributes for
flexibility, tenant-scoped with RLS_ISOLATION, three indexes
serving the three canonical operator queries — (tenant_id,
occurred_at) for "tenant recent activity", (provider_id,
kind, occurred_at) for "anthropic failures last hour",
(tenant_id, session_id) for "session audit trail
reconstruction". Distinct from LATENCY_SAMPLES on purpose:
different read patterns deserve different schemas — single
mega-table would have aggregations scan-and-decode large
rows + audits compete with high-volume sample writes.
PostgresRouterInstrumentation: single INSERT per onEvent,
no batching/buffering, mirrors PostgresWorkflowInstrumentation
verbatim. ai-router-pg adapter set now has 4 substrates:
cost-windows (M6.7), cost-ceilings (M6.7.x), latency-samples
(M6.7.y), call-traces (M6.7.z) — router is fully observable.
Append-only — retention is a future milestone (~M6.7.z.1
covering all three append-only trace surfaces uniformly).
Storage ~200 bytes/row → 1M calls/day = ~600MB/day after
indexes; PG-native partitioning is operator-side concern.
21 new tests: 11 in router.test.ts (started→completed
sequence on happy path, full event field threading, costUsd
+ token attributes on completed, durationMs null-on-started
+ non-null-on-completed, failed with willFallback=true on
retryable+fallback, full started/failed/started/completed
on fallover, willFallback=false on terminal AllProvidersExhausted,
ISO 8601 occurredAt, noop default behavior unchanged,
attemptIndex 0→1 across chain, non-retryable→willFallback=false),
10 in router-instrumentation.test.ts (INSERT shape, 9-column
param order, completed with cost+tokens, failed with
error+willFallback, JSONB attribute serialization, null
durationMs threading, verbatim ISO 8601, no batching/single
INSERT per event, PG error propagation, contract compat).
M6.7.y completes the ai-router-pg
adapter set by adding `PostgresLatencyTracker` — the third
and final persistable tracker (after PostgresCostTracker
from M6.7 and PostgresCostCeilingResolver from M6.7.x).
Three changes: (1) `LatencyTracker` interface becomes
async — both `record()` and `stats()` now return Promises.
Internal-only breaking change since the only consumer is
DefaultLlmRouter (two await sites added) plus
InMemoryLatencyTracker (mechanical async signature
upgrade). Fire-and-forget alternative was considered but
rejected: silent failures, unbounded queue if PG degraded,
inconsistency with the already-async CostTracker contract.
1ms PG INSERT overhead per LLM request is negligible
compared to LLM call duration. (2) META_LLM_LATENCY_SAMPLES
as the 123rd meta-schema table — append-only sample log,
PK on uuid_generate_v7() id, indexed (provider_id,
recorded_at), latency_ms >= 0 CHECK, NO tenant scoping
(provider-level observability, not per-tenant) and NO RLS
(platform-wide table same pattern as META_TENANTS).
(3) PostgresLatencyTracker in `@crossengin/ai-router-pg` —
record() does single INSERT; stats() does single windowed
SELECT with a CTE limiting to N most recent samples then
aggregating via PG's native percentile_cont. Index-only
scans handle "last 100 anthropic samples" in microseconds
even at millions of rows. Returns same LatencyStats shape
as InMemoryLatencyTracker. percentile_cont is continuous
interpolation; differs from in-memory's floor-index
selection only at tiny window sizes (observably nil at
window>=20). The ai-router-pg adapter set is now complete:
3 substrates (cost-windows from M6.7, cost-ceilings from
M6.7.x, latency-samples from M6.7.y). Operators wiring an
ai-router for multi-replica deployments have a fully-
persistent stack. Operator dashboards can answer "what's
anthropic's p95 over the last hour?" with a single SELECT
on meta.llm_latency_samples — `SELECT provider_id,
percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)
AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY
latency_ms) AS p95 FROM meta.llm_latency_samples WHERE
recorded_at > now() - INTERVAL '1 hour' GROUP BY
provider_id;`. 12 new tests in latency-tracker.test.ts
covering record (INSERT shape + params + success boolean),
stats (zero on empty, parsed when populated, windowed
SELECT shape, default windowSize=100, percentile_cont
syntax, NULL-percentile handling, provider filter, FILTER
aggregates, provider isolation), and LatencyTracker
contract compat (drop-in for the async ai-router
interface). M5.11 adds `--max-cost-usd $X` to
`crossengin chat` — a session-scoped post-hoc cumulative
budget cap. Independent from `--cost-ceiling-usd` (which
remains the per-request gate via router preflight); both
can coexist. Enforcement lives entirely in the REPL loop
(not router) for three reasons: (a) router's preflight uses
ESTIMATED cost while session budget needs REAL cost; (b)
router is provider-orchestration but session budget is CLI-
state, separation of concerns; (c) `maxUsdPerWindow` would
require fake-long windowSeconds — code smell. Check fires at
TOP of each REPL while-iteration BEFORE consuming the next
input line: if aggregate.cost >= maxCostUsd, emit
budget_exceeded announcement and break. Implications: the
LAST turn that pushes cumulative cost over the budget IS
allowed to complete (cost observed AFTER response streams);
NEXT input is refused — matches "give me one more answer,
then stop" UX. One-shot mode (single turn): budget check
fires AFTER the turn since there's no next iteration;
result.budgetExceeded surfaces informationally. Display
surfaces: human mode shows "Session budget: $X.XXXX USD."
header, "[budget: $Y.YYYY of $X.XXXX spent]" line after
each turn, "[session budget exceeded: $Y spent, $X budget —
exiting]" notice on exhaustion. JSON mode emits
{kind:"budget_exceeded",spent_usd,budget_usd} chunk on
exit. ChatReplResult.budgetExceeded?: boolean surfaces on
programmatic returns + JSON output. Validation: parse as
finite positive number; exit 2 on bad value. Exit 0 on
budget exhaustion (the session ran successfully; budget
honored — operators wanting hard-failure check the flag).
No breaking change: existing callers without the flag see
identical behavior. CLI flag is the client-side complement
to M6.7 (server-side PostgresCostTracker) + M6.7.x (server-
side per-tenant ceilings) — both substrates remain, neither
duplicates. 11 new tests: 9 in chat.test.ts (REPL refuses
subsequent input after budget crossed + 3-input/2-response
scenario, under-spend doesn't set flag, human header, human
per-turn line, human exit notice, JSON budget_exceeded
chunk, no-budget legacy behavior unchanged, one-shot
over/under-budget flag presence/absence), 2 in
commands.test.ts (--max-cost-usd=-1 exits 2 with clear
error, valid positive value runs the turn). M2.X.5.aa.z.22
closes ADR-0136 Q2
by adding `deleteInferenceProfile(profileIdentifier)` to
BedrockProvider — the 4th DELETE on the Bedrock control
plane and the first "smart" delete with a mandatory pre-
flight guard. The Bedrock `inference-profiles` namespace
contains TWO kinds of resources sharing the same URI path:
type=APPLICATION (operator-created + operator-deletable) and
type=SYSTEM_DEFINED (AWS-owned + immutable). A blind DELETE
on a system profile yields an opaque ValidationException
from AWS. The substrate does better: deleteInferenceProfile
runs a mandatory pre-flight `getInferenceProfile` (serving
three purposes simultaneously: existence check via 404 →
not_found_error, GET-permission check via 403 →
permission_error, and reading the `type` field for the
guard). If type !== "APPLICATION", throws
invalid_request_error with a message naming the profile +
type — NEVER issues DELETE. If type === "APPLICATION",
issues DELETE via the shared signedControlPlaneDelete
(ADR-0136). No bypass flag (substrate can't override AWS;
mandatory guard is contract). No type-from-caller (would be
a footgun — pre-flight reads ground truth). No cache (rare
operation; PG-style read every time). Pre-flight cost: 1
extra GET per delete — acceptable on a DELETE operator
action, would be expensive in a hot path. Race window
between GET and DELETE (profile deleted by another caller):
DELETE returns 404 → propagates verbatim as
not_found_error; same idempotency-via-isNotFoundError wrap
pattern as ADR-0136 applies. Bedrock control plane now has
18 read + 2 stop + 1 create + 4 delete = 25 operations.
Pre-flight-guard pattern established for future "two-typed"
resources where the same URI handles AWS-owned and
operator-owned resources. 13 new tests in provider.test.ts:
APPLICATION happy path (GET then DELETE), SYSTEM_DEFINED
refusal (NO DELETE issued), guard error message names
profile + type, ARN URI-encoding on both calls, control-
plane host, identifier-blank pre-flight (before any GET),
404 / 403 from pre-flight GET, 404 / 403 / 429 / 409 from
DELETE, 204 success. Uses a new sequencedFetch test helper
that discriminates on init.method. M6.7.x closes ADR-0135
Q1 + Q4 in
one milestone: per-tenant cost ceiling configuration as data
rather than code. Three additive changes: (1)
META_LLM_COST_CEILINGS as the 122nd meta-schema table with
columns (tenant_id, max_usd_per_request, max_usd_per_window,
window_seconds, effective_from, updated_at) — one row per
tenant, PK on tenant_id (UPSERT semantics matching
META_LLM_COST_WINDOWS), policy columns NULLABLE so NULL
means "no limit on this axis", NUMERIC(18,8) precision,
positive-value CHECK constraints, RLS tenant-isolated; (2)
new `getTenantCostCeiling?: (tenantId) =>
Promise<CostCeiling | undefined>` field on
DefaultLlmRouterOptions — when wired the router calls it
per-request and uses the result if defined, falls back to
the global `costCeiling` otherwise; resolution rule is
WHOLE-OBJECT OVERRIDE (tenant ceiling REPLACES global, not
merges — matches operator intent "this tenant's policy is
P"); (3) PostgresCostCeilingResolver in
`@crossengin/ai-router-pg` — drop-in for getTenantCostCeiling
via `resolver.resolve`; single SELECT keyed by tenant_id;
NULL columns map to omitted CostCeiling fields; ::TEXT cast
preserves sub-cent NUMERIC precision. No breaking change:
existing callers with global ceiling only continue working.
Schema is forward-compatible with history-aware reads
(effective_from already in place). 16 new tests: 7 in
router.test.ts (tenant-scoped resolution, fallback to
global, tighter override, looser override, tenantId
threading, no-ceiling flow, asymmetric ceiling), 9 in
cost-ceiling-resolver.test.ts (undefined on no row, full
ceiling shape, individual NULL field omission for each of
the three policy columns, all-NULL empty ceiling, SQL
shape, NUMERIC precision preservation). Four operator pains
closed: restart-required-to-change-ceiling, no-free-tier-vs-
enterprise-gating, trial-customer-overspend, compliance-air-
gap-by-budget. M2.X.5.aa.z.21 ships the FIRST
DELETE write surfaces on the Bedrock control plane:
`deleteCustomModel(modelIdentifier)`, `deleteImportedModel(
modelIdentifier)`, `deleteGuardrail(guardrailIdentifier,
guardrailVersion?)`. New shared `signedControlPlaneDelete`
transport (DELETE variant of GET; query optional; empty body;
Sig v4 signed via existing signRequest). The three methods
follow the established pattern: validate identifier
non-empty BEFORE fetch (saves cost + load), URI-encode the
identifier path segment (handles `:` in ARNs), control-plane
host only (not bedrock-runtime), return void on any 2xx
(200, 202, 204), propagate 404 as not_found_error
VERBATIM (caller decides idempotency — the router short-
circuit (M6.6.y) handles automated lifecycle pipelines and
operators wanting silent idempotency wrap in a 3-line try/
catch `isNotFoundError` predicate; the reverse — provider-
swallowed 404 with caller needing the signal — is
impossible to reverse), 409 → conflict_error (in-use
resource — provisioned throughput attached, guardrail used
by application), 403 → permission_error, 429 →
rate_limit_error. deleteGuardrail carries optional
guardrailVersion (omit = delete whole guardrail / all
versions; provide = delete that specific version — matches
AWS semantics; symmetric with getGuardrail's optional
version parameter). 28 new tests in provider.test.ts cover
URL shape + DELETE method + ARN URI-encoding + control-
plane host + identifier-blank pre-flight + 204 success +
404 / 409 / 403 / 429 / network propagation across all
three deletes. Three operator workflows unblocked: post-
fine-tune custom-model cleanup, rejected-upload imported-
model removal, deprecated-guardrail retirement. Bedrock
control plane now has 18 read + 2 stop + 1 create + 3
delete = 24 operations. M6.7 ships the first persisted
ai-router substrate: `@crossengin/ai-router-pg` package with
`PostgresCostTracker` (drop-in replacement for
`InMemoryCostTracker` against the same `CostTracker` interface)
+ `META_LLM_COST_WINDOWS` (121st meta-schema table — one row
per tenant, natural PK on tenant_id, NUMERIC(18,8) cost
column, RLS tenant-isolated). Closes ADR-0059's deferred
cost-tracker persistence Q. Single-row-per-tenant tumbling
window matches the in-memory contract exactly: when the
first request arrives after the window expires, the window
resets to "now"; concurrent recordUsage calls from multiple
gateway replicas safely increment via atomic UPSERT (ON
CONFLICT DO UPDATE with a CASE clause that decides
reset-vs-increment entirely in SQL — single round-trip,
race-free). TS-side clock injection for testability (same
shape as InMemoryCostTracker). checkCeiling logic identical
to InMemoryCostTracker: per-request gate first (no DB hit
when over per-request cap), window gate second (one SELECT).
NUMERIC(18,8) precision preserved via ::TEXT cast + Number()
parse on read. Three workflows unblocked: multi-replica
gateway cost enforcement (was 3× over-spend before), cross-
restart durability (was zeroed on recycle), operator
observability via `SELECT * FROM meta.llm_cost_windows`.
Established X / X-pg pattern preserved (kernel/kernel-pg,
workflow-runtime/workflow-runtime-pg, api-gateway-runtime/
api-gateway-pg, ai-architect/ai-architect-pg, now ai-router/
ai-router-pg). 18 new tests in cost-tracker.test.ts cover
getWindow (5 — null + within-window + expired + boundary +
tenant filter), recordUsage (5 — UPSERT shape + param
threading + clock injection + default window + CASE branch
shape), checkCeiling (6 — per-request + no-window-cap + within
+ exceeded + expired-window + per-request-first-gate), and
2 InMemory-parity tests (NUMERIC string round-trip + shape
match). M6.6.y extends the ai-router's
retry / fallback short-circuit list with isNotFoundError —
closes ADR-0133 Q1, the deferred Q from M6.6.x. One-line
change in `isRouterRetryable` (router.ts): not-found errors
(HTTP 404) join moderation + conflict as terminal — no
provider-level retry, no fallback-provider attempt. Semantic:
not-found means "identifier doesn't resolve (or this
principal can't see it)"; retrying with the same identifier
always fails the same way; switching to a different provider
can't help either (identifiers are provider-scoped — an
OpenAI file_id is not an Anthropic file ID is not a Bedrock
ARN; re-issuing against a different provider can't succeed).
Preserves the original error verbatim (kind +
status === 404). Existing behavior on every other error
class unchanged — rate_limit still falls over, moderation
and conflict still early-exit separately, invalid_request
still propagates as before. Three classifiers now short-
circuit: moderation (M6.6), conflict (M6.6.x), not-found
(M6.6.y). 5 new tests in router.test.ts validate the not-
found early-exit (fallback bypass + no-retry + error
preservation + distinct-from-conflict + rate_limit fallback
preserved). M6.6.x extends the ai-router's
retry / fallback short-circuit list with isConflictError —
closes ADR-0118 Q2, the deferred Q from M2.X.12. One-line
change in `isRouterRetryable` (router.ts): conflict errors
(HTTP 409) join moderation errors as terminal — no
provider-level retry, no fallback-provider attempt. Semantic:
conflict means "resource is in incompatible state"; retrying
with the same input always fails the same way; switching to
a different provider doesn't help (the conflict lives on the
operator's resource state, not the provider's availability).
Preserves the original error verbatim (kind +
status === 409 + code === "ConflictException"). Existing
behavior on every other error class unchanged — rate_limit
still falls over, moderation still early-exits separately,
invalid_request still propagates as before. Pattern set for
future classifier short-circuits: each future short-circuit
gets its own ADR with documented semantics — no lump-add. 5
new tests in router.test.ts validate the conflict early-exit
+ preserve the rate_limit fallback path. M8.1 adds activity execution
instrumentation to the workflow runtime — closes ADR-0120
Q3, the longest-outstanding deferred Q from the M8 milestone.
WORKFLOW_INSTRUMENTATION_KINDS grows from 11 → 14 with three
new event kinds: activity_started (fires before the
event-log row append; captures activityStartedAt timestamp
for duration tracking), activity_completed (fires after
handler returns success outcome; populates durationMs =
clock.now() - activityStartedAt + activityId / activityKey /
activityKind attributes), activity_failed (fires after
handler returns failed outcome OR throws an uncaught
exception; populates durationMs + errorCode + errorMessage +
retryable attributes). Three new emit calls land in the
existing applyScheduleActivity method; no new transport, no
new types. META_WORKFLOW_TRACES.kind CHECK constraint
extended additively to allow the three new kinds. Same shape
as M8's existing instrumentation events (kind + tenantId +
instanceId + definitionId + correlationId + occurredAt +
durationMs + attributes). Instrumentation fires BEFORE the
corresponding event-log append — consistent with M8's
pattern. Handler-exception path covered: both `return {
status: "failed" }` (operator-controlled failure) and
`throw new Error(...)` (uncaught) surface activity_failed
with the error context. Three workflows unblocked: activity
latency dashboards (p50/p95/p99 via durationMs aggregation
queries), activity failure alerting (errorCode +
errorMessage + retryable on a single trace event), per-
activity-kind cost attribution rail ready for M6.7
PostgresCostTracker. M2.X.5.aa.z.20 closes the
customization-job CRUD with
`BedrockProvider.createModelCustomizationJob(input)` —
LARGEST write surface remaining on Bedrock's control plane.
After M2.X.5.aa.z.17/.18/.19 shipped list + get + stop, this
milestone adds programmatic fine-tune submission. New
`buildCreateModelCustomizationJobBody(input)` pure boundary-
validator enforces 12+ documented AWS constraints BEFORE any
fetch: jobName + customModelName pattern + length [1, 63];
roleArn AWS-partition-aware IAM regex; baseModelIdentifier
length [1, 2048] (no pattern — AWS accepts foundation model
IDs / ARNs / inference profile IDs); s3Uri scheme
^s3://[a-z0-9.\-_]{1,255}/.* on both training + output +
validator URIs; hyperParameters object of string→string
(per-value typeof check); clientRequestToken shape + length
[1, 256]; customModelTags + jobTags count ≤ 200 + key length
[1, 128] + value length [0, 256]; validationDataConfig.
validators count ≤ 10; vpcConfig.subnetIds +
securityGroupIds counts in [1, 16]. All ARN patterns
AWS-partition-aware (aws, aws-us-gov, aws-cn).
`parseCreateModelCustomizationJobResponse(raw)` is strict —
{jobArn} only; missing / empty / non-string throws api_error.
AWS contract preservation: `customModelKmsKeyId` (NOT
KmsKeyArn) per CreateModelCustomizationJob docs; field-naming
asymmetry vs get (outputModelName ≠ customModelName)
preserved verbatim from M2.X.5.aa.z.18. Reuses 5 sub-types
from M2.X.5.aa.z.18 (S3Config / ValidationDataConfig /
VpcConfig / CustomizationConfig / Validator) + adds new
BedrockModelCustomizationJobTag = {key, value}. Bedrock
control-plane surface now has 18 of N operations
(customization CRUD complete). Three workflows unblocked:
programmatic fine-tune submission (CI-driven training
pipelines), automated retry-on-failure flows (catch +
re-submit with adjusted hyperparameters), distillation
lineage capture (teacher model + max response length
recorded with the job). M2.X.16 lifts the EIGHTH
cross-provider error classifier and COMPLETES the canonical
4xx/5xx classifier sweep — `isInvalidRequestError(err)` in
`@crossengin/ai-providers/invalid-request.ts`. Closes ADR-0129
Q1 mechanically. All three providers emit
`invalid_request_error` from classifyHttpStatus(400); Bedrock
additionally maps `ValidationException` via CODE_TO_KIND;
OpenAI maps via TYPE_TO_KIND. Zero provider changes.
Structurally identical to permission.ts (M2.X.15). Single-kind
tuple. Explicitly distinct from request_too_large: 400 =
structural problem (missing field, bad type, out-of-range) →
fix shape; 413 = correct shape but oversized payload → reduce
input. Canonical 4xx sweep coverage map: 400 invalid_request
+ 401 authentication + 403 permission + 404 not_found + 408
timeout (via retryable) + 409 conflict + 413 request_too_large
+ 429 rate_limit (via retryable) + 503/529 overloaded (via
retryable) + ≥500 api_error (via retryable). Moderation
kinds + network errors covered by their dedicated
classifiers. Coverage is COMPLETE — every documented kernel
error kind across all three providers maps to at least one of
the eight classifiers. New mutual-exclusivity test asserts an
`invalid_request_error` matches exactly ONE classifier
(itself) — verifying the suite remains partitioned. Three
workflow patterns enabled: CI kernel-validation tests
(assert isInvalidRequestError on malformed requests),
auto-fix workflows for LLM-generated requests (re-prompt with
error feedback when isInvalidRequestError fires), user-facing
error translation (8-way dispatch documented in ADR-0130).
M2.X.15 lifts the SEVENTH
cross-provider error classifier — `isPermissionError(err)`
in `@crossengin/ai-providers/permission.ts`. Closes ADR-0128
Q1 mechanically. All three providers emit `permission_error`
(Anthropic + OpenAI via classifyHttpStatus(403); Bedrock via
CODE_TO_KIND["AccessDeniedException"] → permission_error —
Bedrock's classifyHttpStatus collapses 401||403 to
authentication_error broadly, the typed-exception path
provides finer detail). Zero provider changes. Structurally
identical to authentication.ts (M2.X.14). Single-kind tuple
(`permission_error` only). Explicitly distinct from
authentication_error: 401 = bad credentials → rotate;
403 = valid credentials, no access → grant principal access
or use different principal. Operators wanting "any
auth-related" compose
`isAuthenticationError(err) || isPermissionError(err)`
inline (the canonical pattern documented in the test file
itself). Three workflow patterns enabled: cross-account /
cross-tenant access denial handling (translate to
TenantAccessDeniedError with structured tenant-facing
message), multi-region access policies (inference profile
routing through a region the operator lacks access to),
resource-scoped access (guardrail / custom-model /
inference-profile created in account A is 403 to account B).
M2.X.14 lifts the SIXTH
cross-provider error classifier to the kernel —
`isAuthenticationError(err)` in
`@crossengin/ai-providers/authentication.ts`. Closes ADR-0127
Q1 mechanically. All three providers (Anthropic, OpenAI,
Bedrock) already emit `authentication_error` from
`classifyHttpStatus(401)`; Bedrock additionally maps
ExpiredTokenException / InvalidSignatureException /
MissingAuthenticationTokenException / UnrecognizedClientException
via CODE_TO_KIND. The kind is wired everywhere — this
milestone adds the kernel-level predicate. Zero provider
changes required. Structurally identical to the prior five
classifiers (M2.X.6.x / M2.X.7 / M2.X.9 / M2.X.12 / M2.X.13):
AUTHENTICATION_ERROR_KINDS tuple + isAuthenticationErrorKind
predicate + isAuthenticationError(err) duck-typed
discriminator on .kind. Single-kind tuple (authentication_error
only). Explicitly EXCLUDES permission_error (HTTP 403 vs 401
have distinct remediation paths — auth = rotate credentials,
permission = grant access or use different principal);
operators wanting both compose isAuthenticationError(err) ||
isPermissionError(err). Three workflow patterns documented:
credential rotation flow (catch + refresh + retry),
multi-tenant key validation at request boundary (translate
to TenantKeyInvalidError with structured message), CI boot-
time credential check (fail loud rather than burying in
generic exception). isPermissionError (HTTP 403) is the next
mechanical lift, called out as Q1 in ADR-0128. M2.X.13 lifts
the FIFTH
cross-provider error classifier to the kernel —
`isNotFoundError(err)` in
`@crossengin/ai-providers/not-found.ts`. All three providers
(Anthropic, OpenAI, Bedrock) already emit `not_found_error`
from their `classifyHttpStatus(404)` paths; this milestone
adds the kernel-level predicate so operators can write
provider-agnostic `catch` blocks. Zero provider changes
required — the kind was already wired everywhere; only the
kernel module is new. Structurally identical to the prior
four classifiers (`isModerationError` M2.X.6.x,
`isRetryableError` M2.X.7, `isInputTooLargeError` M2.X.9,
`isConflictError` M2.X.12): `NOT_FOUND_ERROR_KINDS` tuple +
`isNotFoundErrorKind` predicate + `isNotFoundError(err)`
duck-typed discriminator on `.kind`. Single-kind tuple
(`not_found_error`); future variants extend additively. The
kernel error-space partition now has five buckets: retryable
(try again with backoff), moderation (terminal; audit),
input-too-large (terminal; reduce input), conflict (terminal;
reconcile state), not-found (terminal; resource absence —
NEW), other (auth / permission / invalid_request / unknown).
Pattern fully mature across five classifiers. Idempotent
cleanup workflows now have a documented cross-provider
pattern: `catch (err) { if (!isNotFoundError(err)) throw err }`.
M2.X.11.x wires `cacheBreakpoint`
through the Bedrock Converse translator (the deferred Q1 from
ADR-0125). Single-line change in
`@crossengin/ai-providers-bedrock/converse-api.ts`
appendKernelBlocks loop: after emitting each translated block,
if the kernel block carries cacheBreakpoint, append the shared
BEDROCK_CACHE_POINT constant
({cachePoint: {type: "default"}}). The supporting
infrastructure (BedrockCachePointBlock type,
BEDROCK_CACHE_POINT constant, isCachePointBlock discriminator)
was pre-built in M2.9 — this milestone is the call site that
finally uses them. Vocabulary asymmetry preserved: kernel uses
"ephemeral" (matching Anthropic-first naming); Bedrock wire
uses "default" (only documented value); translator maps
ephemeral → default verbatim. Cross-provider parity achieved
across Anthropic + Bedrock for the cacheBreakpoint field;
OpenAI continues to silently drop (no per-block knob in their
API). All four prior M2.X.5.* multimodal block variants
(image / document / file_id / tool_use) benefit end-to-end on
Bedrock now. Pure translator change — no new types, no new
transport, no kernel API change. Tool-role messages don't yet
preserve cacheBreakpoint (existing translator flattens to
string via contentToText) — Q1 deferred. M2.X.11 adds a
`cacheBreakpoint?:
LlmCacheBreakpoint` optional field on every LlmContentBlock
variant (text / image / image_url / document / document_url /
file_id / tool_use / tool_result — all 8 schemas extended).
`LlmCacheBreakpoint` is a `{type: "ephemeral"}` shape;
LLM_CACHE_BREAKPOINT_TYPES is a single-value const tuple
(future Anthropic extensions like persistent or named-key
caching extend the tuple without breaking call sites). Wired
through the Anthropic translator: `translateKernelBlock`
refactored to call `translateKernelBlockShape` then
post-process via `withCacheControl` that shallow-spreads
`cache_control: {type: "ephemeral"}` when the kernel field
is present. AnthropicContentBlock union widened — every
variant gains an optional cache_control field; new
AnthropicCacheControl type alias exported. OpenAI translators
(chat-api + responses-api) silently drop the field (OpenAI
handles caching implicitly via prefix-stability heuristics;
no per-block knob). Bedrock translator silently drops for
now (Bedrock Converse uses a SEPARATE `{cachePoint: {type:
"default"}}` BLOCK type — structurally different wire shape;
future M2.X.11.x can wire). Token economics: operators with
long-context chat workloads (10k+ tokens repeated across
turns) see ~10x input-cost reduction on cache hits via
Anthropic. Three patterns enabled: long static context
(document block at start of every turn marked cached),
multi-turn tool sessions (tool_result of expensive search
cached for subsequent turns), few-shot prefixes (final
example block cached so variant inputs hit cache). All
existing tests pass without modification. M2.X.5.aa.z.19 ships
`BedrockProvider.stopModelCustomizationJob(jobIdentifier)` —
the operator-initiated abort surface paired with
M2.X.5.aa.z.17/.18's read pair (the Stopping/Stopped statuses
in the 5-value tuple now have a programmatic trigger). Pure
reuse of established rails — POST endpoint via
signedControlPlanePost (M2.X.5.aa.z.5) with empty body;
URI-encoded path /model-customization-jobs/{encoded}/stop;
returns void on success. No new types / modules / transport.
Error mapping: 200 → resolve, 400 ValidationException →
invalid_request_error, 403 AccessDeniedException →
permission_error, 404 ResourceNotFoundException →
not_found_error, 409 ConflictException → conflict_error
(via M2.X.12's CODE_TO_KIND mapping; THIRD Bedrock endpoint
emitting 409 — isConflictError classifier is now load-bearing
across stopBatch + createBatch + stopModelCustomizationJob),
429 ThrottlingException → rate_limit_error. Three operational
workflows unblocked: cost-runaway kill switches for fine-tunes
(detect long-running InProgress → stop), tenant-offboarding
fine-tune cancellation sweeps (paired with
listModelCustomizationJobs({nameContains}) + status filter),
compliance kill switches (new policy lands → stop in-flight
fine-tunes that may violate it). Bedrock control-plane surface
now has 17 of N operations. Customization-job read+write
surface is feature-equivalent to batch surface (M2.X.5.aa.z.3
shipped batch list/get/stop/create; this milestone closes the
equivalent stop for customization jobs).
M2.X.5.aa.z.18 ships
`BedrockProvider.getModelCustomizationJob(jobIdentifier)` —
the rich-detail companion to listModelCustomizationJobs
(M2.X.5.aa.z.17). Fifth extended-shape detail instance after
Guardrail (M2.X.5.aa.z.8) / ImportedModel (M2.X.5.aa.z.12) /
CustomModel (M2.X.5.aa.z.14) / ModelImportJob
(M2.X.5.aa.z.16). Pattern now fully mature across 5 AWS
resource types. Structurally analogous to getCustomModel:
9 required top-level fields (jobArn / jobName /
outputModelName / roleArn / status / creationTime /
baseModelArn / trainingDataConfig / outputDataConfig) +
13 optional. Eight new typed sub-shapes in
`model-customization-jobs-api.ts`:
BedrockModelCustomizationJobS3Config, Validator,
ValidationDataConfig, TrainingMetrics, ValidationMetric,
VpcConfig, TeacherModelConfig, DistillationConfig,
CustomizationConfig — structurally mirror the
BedrockCustomModel* types from M2.X.5.aa.z.14 but typed
under their own prefix (AWS-contract preservation; if AWS
diverges them later, no shared-type refactor needed).
parseModelCustomizationJobDetail validates 9 required fields,
reuses isBedrockModelCustomizationJobStatus discriminator
from M2.X.5.aa.z.17 (5-value tuple including Stopping /
Stopped), enforces hyperParameters as Record<string, string>
matching AWS wire contract, validates trainingLoss +
validationLoss as finite numbers (NaN/Infinity throw),
validates VPC arrays of strings. Field-naming asymmetry vs
summary preserved verbatim: summary uses customModelArn /
customModelName (populated post-success); detail uses
outputModelName (required — operator's requested name) +
outputModelArn (optional — populated post-success).
Operators map between them at the application layer.
Provider validates identifier non-empty BEFORE fetch,
URI-encodes path, reuses signedControlPlaneGet rail. Bedrock
control-plane surface now has 16 of N operations; module
count unchanged at 16. Customization-job read story complete
(list + get). Five extended-shape detail instances now in
place — pattern is extremely stable. M2.X.5.aa.z.17 ships
`BedrockProvider.listModelCustomizationJobs(options?)` against
AWS's `ListModelCustomizationJobs` endpoint — the seventh
paginated control-plane enumeration. Parallels
M2.X.5.aa.z.15's listModelImportJobs surface but for
AWS-native fine-tunes/continued-pretrains/distillations (vs
externally-trained imports). BedrockCustomModelDetail
(M2.X.5.aa.z.14) surfaces a jobArn pointing to the
ModelCustomizationJob that produced the model;
listModelCustomizationJobs enumerates those jobs.
Pipeline-health monitoring, failure triage, throughput
analysis, cost attribution all unblocked. Key asymmetry vs
import jobs: customization jobs have a RICHER 5-value status
vocabulary — InProgress / Completed / Failed / Stopping /
Stopped (operators can issue StopModelCustomizationJob
mid-training to abort an expensive fine-tune). New module
`model-customization-jobs-api.ts` exports
BEDROCK_MODEL_CUSTOMIZATION_JOB_STATUSES 5-value tuple
(mixed-case preserved verbatim, case-sensitive discriminator),
boundary-validation constants, sortBy/sortOrder tuples,
BedrockModelCustomizationJobSummary (5 required fields:
jobArn, jobName, baseModelArn, status, creationTime + 5
optional: lastModifiedTime, endTime, customModelArn,
customModelName, customizationType),
BedrockModelCustomizationJobListResponse,
buildModelCustomizationJobListQuery pure boundary-validator
(8 optional parameters: creationTimeBefore/After +
nameContains + statusEquals + maxResults + nextToken +
sortBy + sortOrder), strict parsers. customizationType
preserved as string for forward-compat against AWS additions
(FINE_TUNING / CONTINUED_PRE_TRAINING / DISTILLATION
documented; AWS adds new). Provider reuses
signedControlPlaneGet rail. Bedrock control-plane surface now
has 15 of N operations; module count up to 16. Seven
paginated enumerations now in place across 7 AWS resource
types — the boundary-validator + strict-parser pattern is
fully mature. M2.X.5.aa.z.16 ships
`BedrockProvider.getModelImportJob(jobIdentifier)` — the
rich-detail companion to listModelImportJobs (M2.X.5.aa.z.15).
Failure-triage workflows now fully unblocked: when a Failed
job surfaces in the roster, operators look up the specific
job to read failureMessage (AWS's typed error),
modelDataSource.s3DataSource.s3Uri (S3 source bucket),
roleArn (IAM role for permission verification),
importedModelKmsKeyArn (KMS compliance), vpcConfig (subnet +
security-group routing). Fourth extended-shape detail
instance in the Bedrock package after Guardrail
(M2.X.5.aa.z.8), ImportedModel (M2.X.5.aa.z.12), and
CustomModel (M2.X.5.aa.z.14). Pattern fully stable. New
types in `model-import-jobs-api.ts`:
BedrockModelImportJobS3DataSource ({s3Uri}),
BedrockModelImportJobDataSource ({s3DataSource}),
BedrockModelImportJobVpcConfig ({subnetIds[],
securityGroupIds[]}), BedrockModelImportJobDetail (5 required
+ 8 optional fields). parseModelImportJobDetail strict
parser validates 5 required fields, reuses
isBedrockModelImportJobStatus discriminator from
M2.X.5.aa.z.15, validates nested s3DataSource.s3Uri + VPC
arrays of strings. Provider validates identifier non-empty
BEFORE fetch, URI-encodes path component, reuses
signedControlPlaneGet rail. Asymmetry with summary preserved:
importedModelArn + importedModelName optional in both
(populated only post-success per AWS docs); detail adds
roleArn (required), failureMessage (Failed-only),
modelDataSource (required), vpcConfig (optional),
importedModelKmsKeyArn (optional). Bedrock control-plane
surface now has 14 of N operations; module count unchanged at
15. M8 closes the workflow runtime
depth gap — the first production-grade observability surface
for workflows. New `WorkflowInstrumentation` interface in
`@crossengin/workflow-runtime/src/instrumentation.ts` with 11
documented event kinds (instance_started / instance_completed
/ instance_failed / instance_cancelled / state_transitioned /
signal_received / signal_consumed / timer_fired /
activity_scheduled / action_applied / engine_error),
`WorkflowInstrumentationEvent` shape (kind, tenantId,
instanceId, definitionId, correlationId, occurredAt,
durationMs, attributes JSONB), NoopInstrumentation default,
captureInstrumentation() in-memory buffer for testing,
combineInstrumentations(...children) fan-out helper (returns
noop for empty input, single child unchanged, sequential await
for multiple), isWorkflowInstrumentationKind discriminator.
Engine wired at 8 key paths: startInstance emits
instance_started; submitSignal emits signal_received then
signal_consumed; tickTimers emits timer_fired per fired
timer; cancelInstance emits instance_cancelled; applyTransition
emits state_transitioned; applyScheduleActivity emits
activity_scheduled; emitTerminalForStateKind emits
instance_completed / instance_failed / instance_cancelled
based on terminal kind (guarded by Set against
double-emission when runStepLoop re-enters). Internal state
widened: instanceDefinition: Map<instanceId, definitionId>
tracks definition IDs for instrumentation event correlation;
registerInstance() gains optional definitionId parameter.
`emitInstrumentation(kind, fields)` private helper builds
the typed event with occurredAt from engine clock, routes
through this.instrumentation.onEvent, and SWALLOWS exceptions
— instrumentation failures must NEVER crash the engine
(errors land in the noop sink as engine_error events for
operator-side observability). New kernel meta-schema table
META_WORKFLOW_TRACES (120th table) — observability-only,
distinct from the source-of-truth META_WORKFLOW_EVENTS:
id UUID PK, tenant_id (RLS-isolated), instance_id (FK CASCADE
to workflow_instances), definition_id (FK SET NULL to
workflow_definitions), kind (11-value CHECK constraint),
occurred_at, duration_ms, correlation_id, attributes JSONB,
created_at. Three indexes optimized for time-series queries:
(instance_id, occurred_at), (tenant_id, kind, occurred_at),
(tenant_id, correlation_id). RLS tenant_isolation policy
applied. New `PostgresWorkflowInstrumentation` in
`@crossengin/workflow-runtime-pg/src/instrumentation.ts`
implements WorkflowInstrumentation.onEvent by writing to
meta.workflow_traces via WorkflowInstanceIdResolver +
WorkflowDefinitionIdResolver — tolerates unresolved instance/
definition IDs (writes null UUIDs so engine_error events that
happen mid-startup don't break). `buildPersistentEngine`
gains two new optional inputs: `instrumentation?:
WorkflowInstrumentation` (direct hook, overrides
persistTraces) and `persistTraces?: boolean` (when true,
auto-constructs PostgresWorkflowInstrumentation against the
same connection + resolvers). resolveInstrumentation
precedence: explicit instrumentation > persistTraces auto >
NoopInstrumentation fallback. OTel-ready — event shape is a
subset of OTel SpanEvent; operators write thin adapter in
~20 lines. Backwards compat preserved — all pre-M8 engine
tests pass without modification. M5.10.5 closes the M2.X.5
loop —
the `crossengin chat` REPL in `apps/architect-cli` now accepts
inline content-block attachments. Before this milestone the
kernel `LlmMessage.content` supported `string | readonly
LlmContentBlock[]` (since M2.X.5 / ADR-0088) and all four
provider translators handled the union, but the REPL still
serialized every user turn as a plain string — operators
couldn't paste an image_url, file_id, or document_url into a
chat turn. M5.10.5 adds five new exports to
`apps/architect-cli/src/chat.ts`: `UserContent` type alias
(`string | readonly LlmContentBlock[]`), `parseUserLine(line)`
slash-command parser returning a discriminated
`ParsedUserLine` union (kinds: attach / clear_attachments /
show_attachments / exit / send / noop / error),
`composeUserContent(text, pendingBlocks)` that returns plain
string when no pending blocks or LlmContentBlock[] otherwise,
`userContentToTranscriptText(content)` that flattens blocks
to bracketed placeholders for transcript storage (transcript
schema's content field stays string-typed),
`describeAttachment(block)` human-readable single-line
description. Slash-command vocabulary: `/attach image_url
<url>`, `/attach document_url <url>`, `/attach file_id <id>`,
`/attach text <text>` (prefatory context), `/clear-attachments`,
`/show-attachments`. Existing `/exit` and `/quit` preserved.
REPL loop maintains pendingBlocks[] state — after a successful
send, pending blocks reset to empty (per-turn semantics, no
leak across turns). `ChatTurnInput.userInput` +
`ChatExchangeOptions.userInput` widened from `string` to
`UserContent`. `buildCompletionRequest` + `runChatTurn`
unchanged — type widening propagates through
`LlmMessage.content` since the kernel union already supported
it. Transcript flattens block-rich messages to placeholder
strings so DB schema unchanged. Backwards compat fully
preserved — all 42 pre-existing chat tests pass without
modification. 34 new tests cover parseUserLine (10 cases —
plain text / noop / exit / clear / show / 4 attach types /
unknown type / missing value / fall-through), composeUserContent
(4 cases — string / blocks+text / multiple blocks / empty
text), userContentToTranscriptText (5 cases — string /
image_url / file_id / document_url / image bytes),
describeAttachment (5 cases — all block types + truncation),
runChatExchange with content blocks (2 cases), runChatRepl
attachment commands (5 cases — thread through / clear /
show / parse error / no leak across turns). Pattern set for
future kernel multimodal additions: when M2.X.5.aa.z.x adds
a new block variant, the REPL gets a new /attach branch +
tests (~5 lines). M2.X.12 ships the fourth
cross-provider kernel error classifier — `isConflictError(err)`
in `@crossengin/ai-providers/conflict.ts`. Two Bedrock 409-
emitting endpoints (stopBatch from M2.X.5.aa.z.5 + createBatch
from M2.X.5.aa.z.6) plus OpenAI's documented 409 surfaces (run
state conflicts, file uniqueness) plus Anthropic forward-compat
now justify lifting the classifier to the kernel. Structurally
identical to the three prior classifiers (`isModerationError`
M2.X.6.x, `isRetryableError` M2.X.7, `isInputTooLargeError`
M2.X.9): `CONFLICT_ERROR_KINDS` tuple + `isConflictErrorKind`
predicate + `isConflictError(err)` duck-typed discriminator on
`.kind`. Single-kind tuple (`conflict_error`) for now;
future-compats additional sub-types. Three provider error
tables extended: Bedrock adds conflict_error to
BEDROCK_ERROR_KINDS, classifyHttpStatus(409) →
conflict_error, CODE_TO_KIND["ConflictException"] →
conflict_error; OpenAI + Anthropic add conflict_error to their
KINDS + classifyHttpStatus(409) → conflict_error. conflict_error
is NOT in any provider's RETRYABLE_KINDS — state conflicts are
terminal, operator must reconcile state. Two existing
M2.X.5.aa.z.5 / M2.X.5.aa.z.6 tests upgraded to assert the new
classified kind (they previously asserted only `.code` since
`.kind` was a placeholder `unknown_error`). Pattern: when ≥2
providers emit semantically-equivalent error class, lift
classifier to kernel. Trigger from M2.X.5.aa.z.5 and
M2.X.5.aa.z.6 ADRs ("dedicated conflict_error kernel kind
deferred until a second 409-emitting endpoint lands") is met.
M2.X.5.aa.z.15 ships
`BedrockProvider.listModelImportJobs(options?)` against AWS's
`ListModelImportJobs` endpoint — the sixth paginated control-
plane enumeration. BedrockImportedModelDetail (M2.X.5.aa.z.12)
surfaces a `jobArn` field; M2.X.5.aa.z.15 closes the gap by
making those jobs enumerable. Pipeline-health monitoring
("how many imports are InProgress / Completed / Failed?"),
failure triage (statusEquals=Failed enumerates broken
imports), and throughput analysis (time-range filters) now
viable. New module `model-import-jobs-api.ts` exports
`BEDROCK_MODEL_IMPORT_JOB_STATUSES` 3-value tuple (InProgress
/ Completed / Failed — mixed case preserved verbatim;
case-sensitive discriminator), boundary-validation constants,
`BedrockModelImportJobSummary` (4 required + 4 optional
fields where `importedModelArn` + `importedModelName` only
populated post-success — AWS asymmetry mirrored verbatim),
`BedrockModelImportJobListResponse`,
`buildModelImportJobListQuery` pure boundary-validator (8
optional parameters including the same time-range +
nameContains + statusEquals + sortBy/sortOrder pattern as
sibling enumerations), strict parsers. Provider reuses
signedControlPlaneGet rail. Bedrock control-plane surface
now has 13 of N operations; module count up to 15. Sixth
paginated enumeration with the boundary-validator + strict-
parser pattern — extremely stable across this many instances.
M2.X.5.aa.z.14 ships
`BedrockProvider.getCustomModel(modelIdentifier)` — the
rich-detail companion to listCustomModels. Compliance teams +
ML-ops engineers need 8 things the summary lacks: training-
data provenance (`trainingDataConfig.s3Uri`), validation-data
provenance (`validationDataConfig.validators[].s3Uri`),
output-artifact location (`outputDataConfig.s3Uri`), quality
metrics (`trainingMetrics.trainingLoss`,
`validationMetrics[].validationLoss`), hyperparameter
reproducibility (`hyperParameters` map),
distillation lineage (`customizationConfig.distillationConfig.
teacherModelConfig`), KMS-key audit (`modelKmsKeyArn`),
customization-job correlation (`jobArn`). Follows the
extended-shape pattern (third instance after Guardrail +
ImportedModel) since AWS returns substantively richer fields
than the summary — 15 detail fields vs 8 summary fields. Eight
new typed sub-shapes in `custom-models-api.ts`:
BedrockCustomModelS3Config (shared by training + output
configs), BedrockCustomModelValidator,
BedrockCustomModelValidationDataConfig (wraps validators[] —
operators can validate against multiple datasets),
BedrockCustomModelTrainingMetrics (currently
{trainingLoss?: finite-number}; AWS may add fields),
BedrockCustomModelValidationMetric (one per validator),
BedrockCustomModelTeacherModelConfig (only present for
DISTILLATION — {teacherModelIdentifier,
maxResponseLengthForInference?}),
BedrockCustomModelDistillationConfig,
BedrockCustomModelCustomizationConfig (wraps distillation —
gives AWS room to add adapter / RLHF / future configs without
breaking the kernel). hyperParameters parsed as
Record<string, string> matching AWS's wire contract (AWS
serializes numeric hyperparams as strings; operators parse at
the app layer). Strict finite-number validation on
trainingLoss + validationLoss — NaN / Infinity throw api_error.
Provider validates identifier non-empty BEFORE fetch,
URI-encodes path (handles ARN colons), reuses
signedControlPlaneGet rail. Bedrock control-plane surface now
has 12 of N operations. M2.X.5.aa.z.13 ships
`BedrockProvider.listCustomModels(options?)` against AWS's
`ListCustomModels` endpoint — the fifth paginated control-plane
enumeration after listBatches / listGuardrails /
listInferenceProfiles / listImportedModels. Bedrock has two
distinct surfaces for non-foundation models: imported models
(externally-trained, uploaded from S3 via
CreateModelImportJob — M2.X.5.aa.z.11/.12) and custom models
(fine-tunes / continued-pretrains / distillations of an
AWS-supported foundation model via
CreateModelCustomizationJob — this milestone). AWS exposes
them through separate endpoints (/imported-models vs
/custom-models) with different filter parameters; the kernel
matches the surface 1:1 rather than unifying. New module
`custom-models-api.ts` exports `BEDROCK_CUSTOM_MODEL_STATUSES`
3-value tuple (Active / Creating / Failed — mixed case
preserved verbatim from AWS, NOT uppercased like guardrails;
case-sensitive discriminator), boundary-validation constants,
`BedrockCustomModelSummary` (4 required fields: modelArn,
modelName, creationTime, baseModelArn + 4 optional:
baseModelName, customizationType as string for forward-compat
against AWS additions like DISTILLATION,
ownerAccountId, modelStatus validated against tuple when
present), and `buildCustomModelListQuery` pure boundary-
validator with the LARGEST filter set yet — 8 distinct
optional parameters (creationTimeBefore/After,
baseModelArnEquals, foundationModelArnEquals, nameContains,
isOwned boolean, modelStatus, maxResults [1, 1000], nextToken,
sortBy, sortOrder). isOwned boolean serialized as "true" /
"false" in the query string per AWS convention. modelStatus
optional in summaries (AWS omits it for some legacy entries —
strict parsing of optional fields when present, omit when
absent). customizationType preserved as raw string (same
forward-compat stance as modelArchitecture for imported
models). Provider reuses signedControlPlaneGet rail. Bedrock
control-plane surface now has 11 of N operations; module
count up to 14. Four operational workflows unblocked:
customization-job inventory ("show every fine-tune"),
base-model audit (filter by baseModelArnEquals for compliance),
cross-account discovery (isOwned=false surfaces shared-in
models), status-aware cleanup (modelStatus=Failed enumerates
broken customizations). M2.X.5.aa.z.12 ships
`BedrockProvider.getImportedModel(modelIdentifier)` — the
rich-detail companion to listImportedModels. Unlike
getInferenceProfile / getBatch (which use the type-alias
pattern since AWS returns identical shapes for list + get),
getImportedModel follows the M2.X.5.aa.z.8 getGuardrail
extended-shape pattern: AWS adds 4 fields the summary lacks
(`jobName`, `jobArn`, `modelDataSource.s3DataSource.s3Uri`,
optional `modelKmsKeyArn`). Three operational workflows
unblocked: provenance audits (compliance teams verifying
"model X imported from S3 URI Y by job Z"), KMS-key audits
(per-model encryption-key verification), import-job
correlation (linking finished models to their ModelImportJob
records). New types in `imported-models-api.ts`:
`BedrockImportedModelDetail` (independent type with explicit
fields — not a type alias because shapes diverge),
`BedrockImportedModelDataSource` (preserves AWS's 3-level
nesting `modelDataSource.s3DataSource.s3Uri` verbatim — gives
AWS room to add non-S3 data sources without breaking the
kernel), `BedrockImportedModelS3DataSource`,
`parseImportedModelDetail(raw)` strict parser. Provider
validates identifier non-empty BEFORE fetch, URI-encodes path,
reuses signedControlPlaneGet rail. Two get-shape patterns now
distinct in the Bedrock package: type-alias (batch + inference-
profile when AWS returns identical shapes) vs extended-type
(guardrail + imported-model when get returns richer fields).
The choice follows AWS's response shape, not kernel preference.
Bedrock control-plane surface now has 10 of N operations
(listBatches + getBatch + stopBatch + createBatch +
listGuardrails + getGuardrail + listInferenceProfiles +
getInferenceProfile + listImportedModels + getImportedModel).
M2.X.5.aa.z.11 ships
`BedrockProvider.listImportedModels(options?)` against AWS's
`ListImportedModels` endpoint — the fourth paginated
control-plane enumeration after listBatches / listGuardrails /
listInferenceProfiles. Custom Model Import lets customers
upload model artifacts (weights, tokenizer, config) from S3
and serve them through Bedrock alongside foundation models;
listImportedModels enumerates them for inventory + architecture-
aware routing + instruct-tuned discoverability + tenant cleanup
workflows. New module `imported-models-api.ts` exports 7
boundary-validation constants (maxResults bounds, nameContains
length bounds, sortBy + sortOrder tuples),
`BedrockImportedModelSummary` (5 required fields — modelArn,
modelName, creationTime, instructSupported,
modelArchitecture), `BedrockImportedModelListResponse`,
`buildImportedModelListQuery` pure boundary-validator
(creationTimeBefore/After ISO 8601 parseable, nameContains
length [1, 63], maxResults integer in [1, 1000], nextToken
non-empty, sortBy/sortOrder against tuples), and
`parseImportedModelListResponse` + `parseImportedModelSummary`
strict parsers. Validation discipline: modelArchitecture
preserved as raw string (AWS adds new architectures —
LLAMA2/LLAMA3/MISTRAL/FLAN/... — quarterly; strict enum
would be perpetually stale), instructSupported strict boolean
(catches API drift early). Provider reuses the existing
signedControlPlaneGet rail. Pattern stable across 4 paginated
enumerations now; adding listCustomModels /
listMarketplaceModelEndpoints is mechanical. Bedrock module
count up to 13; control-plane surface up to 9 of N
operations. M2.X.5.aa.z.10 ships
`BedrockProvider.getInferenceProfile(profileIdentifier)` — the
single-resource lookup companion to listInferenceProfiles.
AWS returns the SAME wire shape for GetInferenceProfile as a
ListInferenceProfiles entry; the kernel mirrors M2.X.5.aa.z.4's
getBatch pattern: `BedrockInferenceProfileDetail =
BedrockInferenceProfileSummary` type alias +
`parseInferenceProfileDetail = parseInferenceProfileSummary`
parser alias. Provider method validates the identifier
non-empty BEFORE the fetch (no wasted request on empty
input), URI-encodes the path component (handles dots/colons in
both ID form `us.anthropic.claude-3-5-sonnet-20241022-v2:0`
and ARN form), GETs `/inference-profiles/{encoded}` via the
existing M2.X.5.aa.z.3 signedControlPlaneGet rail, parses via
parseInferenceProfileDetail. AWS accepts BOTH the inference
profile ID and the full ARN as identifier — kernel preserves
this (strict regex would be brittle since IDs have
heterogeneous shapes across SYSTEM_DEFINED and APPLICATION
types, and AWS adds new regional prefixes regularly). Three
operational workflows unblocked: log-driven lookup (profile
ARN appears in CloudTrail / billing → fetch full record),
webhook-driven lookup (EventBridge emits Bedrock event →
look up by id), drift detection (spot-check one profile
without re-enumerating). Bedrock control-plane surface now
has 8 of N operations. Detail-alias pattern now proven twice
(M2.X.5.aa.z.4 + this); future single-resource lookups where
AWS returns identical shapes follow the same convention.
M2.X.5.aa.z.9 ships
`BedrockProvider.listInferenceProfiles(options?)` against
AWS's `ListInferenceProfiles` endpoint — the third paginated
control-plane enumeration after listBatches (M2.X.5.aa.z.3)
and listGuardrails (M2.X.5.aa.z.7). Cross-region inference
profiles route a single logical model ID (e.g.,
`us.anthropic.claude-3-5-sonnet-20241022-v2:0`) to ANY of N
regional model deployments with automatic failover — AWS's
recommended production-workload invocation path. New module
`inference-profiles-api.ts` exports
`BEDROCK_INFERENCE_PROFILE_STATUSES` (1-value tuple: ACTIVE),
`BEDROCK_INFERENCE_PROFILE_TYPES` (2-value tuple:
SYSTEM_DEFINED for AWS-managed | APPLICATION for
operator-created), discriminators, `BedrockInferenceProfileModel`
({modelArn}), `BedrockInferenceProfileSummary` (8 required
fields + optional description), `BedrockInferenceProfileListResponse`,
`buildInferenceProfileListQuery` pure boundary-validator
(typeEquals against tuple, maxResults integer in [1, 1000],
nextToken non-empty), and `parseInferenceProfileListResponse`
+ `parseInferenceProfileSummary` strict parsers. Provider
method reuses the existing `signedControlPlaneGet` rail.
Pagination pattern now proven THREE times — adding future
enumerations (listImportedModels, listCustomModels,
listMarketplaceModelEndpoints) is mechanical. Bedrock module
count up to 12; control-plane surface up to 7 of N
operations. M2.X.5.aa.z.8 ships
`BedrockProvider.getGuardrail(guardrailIdentifier,
guardrailVersion?)` — the rich-detail companion to
listGuardrails. While listGuardrails returns shallow summaries
sufficient for "show me every guardrail" audits, getGuardrail
returns the FULL policy bytes operators need for compliance
disclosures (SOC 2 / HIPAA / GDPR), drift detection between
authoring + runtime, and multi-version diffs. Response shape is
~5x the summary: 9 required top-level fields (guardrailId /
guardrailArn / name / version / status / createdAt / updatedAt
/ blockedInputMessaging / blockedOutputsMessaging) + 9 optional
(description / kmsKeyArn / statusReasons /
failureRecommendations + FIVE nested policy types). Five typed
policies modeled: contentPolicy ({filters[]} of {type:
SEXUAL|VIOLENCE|HATE|INSULTS|MISCONDUCT|PROMPT_ATTACK,
inputStrength: NONE|LOW|MEDIUM|HIGH, outputStrength:
same-tuple}), contextualGroundingPolicy ({filters[]} of {type:
GROUNDING|RELEVANCE, threshold: finite-number}),
sensitiveInformationPolicy ({piiEntities[]} of {type: string —
30+ AWS-extensible values, action: BLOCK|ANONYMIZE} +
{regexes[]} of {name, pattern, action, description?}),
topicPolicy ({topics[]} of {name, type: string — currently
only DENY, definition, examples?}), wordPolicy ({words[]} of
{text} + {managedWordLists[]} of {type: string — currently
only PROFANITY}). Validation discipline: stable AWS
vocabularies (4 enum tuples: filter strength, content filter
type, contextual grounding type, PII action) get strict
discriminators that throw on unknown; growing AWS vocabularies
(PII entity types, topic types, managed word list types)
preserve raw string for forward-compat. Field naming
asymmetry preserved verbatim: ListGuardrails uses {id, arn};
GetGuardrail uses {guardrailId, guardrailArn} — operators
map between them. Provider method validates both inputs
non-empty BEFORE the fetch, URI-encodes the path component
(ARN colons → %3A), threads optional guardrailVersion as a
query parameter (omitted → AWS returns DRAFT), reuses
signedControlPlaneGet rail. parseGuardrailDetail strict
parser: each policy parsed only when present in the response
(AWS only returns configured policies); missing required
top-level fields throw api_error. Bedrock control-plane
surface now has 6 of N operations (listBatches + getBatch +
stopBatch + createBatch + listGuardrails + getGuardrail);
Bedrock module count up to 11 (batch-api + converse-api +
embeddings + errors + event-stream + guardrails +
guardrails-api + pricing + provider + signing + index).
M2.X.5.aa.z.7 ships the second
Bedrock control-plane enumeration after listBatches:
`BedrockProvider.listGuardrails(options?)` against AWS's
`ListGuardrails` endpoint. Operators can now audit which
guardrails exist on their account, reconcile their internal
tenant→guardrail mapping against AWS's view, and detect drift
(a guardrail expected READY that's actually FAILED / DELETING)
— all through the kernel. New module `guardrails-api.ts`
exports `BEDROCK_GUARDRAIL_STATUSES` 6-value const tuple
(CREATING / UPDATING / VERSIONING / READY / FAILED / DELETING
— uppercase, AWS-verbatim), `BedrockGuardrailStatus` type +
`isBedrockGuardrailStatus` discriminator, `BedrockGuardrailSummary`
type (id / arn / status / name / version / createdAt /
updatedAt required + description optional),
`BedrockGuardrailListResponse` ({guardrails, nextToken?} —
nextToken omitted when absent / empty),
`buildGuardrailListQuery` pure boundary-validator (validates
guardrailIdentifier non-empty, maxResults integer in
[1, 1000], nextToken non-empty), and `parseGuardrailListResponse`
+ `parseGuardrailSummary` strict parsers. Provider method
reuses the existing `signedControlPlaneGet` rail from
M2.X.5.aa.z.3 — no transport changes; just a new path
(`/guardrails`). Behavioral note on AWS semantics: omitting
`guardrailIdentifier` returns the DRAFT version of every
guardrail (roster mode); supplying `guardrailIdentifier`
returns DRAFT + all numbered versions of that ONE guardrail
(version-history mode). Module separation discipline:
existing `guardrails.ts` continues to own inference-time
concerns (`BedrockGuardrailConfig`); new `guardrails-api.ts`
owns control-plane concerns. Both export through the barrel.
Bedrock control-plane surface now has 5 of N operations
(listBatches / getBatch / stopBatch / createBatch /
listGuardrails); pattern proven twice for paginated
enumeration; adding `listInferenceProfiles` /
`listImportedModels` / `listCustomModels` is now mechanical.
M2.X.5.aa.z.6 closes the Bedrock
batch CRUD with `BedrockProvider.createBatch(input)` against
AWS's `CreateModelInvocationJob` endpoint. All four documented
batch operations (list + get + stop + create) now have
provider methods. Operators can detect runaway jobs, stop
them, fix inputs, and relaunch — all through the kernel.
`buildCreateBatchBody(input)` is a pure exported boundary-
validator enforcing 14 documented AWS constraints BEFORE any
fetch: jobName pattern [a-zA-Z0-9](-*[a-zA-Z0-9])* length
1-63, modelId length 1-2048 (no pattern — AWS accepts base
IDs / ARNs / inference profile IDs / custom model ARNs / etc.),
roleArn AWS-partition-aware IAM-role pattern, s3Uri scheme
^s3://[a-z0-9.\-_]{1,255}/.* on both input + output,
s3InputFormat whitelist (only "JSONL"), clientRequestToken
shape + length 1-256, timeoutDurationInHours integer in
[24, 168], tags count ≤ 200 + key length 1-128 + value
length 0-256, vpcConfig.subnetIds + securityGroupIds counts
in [1, 16]. All ARN patterns AWS-partition-aware (aws,
aws-us-gov, aws-cn). `parseCreateBatchResponse(raw)` is
strict — `{jobArn}` only; missing / empty / non-string
throws api_error. AWS's create response really is just the
ARN — operators wanting fuller state call getBatch
immediately after. `signedControlPlanePost` widened from
M2.X.5.aa.z.5: now accepts `{path, body?}` with default empty
body; stopBatch's call unchanged (backwards-compatible).
Error mapping: 200 + {jobArn} → resolve, 400
ValidationException → invalid_request_error (e.g., role
lacks s3:GetObject), 403 → permission_error, 429 →
rate_limit_error, 409 ConflictException (jobName already
exists OR clientRequestToken reused with different payload)
→ kind: "unknown_error" + code: "ConflictException" (same as
M2.X.5.aa.z.5; dedicated conflict_error kernel kind now
justified by TWO 409-emitting endpoints — proposed as
M2.X.12). Operators get idempotency via clientRequestToken
(re-submitting same payload + same token returns same job
ARN), cost attribution via tags (threading tenant / purpose
/ cost-center to AWS Cost Explorer), and VPC-scoped batch
jobs (subnets + security groups). Boundary-validation pattern
set for future POST-with-body control-plane writes
(createGuardrail, createInferenceProfile, etc.) — pure body-
builder + exported response parser + provider thin wrapper.
M2.X.5.aa.z.5 ships
`BedrockProvider.stopBatch(jobIdentifier)` against AWS's
`StopModelInvocationJob` endpoint, completing the read/write
split on the batch surface (3 of 4 batch operations now
covered: list + get + stop; only createBatch deferred).
Method validates the identifier via the M2.X.5.aa.z.4
`isBedrockBatchJobIdentifier` regex BEFORE the fetch, URI-
encodes into `/model-invocation-jobs/{encoded}/stop`, POSTs
an empty body via a new private `signedControlPlanePost`
helper (sibling to M2.X.5.aa.z.3's `signedControlPlaneGet`
with method POST + content-type header + no query param),
returns `void` on success. AWS sig v4 handles empty bodies
correctly via SHA-256 of empty string. Error mapping:
404 ResourceNotFoundException → not_found_error, 403
AccessDeniedException → permission_error, 429
ThrottlingException → rate_limit_error, 400 ValidationException
→ invalid_request_error, network → network_error. 409
ConflictException (job already in terminal state, e.g., race
between poll + stop) surfaces with `kind: "unknown_error"` +
`code: "ConflictException"` — operators discriminating on
`.code` get clean detection; a dedicated `conflict_error` kind
deferred to when a second 409-emitting endpoint lands. Three
operational workflows unblocked: cost-runaway kill switches
(detect long-running job → stop), tenant-offboarding
cancellation sweeps (paired with listBatches({nameContains}) +
status filter), compliance kill switches (new policy lands →
stop in-flight jobs). POST rail established —
signedControlPlanePost is reusable for future control-plane
POSTs with empty bodies (state mutations on guardrails /
inference profiles / custom models). M2.X.5.aa.z.4 adds
`BedrockProvider.getBatch(jobIdentifier)` — single-job
lookup against AWS's `GetModelInvocationJob` control-plane
endpoint, pairing with M2.X.5.aa.z.3's `listBatches` for
polling, failure diagnostics, and webhook-driven retrieval
workflows. New exports in `batch-api.ts`:
`BedrockBatchJobDetail` type alias (same shape as
`BedrockBatchJobSummary` — AWS returns identical wire
formats for both endpoints), `BEDROCK_BATCH_JOB_IDENTIFIER_
PATTERN` regex covering both AWS-accepted forms (12-char
lowercase-alphanumeric unique id OR full job ARN across the
three AWS partitions: aws, aws-us-gov, aws-cn),
`isBedrockBatchJobIdentifier(value)` discriminator,
`parseBatchJobDetail(raw)` exported wrapper around the
(now-also-exported) `parseBatchJobSummary` parser.
`getBatch` validates the identifier via the regex BEFORE
the fetch (invalid input throws `BedrockError` with
invalid_request_error kind without burning a request),
URI-encodes the identifier in the path (`encodeURIComponent`
converts ARN colons to %3A), GETs
`/model-invocation-jobs/{encoded}` via the existing
M2.X.5.aa.z.3 `signedControlPlaneGet` helper, parses via
`parseBatchJobDetail`. 404s surface as typed
not_found_error via the existing CODE_TO_KIND map
(ResourceNotFoundException → not_found_error); other
errors route through `fromHttpResponse` /
`fromNetworkError` paths as M2.X.5.aa.z.3. Bedrock
control-plane surface now has 2 of N operations
(listBatches + getBatch); pattern set for future
single-resource lookups (`getGuardrail`,
`getInferenceProfile`, etc.) following the same
regex-validate → encode → signedControlPlaneGet → parse
shape. M2.X.5.aa.z.3 ships
`BedrockProvider.listBatches(options?)` against AWS Bedrock's
`ListModelInvocationJobs` control-plane endpoint. AWS does
not ship a Files API; batch inference is the closest
operational surface, and the same three workflows that
motivated `listFiles()` (tenant offboarding, storage audits,
reference reconciliation) all apply here. New `batch-api.ts`
module in `@crossengin/ai-providers-bedrock` exports
`BEDROCK_BATCH_JOB_STATUSES` (10-value const tuple matching
AWS's documented states: Submitted / InProgress / Completed /
Failed / Stopping / Stopped / PartiallyCompleted / Expired /
Validating / Scheduled), `BedrockBatchJobStatus` type +
`isBedrockBatchJobStatus` discriminator,
`BEDROCK_BATCH_SORT_BY_VALUES = ["CreationTime"]` +
`BEDROCK_BATCH_SORT_ORDER_VALUES = ["Ascending",
"Descending"]`, `BedrockBatchJobSummary` type mirroring AWS's
`InvocationJobSummary` (jobArn / jobName / modelId / roleArn
/ status / submitTime + s3InputDataConfig / s3OutputDataConfig
+ optional clientRequestToken / message / lastModifiedTime /
endTime / timeoutDurationInHours / jobExpirationTime /
vpcConfig), `BedrockBatchJobListResponse` ({invocationJob
Summaries, nextToken?} — nextToken omitted when absent/empty),
`buildBatchListQuery(options)` pure validator-builder
(statusEquals against tuple, maxResults int in [1, 1000],
nameContains length [1, 63], submitTimeAfter/Before parseable
via Date.parse, nextToken non-empty, sortBy/sortOrder against
tuples), and `parseBatchListResponse(raw)` strict parser.
`BedrockProvider.listBatches(options?)` GETs `/model-
invocation-jobs/` on the control-plane host with sig v4 +
sorted query string. Two-host model surfaced explicitly:
`controlPlaneBaseUrl` defaults to `https://bedrock.{region}.
amazonaws.com` (distinct from the existing `baseUrl` which
remains `https://bedrock-runtime.{region}.amazonaws.com`);
both use the same sig v4 service name (`bedrock`). New
private `signedControlPlaneGet({path, query})` helper threads
GET + empty body + URI-encoded query string through
`signRequest` (the `query` parameter on `signRequest` was
already supported since M2.9). Validation fast-fails BEFORE
the fetch — out-of-range maxResults / unknown statusEquals /
unparseable dates throw `BedrockError` with
`invalid_request_error` kind without burning a request. Errors
route through existing `fromHttpResponse` / `fromNetworkError`
helpers (AccessDeniedException → permission_error,
ThrottlingException → rate_limit_error, etc.). Bedrock now
has a read-only operational surface: pre-M2.X.5.aa.z.3 only
inference + embed methods existed. Three-provider enumeration
parity achieved (OpenAI listFiles, Anthropic listFiles,
Bedrock listBatches). Pattern set for future Bedrock control-
plane methods (getBatch, listGuardrails, listImportedModels,
listInferenceProfiles, listCustomModels) — same
signedControlPlaneGet rail. M2.X.5.aa.z.2 added `listFiles()`
to both OpenAI and Anthropic Files API surfaces, completing
the CRUD+list pattern. Closes ADR-0102 Q1 + ADR-0103 Q5.
Response types `OpenAIFileListResponse` and `AnthropicFile
ListResponse` were already defined in M2.X.5.aa.z /
M2.X.5.aa.z.1 — only the methods + tests are new.
`OpenAIProvider.listFiles({purpose?, limit?, order?, after?})`
GETs `/v1/files` with optional query params; limit validated
to [1, 10000]; purpose validated against
OPENAI_FILES_PURPOSES. `AnthropicProvider.listFiles({limit?,
beforeId?, afterId?, order?})` GETs `/v1/files` with the beta
header; limit validated to [1, 1000] (Anthropic's documented
max); camelCase kernel params translated to snake_case HTTP
params (`before_id`, `after_id`). Provider-native response
shapes preserved (OpenAI: just `{object, data}`; Anthropic:
`{data, has_more, first_id, last_id}`) — the kernel doesn't
try to unify pagination semantics. Use cases unblocked:
tenant offboarding (find + bulk-delete by tenant), storage
audits (total bytes by purpose), reference reconciliation
(diff operator records against provider state). M2.X.5.aa.z.1 ships Anthropic Files
API + makes the kernel `FileReferenceContentBlock` work
natively on Anthropic. Closes the throw from M2.X.5.aa.z. New
`files-api.ts` module in `@crossengin/ai-providers-anthropic`
exports `ANTHROPIC_FILES_BETA_HEADER = "files-api-2025-04-14"`
const, `AnthropicFile` / `AnthropicFileDeleteResponse` /
`AnthropicFileListResponse` types, and
`buildAnthropicMultipartUpload({bytes, filename, contentType?})`
encoder. Differs from OpenAI's encoder in two ways: NO purpose
field (Anthropic doesn't classify uploads), multipart body has
ONE part (just `file`). Same RFC 7578 quote escaping, random
per-call boundary, byte-for-byte binary preservation.
`AnthropicProvider` gains `uploadFile / retrieveFile /
deleteFile` methods POSTing/GETting/DELETEing `/v1/files` with
the beta header always present. `filesApiBetaHeader()` helper
merges + deduplicates against any operator-set `anthropicBeta`
constructor option. `FetchLike.body` widened from `string` to
`string | Uint8Array` (backwards-compatible). `AnthropicContent
Block` document variant gained a 4th source variant
`{type: "file", file_id}` alongside base64/url/text. Translator
removes the throw and emits `{type: "document", source:
{type: "file", file_id}, ...}` for kernel `file_id` blocks.
Cross-provider matrix updated: file_id now works natively on
OpenAI Responses + Anthropic; OpenAI Chat + Bedrock still throw
with actionable guidance. file_ids are NOT portable across
providers (operators upload to each provider they target). M2.X.5.aa.z adds full OpenAI Files
API integration: kernel `FileReferenceContentBlock` (8th
variant in LlmContentBlock discriminated union) +
`OpenAIProvider.uploadFile / .retrieveFile / .deleteFile`
methods. Closes ADR-0097 Q3. New types: `FileReferenceContent
BlockSchema = {type: "file_id", fileId: string.min(1).max(120)}`
(opaque text — kernel doesn't enforce the file-<24hex> shape).
Role validation: file_id rejected on tool messages (same rule
as documents/images). New OpenAI module `files-api.ts`
exports `OPENAI_FILES_PURPOSES = ["assistants", "batch",
"fine-tune", "vision", "user_data"]`, `OpenAIFile` /
`OpenAIFileDeleteResponse` types, `isOpenAIFilesPurpose`
discriminator, and `buildMultipartUpload(input)` —
manually-constructed multipart/form-data encoder producing
Uint8Array body + boundary-aware Content-Type. Random
per-call boundary (`----CrossEnginFormBoundary<rand>`); RFC
7578 quote escaping in filenames; binary content preserved
byte-for-byte. `OpenAIProvider` gained 3 methods:
`uploadFile({bytes, filename, purpose, contentType?})` POSTs
to `/v1/files` with multipart body; `retrieveFile(fileId)`
GETs `/v1/files/{id}`; `deleteFile(fileId)` DELETEs same
path. `FetchLike.body` widened from `string` to `string |
Uint8Array` (backwards-compatible). Per-provider translation:
OpenAI Responses API natively passes through to `{type:
"input_file", file_id}` (`OpenAIResponsesContentFileInput`
becomes a union of file_data + file_id variants); OpenAI Chat
Completions + Anthropic + Bedrock all THROW with actionable
"use Responses API path" / "use document block with inline
bytes" guidance. M2.X.10 enforces OpenAI's name
regex at the kernel layer + threads `LlmMessage.name` through
OpenAI Chat Completions on all four message roles (system,
user, assistant, tool). Pre-M2.X.10 only the tool-role
translator carried `name`; other roles silently dropped it.
New kernel exports `LLM_MESSAGE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/`
+ `LlmMessageNameSchema` (OpenAI's documented rules: 1-64
chars, alphanumeric + underscore + hyphen). Bad names fail at
zod parse time instead of as HTTP 400 from OpenAI. Anthropic +
Bedrock + OpenAI Responses silently DROP `name` at translation
(those APIs have no name field). Operators with multi-agent
orchestration on OpenAI Chat get first-class participant
attribution; cross-provider workflows aren't blocked because
of the silent-drop policy. Pre-M2.X.10 tool-role threading
preserved (regression-tested). M2.X.5.aa.x.1 expands the document
format enum from 4 to 9 formats by adding the office set
(doc, docx, xls, xlsx, html). Matches Bedrock Converse API's
full document-format set. Closes ADR-0099 Q1. New helpers
`OFFICE_DOCUMENT_FORMATS = ["doc", "docx", "xls", "xlsx",
"html"]` const tuple + `isOfficeDocumentFormat(format)`
discriminator. `documentMediaType` MIME map extended with the
5 office formats (application/msword,
application/vnd.openxmlformats-officedocument.wordprocessingml.
document, application/vnd.ms-excel,
application/vnd.openxmlformats-officedocument.spreadsheetml.
sheet, text/html). Per-provider: Bedrock translator
unchanged — already accepted all 9 formats; office formats
pass through natively. Anthropic gains an explicit throw
branch (BEFORE the text-format dispatch) for office formats
with conversion guidance: "convert to PDF, or use a different
provider (Bedrock supports office formats natively)". OpenAI
Responses gains an `isOfficeDocumentFormat` check + throw with
same conversion guidance. OpenAI Chat unchanged (still throws
on all documents). Operators using Bedrock get full 9-format
support; cross-provider workflows convert office documents to
PDF client-side. M2.X.5.aa.x expands the document
format enum from `["pdf"]` to `["pdf", "txt", "md", "csv"]`,
closing ADR-0097 Q1 (partially — office formats deferred).
New kernel helpers: `documentMediaType(format)` (single source
of truth for MIME-type mapping: application/pdf, text/plain,
text/markdown, text/csv); `isTextDocumentFormat(format)`
(discriminator between PDF and text formats). Per-provider:
Bedrock translator unchanged — the BedrockDocumentContentBlock.
format type already accepted the broader Bedrock format set;
all 4 kernel formats pass through natively. Anthropic
translator becomes format-aware — PDF uses the existing
`source: {type: "base64", media_type: "application/pdf"}`
shape; txt/md/csv use the new `source: {type: "text",
media_type, data}` shape with bytes decoded from base64 to
UTF-8 via Node's Buffer. AnthropicContentBlock document
variant extended with the text source. OpenAI Responses
translator uses `documentMediaType` for the data URL MIME
prefix — all 4 formats flow as input_file with correct MIME.
OpenAI Chat still throws (no document support). Office formats
(doc/docx/xls/xlsx/html) deferred to future milestone — only
Bedrock supports them natively; adding now would create
two-provider throw asymmetry. Document parity post-M2.X.5.aa.x:
4 formats × 3 providers (Bedrock + Anthropic + OpenAI
Responses) all native. M2.X.5.aa.y adds a URL-based document
variant alongside the M2.X.5.aa bytes variant, closing ADR-0097
Q2. New `DocumentUrlContentBlock` type `{type: "document_url",
url: string, format?: DocumentFormat, name?: string<120}` added
to the LlmContentBlock discriminated union (grows from 6 to 7
variants). URL validated via `z.string().url()` at parse time;
format + name both optional (URL Content-Type provides format
hint; provider-side defaults apply where needed). Same role rule
as document (rejected on tool messages). Per-provider
translation: Anthropic passes URL through to `{type: "document",
source: {type: "url", url}, title?}` (native support, same shape
as the M2.X.5.z URL image variant); Bedrock + OpenAI Responses +
OpenAI Chat all THROW with actionable pre-fetch / use-Files-API
guidance. Three of four provider paths throw — same asymmetry
as image_url (M2.X.5.y). Document parity post-M2.X.5.aa.y: bytes
on Bedrock + Anthropic + OpenAI Responses; URLs on Anthropic
only. Operators with mixed-provider workflows pre-fetch URLs to
bytes when targeting non-Anthropic providers. M2.X.5.aa adds a `DocumentContentBlock`
variant to the kernel content union for PDF inputs, closing
ADR-0096 Q7. New types in `@crossengin/ai-providers/src/types.ts`:
`DOCUMENT_FORMATS = ["pdf"]` const tuple (singleton; future
expansion purely additive), `DocumentFormat` type,
`DocumentContentBlockSchema = {type: "document", format,
bytes, name?: string<120}`. `LlmContentBlockSchema` discriminated
union grows from 5 to 6 variants. Same role rule as images
(rejected on tool messages). Per-provider translation: Bedrock
emits `{document: {format, name, source: {bytes}}}` (defaults
name to "document"); Anthropic emits `{type: "document", source:
{type: "base64", media_type: "application/pdf", data}, title?}`
(maps kernel `name` → Anthropic `title`); OpenAI Responses API
emits `{type: "input_file", filename, file_data: "data:
application/pdf;base64,<bytes>"}` (defaults filename to
"document.<format>"); OpenAI Chat Completions THROWS with
actionable error message pointing to the Responses API path.
Both `BedrockDocumentContentBlock` and `OpenAIResponses
ContentFileInput` added to their respective provider unions.
Anthropic's `AnthropicContentBlock` gains the document variant
with both base64 + url source types (URL variant added for
future M2.X.5.aa.y). Provider asymmetry: three of four real
provider paths support PDFs natively; OpenAI Chat throws with
actionable "use Responses API path" guidance. M2.X.5.z removes the M2.X.5.y throw
in the Anthropic translator + threads URLs through to
Anthropic's native URL source variant, closing ADR-0094 Q3.
Anthropic recently added URL source support; the
`AnthropicContentBlock` image source becomes a discriminated
union on `source.type`: existing `{type: "base64", media_type,
data}` variant unchanged + new `{type: "url", url}` variant
added. `translateKernelBlock` for `image_url` now returns
`{type: "image", source: {type: "url", url: block.url}}`
instead of throwing. Provider parity for URL-based images is
now: OpenAI Chat Completions ✓, OpenAI Responses ✓, Anthropic
✓. Bedrock ✗ (still throws — Bedrock's image source format
has no URL variant; operators with cross-provider URL workflows
pre-fetch bytes when targeting Bedrock). Format hint dropped on
URL path (Anthropic infers from response Content-Type). The
existing M2.X.5.y throw test was replaced with two passthrough
tests: pure URL translation + mixed bytes + URL in same
message. M2.X.9 adds the third kernel-level
cross-provider error classifier: `isInputTooLargeError(err)`.
Follows the same shape as M2.X.6.x (`isModerationError`) and
M2.X.7 (`isRetryableError`) — duck-types on `.kind` against a
shared tuple. New `input-too-large.ts` module exports
`INPUT_TOO_LARGE_ERROR_KINDS = ["request_too_large"]`
(singleton tuple — all three providers map HTTP 413 to this
kind via their classifyHttpStatus paths),
`InputTooLargeErrorKind` type, `isInputTooLargeErrorKind`
discriminator, `InputTooLargeDiscriminator` interface, and the
headline predicate. The kernel surface now partitions the
error space into eight COMPLETE buckets: retryable (try again
with backoff), moderation (terminal; audit), input-too-large
(terminal; reduce input — 413), conflict (terminal;
reconcile state — 409 / M2.X.12), not-found (terminal;
resource absence — 404 / M2.X.13), authentication (terminal;
rotate credentials — 401 / M2.X.14), permission (terminal;
grant access or switch principal — 403 / M2.X.15),
invalid-request (terminal; fix request shape — 400 /
M2.X.16). Canonical 4xx/5xx sweep complete — every documented
kernel error kind across all three providers has a kernel
classifier. Operators classifying errors across providers use
eight parallel discriminators with no provider-package
imports: isModerationError + isRetryableError +
isInputTooLargeError + isConflictError + isNotFoundError +
isAuthenticationError + isPermissionError +
isInvalidRequestError.
Mutual exclusivity verified by tests: a request_too_large
error is NOT retryable + NOT a moderation event.
Cross-package integration tests in all three providers verify
the predicate works against their native error classes.
Pattern continues to scale — adding a fourth classifier (e.g.
isSafetyFilterError if a provider ships a distinct kind) is an
additive tuple expansion. M2.X.5.y adds a URL-based image
variant to the kernel content union, closing ADR-0093 Q1. New
`ImageUrlContentBlock` type `{type: "image_url", url: string,
format?: ImageAttachmentFormat}` added to the LlmContentBlock
discriminated union (grows from 4 to 5 variants: text, image,
image_url, tool_use, tool_result). URL validated via
`z.string().url()` at parse time; `format` optional (URL
responses' Content-Type tells the provider). Same role rule as
image (rejected on tool messages). Per-provider translation:
OpenAI Chat Completions passes the URL through to `image_url:
{url}` (URL passthrough, OpenAI fetches server-side); OpenAI
Responses API passes through to `input_image: {image_url: url}`;
Bedrock + Anthropic THROW with explicit error message ("pre-
fetch the URL to base64 bytes and use an image block
instead") — both providers require base64 inline. Auto-
fetching deferred (operator code owns timeout / retry / cache /
SSRF policy). Payload size + latency win for OpenAI users: a
5 MB image URL is 100 bytes in the request vs ~6.7 MB inline
base64. Pattern set for future URL-only variants (audio_url,
video_url). All 6,713 pre-M2.X.5.y tests pass unchanged; 13
new tests verify URL validation, role rules, OpenAI Chat /
Responses pass-through, Bedrock + Anthropic throw semantics.
M2.8.6 threads `ImageContentBlock`
through the OpenAI Responses API path, closing ADR-0088 Q6.
Pre-M2.8.6 the Responses-API translator used `contentToText`
throughout — array content was flattened to text only, silently
dropping any image blocks. New `OpenAIResponsesContentImage
Input` type `{type: "input_image", image_url: string}` added
to the `OpenAIResponsesContentBlock` discriminated union
(grows from 2 to 3 variants: input_text, input_image,
output_text). New private `buildUserInputBlocks` helper walks
user content: string → single input_text; array content
walks each block (text → input_text, image → input_image
with `data:image/<format>;base64,<bytes>` URL matching
Chat Completions format; tool_use/tool_result skipped — they
flow via top-level function_call_output items or are kernel-
schema rejected on user role). Attachments field flows into
input_image blocks for M2.X backwards compat. Block order
preserved. Empty text blocks filtered. Empty result emits a
single empty input_text block (Responses API rejects empty
content arrays). All 19 pre-M2.8.6 Responses-API tests pass
unchanged; 7 new tests verify image-input threading,
backwards compat, attachment paths, 4 image formats, mixed
text/image ordering, empty filtering. OpenAI provider now has
full multimodal parity across both API paths. M2.X.8 ships standalone OpenAI
Moderations API support in `@crossengin/ai-providers-openai`,
closing ADR-0086 Q1. New `moderations-api.ts` module exports
`OPENAI_MODERATION_MODELS` (4 models: omni-moderation-latest as
default + 2024-09-26 dated + 2 legacy text-moderation models),
`OPENAI_MODERATION_CATEGORY_KEYS` (11 documented categories),
`buildModerationRequest` (input validation: rejects empty
string / empty array / array-with-empty-string at build time),
`normalizeModerationResponse` (folds raw response into
`{model, anyFlagged, results, flaggedCategoriesPerResult}` —
operator-facing summary plus raw results preserved),
`highestCategoryScore(result)` (returns top scoring category,
useful for soft-threshold policies). `OpenAIProvider.moderate
({input, model?})` POSTs to `/v1/moderations` with same
network / HTTP / parse error handling as other endpoints.
`OpenAIProviderOptions.defaultModerationModel?` validated at
construction; unsupported model throws synchronously. Input
accepts `string | readonly string[]` (batch up to 32 strings
per OpenAI's docs); per-call `model` override checked at call
time. Use cases: pre-screen user input before paying for a
chat call ($0.0001 moderation vs $0.005+ chat), bulk content
audits, soft-threshold risk scoring. Provider-specific method
(not on `LlmProvider` interface) because Anthropic + Bedrock
don't expose standalone moderation endpoints. M6.6 migrates `@crossengin/ai-router`
to use the kernel cross-provider helpers, validating M2.X.6.x
+ M2.X.7 with a real non-test consumer + closing a latent bug
exposed by M2.X.5. Three coordinated changes in retry.ts +
router.ts: (1) retry.ts's local `isRetryableError` becomes a
hybrid predicate — checks kernel's kind-based `isRetryableError`
first (the M2.X.7 path); falls back to the legacy `isRetryable()`
method-based duck-typing for compat with custom error classes.
(2) router.ts's `isRouterRetryable` gains an explicit
`isModerationError(err) → false` early-exit BEFORE delegating
to `isRetryableError`. Documents intent: moderation events
never trigger fallback to alternate providers (the input
itself triggered the policy violation; switching providers
won't help). Pre-M6.6 the correct behavior was accidental
(moderation errors return false from each provider's
`isRetryable()`); post-M6.6 it's explicit + tested. (3)
`estimateRequestTokens` bug fixed — was using
`m.content.length` which broke after M2.X.5 (returned block
count for array content, not char count); now uses
`contentToText(m.content).length` which handles both string +
LlmContentBlock[] shapes correctly. Three new router tests
verify: refusal from primary does NOT trigger fallback;
guardrail_intervened same; rate_limit_error DOES trigger
fallback. Six new retry tests verify the kernel-kind shape
works: errors with `.kind: "rate_limit_error" |
"network_error" | "model_stream_error"` are classified
retryable; moderation kinds + auth_error are not. All 51
existing router tests + 14 existing retry tests pass
unchanged. M2.X.7 adds a kernel-level
cross-provider retryability helper to `@crossengin/ai-providers`,
mirroring M2.X.6.x for the second cross-cutting error concern.
Closes ADR-0087 Q3. New `retryable.ts` module exports
`RETRYABLE_ERROR_KINDS` const tuple ([rate_limit_error,
overloaded_error, network_error, timeout_error, api_error,
model_stream_error] — the UNION of all three providers'
retryable sets; Bedrock-specific model_stream_error included so
kernel agrees with Bedrock's local classification),
`RetryableErrorKind` type, `RetryableDiscriminator` interface,
`isRetryableErrorKind(value)` string discriminator, and the
headline predicate `isRetryableError(err): err is Error &
{kind: RetryableErrorKind}`. Same duck-typing approach as
`isModerationError`: inspects `err.kind` against the shared
tuple. No changes to provider error classes; their existing
local `RETRYABLE_KINDS` sets + `isRetryable()` methods continue
to work. Cross-package integration tests in all three real
providers verify the kernel helper agrees with the provider's
local isRetryable() method for each shared kind; moderation +
auth kinds correctly return false. Symmetric API surface:
operators have parallel discriminators `isModerationError` +
`isRetryableError`, both narrow `.kind`, both work across
providers, neither requires provider-package imports. Pattern
set for future third cross-provider concern. M2.X.5.x adds `tool_use` +
`tool_result` content block variants to the kernel
`LlmContentBlock` discriminated union, consolidating the
tool-call surface. New types in `@crossengin/ai-providers/src/
types.ts`: `ToolUseContentBlock` (`{type: "tool_use", id, name,
input}`), `ToolResultContentBlock` (`{type: "tool_result",
toolUseId, content, status?: "success" | "error"}`), and the
`TOOL_RESULT_STATUSES` const tuple. LlmMessageSchema's
superRefine validates role-bound semantics: tool_use only on
assistant role, tool_result only on user or tool role, image
NOT allowed on tool messages (text-only by convention). All
three provider translators handle the new blocks: Bedrock
emits `{toolUse: {toolUseId, name, input}}` and `{toolResult:
{toolUseId, content: [{text}], status?}}`; Anthropic emits
`{type: "tool_use", id, name, input}` and `{type: "tool_result",
tool_use_id, content}`. OpenAI required a flatMap refactor —
`translateMessage` now returns `OpenAIChatMessage[]` because a
single kernel user message with tool_result blocks splits into
multiple OpenAI messages (tool-role per result + user-role with
remaining text). buildOpenAIChatRequest switched from `.map` to
`.flatMap`. Hybrid support: a single assistant LlmMessage can
mix the legacy `toolUses` field with inline `tool_use` content
blocks; OpenAI merges both into one `tool_calls` envelope array.
Bidirectional field compat: the legacy `LlmMessage.toolUses`
field + `role: "tool"` messages continue working unchanged;
operators can mix legacy + canonical patterns. Unblocks
parallel tool calls in a single assistant turn, bundled tool
results in a single user turn, and arbitrary text/tool
interleaving without losing order. M2.X.5 lifts the kernel
`LlmMessage.content` from `string` to a discriminated union
`string | LlmContentBlock[]`, closing the M2.X asymmetry where
user messages could carry images (via `attachments`) but
assistant messages could only emit text. New types in
`@crossengin/ai-providers/src/types.ts`: `TextContentBlock` +
`ImageContentBlock` (flat shape `{type, format, bytes}`
matching ImageAttachment for symmetry), `LlmContentBlock`
discriminated union, `LlmContent` union, and four helpers —
`isStringContent`, `isBlockContent`, `normalizeContent`
(string → `[{type: "text", text}]`), `contentToText` (extracts
text from blocks, joins, ignores images). LlmMessageSchema's
superRefine gains validation: array content + attachments
together is REJECTED (mutually exclusive); string content +
attachments still valid (M2.X backwards compat). Empty arrays
rejected via `.min(1)`. All three provider message-builders
gained a private `appendKernelBlocks(out, content)` helper
that branches on `typeof content` — Bedrock pushes
`{text}` / `{image: {format, source: {bytes}}}`, Anthropic
pushes `{type: "text", text}` / `{type: "image", source:
{type: "base64", media_type: "image/<format>", data}}`,
OpenAI pushes `{type: "text", text}` / `{type: "image_url",
image_url: {url: "data:image/<format>;base64,<bytes>"}}`.
Assistant messages with array content now emit provider-
native content arrays instead of strings — unblocks image-
generation responses and any future multimodal assistant
output. Backwards compat: 90+ existing string-content call
sites pass unchanged; verified by full pre-M2.X.5 test suite
running at 6,588. The OpenAI Responses API path uses
`contentToText` throughout (its top-level shape doesn't
support inline image parts the same way; image content is
silently dropped — future M2.8.6). Pattern set for future
content variants (audio / video / document) — append to the
discriminated union + update each provider's translator. M2.X.6.x adds a kernel-level
cross-provider moderation helper to `@crossengin/ai-providers`,
closing ADR-0084 Q7 + ADR-0086 Q3. New `moderation.ts` module
exports `MODERATION_ERROR_KINDS` const tuple ([
"guardrail_intervened", "content_filtered", "refusal"] — the
union of moderation-event kinds across Bedrock, OpenAI, and
Anthropic), `ModerationErrorKind` type, `ModerationDiscriminator`
interface, `isModerationErrorKind(value)` string discriminator,
and the headline predicate
`isModerationError(err): err is Error & {kind: ModerationErrorKind}`.
Duck-typing approach: inspects `err.kind` against the shared
tuple; works against any error class whose `.kind` matches the
moderation slice. No changes to provider error classes —
`BedrockGuardrailViolationError`, `OpenAIContentFilteredError`,
`AnthropicRefusalError` are byte-identical to M2.9.8 / M2.X.6;
they already set `.kind` to the right string values. Type
narrowing: inside the predicate's true branch, `err.kind`
narrows to `ModerationErrorKind` — verified by a TS assignment
test. Robust against non-Error inputs (null / undefined /
primitives / objects without `kind` / objects with non-string
`kind`). Cross-package integration tests in all three real
providers verify their error classes flow through the kernel
helper. Operators using the router catch one error shape
instead of three:
  if (isModerationError(err)) auditViolation(err.kind);
Pattern set for future kernel-level cross-provider helpers
(retryability, token-limit detection). Forward-compatible: a
fourth provider's novel moderation kind just gets appended to
the tuple. M2.X.6 ships parallel moderation
surfaces in `@crossengin/ai-providers-openai` and
`@crossengin/ai-providers-anthropic`, matching M2.9.8's pattern.
New `moderation.ts` module in each package exports a typed
error class (`OpenAIContentFilteredError extends OpenAIError`,
`AnthropicRefusalError extends AnthropicError`) plus
discriminator helpers (`isContentFilterFinishReason` /
`isContentFilteredResponse`, `isRefusalStopReason` /
`isRefusalResponse`) and the relevant stop-reason constants
(`OPENAI_CONTENT_FILTER_FINISH_REASON = "content_filter"`,
`ANTHROPIC_REFUSAL_STOP_REASON = "refusal"`). Both providers'
`_ERROR_KINDS` grow by one (`content_filtered` /  `refusal`);
neither is in `RETRYABLE_KINDS`. Schema extension: Anthropic's
`AnthropicResponse.stop_reason` union now includes `"refusal"`
(OpenAI's `finish_reason` already had `"content_filter"`).
Streaming detection: both `chunksFromSse` / `readSseStream`
generators track a contentFiltered / refused flag in stream
state; at the appropriate event (`finish_reason: "content_
filter"` for OpenAI, `message_delta.delta.stop_reason: "refusal"`
for Anthropic), set the flag without throwing; after yielding
`usage_final` normally, throw the typed error. Same
post-usage_final-throw ordering as M2.9.8 — cost accounting
flows even on moderation. Non-streaming asymmetry preserved:
`completeNonStreaming` returns the raw response; callers use
the discriminator helpers to detect. Cross-provider error
landscape: all three real providers now throw non-retryable
typed errors on moderation events. The shared `content_filtered`
kind name between Bedrock + OpenAI is intentional — operators
classifying logs by `error.kind` get matching coverage.
ADR-0084 Q7 (cross-provider abstraction) now has three concrete
data points to reason about; revisit in future M2.X.6.x if
patterns stabilize. Zero kernel changes: `CompletionRequest`,
`CompletionChunk`, `LlmProvider` interface — all untouched.
M2.9.8.x adds two new public methods
to BedrockProvider for per-request guardrail override:
`completeWithGuardrail(req, guardrailOverride?)` (streaming) +
`completeNonStreamingWithGuardrail(req, guardrailOverride?)`
(non-streaming). Three-state override semantics:
`BedrockGuardrailConfig` → use this config (validated at call
time via buildBedrockGuardrailConfig); `null` → explicitly
DISABLE the provider's default guardrail for this request;
`undefined` (or omitted) → fall back to provider default.
Closes ADR-0084 Q3. Internal refactor: `complete()` and
`completeNonStreaming()` now delegate to private
`completeInternal` / `completeNonStreamingInternal` taking the
effective resolved guardrail explicitly; the duplicated
`guardrailConfig` spread sites are unified. Validation timing
preserved: bad override identifier/version/trace throws BEFORE
the fetch (rejected promise for non-streaming). The kernel
`LlmProvider.complete(req)` interface is untouched — operators
wanting per-request overrides use the Bedrock-specific
sibling methods directly, bypassing the router. Operationally
unblocks: per-tenant guardrail tiers (Bronze/Gold compliance
packs), A/B testing content policies, admin escape hatches
(`null` override skips filtering for security-ops inspection),
mixed-sensitivity workloads (trial users get stricter PII
redaction than enterprise customers). M2.9.8 wires AWS Bedrock Guardrails
into `@crossengin/ai-providers-bedrock` as an opt-in safety
surface. New `guardrails.ts` module exports
`BedrockGuardrailConfig` ({guardrailIdentifier, guardrailVersion,
trace?: "enabled"|"disabled"}), `buildBedrockGuardrailConfig`
(slug-regex validator: identifier `^[a-z0-9]{6,16}$`, version
`^(DRAFT|[1-9][0-9]{0,4})$`), `BedrockGuardrailViolationError
extends BedrockError` (carries `stopReason` ∈
{guardrail_intervened, content_filtered} + optional `trace`),
plus discriminators `isBedrockGuardrailInterventionStopReason`
+ `isGuardrailInterventionResponse`. `BEDROCK_ERROR_KINDS`
grows by two — both non-retryable. `BedrockConverseRequest`
gains optional `guardrailConfig` field; `buildBedrockConverse
Request` threads it from `BuildConverseRequestOptions`; OMITTED
from request body when undefined (byte-identical to pre-M2.9.8
for unguarded providers). `BedrockProviderOptions.guardrailConfig?`
validates at construction time (fast-fail on bad config); stored
on the instance; passed to both `complete()` (streaming) and
`completeNonStreaming()`. The event-stream parser now tracks a
`ConverseStreamState` ({toolBlocks, pendingIntervention,
guardrailTrace}) instead of just a Map. At `messageStop` with an
intervention `stopReason`, the parser SETS the pending flag but
does NOT throw — `metadata` event still fires + yields
`usage_final` for cost accounting; the parser also pulls
`trace.guardrail` if present. AFTER the stream loop ends with
pendingIntervention set, throws `BedrockGuardrailViolationError`
{stopReason, trace}. Consumer ordering: text/tool chunks →
usage_final → throw. Non-streaming asymmetry: returns the raw
`BedrockConverseResponse` with `stopReason` already typed to
include the intervention values; callers inspect via
`isGuardrailInterventionResponse(response)` rather than catching
an error. `BedrockGuardrailViolationError extends BedrockError`
so `instanceof BedrockError` keeps working; the `kind` field
discriminates. Router automatically treats guardrail violations
as terminal (no retry burn). M4.10.x adds a `--by-source-pack`
flag to `gateway routes unregister-pack`, exposing M4.10's
`deleteByPackSlug` API at the CLI. When set, the entire
manifest pipeline (resolvePack → resolveManifest →
tryValidateManifest → generatePackRoutes) is skipped; the
handler issues a single `DELETE WHERE source_pack = $1`
(or `listByPackSlug` + table render under --dry-run).
Operationally unblocks three real scenarios: decommissioned
packs (slug no longer in the registry → resolvePack would
throw UnknownPackError), broken manifests (resolveManifest
fails on ExtendsCycle / UnknownParent), and forgotten old
versions (manifest changed; M4.8.x's default path would only
delete the CURRENT generation, leaving old routes orphaned).
Slug validation is enforced at the CLI boundary via the same
regex as the DB CHECK + zod schema (`^[a-z][a-z0-9-]*
(\/[a-z][a-z0-9-]*)*$`); invalid slug → exit 2. Dispatcher
short-circuit updated: `--by-source-pack` always needs PG (the
--dry-run path reads via listByPackSlug), so the
register-pack/unregister-pack PG-free short-circuit excludes
`unregister-pack --by-source-pack`. Output shapes: human
"deleted N route(s) where source_pack = 'X'" (live) or
"-- dry-run: N route(s) would be deleted (by source_pack =
'X')" (preview); JSON {pack, bySourcePack: true, deleted,
dryRun} (live) or {pack, bySourcePack: true, count, dryRun:
true, routes[{id, method, operationId}]} (preview). The
`bySourcePack: true` field is the schema discriminator for
consumers parsing M4.8.x vs M4.10.x output. Existing M4.8.x
default path unchanged — verified by test: `unregister-pack
<slug>` without the flag still issues N per-id DELETEs from
the manifest-derived ID set. M4.10 adds a `source_pack TEXT`
column (nullable + indexed + slug-pattern CHECK) to
META_GATEWAY_ROUTES, closing the three open questions across
ADR-0079/0080/0081 about which pack owns which route. The
column is set by `generatePackRoutes` to the pack slug on
every CRUD + transition route; routes registered via
`gateway routes register <route.json>` default to NULL.
`RouteDefinitionSchema` gains `sourcePack: z.string().regex
(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/).max(120).nullable
().default(null)`. `PostgresRouteRegistry` upsert grows to
16 INSERT params + ON CONFLICT writes `source_pack =
EXCLUDED.source_pack`; new methods `listByPackSlug(slug)` +
`deleteByPackSlug(slug): Promise<number>` add bulk
source-attribution queries; all three SELECT call sites
(`listAll`, `loadCompiled`, `listByPackSlug`) factor through
a shared `SELECT_COLUMNS` constant. `runRoutesSyncPack`
classification expands from three buckets to four: `added`
(generated − stored), `persistent` (generated ∩ stored),
`obsolete` (stored with sourcePack === slug, not in current
generation — SAFE to prune), `external` (stored with
sourcePack !== slug or NULL — NEVER pruned). New flag
`--prune-obsolete` opt-in deletes obsolete routes; safely
no-ops on legacy NULL-attributed routes. JSON shape gains
{obsolete, obsoleteIds[], pruned, pruneObsolete} alongside
the existing {added, persistent, external, externalIds[]}.
Human output names the obsolete bucket separately with
"use --prune-obsolete to delete" hint. Backwards compatible:
pre-M4.10 routes survive with NULL source_pack (no
auto-classification); operators backfill by re-running
register-pack which now writes the slug via ON CONFLICT.
Eleven RouteDefinition construction sites across 9 files
updated to include `sourcePack: null` — TS strict catches
any missed site at compile time. M4.8.y completes the three-verb
gateway-routes pack vocabulary: `crossengin gateway routes
sync-pack <slug> [--api-version v1] [--dry-run] [--created-by
<uuid>]`. Re-generates the desired route set, calls
`registry.listAll()` for the stored set, classifies route IDs
into three buckets: `added` (generated but not stored —
will be upserted), `persistent` (in both — will be refreshed
via upsert), `external` (in stored but not generated — left
alone, reported). Upserts all generated routes (both buckets);
NEVER deletes external routes — without a `source_pack`
column or previous-manifest snapshot we cannot reliably
classify them as "obsolete from this pack" vs "from a
different pack" vs "operator-curated." sync-pack ALWAYS needs
PG (even --dry-run reads the stored set for the diff) —
documented departure from M4.8 / M4.8.x where --dry-run was
PG-free. Output shapes: human "synced N route(s) for pack 'X'
(A added, B refreshed[, C external — left alone])" with
optional external-IDs list, JSON {pack, dryRun, total, added,
persistent, external, externalIds[]}; dry-run human prints
three sections (added / refreshed / external) with rt_<hex> +
method + path + operationId per row. Idempotent by design:
second invocation on unchanged manifest reports (0 added, N
refreshed, 0 external) and writes N upserts. CI-grade: one
command per deploy step that's safe to re-run. M4.8.x ships the companion to M4.8:
`crossengin gateway routes unregister-pack <slug> [--api-
version v1] [--dry-run]`. Same generation pipeline as
register-pack (resolvePack → resolveManifest →
generatePackRoutes) but instead of `registry.upsert` per
route, it calls `registry.deleteByRouteId(r.route.id)` —
re-deriving the deterministic hash IDs guarantees we look up
exactly the rows register-pack would have created. Soft-fail
semantics: missing routes report as `notFound` rather than
erroring (re-running idempotently surfaces "unregistered 0 of
N (N not found — already removed)"). Skips
tryValidateManifest — operators tearing down a pack don't need
post-resolve validation. Dispatcher short-circuit extended to
cover `unregister-pack --dry-run` so operators preview without
PG. Output shapes: human "unregistered N of M route(s) for
pack 'X'" (optional partial-miss suffix), JSON {pack,
attempted, deleted, notFound, notFoundIds[]}; dry-run human
prints rt_<hex> + method + path + operationId, dry-run JSON
emits {pack, count, dryRun, routes[{id, method, operationId}]}.
End-to-end verified: `crossengin gateway routes
unregister-pack operate-erp/payments --dry-run` emits the
34-row route-ID list without touching PG. M4.8 closed M4.7's manifest-driven
route-registration open question. New
`apps/architect-cli/src/gateway-pack-routes.ts` exports a pure
`generatePackRoutes({manifest, packSlug, apiVersion?})`
function that derives `RouteDefinition[]` from the resolved
manifest: 5 standard CRUD routes per entity
(list/read/create/update/delete with appropriate HTTP method +
idempotency + scope) plus one route per `entityLifecycle`
workflow transition (`POST /v1/<plural>/:id/transitions/<name>`).
Pluralizer kebabifies CamelCase + adds `s` (or `ies` for
consonant+y endings); `entityKey` produces snake_case for
operationIds + scopes. `routeIdFor({packSlug, operationId})`
emits `rt_<sha256(...).slice(0,16)>` — deterministic, regex-
safe, collision-free within a pack. New CLI action:
`crossengin gateway routes register-pack <slug>
[--api-version v1] [--dry-run] [--created-by <uuid>]` resolves
the pack via the M7.6.5 packManifestRegistry, validates
post-resolve via tryValidateManifest, generates the route
list, and either upserts every row via `PostgresRouteRegistry
.upsert` (registered N route(s) for pack '<slug>') or prints
the route table without writing (`--dry-run`). The dispatcher
short-circuits the `--dry-run` path before resolving the
registry so operators can preview routes without a running
database. Three packs immediately bulk-deployable:
core → 24 routes (4 entities × 5 CRUD + 4 invoice transitions);
payments resolved → 34 (+1 entity, +5 payment transitions);
healthcare resolved → 47 (+2 entities, +5 encounter, +3
observation transitions). End-to-end verified:
`crossengin gateway routes register-pack operate-erp/
healthcare --dry-run` emits the 47-row route table without
touching PG. M2.X closed M2.9.7 Q1 by extending the kernel
`LlmMessage` schema with `attachments?: MessageAttachment[]`
and threading vision content blocks through all three real
providers. New types in `@crossengin/ai-providers/src/types.ts`:
`IMAGE_ATTACHMENT_FORMATS = [png, jpeg, gif, webp]`,
`ImageAttachmentSchema`, `MessageAttachmentSchema`
(discriminated union on `kind`; only `"image"` today, but
audio/video/document slot in cleanly), `imageMediaType(format)`
helper. `LlmMessageSchema.superRefine` rejects attachments on
non-user roles at parse time. `ProviderCapabilitiesSchema`
gains `vision: z.boolean().default(false)`. All three real
providers flip `vision: true`; mock provider keeps false.
Provider translators wired:
`@crossengin/ai-providers-anthropic/messages-api.ts` user
branch emits `content: [{type: text}, {type: image, source:
{type: base64, media_type: image/<format>, data}}]` when
attachments present, falls back to string content otherwise;
`AnthropicContentBlock` discriminated union grows the image
variant. `@crossengin/ai-providers-openai/chat-api.ts`
`OpenAIChatMessage.content` widens to `string | null |
OpenAIContentPart[]`; user branch emits
`[{type: text}, {type: image_url, image_url: {url:
data:image/<format>;base64,<bytes>}}]`;
`extractTextFromResponse` joins text parts + ignores image_url
parts on content-part responses (forward-compat for vision
model outputs). `@crossengin/ai-providers-bedrock/converse-
api.ts` user branch appends `BedrockImageContentBlock` entries
(the type already existed from M2.9.7) — kernel-side
attachments now flow into the Bedrock builder's content array.
Router's `unionCapabilities` ORs `vision` across configured
providers so the chat substrate sees the union flag. Backward
compat: messages without attachments produce byte-identical
provider requests; existing 6,396 tests unchanged. M2.9.7 closed M2.9.5 Q6 by shipping Bedrock multimodal
embeddings (`amazon.titan-embed-image-v1`) + chat image content
block types. Two new surfaces in `@crossengin/ai-providers-
bedrock`, all additive, zero kernel changes. First — new
provider-native method `embedMultimodal({model?, text?, image
Base64?, dimensions?})` POSTs to `/model/amazon.titan-embed-
image-v1/invoke` with sig-v4. Takes EITHER text OR image OR
both; returns `{vector, dim, model, usage: {inputTextTokens,
imageCount, cost}}`. Dual billing: $0.80/M text tokens + flat
$0.00006 per image (combined inputs sum both tracks). 256/384/
1024-dim output (default 1024). New types in pricing.ts:
`BEDROCK_MULTIMODAL_EMBEDDING_MODELS`,
`BedrockMultimodalEmbeddingPricing`,
`computeBedrockMultimodalEmbeddingCost`,
`buildBedrockMultimodalEmbeddingUsage`,
`isBedrockMultimodalEmbeddingModel`. `BedrockModel` union
expands to three families (chat / embedding / multimodal
embedding); `isBedrockModel` accepts all three. `embed()` (the
kernel-facing method) now rejects `model: "amazon.titan-embed-
image-v1"` with a redirect error pointing to `embedMultimodal`
— catches the typo case that would silently pick the wrong
billing track. Second — Bedrock chat `BedrockImageContentBlock`
type added to the discriminated union (`{image: {format,
source: {bytes}}}`); `BEDROCK_IMAGE_FORMATS = [png, jpeg, gif,
webp]`; `buildBedrockImageBlock({format, imageBase64})` factory;
`isBedrockImageFormat` discriminator. `extractTextFromConverse
Response` + `extractToolCallsFromConverseResponse` skip image
blocks via the existing `"text" in block` / `"toolUse" in
block` discriminators (regression-tested). No
`buildBedrockConverseRequest` wiring yet — the kernel
`LlmMessage.content: string` is text-only; the types are ready
for a future M2.X kernel extension that adds structured
content. M2.9.6 closed M2.9 Q3 + M2.9.5 Q4 with two additive opt-in
features for the Bedrock provider. First — kernel-level
`CompletionRequest.cacheControl` now threads into Bedrock
`cachePoint` content blocks: `systemPrompt` and/or `toolSchemas`
appends a cachePoint to the end of the `system` array;
`conversationHistory` appends one to the penultimate message's
content (no-op when `messages.length < 2`); `retrievedContext`
appends one to the last message's content. Three independent
placements; operators set any combination. Anthropic-on-Bedrock
+ Claude 3.5/3.7/Opus 4 get the documented 90%-off cached-
input rate at $0.30/$1.50/$0.30 per million via the existing
`BEDROCK_CHAT_PRICING[model].cachedInputUsdPerMillion` path —
no extra cost-accounting work. New types:
`BedrockCachePointBlock`, `BEDROCK_CACHE_POINT` constant,
`isCachePointBlock` discriminator. `extractTextFromConverse
Response` + `extractToolCallsFromConverseResponse` already
discriminate via `"text" in block` / `"toolUse" in block`,
so cachePoint blocks fall through silently (regression-tested).
Second — `titanConcurrency` constructor option (default 4,
range [1, 100]) parallelizes the Titan single-text-only loop
in `embedViaTitan`. Refactored from sequential `for (const
text of texts)` to chunked Promise.all (chunks of `titan
Concurrency` size), preserving input order via pre-allocated
result array indexed by request position regardless of
completion order. Cohere unchanged — its native batching
(96 texts per call) already covers parallelism for that
family. M4.7.6 closed
M4.7.5's two follow-up questions: cloud-IdP-friendly JWKS URL
fetching + hot-reload. `apps/architect-cli/src/gateway-jwks.ts`
gained `loadJwksFromUrl(url, opts?)` (injectable FetchLike,
10s default timeout, AbortSignal-translated to typed
JwksLoadError on timeout), `normalizeJwksEntry` accepts BOTH
CrossEngin-native `{kid, publicKeyBase64}` AND RFC 7517 OKP/
Ed25519 `{kid, kty: "OKP", crv: "Ed25519", alg?: "EdDSA",
x: <base64url>}` entries (RSA / EC / oct rejected at parse
time with a clear EdDSA-only message), and a `Refreshable
JwksProvider` class wrapping an initial provider + a loader
function; `refresh()` atomically swaps the inner pointer on
success, keeps old keys on loader failure, and exposes
`startPeriodicRefresh({intervalMs, onResult})` /
`stopPeriodicRefresh()` (timer `.unref()`'d so it doesn't
keep the event loop alive). `runGatewayStart` integrated:
new flags `--jwks-url <url>` (mutually exclusive with
`--jwks-file`) and `--jwks-refresh-seconds <n>` (range [0,
86400]; defaults to 300 in URL mode, 0 in file mode where
SIGHUP is the reload path). After server boot the runtime
installs a SIGHUP handler + a periodic-refresh interval if
configured; both emit structured `{kind: "jwks_refresh",
source, ok, error?}` events (NDJSON in JSON format mode,
human prints otherwise). Initial JWKS load is hard-fail (exit
2 with typed JwksLoadError); subsequent refreshes are soft-
fail (old keys retained on loader error). `GatewayContext`
gained two test seams — `jwksFetch?: FetchLike` and
`registerReloadHandler?` — so the URL + SIGHUP paths are
exhaustively tested without real network/signals. End-to-end
verified: `crossengin gateway start --jwks-url http://...
--jwks-refresh-seconds 1` boots; SIGHUP triggers a
`jwks_refresh` event; periodic refresh fires every second.
RSA/oct JWKS endpoints, fs.watch hot-reload, lazy-on-miss
refresh, cached-on-disk JWKS responses, and per-tenant JWKS
isolation deferred to M4.7.7+. M4.7.5 closed M4.7's
two biggest open questions: JWT auth + routes management. New
`apps/architect-cli/src/gateway-jwks.ts` loads JWKS keys from a
JSON file shaped `{keys: [{kid, publicKeyBase64}, ...]}` and
returns an `InMemoryJwksProvider`; `resolveJwtFlags` is the
flag-glue layer that validates the all-or-nothing constraint
(`--jwks-file` requires both `--jwt-issuer` + `--jwt-audience`;
JWT options without `--jwks-file` are rejected with exit 2).
`runGatewayStart` resolves JWT flags BEFORE building the
runtime and spreads them via `jwtRuntimeOptions(jwt)` into the
`GatewayRuntime` constructor (both in-memory and Postgres
modes). New `gateway-routes.ts` adds `crossengin gateway routes
<list|register|unregister>` mirroring the M5.9 sessions
subcommand pattern — list renders a 7-column table (route_id /
method / path / version / operation / scopes / deprecated) or
JSON; register reads a JSON file, validates via
`RouteDefinitionSchema.parse()`, calls `registry.upsert`;
unregister deletes by route id with proper exit-code semantics.
`PostgresRouteRegistry` gained two additive methods —
`listAll()` returning RouteDefinition[] sorted by api_version /
method / route_id, and `deleteByRouteId(routeId)` returning
boolean + invalidating the cache. End-to-end verified:
`crossengin gateway start --jwks-file /tmp/jwks.json --jwt-
issuer X --jwt-audience Y` boots with JWT auth wired; anonymous
GET /__ping returns 200 (empty scopes); malformed Bearer
returns 401 + RFC 9457 problem detail with WWW-Authenticate
challenge. Documented constraint: the CrossEngin JWT verifier
accepts EdDSA only with base64-encoded public keys — different
from RSA JWKS most IdPs emit. URL-fetched JWKS, hot-reload, RSA
support, and bulk route management deferred to M4.7.6+. M6.5.6 wired the M2.9 / M2.9.5 Bedrock
provider into `architect-cli`'s `chat` subcommand by extending
`router-setup.ts` env-var detection. `AWS_ACCESS_KEY_ID` +
`AWS_SECRET_ACCESS_KEY` (required pair) plus optional
`AWS_SESSION_TOKEN` (STS) + `AWS_REGION` / `AWS_DEFAULT_REGION`
(default us-east-1) trigger BedrockProvider construction.
`DEFAULT_TASK_POLICIES` extended so every task fallback chain
ends with a Bedrock entry — planner adds `bedrock/anthropic.
claude-opus-4-20250514-v1:0`, executor adds Sonnet-on-Bedrock,
summarizer/diff-narrator/rerank/classifier add Haiku-on-
Bedrock, and the previously-empty embedding fallback gains
`bedrock/amazon.titan-embed-text-v2:0` at the same $0.02/M as
OpenAI's text-embedding-3-small. The `filterPoliciesByAvailable`
filter strips Bedrock entries when AWS env is unset — tenants
running with one or two providers see the same single/two-way
router behavior as before. New `resolveBedrockDefault(forceModel)`
helper mirrors the Anthropic + OpenAI ones. Three-key envs
return a 3-provider router with `availableProviders: ["anthropic",
"openai", "bedrock"]` for real failover diversity across
independent control planes. Help text + NoProvidersConfiguredError
message now mention all three credential paths. M2.9.5 closed M2.9's open Q4 by
implementing `embed()` for the Bedrock provider. New
`embeddings.ts` module dispatches on model family — Amazon Titan
(`amazon.titan-embed-text-v2:0` at $0.02/M with selectable 256 /
512 / 1024 dimensions, `amazon.titan-embed-text-v1` at $0.10/M)
uses a single-text-only `InvokeModel` request shape and the
provider loops over `texts: string[]`; Cohere (`cohere.
embed-english-v3` / `cohere.embed-multilingual-v3` at $0.10/M)
uses a batched `{texts, input_type}` request and the provider
makes one call per batch (max 96 per AWS). Token counts come
from Titan's `inputTextTokenCount` or Cohere's `meta.
billed_units.input_tokens` when reported; falls back to
ceil(chars/4) approximation otherwise. `BedrockProvider`
capabilities flip `embedding: false → true`; `models` expands
from 8 to 12 (4 new embedding models); constructor gains
`defaultEmbeddingModel` (default titan-embed-text-v2:0),
`defaultEmbeddingDimensions` (Titan v2 only — 256/512/1024),
`defaultCohereInputType` (search_document/_query/classification/
clustering). Same sig v4 path as chat; both endpoints hit
`POST /model/{modelId}/invoke`. Cost rounds to 6 decimals;
output_tokens always 0 for embeddings. Router (M6.5) now has a
second embedding-capable provider — operators serving non-
English markets can route `task: "embedding"` to
`cohere.embed-multilingual-v3` for 100+ language coverage while
keeping OpenAI's `text-embedding-3-small` as fallback. AWS-
native end-to-end story closed: a tenant with strict residency
requirements can now serve both chat completion AND vector
search entirely inside their AWS account in their region. M2.9 shipped the third real `LlmProvider` —
`@crossengin/ai-providers-bedrock`. AWS Bedrock converse-stream
client implementing the same contract as M2.7 (Anthropic) +
M2.8 (OpenAI). Zero runtime deps — pure `fetch` + `node:crypto`
with from-scratch AWS Signature V4 (verified against the
AWS-documented `f4780e2d...` reference signing key). 6 modules:
pricing (8 chat models — Claude on Bedrock matches first-party
pricing including 90%-off cached input + Llama 3.1 70B/405B +
Mistral Large 2407 + Titan Text Premier; per-million rates +
6-decimal cost rounding), signing (AWS sig v4 with HMAC chain
kSecret → kDate → kRegion → kService → aws4_request,
URI-encoded canonical request, signed headers always include
host + x-amz-date + x-amz-content-sha256), converse-api
(CompletionRequest → BedrockConverseRequest: system messages
lifted to top-level system array, assistant.toolUses translated
to content blocks with toolUseId, tool-role messages folded
back as user messages with toolResult blocks per Bedrock's
quirk), event-stream (AWS event-stream BINARY frame parser —
4-byte BE length prelude + headers + JSON payload + CRC, NOT
SSE; parses headers byte-by-byte, dispatches on
`:event-type` to map messageStart / contentBlockStart /
contentBlockDelta / contentBlockStop / messageStop / metadata →
CompletionChunk; tracks contentBlockIndex → toolUseId across
deltas; throws BedrockError on `:message-type: exception`),
errors (12 typed kinds including `model_stream_error` for
ModelStreamErrorException; CODE_TO_KIND maps 15 AWS exception
classes — ThrottlingException, ValidationException,
ServiceUnavailableException, ExpiredTokenException etc. — to
kernel-level kinds; same isRetryable shape as M2.7 / M2.8),
provider (BedrockProvider class with complete() +
completeNonStreaming() + embed() rejects with typed error
directing to OpenAI; constructor accepts accessKeyId +
secretAccessKey + optional sessionToken + region + clock
injectable for sig v4 testing). Residency derived from region
prefix (us-* → ["us"], eu-* → ["eu"], ap-*/me-* → ["ap"], sa-*
→ ["sa"]). Capabilities: `{chat: true, streaming: true,
toolUse: true, jsonMode: false, embedding: false,
maxContextTokens: 200_000}`. Router (M6.5) now has three real
providers to chain — failover diversity across three
independent control planes (Anthropic + OpenAI + AWS). Titan
embeddings + JWKS-style OIDC role assumption + automatic env
detection in CLI deferred to M2.9.5 / M6.5.6. M7.9 shipped the third vertical pack — `@crossengin/pack-erp-
healthcare`. Three FHIR-shaped entities (Patient with auditable +
tenant_owned + 12 user fields including mrn unique-per-account,
sex_assigned_at_birth, blood_type, allergies, preferred_language,
emergency contact; Encounter referencing Patient with FHIR
EncounterClass enum + 6-state lifecycle scheduled → checked_in →
in_progress → completed | cancelled | no_show; Observation
referencing both Encounter and Patient with code_system enum
matching LOINC/SNOMED/ICD-10 + value_quantity decimal(18,6) +
FHIR R4 ObservationStatus). Three relations: Account → Patient,
Patient → Encounter restrict, Encounter → Observation cascade.
Two new role contributions: erp_clinician + erp_front_desk merge
with core's three. Two lifecycle workflows: encounter_lifecycle
(5 transitions + 2 SLAs; only mark_no_show is automatic for the
sweep job) and observation_lifecycle (4 states matching FHIR R4
exactly; mark_in_error is admin-only for amendment discipline).
Three jobs: daily encounter-reminder, 15-min no-show-sweep,
event-triggered FHIR R4 export on `healthcare.encounter.
completed`. compliancePacks defaults to ["hipaa", "21_cfr_11"].
Registered in architect-cli's pack registry; `crossengin apply
--pack=operate-erp/healthcare` emits 65 pack statements
covering all 7 entities (4 core + 3 healthcare) with M7.7
tenant scoping intact, exercises the M7.6.5 resolver with a
second downstream consumer. M4.7 closed
the substrate-to-binary loop for the gateway pillar.
`crossengin gateway start [--port N] [--host A] [--in-memory]`
boots the M4 `GatewayRuntime` against a Node `http.createServer`
and the M4.5 Postgres-backed stores (idempotency / route registry
/ rate limit / pipeline executions). Built-in routes `GET /__ping`
+ `GET /__health` register at startup with `requiredScopes: []`
and `idempotencyRequired: false` so the server is responsive even
with an empty route registry; both flow through the full 17-stage
pipeline. New modules: `apps/architect-cli/src/gateway.ts` (CLI
entry + runtime construction), `gateway-server.ts` (Node HTTP
adapter — `buildIncomingFromNode`, `writeOutgoing`, `readBody`
with 1 MB cap, `generateRequestId` returning `req_<24-hex>`), and
`gateway-handlers.ts` (`platform.ping` + `platform.health`
handlers). `--in-memory` swaps PG adapters for in-memory
equivalents; default mode reads `PGHOST/PGDATABASE/...` env vars
and persists pipeline executions to `meta.gateway_pipeline_
executions`. `PostgresRouteRegistry.ensureLoaded()` runs as a
per-request `beforeHandle` so the route cache stays warm. SIGINT
/ SIGTERM trigger graceful shutdown — server closes, PG connection
closes, exit 0. End-to-end verified: `curl http://127.0.0.1:14250
/__ping` returns 200 + `{status:"ok",at:<ISO>}`; `/__health`
reports `uptimeSeconds` since boot; `/nope` returns 404 via the
gateway's `match_route` stage. JSON format mode emits NDJSON-
style records (`{kind:"started",...}` on boot, one
`{kind:"request",...}` per request). JWT mode + manifest-driven
route registration deferred to M4.7.5 + M4.8. M7.6.5 wired the kernel's
existing `resolveManifest` (from `packages/kernel/src/manifest/
extends.ts`) into the CLI's apply pipeline. `buildErpPaymentsPack
()` refactored to return a child-only manifest (1 entity, 1
relation, etc.) with `meta.extends: ["operate-erp/core"]`; the
inline merge with `buildErpCorePack()` is gone. `apps/
architect-cli/src/pack-registry.ts` gained `packManifestRegistry
()` factory wrapping `PACK_REGISTRY` as a `ManifestRegistry`
implementation; `apps/architect-cli/src/apply.ts`'s `buildPlan`
became async, calling `resolveManifest(rawManifest, {registry:
packManifestRegistry()})` before `tryValidateManifest`. Added
typed error handling for `ExtendsCycleError` ("pack extends-chain
cycle") and `UnknownParentManifestError` ("pack references
unknown parent: <slug>. Available: <list>"). Pack-erp-payments
tests refactored: identity tests (slug, version, extends, child
counts) use `buildErpPaymentsPack()` directly; composition tests
(5 entities merged, cross-pack FK resolves) use a new
`buildResolvedPayments()` helper. End-to-end verified: `crossengin
apply --dry-run --pack=operate-erp/payments` still emits all 5
entity tables with M7.7 tenant scoping intact — the resolver
merges, the emitter sees one unified manifest. M5.9 added three CLI
subcommands for the chat audit data: `crossengin sessions
list` renders a table of recent sessions for a tenant;
`crossengin sessions show <id>` dumps one session's full
transcript (header + messages + tool invocations + proposals)
with truncation for terminal viewing; `crossengin sessions
replay <id>` renders the messages as chat-style output
(`You:` / `Architect:` / `[tool result ← tu_1]`) matching the
live REPL's look. New `apps/architect-cli/src/sessions.ts`
dispatches on positional action; `getBySessionId({tenantId,
sessionId})` added to `PostgresArchitectSessionStore` so the
CLI looks up by the user-visible session_id string (UUID lookup
also supported via regex check). Tests inject store overrides
via the new `SessionsContext.storesOverride` so the offline
CI path mirrors the chat side's `transcriptOverride`.
M7.8 wired pack-erp-payments to
M6's `workflow-signal-bridge`. New `signal-bridge.ts` module
exports `PAYMENT_SIGNAL_NAMES` (5 lifecycle signals matching
the payment_lifecycle workflow's transitions),
`PROVIDER_EVENT_SIGNAL_MAP` (Stripe + Adyen + Braintree event
types → canonical signal names), `paymentReferenceExtractor()`
backed by a new `FirstMatchingPathExtractor` that tries
multiple dotted paths (Stripe's `data.object.id`, Adyen's
`pspReference`, Braintree's `transaction.id`, generic
`provider_reference`), `buildPaymentSignalBridge(opts)`
factory, and `buildPaymentBridgesByEvent(opts)` that returns
a map of one bridge per provider event type. End-to-end test
proves: real HMAC-signed Stripe-shaped webhook → bridge
verifies → extractor finds `pi_xxx` → submitSignal called
with `payment.captured` + correct correlation key + idempotency
key. The pack's `erp-payments-provider-webhook` job declaration
now has matching code-side wiring.
M7.5 shipped the second vertical pack —
`@crossengin/pack-erp-payments` — proving the cross-pack
composition story. The pack adds 1 entity (Payment with both
`auditable` + `tenant_owned` traits; 13 user-fields including
provider enum, provider_reference unique-within-provider,
amount + refund_amount decimal(14,2), 6-state lifecycle),
1 relation (Invoice → Payment one-to-many RESTRICT), 5
permission transitions (admin-only refund + delete; everyone
else for capture/settle/fail/cancel), the `payment_lifecycle`
workflow (pending → captured → settled active; refunded /
failed / cancelled terminal; refund reachable from captured +
settled; 2 SLAs), 2 jobs (event-triggered payment-provider
webhook handler + hourly settlement sweep backstop), 1 list
view. `buildErpPaymentsPack()` calls `buildErpCorePack()` and
merges its additions — the resulting manifest declares
`extends: ["operate-erp/core"]` for documentation but applies
as one unified manifest (5 entities, 4 relations, 5 permission
sets, 2 workflows, 4 jobs, 3 views). `tryValidateManifest`
passes; cross-pack Payment.invoice_id → Invoice reference
resolves internally via merge. Pack-erp-payments registered in
the architect-cli pack-registry; `crossengin apply
--pack=operate-erp/payments` produces deployment-grade SQL
covering both core and payment tables.
M7.7 fixed the biggest open question from M7-wire:
pack tables now isolate per tenant at the DB level. The kernel's
`tenant_owned` built-in trait gained a `tenant_id UUID NOT NULL`
(indexed) field; `emitEntity` now emits a cross-schema FK
(`<table>_tenant_fk` → `meta.tenants(id) ON DELETE CASCADE`),
`ENABLE ROW LEVEL SECURITY`, and a `<table>_tenant_isolation`
policy (`tenant_id = current_setting('app.current_tenant_id',
true)::UUID` — matches META exactly) for entities declaring the
trait. Pack-erp-core's four entities (Account, Contact,
Invoice, InvoiceLine) now use `["auditable", "tenant_owned"]`.
`crossengin apply --pack=operate-erp/core` now produces
deployment-grade DDL — every pack table carries `tenant_id`, FK
to `meta.tenants`, RLS enabled, isolation policy.
M7-wire closed the substrate-to-pack loop in the CLI.
New `apps/architect-cli/src/pack-registry.ts` maps slug →
manifest builder (today: just `operate-erp/core` →
`buildErpCorePack()`; future packs add entries). `runApply`
gains `--pack <slug>` and `--pack-schema <name>` flags
(default schema: `public`). `buildPlan` validates the pack
via `tryValidateManifest` before any DB write, then emits its
DDL via `emitManifestCreate(manifest, {schema})`. The dry-run
output streams META bootstrap SQL followed by pack DDL with a
divider; JSON mode exposes `pack` + `metaStatementCount` +
`packStatementCount` + `availablePacks`. Live apply
concatenates both statement lists into one `MigrationApplier`
run — atomic via advisory-lock + per-statement transactions.
`crossengin apply --dry-run --pack=operate-erp/core` now
produces ~730 statements total (META bootstrap + 4 ERP entity
tables in `public` with FKs, check constraints, indexes —
topologically ordered).
M2.8.5 extended `@crossengin/ai-providers-openai` with the
Responses API (`/v1/responses`) as an opt-in alternative to
Chat Completions. 2 new modules: responses-api (`buildOpenAI
ResponsesRequest` translates `CompletionRequest` to the
flat input-array shape with `instructions` instead of system
messages; `function_call` + `function_call_output` items
replace assistant `tool_calls` and tool-role messages),
responses-streaming (named-event SSE parser dispatching on
`response.output_text.delta` / `response.function_call_
arguments.delta` / `response.completed`). `OpenAIProvider`
gains `defaultApiPath: "chat" | "responses"` constructor
option (defaults to `"chat"` — backward compat) and
`reasoningEffort: "low" | "medium" | "high"` for thinking
models (o1, o3). Two new methods: `completeViaResponses` +
`respondNonStreaming`. The CompletionChunk discriminated
union is unchanged; reasoning summary surfaces only on the
non-streaming envelope via `summarizeResponsesResponse`.
M6.5.5 wired the ai-router into `architect-cli`'s `chat` subcommand. New
`router-setup.ts` exports `DEFAULT_TASK_POLICIES` (7 tasks
mapped to Anthropic-primary + OpenAI-fallback chains; cheap
tasks like summarizer/classifier go to gpt-4o-mini primary) and
`buildChatCompleter({env, forceModel?, costCeiling?})` which
chooses adaptively: one API key → single provider (legacy
behavior); both keys → `DefaultLlmRouter` wrapped in a
`RouterAsProvider` adapter so the chat engine still sees a
single `LlmProvider`-shaped interface. New `--cost-ceiling-usd`
flag enforces per-request budget when the router is active.
Strict `isAnthropicModel` check replaced with a union-aware
check against `provider.models`. Session summary now reports
`providerKind` (single | router) and `availableProviders`.
M2.8 added
`@crossengin/ai-providers-openai` — the second concrete
`LlmProvider`, mirroring M2.7's Anthropic structure. 6 modules:
pricing (5 chat models + 2 embedding models with current
per-token + cached + output rates), chat-api (Chat Completions
request builder + response normalizer with `LlmMessage.toolUses`
→ `tool_calls` translation), streaming (SSE parser for OpenAI's
indexed-tool-call delta format; `delta.tool_calls[i].index`
identifies a call across deltas; usage from the final
`stream_options.include_usage` chunk), embeddings (the FIRST
real `embed()` implementation — buildEmbeddingsRequest +
normalizeEmbeddingResponse with sorted-by-index vectors + dim),
errors (11 typed kinds matching Anthropic's shape so the
router's `isRetryable()` check works uniformly across
providers), provider (`OpenAIProvider.complete()` streaming +
`completeNonStreaming()` + `embed()`; rejects embedding model
in `complete()` and chat model in `embed()`). Zero runtime
deps — pure `fetch` + `ReadableStream`. The router can now
chain Anthropic + OpenAI with real fallback semantics; the
chat substrate can route `--task=summarizer` to gpt-4o-mini
($0.15/M) for cheap operations while keeping authoring on
Claude. Embeddings finally have a real backend.
M6.5 added `@crossengin/ai-router` — the orchestration layer
between consumers and `LlmProvider` implementations. 5 modules: retry
(exponential backoff + isRetryable check + withRetry wrapper),
cost-tracker (CostCeiling interface + InMemoryCostTracker with
rolling per-tenant windows + CostCeilingExceededError),
latency-tracker (rolling p50/p95 buffer per provider), resolve
(pure provider-chain resolution: parseProviderRef + residency
filter + parent/override merge), router (DefaultLlmRouter
implements LlmRouter from @crossengin/ai-providers — picks a
provider per task, retries transient errors, falls back to the
next provider on failure, enforces cost ceilings pre-flight,
buffers chunks for clean retry replays, throws
AllProvidersExhaustedError when every fallback exhausts). The
chat substrate can swap its direct AnthropicProvider for a
router whenever M2.8 (OpenAI) lands — the consumer-facing
LlmProvider surface is identical.
M7 shipped the first vertical pack — `@crossengin/pack-erp-core`: a real Manifest
with 4 entities (Account, Contact, Invoice, InvoiceLine all
on the `auditable` trait), 3 relations (Account→Contacts
cascade, Invoice→Account restrict, Invoice→Lines cascade),
3 roles (erp_admin / erp_accountant / erp_viewer), per-entity
permissions including transition grants, an entityLifecycle
workflow for Invoice (draft → sent → paid|overdue|void with
a 30-day SLA), 2 jobs (scheduled overdue-invoice-reminder +
event-driven payment-received-handler), 2 list views. The
`buildErpCorePack(opts)` builder returns the full Manifest;
`tryValidateManifest` passes — every cross-reference resolves,
proving the kernel's abstractions hold up under a real schema.
M5.7 added chat persistence:
`@crossengin/ai-architect-pg` ships
`PostgresArchitectSessionStore` / `…MessageStore` /
`…ToolInvocationStore` / `…ProposalStore` plus a
`PostgresTranscript` orchestrator that implements the
`Transcript` lifecycle interface (`onSessionStart` /
`onMessage` / `onToolInvocation` / `onProposal` /
`onSessionEnd`). The chat engine emits events via this
interface — `NullTranscript` is the default no-op, so
non-persisted runs are unchanged. Four new META_ARCHITECT_*
tables (sessions / messages / tool_invocations / proposals)
with tenant RLS + FK chain. `crossengin chat --persist` reads
PG env vars and writes a full audit trail of who proposed
what, when, and whether it was applied. Operators can join
sessions ⇒ messages ⇒ tool_invocations ⇒ proposals to
reconstruct any developer's authoring history.
M5.8 closed the authoring loop by
adding a write tool with human-in-the-loop approval.
`propose_manifest_edit({path, new_manifest_json})` shows the
developer a diff + entity counts + new hash, prompts y/N (via
a shared `LineReader` that the REPL also uses, so the approval
read doesn't compete with the for-await on stdin), and only
writes the file on approval. `--allow-file-write` gates the
tool; `--auto-approve-writes` skips the prompt (required for
one-shot scripted use). Refactored ChatReplOptions: `stdin:
AsyncIterable<string>` → `lines: LineReader` so the approver
and the REPL share one source. `tools.ts` now ships an
`autoApprover(approve = true)` and `chat.ts` exports
`interactiveApprover({io, reader})`.
M5.6 made `crossengin chat` a real authoring loop
by adding tool dispatch. The CLI exposes
`validate_manifest` / `hash_manifest` / `diff_manifests` /
`summarize_manifest` (plus opt-in `read_file` under
`--allow-file-read`) as tools Claude can invoke mid-turn. The
chat engine assembles tool inputs from streamed
`tool_call_arg_delta` chunks, executes locally via
`executeToolCall`, appends tool-role results to history, runs
continuation turns until the assistant produces terminal text
or hits `DEFAULT_MAX_TOOL_ITERATIONS` (5). To round-trip cleanly
through Anthropic's API, `LlmMessage` in `@crossengin/
ai-providers` gained an optional `toolUses: {id, name, input}[]`
field; `buildAnthropicRequest` in `ai-providers-anthropic`
encodes those as `tool_use` content blocks alongside text on
assistant messages. Pattern extends to OpenAI / Bedrock / Vertex
when M2.8+ ships.
M5.5 wired the Anthropic provider into `architect-cli`'s `chat`
subcommand. `crossengin chat` now actually talks to Claude:
streams tokens as they arrive, reports per-turn + aggregate cost
in USD, supports `--prompt` for one-shot mode + REPL otherwise,
`--model` / `--max-tokens` / `--system` / `--system-file` /
`--tenant-id` / `--session-id` flags, `--format=json` emits the
`CompletionChunk` discriminated union as NDJSON. Tests inject
a stub `LlmProvider` via `RunContext.providerOverride` so CI
runs offline. Default system prompt primes Claude as the
CrossEngin Architect.
M2.7 added `@crossengin/ai-providers-anthropic` — a real
Anthropic Messages API client implementing the `LlmProvider`
interface from `@crossengin/ai-providers`. Zero runtime deps —
pure `fetch` + `ReadableStream`. 5 modules (pricing for the
five Claude 4.x models with per-token + per-cache-tier rates,
messages-api request builder + response normalizer, SSE
streaming parser with shared state across read boundaries,
typed error classification + retry policy, and the
`AnthropicProvider` class itself with `complete()` streaming +
`completeNonStreaming()` + `anthropic-beta` header support).
The Architect agent now has a real backend to call.
M6 added `@crossengin/workflow-signal-bridge` — verify a webhook
via `sdk/webhook-signing`, extract a correlation key, route
to `workflow-runtime.submitSignal`. Pairs with the gateway as
a registered Handler so every external webhook → workflow
advance flows through one place. The four runtime pillars
(DDL execution + cryptography + workflow execution + HTTP
gateway) are in place; both impure runtime pillars (workflows +
gateway) now have production-shape Postgres adapters; M5 added
the first app under `apps/` — `@crossengin/architect-cli` ships
the `crossengin` binary with `init`, `validate`, `diff`, `patch`,
`hash`, `apply`, `chat` (stubbed for M5.5), `version`, `help`.
The end-to-end story works today: `crossengin init m.json &&
crossengin validate m.json && crossengin apply --dry-run`
produces a 3,061-line SQL dump of the full meta-schema. M3.6
added `ProjectingEventLog` + `buildPersistentEngine` to
`@crossengin/workflow-runtime-pg` — wrap a `WorkflowEngine` once
and every event append automatically projects + upserts the
instance / activity / signal / timer rows into their META_
WORKFLOW_* tables. M3.5 added
`@crossengin/workflow-runtime-pg` — PostgresEventLog + four
projection stores (instance / activity / signal / timer) backed
by the existing META_WORKFLOW_* tables, with cached wfi_*/wfd_*
→ UUID resolvers that bridge the runtime's string IDs to the
schema's UUID FKs. M4.5 added `@crossengin/api-gateway-pg` —
Postgres-backed adapters for the gateway runtime's four store
interfaces (IdempotencyStore, RouteRegistry, RateLimitChecker,
PipelineExecutionStore) backed by the existing META_GATEWAY_* +
META_RATE_LIMIT_DECISIONS tables via `@crossengin/kernel-pg`.
M4 added `@crossengin/api-gateway-runtime` — the 17-stage
pipeline as real middleware, with EdDSA JWT verification (via
crypto), idempotency-key replay detection, rate-limit denial
with Retry-After, RFC 9457 problem details for every error, and
a queryable PipelineExecution per request. M1
added `@crossengin/kernel-pg` (Postgres-backed migration applier).
M2 added `@crossengin/crypto` (real SHA-256 / BLAKE2b-512 /
HMAC-SHA256 / Ed25519). M2.5 wired crypto into marketplace + sdk
+ forensics + tenant-lifecycle. M2.6 finished M2 wiring into
`access-reviews` (`signDecisionAttestation` for digital + qualified
e-signatures; `sealEvidenceWithBundle` + `verifyEvidenceSeal` for
SOC 2 / ISO 27001 / HIPAA / PCI / GDPR / 21 CFR Part 11 evidence
packs) and `data-lineage` (`sealArticle15Pack` +
`deliverArticle15Pack` + `verifyArticle15PackSeal` for the GDPR
Article 15 evidence pack lifecycle). M3 added `@crossengin/
workflow-runtime` — in-process event-sourced executor consuming
`@crossengin/workflow-engine` contracts; turns workflow
definitions into actually-running instances with append-only
event log, deterministic replay-style projection, registered
activity handlers, signal correlation, timer firing, automatic
transitions, on-entry actions (set_variable / schedule_activity /
schedule_timer), and saga compensation planning.

ADRs 0001-0104 are fully drafted in `docs/adr/` — no reserved
gaps. ADR-0046 is the Phase 2 implementation plan (M1 DDL → M2
crypto → M3 workflow runtime → M4 gateway runtime → M5 architect-
cli → M6 notifications + workflow bridge → M7 first vertical pack
→ M8 SLO enforcement); ADR-0047 covers M1, ADR-0048 covers M2,
ADR-0049 covers M3, ADR-0050 covers M4, ADR-0051 covers M5,
ADR-0052 covers M6, ADR-0053 covers M2.7 (Anthropic provider),
ADR-0054 covers M5.5 (architect-cli chat mode), ADR-0055 covers
M5.6 (tool-driven chat), ADR-0056 covers M5.8 (write tools with
human-in-the-loop approval), ADR-0057 covers M5.7 (chat
persistence to META_ARCHITECT_*), ADR-0058 covers M7
(`pack-erp-core` — first vertical pack), ADR-0059 covers M6.5
(`ai-router` — provider router with retry / cost / latency),
ADR-0060 covers M2.8 (`ai-providers-openai` — Chat Completions
+ embeddings + tool calls), ADR-0061 covers M6.5.5
(architect-cli router integration), ADR-0062 covers M2.8.5
(OpenAI Responses API support), ADR-0063 covers M7-wire
(CLI `--pack` apply), ADR-0064 covers M7.7 (pack tenant
scoping via `tenant_owned` trait), ADR-0065 covers M7.5
(`pack-erp-payments` — second vertical pack proving cross-pack
composition), ADR-0066 covers M7.8 (payment signal-bridge
wiring), ADR-0067 covers M5.9 (CLI sessions subcommands),
ADR-0068 covers M7.6.5 (kernel `extends` resolver wiring),
ADR-0069 covers M4.7 (CLI gateway binding),
ADR-0070 covers M7.9 (`pack-erp-healthcare` — third vertical
pack), ADR-0071 covers M2.9 (`ai-providers-bedrock` — third
real LlmProvider), ADR-0072 covers M2.9.5 (Bedrock Titan +
Cohere embeddings closing M2.9's open Q4), ADR-0073 covers
M6.5.6 (architect-cli Bedrock integration — env-var detection +
three-deep task fallback chains), ADR-0074 covers M4.7.5
(gateway JWT auth + routes subcommand closing M4.7's open
questions), ADR-0075 covers M4.7.6 (URL-fetched JWKS +
hot-reload via SIGHUP + periodic refresh), ADR-0076 covers
M2.9.6 (Bedrock cacheControl threading + Titan parallelism
closing M2.9 Q3 + M2.9.5 Q4), ADR-0077 covers M2.9.7 (Bedrock
multimodal embeddings + image content block types closing
M2.9.5 Q6), ADR-0078 covers M2.X (kernel LlmMessage.attachments
+ vision capability closing M2.9.7 Q1), ADR-0079 covers M4.8
(gateway routes from pack manifest — bulk register-pack
closing M4.7 manifest-driven question), ADR-0080 covers
M4.8.x (gateway routes unregister-pack — symmetric tear-down
via deterministic ID re-derivation), ADR-0081 covers M4.8.y
(gateway routes sync-pack — composite diff/upsert command
that completes the three-verb pack-routes vocabulary),
ADR-0082 covers M4.10 (routes.source_pack column closing
the open ownership-attribution question across ADRs
0079/0080/0081, enabling safe `sync-pack --prune-obsolete`),
ADR-0083 covers M4.10.x (`unregister-pack --by-source-pack` —
manifest-free tear-down via M4.10's `deleteByPackSlug` API,
closing ADR-0082 Q3), ADR-0084 covers M2.9.8 (Bedrock
Guardrails integration — opt-in content moderation via
guardrailConfig threaded through converse + converse-stream,
with `BedrockGuardrailViolationError` thrown after `usage_final`
for streaming consumers and `isGuardrailInterventionResponse`
helper for non-streaming), ADR-0085 covers M2.9.8.x
(per-request guardrail override via `completeWithGuardrail` +
`completeNonStreamingWithGuardrail` sibling methods, with
three-state semantics: BedrockGuardrailConfig / null / undefined),
ADR-0086 covers M2.X.6 (OpenAI + Anthropic moderation surfaces —
`OpenAIContentFilteredError` for `finish_reason: "content_filter"`
and `AnthropicRefusalError` for `stop_reason: "refusal"`,
matching the M2.9.8 post-usage_final-throw pattern), ADR-0087
covers M2.X.6.x (cross-provider moderation helper — kernel-level
`isModerationError(err)` predicate + `MODERATION_ERROR_KINDS`
shared tuple, duck-typing against `err.kind`), ADR-0088 covers
M2.X.5 (kernel LlmMessage.content as discriminated union —
lifted `content: string` to `string | LlmContentBlock[]` to
unblock multimodal assistant outputs across all three
providers), ADR-0089 covers M2.X.5.x (tool_use + tool_result
content block variants — consolidates tool-call surface with
provider translators handling Bedrock + Anthropic natively
and OpenAI via message-flattening flatMap), ADR-0090 covers
M2.X.7 (cross-provider retryable helper — kernel-level
`isRetryableError(err)` predicate + `RETRYABLE_ERROR_KINDS`
shared tuple, symmetric with M2.X.6.x's moderation helper),
ADR-0091 covers M6.6 (router uses kernel cross-provider
helpers — retry.ts hybrid predicate, explicit moderation
early-exit, estimateRequestTokens bug fix for M2.X.5 array
content), ADR-0092 covers M2.X.8 (standalone OpenAI
Moderations API — `provider.moderate(input)` calls
`/v1/moderations` for proactive content screening before
paying for a chat completion), ADR-0093 covers M2.8.6 (OpenAI
Responses API image inputs — threads ImageContentBlock through
to input_image blocks, closing the M2.X.5 vision gap on the
Responses path), ADR-0094 covers M2.X.5.y (ImageUrlContentBlock
URL variant — adds `{type: "image_url", url}` block alongside
the existing bytes-based image variant; OpenAI providers pass
URLs through, Bedrock + Anthropic throw with explicit
pre-fetch guidance), ADR-0095 covers M2.X.9 (cross-provider
input-too-large helper — third kernel-level predicate
`isInputTooLargeError`; partitions the error space alongside
isModerationError + isRetryableError), ADR-0096 covers M2.X.5.z
(Anthropic URL-source image support — removes the M2.X.5.y
throw, threads URLs through to Anthropic's native URL source
variant; provider parity expanded — OpenAI both paths +
Anthropic now accept URL-based images, Bedrock still requires
bytes), ADR-0097 covers M2.X.5.aa (DocumentContentBlock —
PDF inputs across Bedrock + Anthropic + OpenAI Responses;
OpenAI Chat throws with "use Responses API" guidance),
ADR-0098 covers M2.X.5.aa.y (DocumentUrlContentBlock —
URL-based document inputs; Anthropic native passthrough,
Bedrock + OpenAI throw with pre-fetch guidance), ADR-0099
covers M2.X.5.aa.x (document format expansion — txt/md/csv
added to DOCUMENT_FORMATS enum; Anthropic uses text-source
variant with UTF-8 decoding, OpenAI Responses uses format-
aware MIME types, Bedrock passes format through natively),
ADR-0100 covers M2.X.5.aa.x.1 (office document format
expansion — doc/docx/xls/xlsx/html added; Bedrock native,
Anthropic + OpenAI Responses throw with conversion guidance),
ADR-0101 covers M2.X.10 (kernel LlmMessage.name regex
enforcement + OpenAI Chat threading across all four roles;
Anthropic + Bedrock + OpenAI Responses silently drop),
ADR-0102 covers M2.X.5.aa.z (OpenAI Files API integration —
upload/retrieve/delete CRUD + kernel FileReferenceContentBlock
threaded through Responses API; other providers throw with
actionable guidance), ADR-0103 covers M2.X.5.aa.z.1 (Anthropic
Files API integration — same CRUD shape; removes the M2.X.5.aa.z
throw in the Anthropic translator; file_id blocks now flow
natively to both OpenAI Responses + Anthropic), ADR-0104
covers M2.X.5.aa.z.2 (listFiles() on both Files APIs — provider-
native pagination shapes preserved; tenant offboarding + audit
workflows unblocked), ADR-0105 covers M2.X.5.aa.z.3 (Bedrock
batch inference listBatches — first control-plane operation on
Bedrock; two-host model documented; pattern set for future
control-plane enumeration methods), ADR-0106 covers M2.X.5.aa.z.4
(Bedrock batch inference getBatch — single-job lookup with
identifier regex validation BEFORE fetch; polling-loop +
failure-diagnostic workflows unblocked), ADR-0107 covers
M2.X.5.aa.z.5 (Bedrock batch inference stopBatch — completes
the batch read/write split; new signedControlPlanePost helper;
cost-runaway + tenant-offboarding + compliance-kill-switch
workflows unblocked), ADR-0108 covers M2.X.5.aa.z.6 (Bedrock
batch inference createBatch — closes the four-endpoint batch
CRUD surface; pure boundary validator buildCreateBatchBody
enforces 14 documented AWS constraints; idempotency via
clientRequestToken; cost attribution via tags; VPC-scoped
batch jobs supported), ADR-0109 covers M2.X.5.aa.z.7 (Bedrock
listGuardrails — second control-plane enumeration after
listBatches; new guardrails-api.ts module separated from
inference-time guardrails.ts; pattern now proven twice for
paginated control-plane reads), ADR-0110 covers M2.X.5.aa.z.8
(Bedrock getGuardrail with policy detail — rich companion to
listGuardrails; five typed policy types; stable enums get
strict discriminators while growing enums stay as strings),
ADR-0111 covers M2.X.5.aa.z.9 (Bedrock listInferenceProfiles
— third paginated control-plane enumeration; cross-region
inference profiles; SYSTEM_DEFINED vs APPLICATION type
distinction; pagination pattern now mechanical), ADR-0112
covers M2.X.5.aa.z.10 (Bedrock getInferenceProfile — detail
companion to listInferenceProfiles via type-alias pattern;
log-driven + webhook-driven lookup workflows unblocked),
ADR-0113 covers M2.X.5.aa.z.11 (Bedrock listImportedModels —
fourth paginated control-plane enumeration; custom-imported
model inventory + architecture-aware routing), ADR-0114 covers
M2.X.5.aa.z.12 (Bedrock getImportedModel with data-source
provenance — extended-shape detail pattern; provenance +
KMS-key audit workflows unblocked), ADR-0115 covers
M2.X.5.aa.z.13 (Bedrock listCustomModels — fifth paginated
control-plane enumeration; fine-tune / continued-pretrain /
distillation inventory; 8-parameter filter set is the largest
yet), ADR-0116 covers M2.X.5.aa.z.14 (Bedrock getCustomModel
with training/validation detail — third extended-shape detail
instance; training/validation/output provenance + metrics +
hyperparameters + distillation lineage all surfaced),
ADR-0117 covers M2.X.5.aa.z.15 (Bedrock listModelImportJobs —
sixth paginated enumeration; pipeline-health monitoring +
failure triage + throughput analysis unblocked), ADR-0118
covers M2.X.12 (conflict_error kernel kind + isConflictError
cross-provider classifier — fourth in the family after
isModerationError + isRetryableError + isInputTooLargeError;
two Bedrock 409 endpoints + OpenAI 409s justify the lift),
ADR-0119 covers M5.10.5 (chat REPL widens user input to
LlmContentBlock[] — closes the M2.X.5 investment;
`/attach image_url|document_url|file_id|text` slash commands;
per-turn attachment reset; transcript flattens to placeholders),
ADR-0120 covers M8 (workflow runtime instrumentation hooks +
META_WORKFLOW_TRACES — first production-grade observability
surface for workflows; 11 documented event kinds; PG sink
opt-in via persistTraces; combineInstrumentations fan-out;
OTel-ready event shape; closes the workflow runtime depth gap),
ADR-0121 covers M2.X.5.aa.z.16 (Bedrock getModelImportJob —
fourth extended-shape detail instance; failure-triage +
KMS-audit + VPC-compliance workflows unblocked via
failureMessage / modelDataSource.s3DataSource.s3Uri / roleArn
/ importedModelKmsKeyArn / vpcConfig), ADR-0122 covers
M2.X.5.aa.z.17 (Bedrock listModelCustomizationJobs — seventh
paginated enumeration; parallels listModelImportJobs but for
AWS-native fine-tunes with a richer 5-value status vocabulary
including Stopping/Stopped), ADR-0123 covers M2.X.5.aa.z.18
(Bedrock getModelCustomizationJob with training/validation
detail — fifth extended-shape detail instance; 8 new typed
sub-shapes structurally mirroring getCustomModel; field-name
asymmetry preserved verbatim; reproducibility / triage / cost
/ distillation lineage workflows unblocked), ADR-0124 covers
M2.X.5.aa.z.19 (Bedrock stopModelCustomizationJob — pure
reuse of M2.X.5.aa.z.5's signedControlPlanePost rail;
operator-initiated mid-training aborts; third 409-emitting
Bedrock endpoint earning isConflictError its keep), ADR-0125
covers M2.X.11 (cacheBreakpoint field on LlmContentBlock +
Anthropic prompt caching — additive optional field on all
8 block variants; Anthropic translator emits
cache_control:{type:"ephemeral"}; OpenAI + Bedrock silently
drop for tight scope), ADR-0126 covers M2.X.11.x (Bedrock
cachePoint translator wiring — single-line append in
appendKernelBlocks loop; reuses M2.9's BEDROCK_CACHE_POINT
infrastructure; cross-provider parity now on Anthropic +
Bedrock), ADR-0127 covers M2.X.13 (not_found_error kernel
kind + isNotFoundError cross-provider classifier — fifth
kernel classifier; zero provider changes since the kind was
already wired everywhere; idempotent cleanup workflows now
have a documented cross-provider pattern), ADR-0128 covers
M2.X.14 (authentication_error kernel kind +
isAuthenticationError cross-provider classifier — sixth
kernel classifier closing ADR-0127 Q1; explicitly EXCLUDES
permission_error since auth and permission have distinct
remediation paths), ADR-0129 covers M2.X.15 (permission_error
kernel kind + isPermissionError cross-provider classifier —
seventh kernel classifier closing ADR-0128 Q1; pairs with
isAuthenticationError; cross-account / cross-tenant /
cross-region access denial workflows now documented),
ADR-0130 covers M2.X.16 (invalid_request_error kernel kind +
isInvalidRequestError cross-provider classifier — eighth
kernel classifier completing the canonical 4xx/5xx sweep;
closes ADR-0129 Q1; user-facing error translation pattern
documented), ADR-0131 covers M2.X.5.aa.z.20 (Bedrock
createModelCustomizationJob — largest write surface remaining
on Bedrock; customization-job CRUD now complete; 12+ boundary-
validation rules; AWS contract preserved verbatim including
customModelKmsKeyId vs KmsKeyArn asymmetry), ADR-0132 covers
M8.1 (workflow runtime activity execution instrumentation —
closes ADR-0120 Q3 — adds activity_started / activity_completed
/ activity_failed kinds with durationMs + error context),
ADR-0133 covers M6.6.x (ai-router special-cases
isConflictError for retry chain short-circuit — closes
ADR-0118 Q2 — conflict errors join moderation as terminal in
the isRouterRetryable gate), ADR-0134 covers M6.6.y (ai-
router special-cases isNotFoundError for retry chain short-
circuit — closes ADR-0133 Q1 — not-found errors join
moderation + conflict as terminal in the isRouterRetryable
gate; identifier mismatches don't benefit from fallback
because identifiers are provider-scoped), ADR-0135 covers
M6.7 (PostgresCostTracker — first persisted ai-router
substrate — closes ADR-0059's deferred cost-tracker
persistence Q — `@crossengin/ai-router-pg` package +
META_LLM_COST_WINDOWS table — atomic UPSERT with SQL-side
expiry CASE — drop-in CostTracker replacement), ADR-0136
covers M2.X.5.aa.z.21 (Bedrock DELETE control-plane
surfaces — FIRST DELETE write surfaces — deleteCustomModel
+ deleteImportedModel + deleteGuardrail + shared
signedControlPlaneDelete transport — propagates 404 as
not_found_error so router short-circuit (M6.6.y) handles
automated lifecycle pipelines and operators wanting silent
idempotency wrap with isNotFoundError predicate), ADR-0137
covers M6.7.x (per-tenant cost ceiling — closes ADR-0135 Q1
+ Q4 — META_LLM_COST_CEILINGS 122nd table +
getTenantCostCeiling resolver field on router +
PostgresCostCeilingResolver — whole-object override
semantic: tenant ceiling REPLACES global rather than
merging; ceilings are now data, not code), ADR-0138 covers
M2.X.5.aa.z.22 (Bedrock deleteInferenceProfile — closes
ADR-0136 Q2 — first "smart" delete with mandatory pre-
flight GET that reads `type` and refuses SYSTEM_DEFINED
profiles before any DELETE is issued; 4th DELETE on the
Bedrock control plane; pre-flight-guard pattern set for
future two-typed resources), ADR-0139 covers M5.11
(`crossengin chat --max-cost-usd` session budget — client-
side post-hoc cumulative cap independent of and orthogonal
to --cost-ceiling-usd; enforcement in REPL loop not router
since session budget needs REAL not estimated cost;
operators can run bounded interactive + loop scripts),
ADR-0140 covers M6.7.y (PostgresLatencyTracker —
LatencyTracker interface async-ified (internal-only breaking
change); META_LLM_LATENCY_SAMPLES as the 123rd table;
record = single INSERT, stats = single windowed SELECT with
PG percentile_cont aggregate; provider-level not tenant-
scoped; no RLS), ADR-0141 covers M6.7.z (RouterInstrumentation
+ META_LLM_CALL_TRACES + PostgresRouterInstrumentation —
closes ADR-0135 Q2 + ADR-0137 Q3+Q4 + ADR-0140 Q3 in one
milestone; pattern parity with M8 WorkflowInstrumentation;
3 event kinds — llm_call_started/completed/failed; per-
attempt granularity with willFallback derived; 124th table
audit-optimized + tenant-RLS; ai-router-pg adapter set now
at 4 substrates — cost-windows + cost-ceilings + latency-
samples + call-traces), ADR-0142 covers M2.X.5.aa.z.23
(Bedrock createInferenceProfile — closes ADR-0138 Q3 —
2nd CREATE on Bedrock control plane; completes full
APPLICATION lifecycle on the substrate (create + list + get
+ delete); pure boundary validation for 8 documented
constraints; modelSource discriminated union forward-compat;
clientRequestToken hooks AWS's idempotency contract),
ADR-0143 covers M6.7.zz (META_RETENTION_POLICIES +
PostgresTraceRetention — closes ADR-0120 Q5 + ADR-0140 Q1 +
ADR-0141 Q1 in one cross-cutting substrate; 125th meta-schema
table with hardcoded CHECK allowlist for the 3 trace tables;
adapter in kernel-pg with hardcoded PRUNABLE_TABLES map
preventing SQL injection; per-policy autonomy + idempotent
prune + clock injection; future trace surfaces add via 2-edit
mechanical change), ADR-0144 covers M6.8 (META_LLM_COST_TIERS
+ META_LLM_TENANT_TIER_MEMBERSHIPS — closes ADR-0137 Q2 —
normalized tier substrate for shared pricing plans;
three-level fallback per-tenant→tier→global with whole-object
override at each level preserving M6.7.x semantics; ON DELETE
RESTRICT prevents orphaning; tier policy changes propagate
to all members via one UPDATE on the tier row), ADR-0145
covers M2.X.5.aa.z.24 (Bedrock cross-resource tagging —
closes ADR-0142 Q2 — first multi-resource Bedrock operations;
tagResource + untagResource + listTagsForResource work
across every Bedrock ARN; AWS wire-shape asymmetry preserved
verbatim — query on tag/untag, body on list), ADR-0146 covers
M2.X.5.aa.z.25 (Bedrock updateInferenceProfile PATCH —
closes ADR-0142 Q1 — first PATCH on the Bedrock control plane;
new signedControlPlanePatch transport; APPLICATION-only
mandatory pre-flight guard mirroring deleteInferenceProfile;
description-only mutation since tags have their own canonical
M2.X.5.aa.z.24 surface; race-deleted 404 propagates verbatim;
full APPLICATION lifecycle now on the substrate), ADR-0147
covers M2.X.5.aa.z.26 (Bedrock provisioned-throughput
inspection — read-only get + list of PT resources;
three-ARN distinction surfaces clearly (modelArn vs
desiredModelArn vs foundationModelArn) — operators detect
mid-migration; mutation deferred since PT cost is 100×-1000×
higher than inference profiles needing careful design;
operator wins on cost visibility + orphan reconciliation +
incident-response failure messages), ADR-0148 covers
M2.X.5.aa.z.27 (Bedrock createProvisionedModelThroughput —
closes ADR-0147 Q1 — first PT mutation; clientRequestToken
REQUIRED in substrate input (AWS makes it optional) as
cost-safety guardrail forcing deliberate token-minting
before each $5K+/op create call; substrate's first CREATE
endpoint to mandate the token; modelUnits cap [1, 1000]
defensive on top of AWS quota; no auto-token, no auto-
commit, no dryRun, no status-polling — substrate is the
raw transport), ADR-0149 covers M2.X.5.aa.z.28 (Bedrock
updateProvisionedModelThroughput — closes ADR-0147 Q2 +
ADR-0148 Q1 — PATCH for model migration + rename;
asymmetric from create (no mandatory clientRequestToken)
because update doesn't multiply cost; reuses
signedControlPlanePatch from ADR-0146; at-least-one-field
rule rejects empty input; PT ARN stable across migration
so downstream InvokeModel calls continue transparently;
PT lifecycle 3/4 complete on substrate), ADR-0150 covers
M2.X.5.aa.z.29 (Bedrock deleteProvisionedModelThroughput —
closes ADR-0147 Q3 + ADR-0148 Q2 + ADR-0149 Q1 in one
operation; PT lifecycle now 4/4 COMPLETE on substrate;
reuses signedControlPlaneDelete; no pre-flight guard since
PTs always operator-owned; 409 ConflictException semantic
surfaces when deleting committed PT mid-commitment —
propagated verbatim; ADR-0150 marks 150 ADRs since project
bootstrap), ADR-0151 covers M2.X.5.aa.z.30 (Bedrock
foundation model discovery — read-only get + list of AWS-
managed foundation models; operators discover availability +
capabilities (modalities + customizations + inference types)
+ legacy-model awareness before committing to CREATEs;
type-alias Detail=Summary pattern since AWS returns same
fields; defensive modelDetails envelope unwrap; 4 enums
strictly validated on responses), ADR-0152 covers
M6.7.z.embed (RouterInstrumentation extends to embed() —
closes ADR-0141 Q2 — three new kinds embed_call_started/
completed/failed added additively to ROUTER_INSTRUMENTATION_KINDS;
META_LLM_CALL_TRACES.kind CHECK constraint extended without
migration; empty-string sessionId as the canonical "embed
without session" marker; cost attribution + failure
diagnosis + provider comparison for embedding workloads
unblocked), ADR-0153 covers M6.7.zz.dry-run
(PostgresTraceRetention.previewPrune — closes ADR-0143 Q4 —
read-only SELECT COUNT(*) per policy returning a distinct
RetentionPreviewResult shape so TypeScript catches "meant
to prune but called preview" mix-ups; same cutoff +
allowlist + skip semantics as prune; doesn't update
last_pruned_at; PG BIGINT precision via ::TEXT cast;
operator workflow preview → review → prune now first-class),
ADR-0154 covers M6.8.x (PostgresCostCeilingResolver.resolveDetailed
— closes ADR-0144 Q2 + ADR-0137 Q3+Q4 + ADR-0141 Q3 in one
milestone — adds source-attribution to ceiling resolution
returning {ceiling, source, tierId?} where source is the
discriminated union "override"|"tier"|"none" and tierId is
conditional on source==="tier"; resolve() delegates to
resolveDetailed() — zero duplication, identical behavior;
audit dashboards now show WHY tenants are capped not just
WHAT they're capped at), ADR-0155 covers M6.7.zz.tenant
(META_TENANT_RETENTION_POLICIES — closes ADR-0143 Q1 —
128th table for per-tenant retention overrides; two-table
design preserves PG-version portability over the NULLABLE-
tenant_id alternative from the original sketch; tenant
policies first then platform-default with NOT IN subquery
exclusion correctly handles both shorter- and longer-than-
default per-tenant retention; llm_latency_samples
mechanically excluded via DB CHECK + adapter allowlist
since the table has no tenant_id column), ADR-0156 covers
M8.2 (timer_set + timer_cancelled instrumentation —
WORKFLOW_INSTRUMENTATION_KINDS grows 14→16 additively;
applyScheduleTimer now emits timer_set with timerId
correlation BEFORE the event-log append; timer_cancelled
kind-defined and CHECK-allowed but emission deferred until
cancel_timer action is implemented in a future milestone;
operator workflows unlocked — timer creation throughput,
set-to-fire latency, cancellation rate), ADR-0157 covers
M6.8.x.trace (`ceiling_resolved` event — closes ADR-0154 Q1
— ROUTER_INSTRUMENTATION_KINDS grows 6→7; automatic
emission from enforceCeilingPreflight before the ceiling
check so audit signal survives CostCeilingExceededError;
new getTenantCostCeilingDetailed?: callback for full source
attribution (override|tier|global|none); legacy
getTenantCostCeiling callback continues working with
degraded "override" source; PostgresCostCeilingResolver.resolveDetailed
is now first-class operator wiring), ADR-0158 covers M6.8.y
(setExactTags Bedrock operator helper — closes ADR-0145 Q5
— standalone function in tagging-helpers.ts preserves
substrate's three-tier layering; idempotent diff-then-apply
with minimum API calls; convergence to desired state
without operators writing diff logic), ADR-0159 covers
M6.7.zz.tenant.dashboard (effectiveRetention resolver on
PostgresTraceRetention — closes ADR-0155 Q6 — single
method returning EffectiveRetentionResolution discriminated
union with three variants tenant/platform/none; resolution
algorithm matches prune semantics — enabled per-tenant
policy wins, disabled falls back to platform-default;
single round-trip happy path when enabled per-tenant policy
exists; method on PostgresTraceRetention not separate
class since retention has no router-side hot path; admin
dashboard + compliance audit + GDPR Article 15 + admin UI
workflows unblocked), ADR-0160 covers M6.7.zz.tenant.opt-out
(opt_out flag on META_TENANT_RETENTION_POLICIES — closes
ADR-0159 Q1 — separate column from enabled with cross-
column CHECK rejecting (enabled=true AND opt_out=true);
EffectiveRetentionResolution gains tenant_opt_out variant;
prune + previewPrune extended with skipped_opt_out status
+ NOT IN subquery widened to (enabled OR opt_out); legal
hold + 21 CFR Part 11 + VIP contract workflows unblocked),
ADR-0161 covers M6.7.zz.tenant.opt-out.reason
(opt_out_reason TEXT NULLABLE column with length CHECK
[1, 256] — closes ADR-0160 Q1 — surfaced through
listTenantPolicies + effectiveRetention.tenant_opt_out +
prune/previewPrune skipped_opt_out results; nullable not
NOT NULL since most rows opt_out=false; no CHECK tying
reason to opt_out state — preserves historical context
on lift-off + supports pre-staged opt-outs; no pattern
constraint — operator taxonomies vary; informational
audit context for compliance dashboards + onboarding
handoff + per-reason metrics),
ADR-0162 covers M6.7.zz.tenant.opt-out.expiry
(opt_out_until TIMESTAMPTZ NULLABLE column with read-time
expiry — closes ADR-0160 Q2 — opt-outs auto-expire at the
resolver / prune / preview clock; new skipped_opt_out_expired
status distinguishes expirations from genuine disable;
tenant_opt_out variant gains optOutUntil; SQL NOT IN
subquery widens from (enabled OR opt_out) to (enabled OR
(opt_out AND (opt_out_until IS NULL OR opt_out_until > now())));
two clock sources by design — adapter uses injected clock
for testability, SQL uses PG now() to avoid parameter-shape
changes; self-managing legal holds + calendar-driven
expirations + reduced compliance theater),
ADR-0163 covers M6.7.zz.tenant.opt-out.alerts
(expiringOptOuts resolver method — closes ADR-0162 Q2 —
returns sorted list of opt-outs within a configurable
window for advance-warning alert pipelines; substrate
stays passive exposing data, operator wires notification
delivery via scheduled job; one method covers three
workflows ("what expires soon?", "what's already expired?",
"everything time-bound in the next year") via withinDays
+ includeExpired parameters; daysUntilExpiry float
pre-computed from injected clock; rejected active-push,
PG-NOTIFY trigger, materialized view, and stateful alert
tracking),
ADR-0164 covers M6.7.zz.tenant.opt-out.cli
(`crossengin retention expiring` CLI subcommand — closes
ADR-0163 Q4 — new top-level `retention` subcommand follows
sessions/gateway-routes action-verb pattern; first action
`expiring` wraps the ADR-0163 resolver with --within-days
+ --include-expired flags + human/JSON output; PG env
required + RetentionContext.retentionOverride for testing;
defaults --within-days=30 + --include-expired=false match
the most common monthly-review workflow; pipes cleanly
into jq + cron + alert delivery; ground for future
sibling actions like retention effective/opt-out/opt-in/
list-policies),
ADR-0165 covers M6.7.zz.tenant.opt-out.cli.effective
(`crossengin retention effective <tenant> <table>` CLI
action — closes ADR-0159 Q5 — wraps the ADR-0159
effectiveRetention resolver with discriminated-union-aware
output rendering for each of four variants tenant /
tenant_opt_out / platform / none; null optOutUntil renders
as 'indefinite', null optOutReason as '<no reason>';
platform + none variants render the queried tenantId since
resolver doesn't carry one; JSON envelope echoes queried
tenantId + tableName for downstream jq correlation;
operator debugging + compliance audit + tier migration
verification + dashboard tooltip workflows),
ADR-0166 covers M6.7.zz.tenant.opt-out.cli.mutate
(`crossengin retention opt-out <tenant> <table> [--until
DATE] [--reason TEXT] [--retention-days N]` and `retention
opt-in <tenant> <table>` mutation actions — closes ADR-0160
Q5 + ADR-0161 Q4 + ADR-0162 Q4 — add adapter methods
setTenantOptOut (atomic INSERT ... ON CONFLICT DO UPDATE)
+ clearTenantOptOut (UPDATE WHERE opt_out=true preserving
opt_out_reason as audit history per ADR-0161); CLI
boundary validation for all flags with exit 2 on invalid;
ISO 8601 normalisation on --until; idempotent opt-in
returns null policy on no-op; shared formatPolicyChange
helper renders both action outputs; completes the
end-to-end CLI retention workflow operators previously
needed raw SQL for),
ADR-0167 covers M6.7.zz.tenant.opt-out.cli.list
(`crossengin retention list-policies [--tenant <uuid>]
[--table <name>]` broad-audit action — wraps existing
listPolicies + listTenantPolicies adapter methods with no
new substrate surface; emits both platform-defaults and
per-tenant-policies sections in one shot; --tenant scopes
per-tenant only (platform stays visible for context),
--table scopes both; filter suffix in headers preserves
query parameters in saved output; JSON envelope {tenantFilter,
tableFilter, platform, tenantPolicies} for downstream jq;
parallel Promise.all adapter calls; closes the
compliance-audit gap left by the four targeted CLI
actions),
ADR-0168 covers M6.7.zz.tenant.retention-set
(`crossengin retention set <tenant> <table> --days N
[--enabled true|false]` action + setTenantRetention
adapter method — closes ADR-0166 Q7 — non-opt-out
per-tenant retention overrides previously required raw
SQL; INSERT ... ON CONFLICT DO UPDATE clears opt_out +
opt_out_until on UPDATE but preserves opt_out_reason
per ADR-0161; --days required + --enabled defaults true;
shared formatPolicyChange helper renders 'Tenant
retention set:' header; tier-upgrade / tier-downgrade /
stand-by / end-of-legal-hold workflows now CLI-native),
ADR-0169 covers M6.7.zz.tenant.retention-delete
(`crossengin retention delete <tenant> <table>` action +
deleteTenantPolicy adapter method — closes ADR-0168 Q1 —
mechanically simplest substrate method; single DELETE
WHERE tenant_id + table_name using PG's rowCount returns
boolean (true=deleted, false=no-op); no opt_out filter
(hard-delete semantic distinct from clearTenantOptOut's
preservation pattern); idempotent — false is success
exit 0 so scripts safely re-run; JSON envelope {action,
deleted, tenantId, tableName} echoes queried fields for
correlation; retention CLI surface now CRUD-complete
on per-tenant policies),
ADR-0170 covers M6.7.zz.tenant.opt-out.history
(META_TENANT_RETENTION_OPT_OUT_HISTORY append-only audit
table (129th) + atomic history writes via CTE chain in
all 4 mutation methods + listOptOutHistory adapter +
`crossengin retention history` CLI action + --actor flag
threading — closes 6 prior ADR Qs in one milestone;
4-value event_kind tuple opt_out_set/opt_out_cleared/
retention_set/policy_deleted; prev_state JSONB from
existing-CTE snapshot or DELETE RETURNING + next_state
JSONB from INSERT/UPDATE RETURNING + nullable actor_id;
five filter dimensions on the query method + history
CLI; substrate gains audit-log pattern future audit tables
can copy),
ADR-0171 covers M6.7.zz.tenant.opt-out.cli.restore
(`crossengin retention restore <history-id>` action +
restoreTenantPolicy adapter method — closes ADR-0169 Q7
+ ADR-0170 Q4 — wires undo on top of the audit-log table;
reads source history row's prev_state and delegates to
existing mutation method (deleteTenantPolicy for null,
setTenantOptOut for opt_out=true, setTenantRetention
otherwise); adds attributes.restored_from for forensic
traceability; discriminated RestoreTenantPolicyResult
covers kind="restored" + kind="deleted" variants;
operational undo for accidental delete / wrong opt-out
/ tier migration mistake recovery workflows),
ADR-0172 covers M6.7.zz.tenant.opt-out.history-retention
(history-table retention — closes ADR-0170 Q1 — the
mechanically simplest retention milestone; three additive
changes widen META_RETENTION_POLICIES + META_TENANT_RETENTION_POLICIES
CHECK constraints from 3+2 to 4+3 values adding
tenant_retention_opt_out_history, plus one PRUNABLE_TABLES
entry; no new adapter methods, no new CLI surface — history
table inherits the entire ADR-0143 + 0155 + 0162 retention
machinery; hasTenantId:true so per-tenant overrides work;
recursive-concern questions for audit-log-of-audit-log
rejected; substrate now self-managing — the audit log
produced by retention is itself subject to retention),
ADR-0173 covers M6.7.zz.tenant.opt-out.cli.diff-history
(`crossengin retention diff-history <id-a> <id-b>` action
+ diffHistoryEntries adapter + computeFieldDiffs pure
helper — closes ADR-0170 Q5 — single query then
client-side diff comparing next_state vs next_state of
two history events; same-(tenant, table) constraint
enforced; refuses cross-tenant/cross-table (separate
workflow); 'absent' placeholder for undefined values
(DELETE event's null next_state); empty fieldDiffs when
states deep-equal; alphabetically sorted output; forensic
audit + compliance changelog + restore validation
workflows now CLI-native),
ADR-0174 covers M6.7.zz.tenant.opt-out.cli.prune
(`crossengin retention prune [--dry-run]` action — closes
ADR-0172 Q2 — pure CLI delivery wrapping existing
prune()/previewPrune() adapter methods; ad-hoc invocation
for debugging stuck prunes / on-demand compliance sweeps
/ validation after configuring new policies / CI gates;
two distinct formatters keep run vs dry-run terminology
distinct ('deleted=N' vs 'would_delete=N'); summary line
aggregates pruned count + row count + categorised skip
counts; --confirm + filter flags rejected matching
existing scheduled-job semantics),
ADR-0175 covers M6.7.zz.tenant.opt-out.cli.history.cursor
(`retention history --after-id <uuid>` cursor pagination
— closes ADR-0170 Q8 — compound cursor (occurred_at, id)
with single $N param reused for both inline subquery
lookup + tiebreaker; ORDER BY widened to include id DESC
tiebreaker for stable pagination; backward compatible
omitting --after-id; nextAfterId field in JSON envelope
+ human-format next-page hint when results.length === limit;
operators paginate dashboards / stream compliance exports
/ replay incident timelines without OFFSET instability),
ADR-0176 covers M6.7.zz.tenant.opt-out.cli.restore.dry-run
(`retention restore --dry-run` flag + previewRestoreTenantPolicy
adapter — closes ADR-0171 Q1 — mirrors prune dual-method
pattern with separate adapter (rather than dryRun?: boolean
param) to avoid type-system pollution; RestoreTenantPolicyPreview
discriminated union with three would_delete /
would_set_opt_out / would_set_retention variants matching
restoreTenantPolicy's dispatch branches; preview is purely
read-only — no actorId/attributes; --actor silently ignored
on --dry-run; JSON envelope dryRun:boolean discriminator
parallel to retention prune; safety preview for the last
remaining destructive retention action),
ADR-0177 covers M6.7.zz.tenant.batch
(`effectiveRetentionBatch(pairs)` adapter + exported
effectiveRetentionKey helper — closes ADR-0159 Q2 —
single-pair effectiveRetention made 2N round-trips for
N pairs prohibitive for dashboard rendering 10K tenants ×
3 tables = 30K calls; batch resolver runs exactly 2
queries total regardless of pair count using (tenant_id,
table_name) IN tuple-list for tenant lookup + table_name
IN unique-list for platform lookup, Promise.all
parallelizes; returns ReadonlyMap<string,
EffectiveRetentionResolution> for O(1) dashboard render
lookups; same resolution algorithm + clock-aware expiry
semantics as single-pair version; substrate-only milestone
no CLI surface),
ADR-0178 covers M6.7.zz.tenant.opt-out.cli.diff
(`retention diff <tenant-a> <tenant-b> <table>` cross-
tenant policy comparison — closes ADR-0165 Q6 —
diffTenantPolicies adapter + normalizeResolutionForDiff
helper; reuses effectiveRetentionBatch internally so just
2 queries; reuses computeFieldDiffs from ADR-0173 after
normalizing each resolution to comparable record; same-
table constraint enforced via single tableName field;
per-tenant resolution summary line varies by variant via
summarizeResolutionForDiff helper; tier migration
verification + drift detection + compliance audit + CI
gate workflows now CLI-native; sibling to retention
diff-history but on the cross-tenant axis),
ADR-0179 covers M6.7.zz.tenant.opt-out.cli.diff.vs-platform
(`retention diff <tenant> <table> --vs-platform` tenant-
vs-default comparison — closes ADR-0178 Q1 —
diffTenantVsPlatform adapter method; 2 parallel queries
via Promise.all (NOT composing on effectiveRetentionBatch
because batch resolver hides whether tenant fell through
to platform or has own policy, losing distinction that
--vs-platform must surface); first adapter exception to
composition pattern from ADR-0177/0178; reuses shared
summarizeResolutionForDiff + computeFieldDiffs +
normalizeResolutionForDiff helpers; vsPlatform:true JSON
envelope discriminator distinguishes from cross-tenant
diff; one-command "is this tenant on the default?" check
vs operators previously running two retention effective
commands + mental-diffing),
ADR-0180 covers M6.7.zz.tenant.opt-out.cli.diff.cross-table
(`retention diff <tenant> <table-a> <table-b> --cross-
table` cross-table-within-tenant comparison — closes
ADR-0178 Q3 — diffTenantTables adapter method; restores
composition on effectiveRetentionBatch from ADR-0177/
0178 (ADR-0179 was the documented exception); 2 queries
total via batch resolver; reuses summarizeResolutionForDiff
+ computeFieldDiffs + normalizeResolutionForDiff
helpers; crossTable:true JSON envelope discriminator;
--cross-table and --vs-platform mutually exclusive at
CLI boundary; completes the diff matrix — same-tenant
cross-event from ADR-0173 + cross-tenant same-table
from ADR-0178 + tenant-vs-platform from ADR-0179 +
cross-table-within-tenant new; one-command "is this
tenant's retention consistent across all trace tables?"
audit; legal-hold completeness check + compliance
migration verification + CI cohort consistency
workflows),
ADR-0181 covers M6.7.zz.tenant.opt-out.cli.diff.exit-on-divergence
(`retention diff --exit-on-divergence` boolean flag on
all 3 diff variants — closes ADR-0179 Q6 + ADR-0180 Q3
— exit code 3 (distinguishable from exit 1 runtime
errors / exit 2 misuse) when fieldDiffs non-empty;
output still emitted; pure CLI enhancement no adapter
changes; backward compatible — flag opt-in so pre-
M6.7.zz.tenant.opt-out.cli.diff.exit-on-divergence
callers never see exit 3; replaces fragile `jq -e`
wrapping whose exit-1 collides with runtime-error exit-
1 making CI logs ambiguous; single flag uniform across
all 3 variants; operators route exit 1 to on-call +
exit 3 to compliance team),
ADR-0182 covers M6.7.zz.tenant.opt-out.cli.effective-batch
(`retention effective-batch --pairs-file <path>` CLI
action exposing ADR-0177's batch adapter — closes
ADR-0177 Q1 — pure CLI delivery no adapter changes;
JSON-only input v1 (array of {tenantId, tableName});
layered validation with index-aware error messages;
output ordering preserves input including duplicates
for 1:1 contract; envelope {action: "effective-batch",
count, results[]}; replaces Node script boilerplate
operators previously wrote; substrate-to-CLI gap from
ADR-0177's substrate-only milestone now closed —
all retention adapters have first-class CLI surfaces),
ADR-0183 covers M6.7.zz.tenant.opt-out.cli.diff.add-tenant
(`retention diff --add-tenant <uuid>` repeated flag for
N-way cross-tenant comparison — closes ADR-0178 Q2 —
new diffTenantPoliciesNway adapter composing on
effectiveRetentionBatch (2 queries regardless of N);
computeFieldVariations pure helper for per-field
variation analysis with tenant attribution; parseArgs
extended with multiFlags ReadonlyMap tracking repeated
flag occurrences + getMultiFlag helper (backward
compatible — existing flags map keeps last-write-wins);
nway:true JSON discriminator (4 diff envelope shapes
now mutually exclusive); A/B/C tenant labels in human
output; replaces 10 pair-wise commands + manual
correlation for 5-tenant cohorts; --exit-on-divergence
from ADR-0181 integrates uniformly),
ADR-0184 covers M6.7.zz.tenant.opt-out.cli.diff.threshold
(`retention diff --threshold N` fuzzy CI-gate threshold
— closes ADR-0181 Q2 + ADR-0183 Q5 — modifies
--exit-on-divergence so exit 3 fires only when
fieldDiffs.length or fieldVariations.length >= N;
default N=1 preserves ADR-0181 behavior; --threshold
without --exit-on-divergence rejected with strict
exit 2; --threshold 0/negative/non-integer rejected;
applies uniformly to all 4 diff variants; validation
at top of runRetentionDiff before any PG queries;
pure CLI enhancement single divergenceExitCode helper
extended no adapter/result-type/envelope changes;
operators get tier-migration tolerance + cohort
minor-drift tolerance + graduated CI gates),
ADR-0185 covers M6.7.zz.tenant.opt-out.history.actor-join
(`retention history --with-actor-names` actor display
name surfacing — closes ADR-0170 Q9 — LEFT JOIN
meta.users when joinActor:true; adapter returns
actorDisplayName + actorEmail (string | null) on entries;
CLI renders 'name (uuid)' format with email fallback +
raw-UUID fallback for orphan FKs; <system> preserved
for null actor_id; backward compat preserved fields
absent when flag not set; substrate now aliases history
table as h consistently to support JOIN; replaces
operator-side meta.users lookup loop for every audit
review).

## Architecture in 90 seconds

- **`zod` schemas are the source of truth.** Types derive via
  `z.infer`. Every package exports `XSchema` + `type X` pairs.
- **Pure contracts + deterministic helpers only.** A package
  defines record shapes, state machines, and pure functions
  (validators, predicates, comparators). It does not open
  sockets, hit databases, or shell out.
- **Kernel meta-schema is the integration point.** Every package
  that needs persisted records wires `META_*` table definitions
  into `packages/kernel/src/bootstrap/meta-schema.ts`. The kernel
  emits DDL deterministically from those.
- **Tenant isolation by RLS.** Tenant-scoped tables enable PG
  row-level security with `tenant_id = current_setting(
  'app.current_tenant_id', true)::UUID`. Platform-wide tables
  skip RLS. Both are tested by the meta-schema test suite.
- **Strict TypeScript.** No `any`. No `--no-verify`. Use explicit
  return types for exported functions when inference is murky.

## Package map

Grouped by concern. Each is `packages/<name>` with `src/index.ts`
re-exporting everything.

### Substrate (the kernel itself)
- **`kernel`** — meta-schema (113 tables), DDL emit, manifest
  validate/diff/patch/topology/hash, bootstrap SQL generator.
- **`kernel-pg`** — Postgres-backed migration applier (first
  impure package). 7 modules: connection (PgConnection interface
  + `parsePgEnvConfig` + node-postgres binding), statement-hash
  (sha256 of normalized SQL), migration-log (`_meta_migrations`
  bookkeeping), preconditions (`pg_uuidv7` extension + PG ≥ 14 +
  CREATE privilege checks), applier (advisory-lock-gated, per-
  statement transactions, halt-on-first-failure, hash-based
  skip), introspection (pg_catalog queries + pure parsers), diff
  (pure `diffSchema` vs `META_TABLES`). Ships `crossengin-pg`
  CLI with `apply`, `apply --dry-run`, `drift`, `inspect`,
  `version` commands.
- **`workflow-runtime-pg`** — Postgres-backed adapters for the
  workflow runtime. 10 modules: id-mapping
  (WorkflowInstanceIdResolver + WorkflowDefinitionIdResolver,
  cached wfi_*/wfd_* → UUID lookups against workflow_instances /
  workflow_definitions), event-log (PostgresEventLog implements
  EventLog over META_WORKFLOW_EVENTS, parses JSONB or text
  payloads, computes latestSequence via MAX(sequence_number)),
  instance-store (PostgresInstanceStore.create INSERTs
  workflow_instances + caches the UUID; upsertProjection
  UPDATEs all status / variables / awaiting* fields by
  instance_id), activity-store (UPSERT into workflow_activities
  via ON CONFLICT (activity_id) DO UPDATE), signal-store (UPSERT
  workflow_signals with COALESCE-preserving instance_id),
  timer-store (UPSERT workflow_timers with status/firedAt/
  cancelledAt), projecting-event-log (ProjectingEventLog wraps
  any EventLog + auto-runs the four projection writers after
  each append; creates the workflow_instances row on
  instance_started so the FK is satisfied; re-projects + upserts
  the instance / activities / signals / timers on every
  subsequent event), persistent-engine (buildPersistentEngine
  one-call factory: pass a PgConnection + definitions map, get
  back {engine, eventLog, stores} where the engine is wired to
  the projecting log so all engine ops persist automatically),
  replayer (WorkflowReplayer.resyncInstance re-projects from the
  event log + upserts all projection tables to fix drift;
  verifyInstance returns a per-field DriftReport comparing
  expected projection vs stored rows; bulkResync iterates with
  pagination + maxInstances cap for periodic CI / observability
  guards), **instrumentation** (M8 — PostgresWorkflowInstrumentation
  implements WorkflowInstrumentation.onEvent by writing to
  META_WORKFLOW_TRACES with resolved instance/definition UUIDs;
  tolerates unresolved IDs by writing null UUIDs;
  buildPersistentEngine gains persistTraces + instrumentation
  options with explicit > auto > Noop precedence).
- **`api-gateway-pg`** — Postgres-backed adapters for the four
  gateway runtime store interfaces + a replayer. 5 modules:
  idempotency-store (INSERT … ON CONFLICT DO UPDATE on tenant+
  operation+key, TTL-based deleteExpired), route-registry
  (cache-backed lookup + listVersionsFor with configurable TTL,
  upsert that invalidates the cache), rate-limit-checker
  (per-(tenant, principal, operation) sliding-window counter;
  writes META_RATE_LIMIT_DECISIONS with allowed /
  denied_rate_limit_exceeded outcomes), pipeline-execution-store
  (INSERT … ON CONFLICT DO NOTHING for the M4 PipelineExecution,
  plus countSince audit query), replayer
  (verifyPipelineExecutionShape pure validator flagging
  stages-out-of-order, stage-repeated, final-stage/outcome
  mismatch, pass-with-4xx-or-5xx, duration-inconsistent,
  terminating-not-last; GatewayReplayer.verifyExecution adds the
  rate_limit_decision_not_found check by joining against
  META_RATE_LIMIT_DECISIONS; listRecentExecutions /
  bulkVerify paginate over META_GATEWAY_PIPELINE_EXECUTIONS;
  summarize computes pass/deny/error counts + p50/p95 latency).
- **`api-gateway-runtime`** — HTTP gateway middleware
  (fourth impure package). 7 modules: adapters (RequestAdapter +
  ResponseAdapter for Node HTTP + edge runtimes,
  buildIncomingRequest helper), stores (PrincipalResolver +
  IdempotencyStore + RateLimitChecker + RouteRegistry interfaces
  + in-memory implementations), auth (EdDSA JWT verify with iss/
  aud/exp/nbf checks via @crossengin/crypto, opaque token matcher
  with constant-time compare, parseAuthHeader for Bearer/Basic/
  x-api-key), problems (RFC 9457 envelope builders for the 14
  declared problem types — authenticationRequired with WWW-
  Authenticate, tooManyRequests with Retry-After, sunsetEndpoint
  with Sunset header), dispatcher (HandlerRegistry mapping
  operationId → handler, handlerOutputToResponse converting
  json/empty/bytes outputs), pipeline-runner (PipelineRecorder
  enforcing stage-order monotonicity, building schema-valid
  PipelineExecution), runtime (GatewayRuntime.handleRequest walks
  the 17 stages: receive → parse_request → validate_tls →
  parse_auth → authenticate → resolve_principal → match_route →
  negotiate_version → negotiate_content → check_idempotency →
  check_rate_limit → validate_signature → validate_schema →
  dispatch_handler → transform_response → apply_security_headers
  → emit_audit; halts on terminating outcomes; merges
  DEFAULT_SECURITY_HEADERS on pass).
- **`workflow-runtime`** — in-process event-sourced workflow
  executor (third impure package). 8 modules: clock (Clock +
  IdGenerator interfaces, SystemClock + FixedClock,
  RandomIdGenerator + CountingIdGenerator), event-log (append-
  only `EventLog` interface + InMemoryEventLog with monotonic-
  per-instance sequence enforcement), projection (pure
  `projectInstance` / `projectActivities` / `projectSignals` /
  `projectTimers` — definition-aware projection refines status
  to waiting_for_signal/timer/manual based on outgoing transition
  triggers), transitions (pure trigger matching + guard
  evaluation, defaultGuardEvaluator covers always_true /
  variable_equals / variable_predicate with 8 operators /
  role_required), activity-handlers (`ActivityRegistry` with
  specific + per-kind fallback resolution, built-in handlers for
  audit_emit + transformation), engine (`WorkflowEngine.start
  Instance` / `submitSignal` / `tickTimers` / `cancelInstance` /
  `getInstanceState` / `listEvents`; step loop runs automatic
  transitions + on-entry actions until quiescent; signals
  matched by tenant + correlationKey with exactly_once
  idempotency dedup), saga (pure `planCompensation` /
  `listCompensatableActivities` / `hasOutstandingCompensation`
  handling immediate_reverse_order / parallel / manual_review /
  no_compensation strategies), **instrumentation** (M8 —
  `WorkflowInstrumentation` interface with 11 documented event
  kinds, NoopInstrumentation default, captureInstrumentation()
  in-memory buffer, combineInstrumentations() fan-out helper;
  engine wires events at 8 paths; observability failures
  swallowed so they never crash the engine).
- **`crypto`** — real cryptography over `node:crypto`. 7 modules:
  algorithms (`HashAlgorithm`/`MacAlgorithm`/`SignatureAlgorithm`
  + `KeyPurpose` allow-list), hashing (SHA-256, BLAKE2b-512, hash
  chain step, content addressing, constant-time compare), hmac
  (HMAC-SHA256 + webhook signing in `t=...,v1=...` format with
  replay-window verify), signing (Ed25519 sign/verify/keypair via
  Node JWK, public key fingerprint), key-handles (opaque
  `KeyHandle` with tenant-scoped `KeyId` and `assertHandleTenant`
  guard), key-store (`KeyStore` interface + `InMemoryKeyStore`
  with rotate + revoke + per-tenant isolation), audit (auto-audit
  for management ops, schema-validated `CryptoAuditRecord`).
- **`types`** — primitive zod types shared across the workspace
  (UUIDs, ISO 8601, slugs, etc.).
- **`config`** — shared TypeScript + lint config base.
- **`testing`** — `vitestPreset` re-export used by every package.

### Identity, security, data
- **`auth`** — RBAC + ABAC + field-level permissions + write
  masks. RoleDefinition, RbacGrant, principals.
- **`sso`** — federated identity: SAML 2.0 + OIDC providers,
  SCIM 2.0 provisioning, claim mappings + JIT policies, session
  lifecycle, login audit.
- **`security`** — data classification, encryption keys, CSP,
  backup policy, incident classification, threat model,
  certifications.
- **`compliance`** — compliance pack architecture (21 CFR 11,
  HIPAA, GDPR, UAE-MoH). Packs contribute clauses to manifests.
- **`residency`** — 8 regions (eu-central/west, us-east/west,
  me-uae, gcc-ksa, apac-sg, ap-south), broad regions,
  residency profiles, routing.
- **`files`** — file lifecycle (upload → scan → available →
  archived), storage tier transitions, OCR, quota, audit.

### AI surface
- **`ai-providers`** — provider router contract, pricing tables,
  fallback policy, latency budgets.
- **`ai-router`** — `DefaultLlmRouter implements LlmRouter` —
  picks a provider per task using `TaskPolicyMap.primary` +
  `fallback[]`, retries transient (`isRetryable()`) failures
  with exponential backoff + jitter, falls back to the next
  provider on exhaustion, enforces per-tenant cost ceilings
  pre-flight via `CostTracker` (InMemoryCostTracker default
  ships rolling per-tenant USD windows; PostgresCostTracker is a
  future M6.6). Buffers chunks per-attempt so retry replays are
  clean. Tracks per-provider p50/p95 latency for observability +
  future latency-based routing. Throws `CostCeilingExceededError`
  / `ProviderResolutionError` / `AllProvidersExhaustedError` —
  all non-retryable, so the router doesn't loop on them.
- **`ai-providers-bedrock`** — real AWS Bedrock client
  implementing `LlmProvider`. Zero runtime deps; pure `fetch` +
  `node:crypto` + from-scratch AWS Signature V4. Speaks Bedrock's
  `converse-stream` (binary event-stream framing, NOT SSE),
  `converse` (non-streaming), `invoke` (embeddings via Titan
  or Cohere), AND the control-plane `ListModelInvocationJobs`
  endpoint (M2.X.5.aa.z.3). Two-host model: runtime endpoints
  at `bedrock-runtime.{region}.amazonaws.com`, control-plane
  endpoints at `bedrock.{region}.amazonaws.com`, same sig v4
  service. 8 modules: batch-api (BedrockBatchJobStatus +
  BEDROCK_BATCH_JOB_STATUSES 10-value tuple +
  buildBatchListQuery validator + parseBatchListResponse
  strict parser + BedrockBatchJobSummary /
  BedrockBatchJobListResponse types — for listBatches()
  enumeration of long-running batch inference jobs), pricing
  (8 chat models —
  Claude on Bedrock, Llama 3.1 70B/405B, Mistral Large, Titan
  Premier + 4 embedding models — Titan v2/v1, Cohere
  english/multilingual), signing (sig v4 with HMAC chain
  verified against the AWS-documented `f4780e2d...` reference
  signing key), converse-api (chat request builder + response
  normalizer), embeddings (family-dispatched request builders —
  Titan single-text with selectable 256/512/1024 dimensions;
  Cohere batched up to 96 texts with input_type selector),
  event-stream (binary frame parser → CompletionChunk; tracks
  contentBlockIndex → toolUseId across deltas; throws
  BedrockError on `:message-type: exception`), errors (12
  typed kinds including `model_stream_error` for
  ModelStreamErrorException; CODE_TO_KIND maps 15 AWS exception
  classes), provider (BedrockProvider with complete +
  completeNonStreaming + embed + embedMultimodal + listBatches
  + getBatch + stopBatch + createBatch + listGuardrails +
  getGuardrail + listInferenceProfiles + getInferenceProfile
  + listImportedModels + getImportedModel + listCustomModels +
  getCustomModel + listModelImportJobs + getModelImportJob +
  listModelCustomizationJobs + getModelCustomizationJob +
  stopModelCustomizationJob + createModelCustomizationJob —
  embed dispatches on
  family, loops over Titan or batches Cohere; listBatches GETs
  the control-plane host with sig v4 + sorted query string via
  signedControlPlaneGet helper; getBatch validates jobIdentifier
  via regex BEFORE the fetch then GETs /model-invocation-jobs/
  {encoded}; stopBatch POSTs an empty body to
  /model-invocation-jobs/{encoded}/stop via
  signedControlPlanePost; createBatch validates the full input
  body via buildCreateBatchBody (14 documented AWS constraints)
  BEFORE the fetch then POSTs to /model-invocation-jobs).
  Capabilities:
  `{chat: true, streaming: true, toolUse: true, jsonMode: false,
  embedding: true, maxContextTokens: 200_000}`. The router has
  THREE real chat providers to chain — Anthropic + OpenAI + AWS
  — and TWO embedding providers — OpenAI's text-embedding-3 +
  Bedrock's Titan/Cohere. Real failover diversity across
  independent control planes; AWS-native end-to-end for tenants
  with strict residency requirements.
- **`ai-providers-anthropic`** — real Anthropic Messages API
  client implementing `LlmProvider`.
- **`ai-providers-openai`** — real OpenAI Chat Completions +
  Embeddings client implementing `LlmProvider`. Zero runtime
  deps (`fetch` + `ReadableStream`). 6 modules: pricing
  (gpt-4o / gpt-4o-mini / gpt-4-turbo / o1 / o1-mini for chat;
  text-embedding-3-small / text-embedding-3-large for
  embeddings; per-token + cached input + output rates with
  6-decimal cost rounding), chat-api (Chat Completions request
  builder translating `LlmMessage.toolUses` → OpenAI's
  `tool_calls` array; assistant.content goes to `null` when
  paired with tool calls and no text), streaming (SSE parser
  for the indexed-tool-call delta format — `tool_calls[i].
  index` identifies a call across deltas; arguments come as
  streamed JSON string fragments; usage from the final
  `stream_options.include_usage` chunk), embeddings (the FIRST
  real `embed()` implementation in the workspace; sorts vectors
  by index + derives `dim`), errors (11 typed kinds with same
  `isRetryable()` shape as Anthropic so the router treats them
  uniformly; maps `rate_limit_exceeded` + `service_unavailable`
  to the platform vocabulary), provider (`OpenAIProvider.
  complete()` + `completeNonStreaming()` + `embed()`; type
  guards reject embedding-model-in-chat and chat-model-in-embed
  locally; optional `openai-organization` + `openai-project`
  headers for enterprise routing). Capabilities `{embedding:
  true, jsonMode: true, supportsThinking: false}` — the
  complement of Anthropic's, so the router can route embedding
  tasks to OpenAI automatically. Zero runtime deps (pure
  `fetch` + `ReadableStream`). 5 modules: pricing (5 Claude 4.x
  models with per-token + cached + cache-write rates, USD cost
  rounded to 6 decimals), messages-api (request builder
  flattens system messages + re-attaches tool-role messages as
  `tool_result` blocks under user role; response normalizer
  computes Usage with cost), streaming (SSE parser + async
  generator over ReadableStream; shared StreamState across read
  boundaries so token counters survive multi-chunk fills),
  errors (11 typed kinds + RETRYABLE_KINDS set,
  `classifyHttpStatus` + `fromHttpResponse` + `fromNetworkError`
  with isRetryable() helper), provider
  (`AnthropicProvider.complete()` streaming + `completeNon
  Streaming()` + `embed()` throws invalid_request_error;
  `anthropic-beta` header for prompt caching / tool streaming
  / computer use; `FetchLike` injection for tests).
- **`ai-architect`** — AI Architect session contract, safety
  policy (refusals, gates, refusal copy, tenant settings, cost
  ceilings, eval gate, incidents, redteam). Plus session-record
  zod schemas (`ArchitectSessionRecord` / `…MessageRecord` /
  `…ToolInvocationRecord` / `…ProposalRecord`) that
  ai-architect-pg materializes into Postgres rows.
- **`ai-architect-pg`** — Postgres-backed transcript adapter for
  chat sessions. 5 modules: session-store + message-store +
  tool-invocation-store + proposal-store (each with append +
  list helpers against META_ARCHITECT_*); transcript
  (PostgresTranscript class threads sessionUUID + tenantId
  through onMessage / onToolInvocation / onProposal / onSession
  End — implements the `Transcript` interface architect-cli's
  chat engine emits into). `crossengin chat --persist` wires
  this in; tests use a fake transcript via ctx.transcriptOverride.

### Runtime + operations
- **`jobs`** — Inngest-style job kinds, idempotency keys, dead
  letters, cost ledger.
- **`observability`** — SLO definitions, error budget compute,
  redaction, synthetics, OTel-style tracing.
- **`integrations`** — integration call audit, idempotency at the
  integration boundary, HMAC signatures, retry policy.
- **`rate-limiting`** — unified rate-limit + quota contracts. 6
  algorithms (token_bucket, leaky_bucket, fixed/sliding window,
  sliding_log, concurrent_request) × 10 scope kinds × policies
  with 5 overage handling kinds; 10 quota targets × 7 periods × 6
  classes; RFC 9457 problem details + IETF rate-limit headers on
  every denial; 6 exception kinds with per-kind duration caps +
  four-eyes; throttle event audit.
- **`api-gateway`** — per-request edge pipeline composing auth +
  sso + rate-limiting + sdk. 17-stage pipeline (receive → ... →
  emit_audit) with state-machine ordering. 8 auth schemes × 15
  outcomes with clock-skew + audience + issuer + hmac-replay
  validation. Route matching with version negotiation + sunset.
  RFC-9457 problem details with 14 problem types. Idempotency
  with replay detection. Content + encoding + language negotiation.
  CORS + default security headers.
- **`feature-flags`** — 7 flag kinds (boolean, string, number,
  json, multivariate, percentage_rollout, kill_switch). 10
  targeting rule kinds with FNV-1a sticky percentage bucketing.
  9-stage rollout state machine (1pct → 5pct → ... → 100pct or
  rolled_back). 8-trigger kill switches with full separation of
  duties (armer ≠ trigger ≠ co-trigger). 17 evaluation reasons.
  23-kind append-only change audit with four-eyes gate.
- **`workflow-engine`** — runtime contracts for the manifest-level
  workflows declared in kernel: definitions (canonical executable
  form), instances (12 statuses), activities (10 kinds, retry
  policies, saga compensation), signals (3 delivery guarantees),
  timers (4 kinds), compensation plans, append-only event history.

### Reporting / search / UI
- **`reporting`** — reports, dashboards, schedules, ClickHouse
  audit, CDC.
- **`search`** — Typesense-style manifest, query, permission tags,
  embeddings, reindex.
- **`views`** — frontend renderer types (columns, views, theme,
  i18n, permissions, widgets).
- **`i18n`** — locales, ICU MessageFormat, CLDR plurals, bundle,
  resolution, calendar, tenant config.
- **`notifications`** — 6 channels × 18 providers, 5 content
  categories, template + audience + preference/suppression
  contracts, dispatch + delivery audit with retry/throttle/digest
  + quiet-hours decisions.

### Vertical packs
- **`pack-erp-healthcare`** — third vertical pack. Extends
  `operate-erp/core` via `meta.extends`. 3 entities (Patient
  with auditable + tenant_owned, references Account + Contact;
  Encounter referencing Patient with FHIR EncounterClass +
  6-state lifecycle; Observation referencing Encounter +
  Patient with FHIR R4 status enum + code_system covering
  LOINC/SNOMED/ICD-10). 3 relations (Account→Patient restrict,
  Patient→Encounter restrict, Encounter→Observation cascade).
  2 new roles (erp_clinician + erp_front_desk) that merge with
  core's three. 2 workflows: encounter_lifecycle (scheduled →
  checked_in → in_progress → completed | cancelled | no_show;
  only mark_no_show is automatic, used by the 15-min sweep job;
  2 SLAs at PT30M + P1D) and observation_lifecycle (FHIR R4 4
  states; entered_in_error is admin-only via permission gate
  for amendment discipline). 3 jobs (daily encounter-reminder
  at 08:00 UTC with phi i/o data class; */15 no-show-sweep;
  event-triggered fhir-export on `healthcare.encounter.
  completed` for downstream EHR integration). 3 list views.
  compliancePacks defaults to ["hipaa", "21_cfr_11"] — the
  meta-level signal for downstream tooling. Cross-pack
  references (Patient → Account, Patient → Contact) resolve via
  the M7.6.5 kernel resolver; standalone manifest fails
  validation by design (intentional — resolver merges first).
- **`pack-erp-payments`** — second vertical pack. Extends
  `operate-erp/core` via `meta.extends`. 1 entity (Payment
  with auditable + tenant_owned, references Invoice), 1
  relation (Invoice → Payment), 5 permission transitions,
  `payment_lifecycle` workflow (6 states: pending → captured
  → settled active; refunded / failed / cancelled terminal;
  refund reachable from captured or settled; 2 SLAs at P1D
  and P5D), 2 jobs (event-triggered provider webhook handler
  on `billing.payment_received` for the M6 signal bridge to
  consume; hourly settlement sweep as backstop), 1 list view.
  As of M7.6.5, `buildErpPaymentsPack()` returns a child-only
  manifest with `meta.extends: ["operate-erp/core"]`; the
  kernel's `resolveManifest` merges the parent at apply
  time. Cross-pack Payment → Invoice FK resolves via the
  merged manifest. Pattern for future packs that extend an
  existing pack — author declares `extends`, kernel does the
  merge work.
- **`pack-erp-core`** — first vertical pack. Declarative
  `Manifest` with 4 entities (Account, Contact, Invoice,
  InvoiceLine on the `auditable` trait), 3 relations, 3 roles
  (erp_admin / erp_accountant / erp_viewer), per-entity
  permissions + transition grants, an entityLifecycle workflow
  for Invoice (draft → sent → paid|overdue|void with `mark_paid`
  reachable from both sent + overdue; 30-day SLA on sent→paid),
  2 jobs (scheduled cron overdue-invoice-reminder +
  event-triggered payment-received-handler), 2 list views.
  `buildErpCorePack(opts?)` returns the full Manifest; passes
  `tryValidateManifest` end-to-end. Pattern for future
  `pack-erp-healthcare` / `pack-erp-retail` / etc. that extend
  via `meta.extends: ["operate-erp/core"]`.

### Business operations
- **`billing`** — plans, subscriptions, metered usage, invoices,
  payments, dunning, tax, events.
- **`finops`** — 17 cost categories × 5 allocation methods,
  per-tenant attribution, budgets + breach actions, unit
  economics (LTV/CAC/contribution margin), chargeback
  statements, cost reports.
- **`tenant-lifecycle`** — 7-state lifecycle (trial → … →
  deleted), grace periods, GDPR Article 17 deletion requests,
  data exports, cryptographic tombstones.

### Delivery + operations infrastructure
- **`deploy`** — apps × environments × strategies; migrations;
  feature flags; releases; artifacts; on-prem/BYOC packaging.
- **`dr`** — 5 DR tiers (mission-critical → best-effort), RPO/
  RTO targets, replication topology, backups, failover
  records, drills, runbooks.
- **`edge`** — region routing, latency budgets per route,
  autoscaling policies, edge cache, throttling, region
  affinity.
- **`active-active`** — multi-region active-active topology, 7
  consistency levels, vector clocks, 6 CRDT kinds (G/PN counters,
  OR-set, LWW register/map, MV register), conflict detection +
  resolution, split-brain lifecycle.
- **`pwa`** — PWA manifest, service worker, IndexedDB outbox,
  sync, push notifications (PHI-safe stubs), Capacitor wrapper.

### Developer / partner surface
- **`sdk`** — public API contract (versioning, scopes, operations,
  RFC 9457 problem details, cursor pagination, idempotency,
  webhooks with HMAC-SHA256).
- **`sdk-clients`** — language-specific client generation
  contract (10 target languages × 10 registries × 3 tiers,
  generator pipeline, semver release lifecycle, compatibility
  matrix, auth + retry helpers, client telemetry with W3C
  trace context).
- **`marketplace`** — installable extension packs, pack registry
  with ed25519 signing + security review, per-tenant install
  lifecycle, permission grants, marketplace listings + reviews.
- **`migration`** — 12 source kinds (CSV, JSONL, Salesforce,
  ServiceNow, SQL dumps, FHIR, etc.), schema inference, field
  mapping, preview/dry-run, idempotent backfill ledger,
  onboarding flow (workspace_setup → … → go_live).
- **`ml-training`** — opt-in consent (phi/regulated permanently
  forbidden), training datasets, eval sets (safety_refusal
  requires 100% pass), training runs, evaluations, model
  registry with shadow/canary/production lifecycle.

### Audit + compliance operations
- **`incident-response`** — 5 SEV levels with SLA profiles, 7
  incident roles, 8-state incident lifecycle, runbook
  executions, blameless postmortems with action items,
  customer comms with GDPR 72h breach notification deadline.
- **`forensics`** — hash-chained tamper-evident logs, evidence
  with sealed/retention/destruction lifecycle, chain-of-custody
  with sha256-verified transfers, legal holds with separation of
  duties, e-discovery requests, court-admissible attestations.
- **`access-reviews`** — periodic attestation campaigns (SOC 2 /
  ISO 27001 / HIPAA / PCI / GDPR / 21 CFR Part 11). Campaigns,
  items, decisions with attestation + four-eyes, exceptions with
  per-reason duration caps, templates, sealed evidence with
  per-framework control mappings.
- **`data-lineage`** — provenance graph for GDPR Article 15 right
  of access (+ CCPA / LGPD / PIPEDA / UAE peers). 14 node kinds ×
  10 edge kinds with classification propagation rules
  (pii → public via anonymized_from with k≥5, phi → internal via
  aggregated_from with k≥11). Provenance records, data subject
  registry (sha256-only identifiers), subject access requests,
  graph traversal (ancestors/descendants/path/cycle/subject impact),
  retention policies + Article 15 evidence packs.

## Cross-cutting invariants

Recurring patterns enforced by zod `superRefine`:

- **Four-eyes principle.** Anywhere an action is privileged
  (deletion, hold release, postmortem review, four-eyes
  approvals), the actor must not also be the approver. Check
  for `executedBy !== approvedBy`, `author ∉ reviewers`,
  `releasedBy !== issuedBy`.
- **State machines.** Most lifecycle types export a `*_STATUSES`
  enum, a `*_TRANSITIONS` map, and a `canTransition*` helper.
  The schema enforces status↔required-fields pairing.
- **Cryptographic anchoring.** Sha256 hashes for content
  addressing show up everywhere: dataset freezing, deletion
  proofs, evidence sealing, postmortem storage, webhook signing,
  pack signing (ed25519 there).
- **Tenant scoping.** Records with `tenant_id` get RLS. Cross-
  tenant audit/compliance records are platform-wide (cdc
  checkpoints, regions, plans, deployments, ediscovery,
  tombstones).
- **Forbidden lists.** PHI/regulated data can never be used for
  ML training (`FORBIDDEN_TRAINING_DATA_CLASSES`). Latest docker
  tag is forbidden (deploy). Two-person integrity for human
  evidence collection.
- **Deadlines.** Where regulation imposes timing (GDPR 72h
  breach, Article 12(3) 3-month deletion deadline), schemas
  enforce it.

## Meta-schema

`packages/kernel/src/bootstrap/meta-schema.ts` is the central
catalog of 115 platform-level Postgres tables. Each new package
adds tables there + updates `meta-schema.test.ts` (table count,
expected names list sorted alphabetically, column-check
assertions).

The test suite enforces two invariants:
1. Every `tenant_id`-bearing table has RLS enabled.
2. Foreign-key references resolve to a table declared earlier
   in `META_TABLES`.

When adding tables, **append them to the array at the bottom in
the order the package was built**, not alphabetically. The
expected-names test sorts independently.

## Build + test commands

```bash
# Install
pnpm install

# Per-package
pnpm --filter @crossengin/<name> build
pnpm --filter @crossengin/<name> test
pnpm --filter @crossengin/<name> typecheck

# Workspace
pnpm -r build
pnpm -r test
pnpm -r typecheck

# Build is fast; full workspace test ≈ 30s
```

There is **no top-level lint script**. ESLint config has not
been migrated to v9 flat config yet; ignore lint until asked.

## Conventions

- **Module structure.** Each package: `package.json`,
  `tsconfig.json` (extends `@crossengin/config/typescript/base`),
  `vitest.config.ts` (re-exports `vitestPreset`), `src/index.ts`
  (re-exports all source modules), 4–7 `src/*.ts` source modules,
  matching `src/*.test.ts` files.
- **Naming.** Constants `SCREAMING_SNAKE_CASE`, types `PascalCase`,
  schemas `<Name>Schema`. Stable id prefixes per kind:
  `INC-YYYY-NNNN` for incidents, `EV-` for evidence, `PM-` for
  postmortems, `LH-` for legal holds, etc.
- **Tests.** Each module gets its own `*.test.ts`. Tests cover
  constants, schema validation (accept + reject paths), helper
  functions, and state-machine transitions. Aim for 15–30 tests
  per module.
- **No comments.** The codebase generally doesn't have JSDoc or
  inline comments. Don't add them unless explaining a non-obvious
  invariant.

## Workflow

The user drives construction with `go [letter]` commands. After
each completed package, propose 6–8 next options labeled A–H and
recommend one. The user picks. Each landed package follows this
shape:

1. Read the relevant ADR (or design fresh against the
   conversation context if no ADR exists yet).
2. Scaffold `package.json` + `tsconfig.json` + `vitest.config.ts`.
3. Build 4–7 source modules with comprehensive zod schemas +
   deterministic helpers. No placeholders.
4. Build `src/index.ts` re-exporting everything.
5. Wire `META_*` tables into kernel meta-schema (+ test).
6. Write `*.test.ts` files alongside each source module.
7. Run `pnpm --filter @crossengin/<name> test` until green.
8. Run `pnpm -r test` to confirm no regression.
9. Run `pnpm -r typecheck`.
10. `git commit` with a detailed multi-paragraph message
    describing each module's enums + invariants + helpers.
11. `git push -u origin claude/crossengin-development-LXLNw`.

## Git

- Working branch: `claude/crossengin-development-LXLNw`.
- Never force-push. Never skip hooks (`--no-verify`).
- Don't create PRs unless the user asks.
- Repository scope is restricted to `amoufaq5/crossengin` and
  `amoufaq5/erp`.

## What's deferred to Phase 2+

The current packages model the *shape* of the platform. The
following are intentionally out of scope until contracts settle:

- Real provider clients (Stripe, Salesforce, ServiceNow).
  Today the packages have credential refs + record types only.
  (Anthropic ships its real client in M2.7 — see below.)
- Real cryptography. Signature fields are typed as strings; the
  actual HMAC/ed25519 computation is not in this codebase.
- Customer-facing apps under `apps/` other than `architect-cli`.
  UI lives in `views` as type definitions only.

**No longer deferred (as of M1):** kernel DDL execution. The
`kernel-pg` package executes meta-schema DDL against a real
Postgres, with `_meta_migrations` bookkeeping for idempotent
re-runs and pg_catalog introspection for drift detection.

**No longer deferred (as of M2):** real cryptography. The
`crypto` package produces verifiable SHA-256 / BLAKE2b-512
hashes, real HMAC-SHA256 / Ed25519 signatures over `node:crypto`,
with an opaque `KeyHandle` contract that hides raw key material
behind a `KeyStore` interface.

**No longer deferred (as of M2.5 + M2.6):** downstream crypto
wiring. The crypto package is now called from six existing
packages, so previously-string-only signature/hash fields are
populated by real verifiable values: marketplace pack manifests
carry real Ed25519 signatures with sha256 public key
fingerprints; sdk webhook deliveries carry real HMAC-SHA256
signatures bound to timestamps for replay protection; forensics
chain entries carry real hash chains rooted at GENESIS_HASH plus
Ed25519 entry signatures, and evidence is sealed with real
sha256 + Ed25519; tenant-lifecycle tombstones carry
canonical-JSON-derived contentManifestSha256 + proofSha256;
access-reviews decision attestations carry real Ed25519
signatures for the four strong attestation kinds (e_signature_
digital, qualified_e_signature, two_person_attestation) and the
campaign evidence pack carries a real sealedSha256 over the
canonical evidence + bundle bytes; data-lineage Article 15
evidence packs carry a real sealedSha256 over the canonical
pack + bundle bytes for GDPR right-of-access deliverables.

**No longer deferred (as of M2.7):** real LLM provider client.
The `ai-providers-anthropic` package ships a working binding to
Anthropic's Messages API. `AnthropicProvider.complete(req)`
POSTs to `/v1/messages` with `x-api-key` + `anthropic-version:
2023-06-01` + `accept: text/event-stream`, yields the
discriminated-union `CompletionChunk` kinds (`text` /
`tool_call_start` / `tool_call_arg_delta` / `tool_call_end` /
`usage_final`) from `@crossengin/ai-providers` as SSE events
stream in. Token state is shared across `reader.read()`
boundaries via an internal `processSseEvents(raw, state)`
helper, so `usage_final` carries cumulative input/output/cached
tokens with USD cost computed at per-model rates (opus-4-7
$15/$75 per million, sonnet-4-6 $3/$15, haiku-4-5 $1/$5;
cached input 90% off; cache-write 25% premium). Errors normalize
to `AnthropicError` with `kind` + `status` + `isRetryable()`.
The provider is the first concrete `LlmProvider` implementation
— the Architect agent (M5.5 chat command) can now run against
a real backend with real cost accounting.

**No longer deferred (as of M3):** workflow execution. The
`workflow-runtime` package consumes `WorkflowDefinition` shapes
and actually runs them: starts instances, threads variables,
runs automatic transitions, schedules + executes activities via
a registered handler registry, fires timers when their fireAt is
reached, accepts signals matched by tenant + correlationKey,
emits the documented 24 event kinds (instance_started /
state_transitioned / activity_* / signal_* / timer_* /
variable_updated / compensation_* / instance_completed/failed/
cancelled/suspended/resumed), and replays state by left-folding
the event stream.

**No longer deferred (as of M3.5 + M3.6 + M3.7):** workflow
persistence + wiring + recovery. The `workflow-runtime-pg`
package implements the `EventLog` interface against
META_WORKFLOW_EVENTS via `@crossengin/kernel-pg`. Events survive
process restarts; multiple worker processes can share an event
log. PostgresInstanceStore / ActivityStore / SignalStore /
TimerStore turn projected in-memory state into UPSERTs against
the corresponding META_WORKFLOW_* tables. `ProjectingEventLog`
wraps any `EventLog` and auto-runs the projection writers after
each append — drop it into a `WorkflowEngine` and every
transition, signal, timer, activity scheduling becomes a
Postgres write without the consumer needing to know.
`WorkflowReplayer.resyncInstance` re-projects from the canonical
event log + re-upserts to fix drift after crashes or schema
changes; `verifyInstance` returns a typed DriftReport for CI
guards; `bulkResync` iterates with pagination so periodic sweeps
stay bounded.
`buildPersistentEngine(conn, definitions)` is the one-call
factory that wires the whole thing together.

**No longer deferred (as of M4):** HTTP request handling. The
`api-gateway-runtime` package executes the 17-stage pipeline
declared in `@crossengin/api-gateway` as real middleware. A
POST request lands → walks the stages → produces an
OutgoingResponse + a schema-valid PipelineExecution. Unauth →
401 + WWW-Authenticate. Valid JWT + over-quota → 429 +
Retry-After. Replay with same Idempotency-Key → cached 201 with
X-Idempotent-Replay: true. Routes with required scopes plug
into @crossengin/auth's principal model.

**No longer deferred (as of M4.5 + M4.6):** production-shape
gateway persistence + audit. The `api-gateway-pg` package
implements the four store interfaces against the existing
META_GATEWAY_* + META_RATE_LIMIT_DECISIONS tables via
`@crossengin/kernel-pg`. Idempotency records survive process
restarts and persist across nodes. Route definitions live in the
database (cache reload on TTL or explicit refresh, plus upsert
API for tooling). Rate-limit decisions are auditable rows in
META_RATE_LIMIT_DECISIONS. PipelineExecutions persist to
META_GATEWAY_PIPELINE_EXECUTIONS so every request is queryable
by tenant + correlationId + time. `GatewayReplayer.verifyExecution`
returns a typed DriftIssue list per request — stages out of
order, final stage/outcome mismatches, pass with 4xx/5xx, deny
without 4xx/5xx, terminating outcome not last, duration
inconsistent, rate-limit decision orphaned. summarize / bulkVerify
power periodic SLO + audit sweeps over the execution stream.

**No longer deferred (as of M5 + M4.7):** the developer entry
point + a running gateway. `apps/architect-cli` ships a
`crossengin` binary with the M5 subcommand surface: `init`
(scaffold a manifest), `validate` (zod-check + summary), `diff`
(computeManifestDiff with human or JSON output), `patch` (write
a manifest patch), `hash` (deterministic manifestHash), `apply`
(--dry-run emits the 3,061-line meta-schema SQL; live mode uses
MigrationApplier against PGHOST/PGDATABASE), `chat` (wired in
M5.5 — see below), `gateway start` (M4.7 — boots the gateway
runtime against a Node HTTP server, in-memory or Postgres-backed,
with built-in `/__ping` + `/__health` routes), `version`, `help`.
Every subcommand has --format human|json. Exit codes: 0 success /
1 runtime problem / 2 misuse. The CLI is the first binary that
composes contracts → real artifact, and now also the binary that
turns the M4 gateway runtime into a real listening HTTP server.

**No longer deferred (as of M5.9):** the chat audit trail is
queryable from the CLI. `crossengin sessions list / show /
replay` reads from META_ARCHITECT_* via the existing M5.7
stores and renders sessions as human-readable transcripts.
The new `getBySessionId({tenantId, sessionId})` on the
session store makes the (tenant_id, session_id) compound key
first-class. Operators debugging a "Claude gave wrong manifest"
report find the session via `list`, inspect the full
transcript via `show`, and re-read the conversation
chat-style via `replay`. M5.6 tool dispatch + M5.8 write
approvals surface verbatim in the audit data.

**No longer deferred (as of M7.8):** webhook → workflow signal
wiring for payments. `pack-erp-payments/src/signal-bridge.ts`
exports the canonical signal-name vocabulary, the provider
event-type → signal-name map (Stripe + Adyen + Braintree), a
multi-path correlation extractor (handles `data.object.id`,
`pspReference`, `transaction.id`, generic `provider_reference`),
and factory functions that wrap M6's `WorkflowSignalBridge`
with the right defaults. End-to-end verified: HMAC-signed
Stripe-shaped `payment_intent.succeeded` webhook → bridge
extracts `pi_xxx` → `submitSignal({signalName: "payment.captured",
correlationKey: "pi_xxx", tenantId, idempotencyKey})`. Pattern
for future webhook-driven packs (`pack-erp-shipping` for
carriers, etc.).

**No longer deferred (as of M7.5 + M7.6.5 + M7.9):** cross-pack
composition with kernel-driven extends resolution, exercised by
TWO downstream consumers. `pack-erp-payments` and
`pack-erp-healthcare` both declare `meta.extends: ["operate-erp/
core"]`; both return only their child additions; both resolve
via the kernel's `resolveManifest(manifest, {registry})` (which
loads the parent by slug from the CLI's `packManifestRegistry()`
and merges entities + traits + relations + roles + permissions
+ workflows + jobs + views into one unified manifest). The
healthcare pack adds 2 new roles (erp_clinician + erp_front_
desk) that merge with core's three — proving role contributions
flow correctly. `crossengin apply --pack=operate-erp/payments`
emits 5 entity tables; `--pack=operate-erp/healthcare` emits 7
(4 core + 3 healthcare); both with M7.7 tenant isolation
intact. Cycle detection (`ExtendsCycleError`) and unknown-
parent errors (`UnknownParentManifestError`) surface as typed
CLI exit codes. Pattern set for future verticals — declare
extends, kernel does the merge, marketplace enumerates
dependencies without running pack builders.

**No longer deferred (as of M7.7):** per-tenant isolation on
pack tables. The kernel's `tenant_owned` built-in trait now
injects `tenant_id UUID NOT NULL` (indexed), a cross-schema FK
to `meta.tenants(id) ON DELETE CASCADE`, `ENABLE ROW LEVEL
SECURITY`, and a `<table>_tenant_isolation` policy that uses
the same `current_setting('app.current_tenant_id', true)::UUID`
expression as every META table. Pack-erp-core's four entities
opt in via `["auditable", "tenant_owned"]`; the resulting SQL
is production-grade for multi-tenant deployments.

**No longer deferred (as of M7-wire):** the substrate-to-pack
end-to-end loop. `crossengin apply --pack <slug>` now resolves
a registered pack (today: `operate-erp/core`), validates its
manifest, emits per-entity DDL via the kernel's
`emitManifestCreate`, and concatenates with the meta bootstrap
SQL into one atomic MigrationApplier run. Five years of
contract work + nine months of runtime work produce a working
binary that ships a working schema in one command.

**No longer deferred (as of M2.8.5):** OpenAI Responses API.
The provider opts into `/v1/responses` via the `defaultApiPath`
constructor option (or per-call via `completeViaResponses`).
The Responses path collapses system messages into `instructions`,
flattens tool calls + tool results into top-level
`function_call` + `function_call_output` items, and surfaces
reasoning summaries via the non-streaming
`summarizeResponsesResponse` helper (streaming only emits
text + tool chunks; reasoning lives off-channel). Pattern set
for future named-event streaming providers (Anthropic's
upcoming responses-style endpoint, AWS Bedrock converse stream)
without touching the `CompletionChunk` discriminated union.

**No longer deferred (as of M6.5.5):** the router is live in
the CLI. `crossengin chat` now uses `buildChatCompleter` to
adapt to whichever API keys are configured. One key →
single-provider mode (legacy behavior preserved). Both keys →
`DefaultLlmRouter` with default task policies (cheap tasks to
gpt-4o-mini, premium tasks to opus, embeddings to OpenAI).
New `--cost-ceiling-usd` flag enforces per-request budget when
the router is active. The CLI's session-end summary reports
which mode was used.

**No longer deferred (as of M2.8):** the second real LLM
provider + embeddings. `@crossengin/ai-providers-openai`
covers OpenAI's Chat Completions (gpt-4o family + o1 family)
and Embeddings (text-embedding-3 family) APIs end-to-end. The
M5.6 `LlmMessage.toolUses` extension translates cleanly into
OpenAI's `tool_calls` format with no schema changes — proving
the cross-provider pattern. The router (M6.5) now has two
real providers to route between; embeddings have a real
backend for the first time. Operators can configure
`taskPolicies.summarizer = { primary: "openai/gpt-4o-mini",
fallback: ["anthropic/claude-haiku-4-5"] }` to drop cheap
summarization to a $0.15/M model while keeping authoring on
Claude.

**No longer deferred (as of M6.5):** policy routing across
providers. `@crossengin/ai-router` lets a consumer hand off a
`CompletionRequest` and get back a stream with: provider chosen
via `TaskPolicyMap` (primary then fallback), residency-filtered
to the tenant's policy, retried with exponential backoff on
retryable errors, falling back to the next provider when
exhausted, and refused if the tenant's `costCeiling` would be
breached. Pre-flight cost estimate uses input length + maxTokens
× per-million pricing; the post-call `usage_final.cost` replaces
the estimate in the cost tracker. Pattern set for OpenAI /
Bedrock / Vertex once their `LlmProvider` adapters land — no
router changes needed.

**No longer deferred (as of M7):** the first vertical pack.
`@crossengin/pack-erp-core` ships a real Manifest that exercises
every kernel cross-validator. The substrate is now proven —
entities, relations, roles, permissions, workflows, jobs, and
views all resolve correctly under a realistic ERP schema. The
Architect agent has a concrete starting point: `buildErpCorePack
(opts)` returns a working Manifest a developer can validate +
hash + apply via the existing CLI flow. Pattern set for future
verticals (healthcare, retail, construction): same module shape,
same cross-validators, optional `meta.extends` lineage.

**No longer deferred (as of M5.7):** chat audit trail. The new
`@crossengin/ai-architect-pg` package persists every chat
session, message, tool invocation, and write proposal to four
META_ARCHITECT_* tables. The chat engine emits lifecycle events
(`onSessionStart` / `onMessage` / `onToolInvocation` /
`onProposal` / `onSessionEnd`) into an abstract `Transcript`
interface; `NullTranscript` (default) discards events,
`PostgresTranscript` writes them. Sessions are unique per
(tenant, session_id); messages are ordered by
(turn_index, message_index); proposals record `decision` (one
of auto_approved / interactive_approved / interactive_denied /
no_changes / invalid_manifest) + `applied` + `denial_reason`.
Operators query `SELECT * FROM meta.architect_proposals WHERE
decision = 'interactive_approved'` to audit writes,
`JOIN architect_messages ON session_id` to reconstruct the
conversation context for any proposal.

**No longer deferred (as of M5.8):** closed authoring loop.
`crossengin chat --allow-file-write` now exposes
`propose_manifest_edit({path, new_manifest_json})` as a tool
Claude can invoke. Every write proposal surfaces a diff
(entities added / removed / modified) + the new hash to the
developer, who approves (`y` / `yes`) or denies (`n` /
anything else / EOF). Approved writes go to disk pretty-
printed; denied / invalid / no-change proposals return
typed `{applied: false, reason}` envelopes Claude can react
to. `--auto-approve-writes` skips the prompt (required for
one-shot scripted mode, where there's no human to ask).
`WriteApprover` interface decouples approval policy from
the tool itself — `autoApprover(true)` for scripted runs,
`interactiveApprover({io, reader})` for the REPL. Both share
the same `LineReader` the REPL uses, so the approval prompt
and the chat prompt cooperate over one stdin without
competing readers.

**No longer deferred (as of M5.6):** tool-driven authoring loop.
`crossengin chat` now exposes the manifest-side CLI helpers as
tools Claude can call mid-conversation. The default catalog
(`validate_manifest` / `hash_manifest` / `diff_manifests` /
`summarize_manifest`) gives Claude what it needs to author +
verify a manifest in one session; `--allow-file-read` adds an
extension-gated, size-capped `read_file` tool when the developer
explicitly opts in. `runChatExchange` orchestrates per-message
tool dispatch with a `DEFAULT_MAX_TOOL_ITERATIONS` (5) circuit
breaker. Tool errors don't terminate the exchange — they go
back to Claude as `tool_result` envelopes so the model can
react. `@crossengin/ai-providers.LlmMessage` gained an optional
`toolUses` field so assistant tool_use blocks round-trip
correctly through Anthropic's API (required for `tool_use_id`
matching on subsequent `tool_result` blocks).

**No longer deferred (as of M5.5):** chat against a real model.
`crossengin chat` now constructs an `AnthropicProvider` (using
`ANTHROPIC_API_KEY` from env + a configurable `--model`,
defaulting to claude-sonnet-4-6) and routes through the shared
chat engine in `architect-cli/src/chat.ts`. `runChatTurn`
streams chunks from `provider.complete()` to a renderer
(plain-text for human, NDJSON for `--format=json`), accumulates
assistant text + tool calls + usage. `runChatRepl` handles both
one-shot (`--prompt "..."`) and REPL (stdin lines until `/exit`
/ EOF) modes, aggregating per-turn usage into a session total
with USD cost. Tests inject a stub `LlmProvider` via
`RunContext.providerOverride`, so CI runs offline without an
Anthropic key.

## ADRs

ADRs 0001-0104 exist as markdown in `docs/adr/`. Every shipped
package has a corresponding ADR; no reserved gaps. ADR-0046 is
the bridge from Phase 1 contracts to Phase 2 runtime (8
milestones). ADR-0047 covers Phase 2 M1 (`kernel-pg`), ADR-0048
covers Phase 2 M2 (`crypto`), ADR-0049 covers Phase 2 M3
(`workflow-runtime`), ADR-0050 covers Phase 2 M4
(`api-gateway-runtime`), ADR-0051 covers Phase 2 M5
(`architect-cli`), ADR-0052 covers Phase 2 M6
(`workflow-signal-bridge`), ADR-0053 covers Phase 2 M2.7
(`ai-providers-anthropic`), ADR-0054 covers Phase 2 M5.5
(architect-cli chat mode), ADR-0055 covers Phase 2 M5.6
(architect-cli tool-driven chat), ADR-0056 covers Phase 2
M5.8 (architect-cli write tools), ADR-0057 covers Phase 2
M5.7 (chat persistence to META_ARCHITECT_*), ADR-0058 covers
Phase 2 M7 (`pack-erp-core`), ADR-0059 covers Phase 2 M6.5
(`ai-router`), ADR-0060 covers Phase 2 M2.8
(`ai-providers-openai`), ADR-0061 covers Phase 2 M6.5.5
(architect-cli router integration), ADR-0062 covers Phase 2
M2.8.5 (OpenAI Responses API support), ADR-0063 covers Phase 2
M7-wire (CLI `--pack` apply), ADR-0064 covers Phase 2 M7.7
(pack tenant scoping via `tenant_owned` trait), ADR-0065
covers Phase 2 M7.5 (pack-erp-payments — cross-pack
composition), ADR-0066 covers Phase 2 M7.8 (payment
signal-bridge wiring), ADR-0067 covers Phase 2 M5.9 (CLI
sessions subcommands), ADR-0068 covers Phase 2 M7.6.5
(kernel `extends` resolver wiring), ADR-0069 covers Phase 2
M4.7 (CLI gateway binding), ADR-0070 covers Phase 2 M7.9
(`pack-erp-healthcare` — third vertical pack), ADR-0071 covers
Phase 2 M2.9 (`ai-providers-bedrock` — third real LlmProvider
with AWS sig v4 + binary event-stream parsing), ADR-0072 covers
Phase 2 M2.9.5 (Bedrock Titan + Cohere embeddings closing
M2.9's open Q4), ADR-0073 covers Phase 2 M6.5.6 (architect-cli
Bedrock integration), ADR-0074 covers Phase 2 M4.7.5 (gateway
JWT auth + routes subcommand), ADR-0075 covers Phase 2 M4.7.6
(URL-fetched JWKS + SIGHUP/periodic hot-reload), ADR-0076
covers Phase 2 M2.9.6 (Bedrock cacheControl + Titan
parallelism), ADR-0077 covers Phase 2 M2.9.7 (Bedrock
multimodal embeddings + chat image content block types),
ADR-0078 covers Phase 2 M2.X (kernel LlmMessage.attachments
+ vision capability — multimodal chat across Anthropic +
OpenAI + Bedrock), ADR-0079 covers Phase 2 M4.8 (gateway
routes from pack manifest — bulk register-pack via the
M7.6.5 extends resolver), ADR-0080 covers Phase 2 M4.8.x
(gateway routes unregister-pack — symmetric tear-down),
ADR-0081 covers Phase 2 M4.8.y (gateway routes sync-pack —
composite diff/upsert + external-route reporting), ADR-0082
covers Phase 2 M4.10 (routes.source_pack column — pack
attribution + safe `sync-pack --prune-obsolete`), ADR-0083
covers Phase 2 M4.10.x (`unregister-pack --by-source-pack` —
manifest-free tear-down via the source_pack column), ADR-0084
covers Phase 2 M2.9.8 (Bedrock Guardrails integration — opt-in
content moderation with thrown errors for streaming + typed
stopReason for non-streaming), ADR-0085 covers Phase 2 M2.9.8.x
(Bedrock per-request guardrail override — sibling methods with
three-state semantics for tenant-specific / A-B-cohort /
admin-escape-hatch use cases), ADR-0086 covers Phase 2 M2.X.6
(OpenAI + Anthropic moderation surfaces — typed errors for
`finish_reason: "content_filter"` and `stop_reason: "refusal"`
matching the M2.9.8 post-usage_final-throw pattern), ADR-0087
covers Phase 2 M2.X.6.x (cross-provider moderation helper —
kernel-level `isModerationError(err)` predicate + shared
`MODERATION_ERROR_KINDS` tuple), ADR-0088 covers Phase 2 M2.X.5
(kernel LlmMessage.content discriminated union — unblocked
multimodal assistant outputs across Anthropic / OpenAI / Bedrock),
ADR-0089 covers Phase 2 M2.X.5.x (tool_use + tool_result content
block variants — consolidates tool-call surface with OpenAI
flatMap refactor for message-flattening), ADR-0090 covers Phase
2 M2.X.7 (cross-provider retryable helper — kernel-level
`isRetryableError(err)` + shared `RETRYABLE_ERROR_KINDS` tuple,
symmetric with M2.X.6.x's moderation helper), ADR-0091 covers
Phase 2 M6.6 (router uses kernel cross-provider helpers —
exercises M2.X.6.x + M2.X.7 in real consumer code + fixes
M2.X.5 array-content estimation bug), ADR-0092 covers Phase 2
M2.X.8 (standalone OpenAI Moderations API — provider.moderate
for proactive pre-screening with 11-category classification),
ADR-0093 covers Phase 2 M2.8.6 (OpenAI Responses API image
inputs — closes M2.X.5 vision gap on the Responses path),
ADR-0094 covers Phase 2 M2.X.5.y (ImageUrlContentBlock — URL-
based image variant for the kernel content union, with
OpenAI pass-through and Bedrock/Anthropic throw semantics),
ADR-0095 covers Phase 2 M2.X.9 (cross-provider input-too-
large helper — third predicate in the kernel error
classification surface, completing the partition into
retryable + moderation + input-too-large + other), ADR-0096
covers Phase 2 M2.X.5.z (Anthropic URL-source image support —
threads ImageUrlContentBlock URLs through to Anthropic's
native URL source variant; provider parity expanded for
URL-based images across both OpenAI paths + Anthropic),
ADR-0097 covers Phase 2 M2.X.5.aa (DocumentContentBlock — PDF
inputs supported on Bedrock + Anthropic + OpenAI Responses
via native document/file content blocks; OpenAI Chat throws
with actionable guidance pointing to the Responses path),
ADR-0098 covers Phase 2 M2.X.5.aa.y (DocumentUrlContentBlock —
URL-based PDF inputs; Anthropic native passthrough, three other
provider paths throw with pre-fetch guidance), ADR-0099 covers
Phase 2 M2.X.5.aa.x (document format expansion txt/md/csv —
4 formats × 3 providers all native), ADR-0100 covers Phase 2
M2.X.5.aa.x.1 (office document format expansion — doc/docx/xls/
xlsx/html added; Bedrock native, two-provider throw with
conversion guidance), ADR-0101 covers Phase 2 M2.X.10 (kernel
LlmMessage.name enforcement + OpenAI Chat threading across all
four message roles), ADR-0102 covers Phase 2 M2.X.5.aa.z
(OpenAI Files API integration — upload/retrieve/delete CRUD +
FileReferenceContentBlock kernel variant; OpenAI Responses
native passthrough, three other provider paths throw),
ADR-0103 covers Phase 2 M2.X.5.aa.z.1 (Anthropic Files API
integration — mirror of OpenAI Files API but with Anthropic
beta header and document source: {type: "file"} variant; the
M2.X.5.aa.z Anthropic throw becomes a native passthrough),
ADR-0104 covers Phase 2 M2.X.5.aa.z.2 (Files API listFiles()
across OpenAI + Anthropic — provider-native pagination shapes
preserved; CRUD+list pattern complete on both providers),
ADR-0105 covers Phase 2 M2.X.5.aa.z.3 (Bedrock batch inference
listBatches — first control-plane operation on Bedrock,
exposed via a separate controlPlaneBaseUrl + signedControlPlaneGet
helper; three-provider enumeration parity achieved across
OpenAI listFiles + Anthropic listFiles + Bedrock listBatches),
ADR-0106 covers Phase 2 M2.X.5.aa.z.4 (Bedrock batch inference
getBatch — single-job lookup pairing with listBatches;
identifier validated against an AWS-partition-aware regex
BEFORE the fetch; BedrockBatchJobDetail = BedrockBatchJobSummary
alias since AWS returns identical wire shapes for both
endpoints; parseBatchJobSummary promoted from private to
exported for operator reuse), ADR-0107 covers Phase 2
M2.X.5.aa.z.5 (Bedrock batch inference stopBatch — third
batch operation, completing read/write split; new
signedControlPlanePost transport rail for empty-body POSTs;
409 ConflictException surfaces via `.code` field — dedicated
conflict_error kernel kind deferred until a second 409-emitting
endpoint lands), ADR-0108 covers Phase 2 M2.X.5.aa.z.6
(Bedrock batch inference createBatch — fourth batch operation
closing the CRUD surface; pure boundary-validator
buildCreateBatchBody enforces 14 documented AWS constraints
fast-fail at the boundary; signedControlPlanePost widened to
accept an optional body; second 409-emitting endpoint now
justifies a dedicated conflict_error kernel kind, proposed
as M2.X.12), ADR-0109 covers Phase 2 M2.X.5.aa.z.7 (Bedrock
listGuardrails — second control-plane enumeration following
the M2.X.5.aa.z.3 pattern; new guardrails-api.ts module
keeps inference-time guardrails.ts and control-plane concerns
separated; six-value status tuple matching AWS uppercase
verbatim; behavioral note documented — guardrailIdentifier
toggles between roster-mode and version-history-mode),
ADR-0110 covers Phase 2 M2.X.5.aa.z.8 (Bedrock getGuardrail
with policy detail — full guardrail body returned for
compliance disclosures + drift detection + multi-version
diffs; five typed nested policy types modeled with stable
4-tuple enums for filter strength + content filter type +
contextual grounding type + PII action; growing enums like
PII entity type preserved as strings for forward-compat;
field naming asymmetry preserved (ListGuardrails uses
{id, arn}; GetGuardrail uses {guardrailId, guardrailArn})),
ADR-0111 covers Phase 2 M2.X.5.aa.z.9 (Bedrock
listInferenceProfiles — third paginated control-plane
enumeration after listBatches + listGuardrails; cross-region
inference profiles, AWS's recommended production-workload
invocation path; SYSTEM_DEFINED vs APPLICATION type
distinction surfaced; per-region modelArn list preserved
verbatim), ADR-0112 covers Phase 2 M2.X.5.aa.z.10 (Bedrock
getInferenceProfile — detail companion mirroring the
M2.X.5.aa.z.4 getBatch type-alias pattern;
BedrockInferenceProfileDetail = BedrockInferenceProfileSummary
since AWS returns identical shapes; both ID and ARN forms
accepted as identifier), ADR-0113 covers Phase 2 M2.X.5.aa.z.11
(Bedrock listImportedModels — fourth paginated control-plane
enumeration; custom-imported model artifacts surfaced for
inventory + architecture-aware routing + instruct-tuned
discoverability + tenant cleanup; modelArchitecture preserved
as raw string for forward-compat against AWS architecture
additions), ADR-0114 covers Phase 2 M2.X.5.aa.z.12 (Bedrock
getImportedModel with data-source provenance — extended-shape
detail (not type-alias) since AWS adds jobName + jobArn +
modelDataSource.s3DataSource.s3Uri + optional modelKmsKeyArn;
two get-shape patterns now distinct in the package: type-alias
when AWS returns identical shapes, extended-type when get
returns richer fields; provenance + KMS audit + import-job
correlation workflows unblocked), ADR-0115 covers Phase 2
M2.X.5.aa.z.13 (Bedrock listCustomModels — fifth paginated
control-plane enumeration; custom models = fine-tunes /
continued-pretrains / distillations distinct from imported
models; 8-parameter filter set including
baseModelArnEquals / foundationModelArnEquals / isOwned;
mixed-case status tuple Active|Creating|Failed preserved
verbatim from AWS; modelStatus optional since AWS omits it
for legacy entries), ADR-0116 covers Phase 2 M2.X.5.aa.z.14
(Bedrock getCustomModel with training/validation detail —
third extended-shape detail instance after Guardrail +
ImportedModel; 8 new typed sub-shapes modeling AWS's contract
verbatim including S3Config / Validator /
ValidationDataConfig / TrainingMetrics / ValidationMetric /
TeacherModelConfig / DistillationConfig /
CustomizationConfig; hyperParameters as Record<string, string>
matching AWS's wire contract; strict finite-number validation
on losses), ADR-0117 covers Phase 2 M2.X.5.aa.z.15 (Bedrock
listModelImportJobs — sixth paginated control-plane
enumeration; pairs with M2.X.5.aa.z.12's BedrockImportedModelDetail
jobArn field; mixed-case 3-value status tuple
InProgress|Completed|Failed; importedModelArn +
importedModelName conditionally populated post-success per AWS
documented behavior), ADR-0118 covers Phase 2 M2.X.12
(conflict_error kernel kind + isConflictError cross-provider
classifier — fourth kernel classifier following the
established M2.X.6.x / M2.X.7 / M2.X.9 pattern; triggered by
two Bedrock 409-emitting endpoints (stopBatch + createBatch)
plus OpenAI 409 surfaces; three provider error tables extended;
conflict_error is NOT retryable; two existing tests upgraded
to assert the new classified kind), ADR-0119 covers Phase 2
M5.10.5 (chat REPL widens user input to LlmContentBlock[] —
closes the M2.X.5/.x/.y/.z/.aa investment loop;
parseUserLine slash-command parser; composeUserContent helper;
per-turn attachment reset semantics; transcript schema
unchanged via userContentToTranscriptText flattening; pattern
set for future kernel multimodal additions), ADR-0120 covers
Phase 2 M8 (workflow runtime instrumentation hooks +
META_WORKFLOW_TRACES — first production-grade observability
surface for workflows; WorkflowInstrumentation interface with
11 event kinds wired at 8 engine paths; NEW 120th meta-schema
table META_WORKFLOW_TRACES distinct from source-of-truth
META_WORKFLOW_EVENTS; PostgresWorkflowInstrumentation
implementation; buildPersistentEngine gains persistTraces +
instrumentation options; observability failures NEVER crash
the engine; OTel-ready event shape; combineInstrumentations
fan-out helper), ADR-0121 covers Phase 2 M2.X.5.aa.z.16
(Bedrock getModelImportJob — fourth extended-shape detail
instance after Guardrail / ImportedModel / CustomModel;
import-job triage workflows fully unblocked; failure
diagnostics + IAM role audit + KMS + VPC config all
surfaced via the rich GetModelImportJob response;
parseModelImportJobDetail reuses M2.X.5.aa.z.15's
isBedrockModelImportJobStatus discriminator), ADR-0122 covers
Phase 2 M2.X.5.aa.z.17 (Bedrock listModelCustomizationJobs —
seventh paginated control-plane enumeration; AWS-native
fine-tune surface paralleling listModelImportJobs but with a
richer 5-value status vocabulary including Stopping/Stopped
for operator-issued mid-training aborts; customizationType
preserved as string for forward-compat), ADR-0123 covers
Phase 2 M2.X.5.aa.z.18 (Bedrock getModelCustomizationJob with
training/validation detail — fifth extended-shape detail
instance; 9 required + 13 optional fields; 8 typed sub-shapes
including S3Config / Validator / ValidationDataConfig /
TrainingMetrics / ValidationMetric / TeacherModelConfig /
DistillationConfig / CustomizationConfig structurally
mirroring getCustomModel but typed independently per
AWS-contract preservation; field-naming asymmetry vs summary
preserved verbatim — detail uses outputModelName/outputModelArn,
summary uses customModelName/customModelArn), ADR-0124 covers
Phase 2 M2.X.5.aa.z.19 (Bedrock stopModelCustomizationJob —
operator-initiated mid-training abort companion to the
Stopping/Stopped statuses from M2.X.5.aa.z.17; pure reuse of
the M2.X.5.aa.z.5 signedControlPlanePost rail; third Bedrock
endpoint emitting 409 ConflictException — isConflictError
classifier (M2.X.12) now load-bearing across stopBatch +
createBatch + stopModelCustomizationJob), ADR-0125 covers
Phase 2 M2.X.11 (cacheBreakpoint field on LlmContentBlock +
Anthropic prompt caching — additive optional field on all 8
block variants; Anthropic translator emits cache_control:
{type: "ephemeral"} via the new withCacheControl post-process
wrapper; AnthropicContentBlock union widened; AWS Bedrock's
separate cachePoint BLOCK type wire shape deferred to a
follow-up; OpenAI implicit-caching path silently drops the
field; long-context chat workloads see ~10x input-cost
reduction on cache hits), ADR-0126 covers Phase 2 M2.X.11.x
(Bedrock cachePoint translator wiring — closes the Q1 deferred
from ADR-0125; single-line append in appendKernelBlocks loop
inserts the shared BEDROCK_CACHE_POINT constant after each
kernel block with cacheBreakpoint; M2.9's pre-built
cachePoint infrastructure earns its keep; cross-provider
parity now on Anthropic + Bedrock for the kernel
cacheBreakpoint field), ADR-0127 covers Phase 2 M2.X.13
(not_found_error kernel kind + isNotFoundError cross-provider
classifier — fifth kernel classifier in the family following
the established M2.X.6.x / M2.X.7 / M2.X.9 / M2.X.12 pattern;
zero provider changes required since all three providers
already emit not_found_error from classifyHttpStatus(404);
kernel error-space partition now has six buckets;
idempotent cleanup workflows have a documented cross-provider
pattern), ADR-0128 covers Phase 2 M2.X.14 (authentication_error
kernel kind + isAuthenticationError cross-provider classifier
— sixth kernel classifier; closes ADR-0127 Q1 mechanically;
all three providers already emit authentication_error from
classifyHttpStatus(401), Bedrock additionally via CODE_TO_KIND
for AWS-specific exception names; explicitly distinct from
permission_error since 401 and 403 have different remediation
paths; credential rotation + multi-tenant key validation + CI
boot-check workflows now documented), ADR-0129 covers Phase 2
M2.X.15 (permission_error kernel kind + isPermissionError
cross-provider classifier — seventh kernel classifier
completing the canonical 4xx/5xx classifier suite except for
invalid_request_error; closes ADR-0128 Q1 mechanically;
Anthropic + OpenAI emit permission_error from
classifyHttpStatus(403), Bedrock via
CODE_TO_KIND["AccessDeniedException"]; pairs with
isAuthenticationError for "any auth-related issue" composite
via inline OR), ADR-0130 covers Phase 2 M2.X.16
(invalid_request_error kernel kind + isInvalidRequestError
cross-provider classifier — EIGHTH AND FINAL kernel
classifier; closes ADR-0129 Q1 mechanically; completes the
canonical 4xx/5xx sweep — every documented kernel error kind
across all three providers now has a kernel classifier;
mutual-exclusivity test asserts an invalid_request_error
matches exactly ONE classifier; CI kernel-validation + LLM
auto-fix + user-facing error translation workflows have
documented patterns), ADR-0131 covers Phase 2 M2.X.5.aa.z.20
(Bedrock createModelCustomizationJob — largest write surface
remaining on Bedrock's control plane; customization-job CRUD
now complete after M2.X.5.aa.z.17/.18/.19; 7 required + 8
optional fields with 12+ boundary-validation rules; reuses 5
sub-types from M2.X.5.aa.z.18 + adds
BedrockModelCustomizationJobTag; AWS contract preservation
includes customModelKmsKeyId (not KmsKeyArn — preserved
verbatim) and create-vs-get field-naming asymmetry per
ADR-0123; three workflows unblocked: programmatic fine-tune
submission, automated retry-on-failure with adjusted
hyperparameters, distillation lineage capture), ADR-0132
covers Phase 2 M8.1 (workflow runtime activity execution
instrumentation — closes ADR-0120 Q3, the longest-outstanding
deferred Q from the M8 milestone; WORKFLOW_INSTRUMENTATION_KINDS
grows 11→14 with activity_started + activity_completed +
activity_failed; durationMs computed from engine clock;
handler-exception path covered (both controlled `return
{status: "failed"}` and uncaught `throw` surface
activity_failed with HANDLER_EXCEPTION errorCode);
META_WORKFLOW_TRACES.kind CHECK constraint widened
additively; three operator workflows enabled: latency
dashboards via durationMs aggregation, failure alerting on
the indexed kind column, per-activity-kind cost attribution
rail ready for future M6.7 PostgresCostTracker), ADR-0133
covers Phase 2 M6.6.x (ai-router special-cases isConflictError
for retry chain short-circuit — closes ADR-0118 Q2 from the
M2.X.12 conflict_error classifier milestone; one-line gate
extension in isRouterRetryable; conflict errors join
moderation as terminal; rate_limit / moderation / other paths
unchanged; pattern set for future per-classifier short-circuit
ADRs), ADR-0134 covers Phase 2 M6.6.y (ai-router special-cases
isNotFoundError for retry chain short-circuit — closes ADR-0133
Q1 from the M6.6.x conflict short-circuit milestone; same
shape one-line extension; not-found errors join moderation +
conflict as terminal in isRouterRetryable; identifier
mismatches don't benefit from fallback because identifiers are
provider-scoped — OpenAI file_id ≠ Anthropic file ID ≠ Bedrock
ARN; three classifiers now short-circuit: moderation +
conflict + not_found; rate_limit fallback path preserved),
ADR-0135 covers Phase 2 M6.7 (PostgresCostTracker — first
persisted ai-router cost accumulator — closes ADR-0059's
longest-deferred Q; new `@crossengin/ai-router-pg` package
follows the established X / X-pg adapter pattern; adds 121st
meta-schema table META_LLM_COST_WINDOWS with one row per
tenant — natural PK on tenant_id, NUMERIC(18,8) cost
precision, RLS tenant-isolated; atomic UPSERT with SQL-side
expiry CASE makes concurrent recordUsage from multi-replica
gateways race-free in a single round-trip; tumbling-window
semantic matches InMemoryCostTracker exactly so the
substitution is drop-in; closes 3 operator gaps: multi-replica
under-enforcement, cross-restart zeroing, and dashboard
observability via `SELECT * FROM meta.llm_cost_windows`),
ADR-0136 covers Phase 2 M2.X.5.aa.z.21 (Bedrock DELETE
control-plane surfaces — FIRST DELETE write surfaces ever
shipped on the Bedrock substrate; deleteCustomModel +
deleteImportedModel + deleteGuardrail + shared
signedControlPlaneDelete transport; mirrors the corresponding
GET endpoints exactly on path / identifier shape; 404
propagation pattern documented — caller decides idempotency
via isNotFoundError(err) predicate wrap, never provider-
swallowed because that would block the router short-circuit
(M6.6.y) and verify-then-recreate workflows; deleteGuardrail
preserves AWS asymmetric default — omit-version = delete all,
provide-version = delete that one; transport rail reusable
for future DELETE rollouts on inference-profiles / prompts /
flows; Bedrock control plane now has 18 read + 2 stop + 1
create + 3 delete = 24 operations), ADR-0137 covers Phase 2
M6.7.x (per-tenant cost ceiling — closes ADR-0135 Q1 + Q4
in one milestone; META_LLM_COST_CEILINGS as the 122nd meta-
schema table with one row per tenant, NULLABLE policy
columns where NULL = unbounded on that axis, NUMERIC(18,8)
precision, RLS tenant-isolated; new `getTenantCostCeiling`
field on DefaultLlmRouterOptions for resolver injection;
PostgresCostCeilingResolver in `@crossengin/ai-router-pg`
provides drop-in implementation; whole-object override
semantic — tenant ceiling REPLACES the global rather than
merging field-by-field; ceilings are now data not code so
operators adjust without redeploying; schema forward-compat
with future history-aware reads via effective_from column;
zero data migration needed — pre-existing tenants get the
global ceiling, new per-tenant rows opt-in via INSERT; per-
tier pricing now expressible (free / pro / enterprise)),
ADR-0138 covers Phase 2 M2.X.5.aa.z.22 (Bedrock
deleteInferenceProfile with system-profile guard — closes
ADR-0136 Q2; 4th DELETE on the Bedrock control plane and
the first "smart" delete with mandatory pre-flight; the
inference-profiles namespace contains two kinds of
resources sharing the same URI — APPLICATION (operator-
deletable) vs SYSTEM_DEFINED (AWS-owned + immutable); a
blind DELETE on a system profile yields opaque AWS
ValidationException so the substrate runs a mandatory pre-
flight `getInferenceProfile` serving three purposes
simultaneously (existence check via 404 → not_found_error,
GET-permission check via 403 → permission_error, type
field read for guard); type !== "APPLICATION" → throw
invalid_request_error with profile + type in message + NO
DELETE issued; type === "APPLICATION" → DELETE via
signedControlPlaneDelete; no bypass flag, no type-from-
caller, no cache; race window between GET and DELETE
propagates the DELETE-side 404 verbatim — same idempotency-
via-isNotFoundError pattern as ADR-0136 applies; pre-flight-
guard pattern established for future two-typed resources;
Bedrock control plane now has 18 read + 2 stop + 1 create +
4 delete = 25 operations), ADR-0139 covers Phase 2 M5.11
(`crossengin chat --max-cost-usd $X` session budget flag —
session-scoped post-hoc cumulative cap independent of and
orthogonal to --cost-ceiling-usd which remains the per-
request gate; enforcement lives in REPL loop not router for
three reasons (router preflight uses estimated cost while
budget needs real cost; router is transport but budget is
CLI-state; maxUsdPerWindow would need fake-long windowSeconds
as code smell); check at top of each REPL iteration BEFORE
consuming next input — last turn allowed to complete but
next refused; one-shot mode flags exceedance informationally
after the single turn; human + JSON display surfaces with
parity; no breaking change — existing callers see identical
behavior without the flag; CLI client-side budget is the
complement to M6.7 server-side multi-replica enforcement,
not a duplicate; operators can run bounded interactive
sessions or batch loops with budget guard rails), ADR-0140
covers Phase 2 M6.7.y (PostgresLatencyTracker + LatencyTracker
contract async-ification — LatencyTracker interface becomes
async — both record() and stats() return Promises; internal-
only breaking change since only the router calls record (two
new awaits) plus InMemoryLatencyTracker upgraded mechanically;
fire-and-forget alternative rejected for silent-failure +
unbounded-queue concerns + contract-inconsistency with
already-async CostTracker; 1ms PG INSERT overhead per LLM
request is negligible vs LLM call duration;
META_LLM_LATENCY_SAMPLES as 123rd meta-schema table —
append-only sample log with composite (provider_id,
recorded_at) index, latency_ms >= 0 CHECK, NO tenant scoping
(provider-level observability not per-tenant) NO RLS
(platform-wide same pattern as META_TENANTS);
PostgresLatencyTracker.record = single INSERT,
.stats = single windowed SELECT with CTE LIMIT N then PG
native percentile_cont aggregate — microseconds even at
millions of rows via index-only scans; continuous
percentile_cont interpolation differs from in-memory's
floor-index only at tiny window sizes (nil at window>=20);
operators can answer "anthropic p95 last hour?" with a
single SELECT; future Q1 retention policy, Q2 per-tenant
extension via additive ALTER TABLE), ADR-0141 covers Phase
2 M6.7.z (RouterInstrumentation + META_LLM_CALL_TRACES +
PostgresRouterInstrumentation — closes ADR-0135 Q2 +
ADR-0137 Q3+Q4 + ADR-0140 Q3 in one milestone; pattern
parity with M8 WorkflowInstrumentation — same onEvent
signature, same captureX/combineXs helpers, same NoopX
default — no behavior change for existing callers; three
event kinds llm_call_started + llm_call_completed +
llm_call_failed; per-attempt granularity (N attempts = 2N
events); willFallback derived from remaining choice index
so terminal short-circuits from ADR-0091/0133/0134 show
willFallback=false; META_LLM_CALL_TRACES as 124th meta-
schema table — audit-optimized (full event context: tenant,
session, task, model, costUsd, tokens, errors) +
tenant-scoped with RLS + 3 indexes serving canonical
operator queries (tenant-recent + provider-failures +
session-audit); distinct from LATENCY_SAMPLES on purpose —
different read patterns (aggregation vs audit) deserve
different schemas; PostgresRouterInstrumentation single-
INSERT-per-event mirroring PostgresWorkflowInstrumentation
verbatim; ai-router-pg adapter set now at 4 substrates —
cost-windows + cost-ceilings + latency-samples + call-
traces — router is fully observable; storage ~200 bytes/row;
embed-path instrumentation + correlationId field + ceiling-
resolution traces all listed as additive future Qs),
ADR-0142 covers Phase 2 M2.X.5.aa.z.23 (Bedrock
createInferenceProfile APPLICATION-only via copyFrom —
closes ADR-0138 Q3; 2nd CREATE on the Bedrock control plane
after createBatch (ADR-0108) and createModelCustomizationJob
(ADR-0131); completes the full APPLICATION-inference-profile
lifecycle on the substrate — create + list + get + delete;
AWS contract preserved with required inferenceProfileName +
modelSource.copyFrom and optional description +
clientRequestToken + tags; pure boundary validation enforces
8 documented constraints (name length+pattern, copyFrom
length, description length+pattern, clientRequestToken
length+pattern, tags count, tag key+value lengths) BEFORE
fetch; modelSource is a structured object so future AWS
expansion (hypothetical routingConfig) is an additive type
extension; NO pre-flight guard needed unlike delete (AWS
only creates APPLICATION via this endpoint, no SYSTEM
ambiguity); response is minimal — `{inferenceProfileArn,
status}` — operators wanting full detail call getInferenceProfile
next; clientRequestToken hooks AWS's idempotency contract;
symmetric error propagation 404/409/403/429; Bedrock control
plane now has 18 read + 2 stop + 2 create + 4 delete = 26
operations), ADR-0158 covers Phase 2 M6.8.y (Bedrock setExactTags
operator helper — closes ADR-0145 Q5; new
tagging-helpers.ts in @crossengin/ai-providers-bedrock hosts
standalone exported function setExactTags(provider,
{resourceArn, desiredTags}) returning {added, removed,
unchanged}; preserves substrate's three-tier layering with
tagging-api.ts pure code + provider.ts raw transport +
tagging-helpers.ts operator composition; algorithm
pre-flight validation → listTagsForResource → diff →
tagResource then untagResource → return audit; minimum
API calls based on diff with idempotent re-runs becoming
1-call list-only no-ops; AWS tagResource OVERWRITES
existing values so no untag-then-tag round-trip needed for
value updates; tag-then-untag ordering matches operator
mental model "add what I want then prune what I don't";
operator pain solved — convergence to desired state without
operators writing diff logic, minimum API calls vs naïve
tag-all+untag-all, idempotent CI/workflow integration, audit
trail via result object; index exports cleanup side effect
— previously-missing exports tagging-api +
provisioned-throughput-api + foundation-models-api added
alongside tagging-helpers so external consumers see the full
type surface; substrate layering preserved — BedrockProvider
stays 1:1 wrapper of AWS endpoints; if helpers proliferate
above 5 functions split into @crossengin/bedrock-helpers
package).
ADR-0159 covers Phase 2 M6.7.zz.tenant.dashboard
(`effectiveRetention(tenantId, tableName)` resolver on
PostgresTraceRetention — closes ADR-0155 Q6; single method
returns a discriminated-union EffectiveRetentionResolution
with three variants: tenant (source="tenant" + retentionDays
+ enabled=true + tenantId), platform (source="platform" +
retentionDays + enabled where boolean reflects platform row
state), none (source="none" + retentionDays=null +
enabled=false); resolution algorithm queries
meta.tenant_retention_policies WHERE tenant_id = $1 AND
table_name = $2 first; if row exists AND enabled=true →
return source="tenant" + SKIP platform query (single
round-trip happy path); else query meta.retention_policies
WHERE table_name = $1; if row exists → return
source="platform" with enabled reflecting platform row;
else return source="none"; semantic alignment with prune —
enabled=true requirement matches ADR-0155 where disabled
per-tenant policies fall back to platform-default;
discriminated union over flat shape because narrowing on
source gives type-safe field access (tenant guarantees
tenantId is present, platform guarantees retentionDays is
number not null, future variants like compliance_override
extend additively); method on PostgresTraceRetention not
separate class since retention has no router-side hot path
— this is CLI/dashboard concern, co-locating keeps SQL
parameterization consistent; two PG round-trips worst case,
one best case; works for llm_latency_samples (always
platform or none since no tenant override possible);
unknown tables return source="none" — operators see
"this isn't a prunable table" distinctly from "no policy
configured"; no schema change, no new dependencies, pure
code addition; operator workflows unblocked — admin
dashboards via "retention by tenant", compliance audits
via "is tenant X compliant?", GDPR Article 15 evidence
packs include retention policy attribution, admin UIs
badge tenants as Custom Policy / Platform Default /
DISABLED / No Policy; rejected alternatives — reuse
listTenantPolicies + listPolicies operator-side (replicates
resolution logic, two full SELECTs), return raw rows in
tuple (consumer still writes resolution), materialized
view (premature; operator-side caching sufficient), PG
function for resolution (deploys server-side functions
unnecessarily), resolve via previewPrune (semantics drift),
split getTenantPolicy + getPlatformPolicy methods (leaks
resolution to caller).
ADR-0178 covers Phase 2 M6.7.zz.tenant.opt-out.cli.diff
(`crossengin retention diff <tenant-a> <tenant-b>
<table-name>` CLI action + diffTenantPolicies adapter
method + exported normalizeResolutionForDiff pure helper
— closes ADR-0165 Q6; ADR-0173 shipped diff-history for
two events on same tenant+table, this milestone ships
the orthogonal axis — two tenants on same table; use
cases — tier migration verification (did Tenant A's
freshly-migrated retention match reference Tenant B's?),
drift detection (two tenants on same plan — divergent?),
compliance audit for regulated cohorts, migration-script
smoke test CI gates; adapter calls effectiveRetentionBatch
internally with the two (tenant, sameTable) pairs —
single canonical batch-resolver pattern: any future
comparison/aggregation operation needing multiple
resolutions should compose on top of effectiveRetentionBatch
rather than issuing own queries; 2 queries total
regardless of resolution variant matching dashboard
performance benefit from ADR-0177; diff computed via
reused computeFieldDiffs helper from ADR-0173 after
normalizing each resolution to comparable record via
new normalizeResolutionForDiff helper — flattens
discriminated-union variant into {source, retention_days,
enabled, opt_out, [opt_out_reason], [opt_out_until]}
where the last two appear only for tenant_opt_out variant;
same alphabetical-sort diff output across retention diff-
history + retention diff for uniform forensic format;
same-table constraint enforced via single tableName field
in input/result — cross-table comparisons different
semantic; result type DiffTenantPoliciesResult carries
{tenantIdA, tenantIdB, tableName, resolutionA, resolutionB,
fieldDiffs}; CLI takes three positional args tenant-a +
tenant-b + table-name all required (exit 2 missing), no
optional flags beyond --format; human output 3-section
format — 'Diff between tenant policies (table: <name>):'
header, per-tenant resolution summary line via private
summarizeResolutionForDiff helper that varies by variant
('source=tenant         retention=Nd  enabled=yes' for
tenant, 'source=tenant_opt_out  reason=<r>  until=<iso|
indefinite>' for opt_out, 'source=platform       retention=
Nd  enabled=yes|no' for platform, 'source=none
(no policy configured)' for none), blank line, then
either 'No differences — both tenants have the same
effective retention policy.' for empty fieldDiffs OR
'Field changes (N):' header followed by 'fieldname
valueA → valueB' lines reusing established conventions
'indefinite' / '<no reason>' for null fields; JSON
envelope {action: "diff", result: DiffTenantPoliciesResult}
preserves full discriminated-union structure for jq;
rejected alternatives — two effectiveRetention calls
(4 queries vs 2 batch defeating the perf composition),
deep-equality without normalization (variant shapes
differ so operators see 'all fields different'
misleadingly), allow cross-table comparison (different
semantic — future action if requested), N-way diff via
multiple positional args (pair-wise canonical pattern;
operators chain commands), --vs-platform shortcut for
tenant-vs-default (defer — operators run two retention
effective commands), use deferred retention effective-batch
CLI for inputs (focused single-purpose command better
than multi-action wrap), render resolution variant fields
without normalization (diff wouldn't tell operators which
values differ on the comparable axis), include tenant
metadata slug+display-name in result (substrate stays
minimal — operators join meta.tenants at their layer);
drawbacks — same-table only (cross-table needs different
command), two-tenant only (N-way runs multiple commands
or uses effectiveRetentionBatch directly via Node script),
no --diff-against-current-platform shortcut (use two
retention effective + manual compare), discriminated-
union JSON shape requires .source narrowing for jq users,
field renames in normalized diff (retentionDays becomes
retention_days matching JSONB history-diff convention
but different from resolution's TypeScript field name);
13 new adapter tests in trace-retention.test.ts —
uses effectiveRetentionBatch internally (issues exactly
2 queries verified via capture.length), returns metadata
+ resolutions + empty fieldDiffs when both none, empty
fieldDiffs when both identical platform, fieldDiffs when
tenant vs platform differ (source + retention_days),
fieldDiffs comparing tenant_opt_out vs tenant (source +
opt_out + opt_out_reason + opt_out_until), fieldDiffs
sorted alphabetically, resolutionA carries A's data and
resolutionB carries B's, uses tableName on both axes
(same table both tenants verified in params), clock-
aware expiry preserved (expired opt_out falls through to
platform on diff — both resolve platform, empty diffs);
normalizeResolutionForDiff helper unit tests — flattens
tenant variant to {source, retention_days, enabled,
opt_out:false}, flattens tenant_opt_out including reason
+ until, flattens platform variant, flattens none variant;
16 new CLI tests in retention.test.ts — missing tenantA/
tenantB/table args each exit 2, threads three args to
adapter, human-format 'No differences' for empty
fieldDiffs with 'same effective retention policy' message,
human-format renders metadata + per-tenant resolutions +
field-by-field diff with arrows + 'Field changes (N)'
header, human-format renders tenant_opt_out inline with
reason+until, JSON envelope shape {action: "diff",
result: ...}, adapter errors propagate exit 1;
formatTenantDiff helper unit tests — 'No differences'
message for empty, 'Field changes (N):' header for
diffs, tenant inline 'source=tenant retention=Nd
enabled=yes', tenant_opt_out inline with reason+until,
'indefinite' for null until + '<no reason>' for null
reason, platform inline with enabled=yes|no flag, none
inline 'source=none (no policy configured)'; cli.ts
helpText extended with retention diff <tenant-a>
<tenant-b> <table-name> usage line + 4-line description
explaining effectiveRetentionBatch reuse + 2-query
optimization; future Qs cover --vs-platform flag for
tenant-vs-default comparison, N-way diff via --add-tenant
repeated flag, cross-table retention diff <tenant>
<table-a> <table-b> (different semantic), visual color
highlighting via opt-in flag, configurable comparison
depth, --field <name> filter on JSON output (jq covers),
combined diff-timeline showing how tenant A vs tenant B
evolved over time). The retention CLI now has 14
operator-facing actions + 1 substrate-only adapter
method covering forensic + recovery + comparison +
performance workflows comprehensively.
ADR-0179 covers Phase 2 M6.7.zz.tenant.opt-out.cli.diff.vs-platform
(`crossengin retention diff <tenant> <table-name>
--vs-platform` flag + diffTenantVsPlatform adapter
method — closes ADR-0178 Q1; operators wanting "how
does this tenant differ from platform default?"
previously had no one-command answer — running two
retention effective commands and mental-diffing was the
workaround; new flag on existing diff action takes 2
positional args (tenant + table) instead of 3 + flag
triggers branch BEFORE positional validation; chose
flag-on-existing-action over new retention diff-platform
action since operators learn --vs-platform more
naturally than new action name; new adapter method
diffTenantVsPlatform({tenantId, tableName}) returns
DiffTenantVsPlatformResult {tenantId, tableName,
tenantResolution, platformResolution, fieldDiffs}; FIRST
adapter method in retention substrate NOT composing on
effectiveRetention/effectiveRetentionBatch — documented
exception because batch resolver returns only EFFECTIVE
resolution per pair (when tenant has no per-tenant
policy the batch result IS the platform fallback so the
"is tenant on default vs has override" distinction is
lost), and --vs-platform must surface BOTH sides
regardless of fallback for the workflow to be meaningful;
implementation 2 parallel queries via Promise.all — one
against meta.tenant_retention_policies + one against
meta.retention_policies — single wall-clock round-trip;
algorithm parallel queries, build platformResolution
from platform row (or {source:"none"} when absent),
build tenantResolution using same opt-out-active/enabled/
fallback logic as effectiveRetention but falling back
to the platformResolution we already computed (avoiding
duplicate platform query), compute fieldDiffs via reused
computeFieldDiffs from ADR-0173 after
normalizeResolutionForDiff on both sides; same clock()
source as effectiveRetention for opt-out expiry boundary
semantics; human output renders 3-section format —
'Diff between tenant and platform default (table:
<name>):' header, tenant row 'Tenant:   <uuid>  <summary>'
with summary via shared summarizeResolutionForDiff
helper from ADR-0178, platform row 'Platform: <summary>'
(no tenantId since platform policy isn't tenant-scoped),
blank line, then either 'No differences — tenant has
the same effective retention policy as the platform
default.' for empty fieldDiffs OR 'Field changes (N):'
header followed by 'fieldname valueA → valueB' lines
reusing established conventions; JSON envelope {action:
"diff", vsPlatform: true, result: DiffTenantVsPlatformResult}
where vsPlatform:true is the discriminator distinguishing
from ADR-0178's cross-tenant variant for downstream jq
consumers parsing either shape; use cases unblocked —
one-command "is this tenant on the default?" check
(.result.fieldDiffs.length==0 means yes), compliance
audit shell loop filtering tenants whose effective
retention deviates from default (for-each-tenant +
jq 'select(.result.fieldDiffs | length > 0)'), tier
migration verification via .result.tenantResolution.source
returning "platform" if migration succeeded vs "tenant"/
"tenant_opt_out" if per-tenant policy still applies,
pre-deletion safety check showing what would change when
policy reverted to default; rejected alternatives — new
action retention diff-platform (cleaner separation but
adds CLI surface and divides diff vocabulary), sentinel
--platform token in positional arg (magical hard-to-
document), always 3 positionals + --vs-platform silently
ignoring 3rd (operator-supplied real tenant ids would
be silently dropped error-prone), compose on
effectiveRetentionBatch with sentinel non-existent
tenant id (semantically awkward + relies on query
short-circuit + still doesn't return platform resolution
as separate field), return only platform + fieldDiffs
without tenantResolution echo (operators rendering would
re-query for tenant side redundantly — both sides
costs nothing extra), implicit fallback when only 2
positionals supplied to diff (surprising magical
behavior; explicit flag clearer), retention vs-default
standalone action name (diverges from diff-* naming
established in ADR-0173/0178), JSON unified envelope
with sentinel string "platform" in tenantIdB position
of cross-tenant shape (type pollution + sentinel-string
discrimination instead of typed discriminator); drawbacks
— single-flag overload on diff action with two arg
shapes (3 positionals or 2+flag) operators reading help
may not immediately notice (mitigated by separate
helpText usage line), doesn't compose on
effectiveRetentionBatch breaking pattern from ADR-0178
(documented as exception not the rule), 2 queries always
no short-circuit when tenant has no per-tenant policy
(same query count as effectiveRetention when it falls
through), no --vs-tier companion (operators run diff
against reference tenant on same tier instead), JSON
envelope shape divergence with two diff variants
operators write 2 jq branches (mitigated by
vsPlatform:true discriminator); 10 new adapter tests
in trace-retention.test.ts — issues exactly 2 queries
in parallel with tenant query against
meta.tenant_retention_policies + platform query against
meta.retention_policies with params verified
[tenantId, tableName] + [tableName] respectively,
returns both resolutions as none + empty fieldDiffs
when neither row exists, returns identical resolutions
+ empty fieldDiffs when tenant falls back to platform
(no per-tenant policy + platform exists — both resolve
platform), returns fieldDiffs when tenant override
differs from platform default (source=tenant vs
source=platform + retention_days=30 vs 90), renders
tenant_opt_out as tenantResolution when active opt-out
present (opt_out + opt_out_reason + opt_out_until fields
appear in diff), platformResolution always reflects
platform table independent of tenant verified via
tenant=7d but platform=365d enabled=false case (platform
returns 365d+disabled regardless of tenant's 7d
override), platformResolution=none when no platform row
exists (tenant policy present + platform absent),
expired opt-out falls through to platform on
tenantResolution (clock-aware via clock injection in
2026-06-01 with opt_out_until=2020-01-01 producing
tenantResolution.source=tenant), tenant row with
enabled=false + opt_out=false falls through to platform
(disabled per-tenant policy + active platform = both
resolutions platform + empty fieldDiffs); 10 new CLI
tests in retention.test.ts — missing tenant arg returns
exit 2 with 'missing arguments' + '--vs-platform'
mention in error, missing table arg returns exit 2,
calls diffTenantVsPlatform NOT diffTenantPolicies
verified via separate captures (diffTenantCapture
length 0, diffTenantVsPlatformCapture length 1 with
{tenantId, tableName}), human-format renders 'No
differences' message when fieldDiffs empty with 'Diff
between tenant and platform default' header, human-
format renders 'Field changes (N)' for non-empty diff
with retention_days field + 30 → 90 + source field +
"tenant" → "platform", JSON envelope includes
vsPlatform:true discriminator + result.tenantId +
result.platformResolution.source, adapter errors
propagate exit 1 ('PG connection refused' in stderr);
formatTenantVsPlatformDiff helper unit tests — 'No
differences' message for empty diff, tenant row with
tenantId prefix + summary line + 'retention=30d' for
tenant variant + Platform: prefix + 'retention=90d'
for platform + 'Field changes (1)' header,
tenant_opt_out variant inline with 'source=tenant_opt_out'
+ 'reason=legal_hold:case#42' + 'until=2099-01-01T00:00:00.000Z',
platform=none variant renders 'source=none' +
'(no policy configured)' annotation; cli.ts helpText
retention diff <tenant> <table-name> --vs-platform
usage line + 5-line description explaining 2-parallel-
queries + one-command workflow benefit vs two retention
effective + mental-diff workaround; future Qs cover
--vs-tier <tier-id> flag for tenant-vs-tier-default
comparison (requires tier substrate aware resolution),
--all-tables for one-tenant-vs-platform across every
prunable table, combined retention diff <tenant>
defaulting to --vs-platform without flag (rejected for
explicit-clearer), render diff as table format,
bulk --bulk file.csv variant for many tenants in one
call, --exit-on-divergence for CI gates that fail when
tenant differs from platform, JSON envelope unification
with cross-tenant diff via tagged union shape
{kind: "vs-tenant"/"vs-platform"} would simplify
operator jq scripts but break backward compat with
ADR-0178 envelope so deferred — vsPlatform:true
discriminator is sufficient). The retention CLI now has
15 actions covering forensic + recovery + comparison +
performance workflows comprehensively: 3 read (expiring
/ effective / list-policies) + 4 write (opt-out / opt-
in / set / delete) + 1 audit (history) + 1 restore
(with --dry-run) + 2 diff (diff-history same-tenant +
diff cross-tenant with --vs-platform variant) + 1
maintenance (prune with --dry-run) + 1 batch substrate-
only (effectiveRetentionBatch).
ADR-0180 covers Phase 2 M6.7.zz.tenant.opt-out.cli.diff.cross-table
(`crossengin retention diff <tenant> <table-a>
<table-b> --cross-table` CLI action + diffTenantTables
adapter method — closes ADR-0178 Q3; after ADR-0173
shipped same-tenant cross-event diff-history, ADR-0178
shipped cross-tenant same-table diff, and ADR-0179
shipped tenant-vs-platform, this milestone closes the
remaining diff axis: cross-table-within-tenant.
Operators auditing a single tenant want to answer "is
this tenant's retention consistent across all the
trace tables they have data in?" — e.g., is the legal
hold applied to workflow_traces ALSO applied to
llm_call_traces? Previously two retention effective
commands + mental-diff was the only workaround; now
one command. CLI surface `retention diff <tenant>
<table-a> <table-b> --cross-table [--format human|
json]` — flag-on-existing-action chosen over new
`retention diff-tables` action matching the
--vs-platform precedent operators already learned;
with --cross-table set dispatcher expects 3 positional
args (tenant + 2 tables) instead of default cross-
tenant shape (2 tenants + 1 table); --cross-table and
--vs-platform mutually exclusive at CLI boundary —
both set returns exit 2 with 'retention diff: --vs-
platform and --cross-table are mutually exclusive'
error checked early before any other arg parsing;
without either flag the existing cross-tenant default
path is unchanged. New diffTenantTables adapter takes
{tenantId, tableNameA, tableNameB} and returns
DiffTenantTablesResult {tenantId, tableNameA,
tableNameB, resolutionA, resolutionB, fieldDiffs}.
RESTORES the canonical composition pattern from
ADR-0177/0178 (ADR-0179 was the documented exception
because batch resolver hides tenant-vs-platform
distinction; this milestone wants the EFFECTIVE
resolution for each pair which is exactly what batch
returns); adapter calls effectiveRetentionBatch({pairs:
[{tenantId, tableNameA}, {tenantId, tableNameB}]})
— 2 queries total (one tenant lookup with both pairs
in IN tuple, one platform lookup with both table
names in IN list), Promise.all parallelized; looks up
both resolutions from returned Map via exported
effectiveRetentionKey helper; throws when either
resolution undefined (defensive). Diff computation
identical to ADR-0178's cross-tenant flow —
computeFieldDiffs(normalizeResolutionForDiff(A),
normalizeResolutionForDiff(B)); reuses existing helpers
unchanged; same alphabetical sort, same 'indefinite'/
'<no reason>' conventions, same 'absent' placeholder
for undefined values. Human output renders 3-section
format — 'Diff between tables for tenant <uuid>:'
header, per-table summary line via shared
summarizeResolutionForDiff helper with 20-char table-
name padding for column alignment, blank line, then
either 'No differences — both tables resolve to the
same effective retention policy for this tenant.' for
empty fieldDiffs OR 'Field changes (N):' header
followed by 'fieldname valueA → valueB' lines. JSON
envelope {action: "diff", crossTable: true, result:
DiffTenantTablesResult} where crossTable:true is the
discriminator; operators now have 3 diff envelope
shapes — cross-tenant (no boolean discriminator),
vsPlatform:true, crossTable:true — boolean discriminators
mutually exclusive at CLI boundary; JSON parsers
branch on discriminator first. Why no validation on
tableNameA===tableNameB — substrate doesn't enforce
semantic constraints unless critical; passing same
table produces identical resolutions + empty fieldDiffs
surfacing the typo immediately; matches existing
diffTenantPolicies (ADR-0178) approach where
tenantA===tenantB is also valid though equally
pointless; keeps adapter signature simple. Use cases
unblocked — cross-table consistency audit for one
tenant (one command), legal hold completeness check
via jq filter on resolutionA.source="tenant_opt_out"
vs resolutionB.source!="tenant_opt_out" surfacing
incomplete holds where opt-out was applied to one
trace table but not the other, compliance migration
verification via shell loop across table pairs after
cross-table policy update to verify all trace tables
under tenant ended up matching, CI cohort consistency
gate failing build when cross-table retention drift
detected. Rejected alternatives — new action retention
diff-tables (cleaner separation but adds CLI surface
and divides diff vocabulary across three action names;
--cross-table matches --vs-platform precedent), implicit
detection if positional args look like tenant+table+
table (heuristic-based; ambiguous when table names
look like UUIDs), compose on two single-pair
effectiveRetention calls (4 queries vs 2 batch defeats
composition pattern), N-way diff via repeated --add-
table (overkill for v1; pair-wise is canonical from
ADR-0178/0179 which both rejected N-way; operators
chain commands), cross-table without flag (default to
it when 2 of 3 positionals look like table names —
fragile + magic), retention compare-tables <tenant>
returning all-table-pairs combinations (operator-
unrequested; bulk variants deferred), allow --cross-
table + --vs-platform to mean "compare two tables'
platform defaults for one tenant" (semantic stretch;
operators wanting that use retention list-policies +
manual compare; mutual exclusivity cleaner), return
Map<tableName, EffectiveRetentionResolution> instead
of A/B labeled fields (more general but breaks pair-
wise diff shape established by ADR-0178; operators
rendering output need to know how to label two map
entries; A/B labeling matches existing diff shapes).
Drawbacks — two flags on diff (--vs-platform +
--cross-table) operators may forget to set one and
fall through to default cross-tenant path (mitigated
by clear missing-args error messages naming expected
flag), three positional-arg shapes on one action
(cross-tenant + --vs-platform + --cross-table)
documented in three separate helpText usage lines,
mutual-exclusivity error at CLI boundary not automatic
disambiguation (acceptable since semantic ambiguous —
cross-table vs vs-platform aren't composable), JSON
envelope discriminator proliferation operators write
3 jq branches (could be unified via tagged union from
ADR-0179 Q7 but would break ADR-0178+0179 compat),
N-way table diff not in scope (operators chain
commands; future Q if requested), same-tenant
constraint both axes share tenant (operators wanting
tenant A on table X vs tenant B on table Y run two
retention effective commands manually — different
semantic out of scope). 8 new adapter tests in
trace-retention.test.ts — composes on
effectiveRetentionBatch issuing exactly 2 queries,
returns metadata + resolutions + empty fieldDiffs when
both resolve to none, empty fieldDiffs when both
tables resolve to identical platform retention,
fieldDiffs when retention differs across tables
(tenant override on A=workflow_traces 30d vs platform
on B=llm_call_traces 365d covering source +
retention_days), fieldDiffs comparing tenant_opt_out
on A vs tenant on B covering source + opt_out +
opt_out_reason + opt_out_until, resolutionA carries
A's data and resolutionB carries B's verified via
platform 30d vs 90d test (resolutionA={source:platform,
retentionDays:30} vs resolutionB={source:platform,
retentionDays:90}), clock-aware expiry preserved
across both table resolutions (expired opt_out on A
falls through to tenant enabled=true while B resolves
platform), supports same tenant on same table for both
axes degenerate but valid empty fieldDiffs; 13 new
CLI tests in retention.test.ts — missing tenant arg
exit 2 with 'missing arguments' + '--cross-table'
mention, missing table-a arg exit 2, missing table-b
arg exit 2, both --vs-platform + --cross-table exit 2
with 'mutually exclusive' error, calls diffTenantTables
NOT diffTenantPolicies or diffTenantVsPlatform
verified via three separate captures (diffTenantCapture
length 0, diffTenantVsPlatformCapture length 0,
diffTenantTablesCapture length 1 with {tenantId,
tableNameA, tableNameB}), human-format 'No differences'
message + 'Diff between tables for tenant <uuid>'
header, human-format renders Table A + Table B headers
+ 'Field changes (2)' with source=tenant + source=
platform + retention=30d + retention=365d + arrow-
formatted lines '30 → 365', JSON envelope crossTable:
true discriminator + result.tenantId + result.tableNameA
+ result.tableNameB, adapter errors propagate exit 1
('PG connection refused' in stderr); formatTenantTablesDiff
helper unit tests — 'No differences' message for empty
diff, Table A + Table B headers with per-table summary
lines + retention=Nd display, tenant_opt_out variant
inline with reason+until ('reason=legal_hold' +
'until=2099-01-01T00:00:00.000Z'), source=none variant
with '(no policy configured)' annotation; cli.ts
helpText retention diff <tenant> <table-a> <table-b>
--cross-table usage line + 5-line description
explaining 2-query optimization + mutually exclusive
with --vs-platform + consistency-across-trace-tables
audit benefit; future Qs cover N-way table diff via
repeated --add-table <name> flag (chain commands
for now), --all-tables for one-tenant-across-every-
prunable-table (bounded set currently 4; shell loop
covers), --exit-on-divergence for CI gates (wrap with
jq + bash bracket), JSON envelope unification across
all 3 diff variants via tagged union {kind: "vs-
tenant"/"vs-platform"/"cross-table"} would simplify
operator jq scripts but break backward compat with
ADR-0178+0179 envelopes — defer, table-name validation
against PRUNABLE_TABLES allowlist (substrate currently
doesn't validate returns source="none" for unknown
tables surfacing typo; matches existing retention
effective non-validation stance — defer), combined
cross-table + diff-history --at-time DATE for point-
in-time cross-table comparison (requires deferred
--at-time substrate from ADR-0162), --field <name>
filter on JSON output (jq covers). The retention CLI
now has 16 actions covering forensic + recovery +
comparison + performance workflows comprehensively:
3 read (expiring/effective/list-policies) + 4 write
(opt-out/opt-in/set/delete) + 1 audit (history) + 1
restore (with --dry-run) + 3 diff (diff-history same-
tenant + diff with cross-tenant default + --vs-
platform variant + --cross-table variant) + 1
maintenance (prune with --dry-run) + 1 batch
substrate-only (effectiveRetentionBatch).
ADR-0181 covers Phase 2 M6.7.zz.tenant.opt-out.cli.diff.exit-on-divergence
(`crossengin retention diff --exit-on-divergence`
boolean flag for CI-gate ergonomics across all 3 diff
variants — closes ADR-0179 Q6 + ADR-0180 Q3; after
the diff matrix completion (cross-tenant default from
ADR-0178 + --vs-platform from ADR-0179 + --cross-
table from ADR-0180), three of those four ADRs
explicitly listed --exit-on-divergence as future work
because operators wiring `retention diff` into CI
pipelines as drift detectors hit the same workaround:
`DIFF=$(crossengin retention diff ... --format json);
if echo "$DIFF" | jq -e '.result.fieldDiffs | length
> 0'; then exit 1; fi` — fragile because jq -e exit-1
collides with retention-diff's runtime-error exit-1
making CI logs ambiguous between "drift detected" and
"PG connection refused", boilerplate replicated per CI
pipeline, and operators need 3 jq branches across the
3 envelope shapes (though .result.fieldDiffs path
happens to be uniform); single --exit-on-divergence
flag covers all 3 variants uniformly. Flag semantic
applies to ALL three variants — cross-tenant default,
--vs-platform, --cross-table — when set fieldDiffs.length
=== 0 → exit code 0 (no drift; CI gate passes),
fieldDiffs.length > 0 → exit code 3 (drift detected;
CI gate fails); when NOT set diff returns exit 0
regardless of fieldDiffs (backward compatible — pre-
M6.7.zz.tenant.opt-out.cli.diff.exit-on-divergence
callers see identical behavior). Why exit code 3 —
existing CLI exit codes across the substrate are 0
(success), 1 (runtime error like adapter throws / PG
connection refused / etc), 2 (misuse like missing args
/ invalid flag value / mutually-exclusive flags); exit
3 for "completed successfully but CI-gate fail" stays
distinguishable from runtime errors so CI logs reading
exit codes get clean signal — exit 1 means "something
is broken fix and rerun", exit 3 means "retention
drift detected on configured tenants cohort-consistency
check failed"; bash gates work the same way regardless
(`if ! crossengin retention diff ... --exit-on-
divergence; then`) but operators differentiating signal
from noise get it for free; GNU diff(1) uses exit 1
for "files differ" and 2 for "error" — different
convention; we diverge deliberately because exit 1 is
already meaningful in CrossEngin CLI. Output unchanged
— result (human or JSON) STILL emitted on exit 3
operators reading scripts see what diverged; flag
controls only the exit code. Single flag for all 3
variants — no per-variant naming
(--cross-tenant-exit-on-divergence etc); uniform
contract. Implementation pure CLI enhancement no
adapter changes — each of the 3 runner functions now
branches output emission then returns
divergenceExitCode(command, result.fieldDiffs.length);
shared private helper checks
getBooleanFlag(command, "exit-on-divergence") &&
fieldDiffsLength > 0 returning 3 else 0; runtime
errors take precedence — existing `return 1` from
catch blocks fires before divergenceExitCode is
reached. Use cases unblocked — CI cohort consistency
gate via direct bash idiom replacing jq -e wrap, per-
tenant drift detection from platform default for
regulated tenants that MUST stay on default (exit 3
→ tenant has its own override violating policy), per-
tenant cross-table consistency gate for legal-hold
completeness (exit 3 → hold applied to one table but
not the other = incomplete hold), pipeline runners
differentiate exit 1 vs exit 3 via bash case statement
routing to on-call vs compliance team respectively
(case $? in 0) "no drift"; 1) "runtime error
investigate"; 3) "drift detected alert team" ;; esac).
Rejected alternatives — exit code 1 matching diff(1)
(collides with existing runtime-error exit 1 in
CrossEngin CLI — distinguishability is the point),
exit code 2 matching git diff --exit-code (collides
with existing misuse exit 2), --ci flag naming (too
vague doesn't name the semantic), three per-variant
flags (verbose; one flag works on all 3), implicit
exit-on-divergence when stdout isn't a TTY (magical;
operators want explicit), print "drift detected"
warning on stderr in addition to exit code (noisy when
piped through pipelines; output already shows diff),
--threshold N parameter for N+ field-diff exit
(overkill for v1; operators chain with jq for now;
deferred to future Q), adapter-side method returning
exit signal (exit codes are CLI concern; adapter stays
uncoupled from process exit). Drawbacks — new exit
code 3 added to substrate's CLI vocabulary operators
reading existing scripts may not realize new code
exists (mitigated by opt-in — pre-flag callers never
see exit 3), no --exit-on-no-divergence inverse flag
for "fail CI when tenants stop diverging" unusual but
conceivable for A/B-test migration gates (operators
wrap with bash ! — single direction covers common
case), no --threshold N for fuzzy thresholds (jq
covers; deferred), no per-field allowlist
(retention_days drift vs enabled drift — jq filter +
length check covers; deferred), exit code 3 is
CrossEngin-specific convention operators porting from
diff(1) need to translate (documented in helpText
3-line note covering all 3 diff variants accept the
flag), output still emitted on exit 3 CI systems
grepping stderr for errors won't see drift output on
stdout (operators redirect appropriately). 9 new CLI
tests in retention.test.ts — cross-tenant exit 0 when
fieldDiffs empty and --exit-on-divergence set
(diffTenantResult with empty fieldDiffs + flag → exit
0 + "No differences" in output), cross-tenant exit 3
when fieldDiffs non-empty with flag (fieldDiffs len 1
with retention_days 30→90 + flag → exit 3 + "Field
changes (1)" in output), cross-tenant exit 0 when
fieldDiffs non-empty but flag NOT set (backward compat
— pre-flag callers see identical behavior), cross-
tenant output still emitted on exit 3 in JSON mode
(parsed envelope checked + fieldDiffs length 1
verified), --vs-platform exit 3 on non-empty
fieldDiffs with flag (tenant=30d vs platform=90d +
flag → exit 3), --vs-platform exit 0 on empty
fieldDiffs with flag (both platform 90d), --cross-
table exit 3 on non-empty fieldDiffs with flag
(workflow_traces tenant vs llm_call_traces platform +
flag → exit 3), --cross-table exit 0 on empty
fieldDiffs with flag, runtime errors exit 1 take
precedence over --exit-on-divergence (adapter throws
PG connection refused returns exit 1 even with flag
set — verified via fakeRetention throws option). cli.
ts helpText extended with 3-line note after the three
diff usage lines explaining all three variants accept
--exit-on-divergence returning exit 3 (instead of 0)
when fieldDiffs non-empty for CI gates that fail the
build when retention drifts. The retention CLI now
has 16 actions with all 3 diff variants supporting
--exit-on-divergence — operators have first-class CI-
gate ergonomics across the full diff matrix (cross-
tenant + tenant-vs-platform + cross-table-within-
tenant), with deliberate exit-3 convention keeping
drift-detection signal distinguishable from runtime
errors.
ADR-0182 covers Phase 2 M6.7.zz.tenant.opt-out.cli.effective-batch
(`crossengin retention effective-batch --pairs-file
<path>` CLI action — closes ADR-0177 Q1; ADR-0177
shipped effectiveRetentionBatch as a substrate-only
milestone — substrate gained 2-query batch read API
for dashboard performance but operators wanting ad-
hoc bulk lookups had to write Node scripts calling
the adapter directly; M6.7.zz.tenant.opt-out.cli.
effective-batch closes that gap with pure CLI delivery
no adapter changes wrapping PostgresTraceRetention.
effectiveRetentionBatch one-for-one. Use cases —
compliance audit across watchlist, migration
verification, periodic snapshot feeding spreadsheet,
reconciliation against upstream tier system. Input
format JSON-only for v1 — array of {tenantId,
tableName} objects; three reasons CSV deferred: (1)
operators generating pairs file from another command
get JSON for free via jq pipe like `crossengin
retention list-policies --format json | jq '[.tenantPolicies[]
| {tenantId, tableName}]' > pairs.json`, (2) type
safety — JSON's typed null+boolean+string+number maps
cleanly to adapter's EffectiveRetentionBatchPair shape
while CSV needs per-field type inference + quoting
rules, (3) smaller substrate surface for v1 —
operators wanting CSV convert with one-liner `jq -R
'split(",") | {tenantId: .[0], tableName: .[1]}'`;
native CSV when measured demand. Layered validation at
CLI boundary with explicit error messages per failure
mode — missing --pairs-file flag exit 2 with 'missing
--pairs-file', file doesn't exist or unreadable exit
1 (runtime not misuse) with 'failed to read <path>:
<reason>', file content not valid JSON exit 2 with
'<path> is not valid JSON: <reason>', JSON not an
array exit 2 with 'must be a JSON array of {tenantId,
tableName} objects', entry at index N not an object
exit 2 with 'entry at index N is not an object',
entry missing tenantId exit 2 with 'entry at index N
missing or empty tenantId (string)', entry missing
tableName exit 2 with 'entry at index N missing or
empty tableName (string)'; index-aware error messages
so operators with 1000-pair file find bad entry by
line number; exit 1 reserved for runtime errors (file
I/O + adapter throws), exit 2 for misuse (missing
flag + invalid JSON shape). Output ordering preserves
input including duplicates for 1:1 contract — adapter
deduplicates pairs internally returning ReadonlyMap
keyed by effectiveRetentionKey(tenantId, tableName)
but CLI iterates ORIGINAL input pairs and looks up
each in Map emitting one output row per input entry;
duplicates in input → duplicates in output; three
reasons: 1:1 input/output contract operators reading
output count rows expecting input count, predictable
ordering input order preserved without sorting,
duplicate visibility operators with accidental
duplicates see them in output rather than silent
deduplication; adapter still called with original
pairs list not pre-deduplicated. Human output renders
'Effective retention for N pair(s):' header followed
by per-pair line '<tenantId> <tableName-padded-20>
<summary>' with summary via internal
summarizeBatchResolution helper covering 4 resolution
variants (tenant retention=Nd enabled=yes,
tenant_opt_out reason=<reason> until=<iso|indefinite>,
platform retention=Nd enabled=yes|no, none (no policy
configured)) reusing established conventions; empty
input prints '0 pair(s): (empty input)' on exit 0 not
an error. JSON envelope {action: "effective-batch",
count, results: [{tenantId, tableName, resolution}]}
where count field echoes results.length for jq scalar
filters wanting quick count without traversing array.
Pure CLI wrap — same pattern as ADR-0174 (retention
prune wrapping prune/previewPrune), ADR-0181
(--exit-on-divergence CLI flag). No max-pairs limit
at CLI boundary — operators are local; if they want
100K pairs PG IN-list size limit or deferred ADR-0177
chunking Q is the constraint; CLI doesn't second-
guess; documented in helpText. Rejected alternatives
— stdin support via --pairs-file - (platform-specific
stdin handling defer until requested), inline --pairs
'[...]' flag (flag-value-as-JSON unwieldy past 2-3
pairs; file is right scale boundary), CSV support in
v1 (tokenizer + quoting + type-inference complexity
defer), auto-detect file format by extension (magic
explicit JSON-only contract simpler), deduplicate
output to match adapter internal dedup (breaks 1:1
input/output contract; operators preferring dedup
wrap with `jq '.results | unique'`), return adapter
Map shape directly as JSON object with
'<tenantId>:<tableName>' keys (JSON property ordering
implementation-defined + colon-as-key-separator
fragile; array of records cleaner), pre-deduplicate
before calling adapter (adapter already dedupes CLI
dedup redundant), --max-pairs N validation at CLI
boundary (operator policy choice PG IN-list limit is
real constraint), auto-chunking for very large inputs
(deferred to ADR-0177 Q2 substrate work not CLI
concern). Drawbacks — JSON-only no CSV in v1
(operators with CSV convert via jq; documented; CSV
deferred), no streaming output all pairs held in
memory for very large inputs >100K pairs operators
see latency (bounded by deferred ADR-0177 chunking Q
— not problem at typical scales), no per-pair
validation against PRUNABLE_TABLES allowlist
(operators passing unknown tables get source:"none"
for those entries surfacing typos but not as error;
matches retention effective non-validation stance),
no deduplication in CLI output even though adapter
dedupes for queries (operators with accidentally-
duplicated input pairs see duplicates in output —
by design 1:1 contract may confuse operators
expecting dedup), output ordering preserves input
operators wanting sorted output use jq on JSON or
sort on tabular text no --sort flag yet, file-based
input only no --pairs <json> inline arg or stdin
support (operators with one-off ad-hoc queries write
to temp file; future Q). 17 new CLI tests in
retention.test.ts — missing --pairs-file flag exit 2
with clear message, file path doesn't exist exit 1
with 'failed to read', file content not valid JSON
exit 2 with 'not valid JSON', JSON not an array exit
2 with 'must be a JSON array', entry missing
tenantId at index 0 exit 2 with index-aware 'index 0'
+ 'tenantId' in error message, entry missing
tableName exit 2 with 'tableName' in error, threads
pairs to adapter in input order verified via
effectiveBatchCapture (TENANT_A workflow_traces then
TENANT_B llm_call_traces), empty input array prints
'0 pair(s) (empty input)' message + exit 0, human-
format renders one row per input pair preserving
order (idxA < idxB verified in output), human-format
includes 'Effective retention for 2 pair(s):' header
+ tenantId + tableName + retention=Nd + source=tenant
/source=platform per pair, JSON envelope shape
{action: "effective-batch", count, results[]} with
results[0] fully populated tenantId + tableName +
resolution, duplicate input pairs appear in output as
duplicates (count=2 + results.length=2 for identical
pairs preserving 1:1 contract), adapter errors
propagate exit 1 ('PG connection refused' in stderr);
formatEffectiveBatch helper unit tests — '0 pair(s)
(empty input)' message for empty array, count header
+ per-pair rows with summary lines, tenant_opt_out
variant inline with 'reason=legal_hold:case#42' +
'until=2099-01-01T00:00:00.000Z', 'indefinite' for
null optOutUntil + '<no reason>' for null
optOutReason, 'none' variant with '(no policy
configured)' annotation. fakeRetention extended with
effectiveRetentionBatch method + effectiveBatchResults
+ effectiveBatchCapture options for test injection.
cli.ts helpText extended with retention effective-
batch --pairs-file <path> usage line + 5-line
description explaining JSON array file format + 2-
query batch optimization + preserved input order in
output; dispatcher case + missing-action + unknown-
action error messages all updated to include the new
effective-batch action; future Qs cover CSV input
format when measured demand, stdin support via --
pairs-file - for shell pipelines, inline --pairs JSON
for one-off queries, --sort flag for output ordering,
--include-only source filter as CI gate similar to
ADR-0181 --exit-on-divergence, auto-chunking for >10K
pairs pairing with ADR-0177 Q2 substrate work,
pretty-printed JSON output operators currently use
jq, per-pair source-attribution
PostgresCostCeilingResolver style returning tier/
override/global signal alongside resolution).
ADR-0183 covers Phase 2 M6.7.zz.tenant.opt-out.cli.diff.add-tenant
(`crossengin retention diff <a> <b> <table>
--add-tenant <c> [--add-tenant <d> ...]` repeated flag
for N-way cross-tenant comparison — closes ADR-0178
Q2; pair-wise diff produced N×(N-1)/2 commands for N
tenants and operators mentally assembled the per-field
variation matrix from outputs — a 5-tenant compliance
cohort meant 10 commands and 10 outputs to correlate by
hand; single command now returns per-field variation
analysis across N tenants. CLI surface — base call still
requires 2 positional tenants + 1 positional table
matching cross-tenant default from ADR-0178;
--add-tenant <uuid> is repeatable each occurrence adds
one tenant to the comparison; N total tenants = 2
positional + count(--add-tenant); minimum N to trigger
N-way mode = 3 (at least one --add-tenant); mutually
exclusive with --vs-platform and --cross-table (those
modes have different semantics);
--exit-on-divergence from ADR-0181 works on N-way too
exit 3 when fieldVariations.length > 0. Repeated-flag
parsing — parseArgs extended additively to track
repeated flag values via new multiFlags: ReadonlyMap
<string, ReadonlyArray<string>> field on ParsedCommand
recording every string-valued occurrence of each flag
in argv order; existing flags map keeps last-write-
wins semantics — backward compatible existing callers
using getStringFlag unaffected; new getMultiFlag
helper reads from multiFlags. Adapter — new method
diffTenantPoliciesNway({tenantIds, tableName}) on
PostgresTraceRetention; rejects fewer than 2
tenantIds with explicit error; composes on
effectiveRetentionBatch (the canonical pattern from
ADR-0177 — same as ADR-0178's diffTenantPolicies and
ADR-0180's diffTenantTables; only ADR-0179's
diffTenantVsPlatform deviated with documented reason);
passes N pairs to batch resolver → 2 queries total
regardless of N; looks up each tenant's resolution
from returned Map via effectiveRetentionKey;
adapter does NOT deduplicate input tenantIds — if same
tenant appears twice in input array it appears twice
in resolutions[] matching input (mirrors ADR-0182
1:1 contract). Variation analysis — for each field
across all N normalized resolutions group tenants by
JSON.stringify(value) handling primitives/null/
undefined uniformly; if only 1 distinct value group
field is uniform skip; if 2+ distinct value groups
include in fieldVariations[]; sort alphabetically by
field name matching ADR-0173 computeFieldDiffs;
new computeFieldVariations(entries) pure helper
exported alongside existing computeFieldDiffs +
normalizeResolutionForDiff with same shape pure
function over normalized records no DB dependency
fully unit-testable. Per-field result lists every
distinct value seen and which tenants have it —
operators reading 'source: tenant (A) | platform
(B, C)' know immediately Tenant A is on its own per-
tenant policy and Tenants B and C share platform
default. Result type DiffTenantPoliciesNwayResult
{tenantIds (input order), tableName, resolutions[]
(one per input tenant ordered), fieldVariations[]
(per-field distinctValues with tenant attribution)}.
Human output renders 'N-way diff between N tenants
(table: <name>):' header + per-tenant row 'Tenant
<label>: <uuid> <summary>' with labels A/B/C... from
input index (beyond 26 labels become T27, T28, ...
operators with >26-tenant cohorts unusual documented
but not optimized), blank line, then either 'No
differences — all N tenants have the same effective
retention policy.' OR 'Field variations (M):' header
+ per-field 'fieldname value1 (A) | value2 (B, C) |
...' lines with tenant labels by index; per-tenant
summary line reuses shared summarizeResolutionForDiff
helper from ADR-0178; 'absent' placeholder for
undefined values in variation groups. JSON envelope
{action: "diff", nway: true, result:
DiffTenantPoliciesNwayResult} where nway:true is the
discriminator distinguishing from existing 3 diff
envelope shapes (cross-tenant default no discriminator
from ADR-0178, vsPlatform:true from ADR-0179,
crossTable:true from ADR-0180); all four boolean
discriminators mutually exclusive at CLI boundary;
JSON parsers branch on discriminator first.
--exit-on-divergence integration — CLI passes
result.fieldVariations.length to divergenceExitCode;
non-zero variations → exit 3 (same semantic as
fieldDiffs for pair-wise variants). Use cases
unblocked — compliance cohort drift detection (single
CI command replaces 10 pair-wise commands + manual
correlation for 5-tenant cohorts: crossengin retention
diff $ref $b workflow_traces --add-tenant $c
--add-tenant $d --add-tenant $e --exit-on-divergence
returns exit 3 if any drift), tier migration
verification across N tenants via jq filter on
.result.fieldVariations[].field=="source" returning
empty array means migration succeeded all on same
source, legal-hold cohort verification ensuring all
hold-tenants opted out via length-0 check on
filtered resolutions where source!="tenant_opt_out",
operator dashboards rendering per-field cohort
variation directly from JSON output. Rejected
alternatives — comma-separated --tenants <a,b,c,d>
(fragile + doesn't compose with shell-quoted UUIDs
containing punctuation + breaks if operators have
tenant IDs with embedded commas), auto-promote to
N-way when more than 3 positional args supplied
(magical operators may pass accidental args), new
action retention diff-nway (adds CLI surface divides
diff vocabulary across four action names —
--add-tenant matches --vs-platform/--cross-table
precedent operators already learned), pair-wise output
for N tenants (A vs B + A vs C + B vs C ... operators
read N×(N-1)/2 outputs manually correlate — per-field
variation analysis is the right abstraction), JSON-
only output no human format (N-way visualizations
useful in terminals), restrict to N <= 10 (arbitrary
PG IN list handles thousands no cap), return Map
<tenantId, Resolution> instead of ordered array
(loses input order), --limit N to truncate variation
rendering at high N (operators pipe through head or
jq out of scope), separate adapter method not
composing on effectiveRetentionBatch (would
duplicate batch resolver logic — composition is the
established pattern). Drawbacks — output gets dense
at high N a 20-tenant cohort with 5 variations renders
5 lines of 'value (A, B, ...) | value (...)' that may
wrap on narrow terminals (operators pipe to less or
use JSON + jq), tenant labels A..Z then T27 T28 ...
operators with >26 cohort tenants get less-readable
label scheme (acceptable since >26-tenant N-way
comparisons are unusual), parseArgs interface change
ParsedCommand gained a multiFlags field (additive
extant ParsedCommand consumers seeing new field;
backward compat preserved existing fields unchanged),
no grouping in variation rendering fields sorted
alphabetically each rendered independently (operators
wanting 'group by retention_days then by source' use
jq on JSON), no de-duplication operators passing same
tenant twice see it twice in output (by design 1:1
input/output may confuse), N-way is pair-wise-superset
2-tenant N-way call works but output wordier ('Field
variations (1)' vs 'Field changes (1)') operators
using --add-tenant deliberately get N-way semantics
those using default cross-tenant path get pair-wise
CLI doesn't auto-route, mutual-exclusivity error
lists 3 flag candidates when more than one of
--vs-platform/--cross-table/--add-tenant is set
(clear message but error path more complex than
previous 2-way exclusion). 15 new adapter tests in
trace-retention.test.ts (rejects fewer than 2
tenantIds with 'at least 2 tenantIds' error, composes
on effectiveRetentionBatch with exactly 2 queries for
3 tenants verified via capture.length, returns
resolutions ordered by input + empty fieldVariations
when all match, returns fieldVariations when 3 tenants
have 3 different sources covering source +
retention_days + opt_out fields, source variation
distinctValues includes tenant attribution verified
([TENANT_A] for tenant + [TENANT_B, TENANT_C] for
platform), supports 2-tenant N-way degenerate-but-
valid call equivalent to diffTenantPolicies, handles
5-tenant comparison with all platform default no
variations, clock-aware expiry preserved across N
tenants, preserves duplicate tenantIds in resolutions
input [A,A,B] → resolutions length 3 same order;
computeFieldVariations helper unit tests — empty
array for <2 entries, empty when all entries agree,
single variation when one field differs, groups
tenants by distinct value, treats absent field as
undefined distinct from null, sorts variations
alphabetically by field name); 13 new CLI tests in
retention.test.ts — exit 2 when --add-tenant +
--vs-platform both set with 'mutually exclusive'
error, exit 2 when --add-tenant + --cross-table both
set, exit 2 missing required positionals with
--add-tenant in error message, calls
diffTenantPoliciesNway with [A,B,C] from positionals
+ 1 --add-tenant verified via capture, collects
multiple --add-tenant flags in order [A,B,C,D] via
repeated flag occurrences, human-format 'No
differences' message when fieldVariations empty,
human-format renders per-field variations with tenant
attribution + A/B/C labels + retention_days '30 (A) |
90 (B, C)' + source '"tenant" (A) | "platform" (B,
C)', JSON envelope nway:true discriminator + result
.tenantIds + result.resolutions length 3,
--exit-on-divergence + non-empty fieldVariations
returns exit 3, adapter errors propagate exit 1;
formatTenantNwayDiff helper unit tests — 'No
differences' message for empty, A/B/C labels in
tenant rows + variation lines '"tenant" (A) |
"platform" (B) | "none" (C)' across 3 distinct
sources, 'absent' for undefined values in variation
groups. fakeRetention harness extended with
diffTenantPoliciesNway method + diffTenantNwayResult
+ diffTenantNwayCapture options for test injection.
cli.ts helpText extended with retention diff <a> <b>
<table> --add-tenant <c> [--add-tenant <d> ...] usage
line + 5-line description explaining N-way semantic +
mutual exclusivity with --vs-platform and --cross-
table + per-field variation analysis output.
Future Qs cover --exclude-tenant for set-subtraction,
--input-file reading tenant IDs from JSON/text file
matching ADR-0182 --pairs-file pattern, --add-tenant
<slug> resolving via meta.tenants.slug for human-
readable input (substrate doesn't validate tenant IDs
against meta), render variations grouped by tenant in
addition to per-field, --threshold N combined with
--exit-on-divergence pairing with ADR-0181 Q2, N-way
--vs-platform adding platform default as synthetic
tenant in comparison (different semantic from pair-
wise), N-way --cross-table comparing one tenant
across N tables pairing with ADR-0180 Q1, tagged-
union JSON envelope across 4 diff variants would
simplify operator jq scripts but break backward compat
with ADR-0178/0179/0180/0183 envelopes — defer).
The retention CLI now has 17 actions with 4 diff
variants in 'diff' action (cross-tenant default +
--vs-platform + --cross-table + --add-tenant) all
supporting --exit-on-divergence — operators have
first-class CI-gate ergonomics across pair-wise AND
N-way comparison matrices.
ADR-0184 covers Phase 2 M6.7.zz.tenant.opt-out.cli.diff.threshold
(`crossengin retention diff --threshold N` fuzzy CI-
gate threshold across all 4 diff variants — closes
ADR-0181 Q2 + ADR-0183 Q5 in one milestone; after
ADR-0181 shipped strict --exit-on-divergence ("any
drift fails") and ADR-0183 extended it to N-way via
fieldVariations counts, both ADRs explicitly listed
--threshold N as future work because real operator
use cases pile up (tier migration tolerance "fail CI
when more than 1 field differs from reference small
drifts during migration acceptable but multi-field
drift signals bigger problem", cohort-consistency
"in 10-tenant cohort fail when 3+ distinct fields
varying minor variations like reason text wording
tolerable structural drift not", compliance noise
reduction "fail only when source + retention_days
differ ignore enabled flag noise operators wrap with
jq for now but want first-class support"); CLI surface
`retention diff <...args> --exit-on-divergence
--threshold <N>`; --threshold N is a string flag
taking positive integer N>=1 default when omitted
N=1 equivalent to current --exit-on-divergence
behavior. Semantic table — fieldDiffs.length or
fieldVariations.length 0 → exit 0 regardless,
fieldDiffsLength 1 → exit 3 without --threshold/with
--threshold 1 but exit 0 with --threshold 2,
fieldDiffsLength 2 → exit 3 with --threshold 1 or 2
but exit 0 with --threshold 5, fieldDiffsLength 5 →
exit 3 with --threshold 1/2/5 same as fieldDiffsLength
10; >= (at-or-above-threshold) comparison —
--threshold 5 fails on EXACTLY 5 diffs not 6+ matches
operator intuition "fail when at least N". Validation
table — --threshold set without --exit-on-divergence
exit 2 with '--threshold requires --exit-on-divergence'
(strict-rejection over silent no-op prevents misuse
masking), --threshold 0 (or negative) exit 2 with
'--threshold must be a positive integer', --threshold
1.5 (non-integer) exit 2 with same message,
--threshold abc (non-numeric) exit 2 with same
message; valid value 0/3 per semantic. Validation
fires at TOP of runRetentionDiff before dispatcher
routes to variant so invalid --threshold returns
exit 2 without any PG queries — CI logs saying "exit
2" immediately recognizable as CLI misuse not runtime
errors. Why require --exit-on-divergence — without
it --threshold would silently no-op operators passing
--threshold 5 thinking gate is configured would get
exit 0 regardless of diff; strict rejection catches
misuse early. Single helper across 4 diff variants —
existing divergenceExitCode(command, fieldDiffsLength)
now reads --threshold from command.flags directly via
getStringFlag returning Number(thresholdRaw) defaulting
to 1; trusts validateThresholdFlag already ran
successfully at parent dispatcher (no error paths
inside exit-code computation); pure CLI no adapter
changes. Applies uniformly to all 4 diff variants —
cross-tenant default fieldDiffs.length, --vs-platform
fieldDiffs.length, --cross-table fieldDiffs.length,
--add-tenant N-way fieldVariations.length (number of
fields with variation not cross-product of distinct
value groups — for 10-tenant cohort with 3 fields
each having 2 distinct values fieldVariations.length
is 3 not 6 matches operator intent "how many fields
differ"). Pure CLI enhancement — no adapter changes,
no result-type changes, no JSON envelope changes;
JSON output emits same fieldDiffs/fieldVariations
arrays as before — operators inspecting JSON apply
custom filter logic on top; threshold consumed at CLI
exit-code layer. Use cases unblocked — cohort drift
gate tolerating minor variations (5-tenant cohort
with --threshold 3 fails CI only when 3+ fields vary
across cohort), tier migration tolerance (--threshold
2 tolerates single expected-field difference like
updated_at timestamp fails on multi-field drift),
compliance-only-source-and-retention gate via simpler
"tolerate up to N differences" without per-field
configuration, graduated CI gates with multiple
--threshold values wired into staged pipelines
(stage 1 strict --threshold 1, stage 2 lenient
--threshold 5). Rejected alternatives — --max-diffs
N alternate name (--threshold more idiomatic for
"fail when N+"), strict > semantic (counterintuitive
— operators counting "fail when 2+ fields differ"
expect --threshold 2 not 1), silent no-op when
--threshold without --exit-on-divergence (masks
misuse), --threshold accepts 0 to mean "fail on any"
(equivalent to default redundant reject to keep
semantic clean), --ignore-fields <list> for per-field
allowlist (broader feature defer — operators use jq),
--threshold-percentage X% for fractional (operators
compute expected count themselves defer), apply
threshold per-field "fail when retention_days alone
differs" (different mental model whole-record
threshold matches user intent), make threshold default
N=2 instead of N=1 (breaks backward compat with
ADR-0181 callers — default 1 preserves prior
semantics), N-way threshold against value-cell count
sum of distinct values across all varying fields
(over-counts confuses operators "how many fields
differ"). Drawbacks — --threshold requires
--exit-on-divergence operators passing --threshold 3
without --exit-on-divergence get exit 2 (documented
but could surprise; strict-rejection chosen over
silent no-op), no per-field threshold or per-field
allowlist operators wanting "ignore enabled field
count everything else" wrap with jq on JSON output
then check length (threshold uniform across all field
types), >= semantic at-or-above operators wanting
strict-above need --threshold N+1 (documented matches
at-least-N intuition), no fractional threshold
(operators compute expected count themselves out of
scope), N-way uses field-variation count not value-
cell count (matches operator intent documented),
validation happens at parent dispatcher variant-
specific helpers (runRetentionDiffVsPlatform etc.)
trust threshold is valid — if new variants are added
in the future they must call divergenceExitCode at
end or they bypass threshold checking. 14 new CLI
tests in retention.test.ts — --threshold without
--exit-on-divergence exit 2 with 'requires
--exit-on-divergence' in error message, --threshold
0 exit 2 with 'positive integer' message,
--threshold -1 exit 2 (via --threshold=-1 syntax),
--threshold 1.5 non-integer exit 2 with 'positive
integer' message, --threshold abc non-numeric exit 2,
--threshold 1 behaves like default
--exit-on-divergence (exit 3 on 1 diff = backward
compat with ADR-0181 preserved), --threshold 2 +
fieldDiffs=1 → exit 0 (below threshold), --threshold
2 + fieldDiffs=2 → exit 3 (at threshold = >= matches
operator intuition), --threshold 2 + fieldDiffs=3 →
exit 3 (above threshold), --threshold 5 + fieldDiffs
=0 → exit 0 (no drift at all regardless of
threshold), --threshold integrates with --vs-platform
variant (threshold=3 + 2 diffs → exit 0 below
threshold), --threshold integrates with --cross-
table variant (threshold=2 + 2 diffs → exit 3 at
threshold), --threshold integrates with --add-tenant
N-way variant using fieldVariations.length not
fieldDiffs.length (threshold=3 + 2 variations → exit
0 below threshold), validation happens BEFORE PG
adapter call verified via diffTenantCapture length 0
with invalid --threshold 0 (no DB query attempted on
misuse). cli.ts helpText extended with 3-line note
under existing exit-on-divergence note explaining
--threshold N default 1 + requires --exit-on-
divergence + invalid values exit 2 + applies to all
4 diff variants. Future Qs cover --ignore-field
<name> repeated flag for per-field allowlist using
multiFlags infrastructure from ADR-0183 defer,
--threshold-percentage X% for fractional thresholds
in N-way comparisons across many fields defer, per-
field severity weighting (source change = 10 points
enabled change = 1 point fail when score >=
threshold overcomplicated defer), --threshold on
retention diff-history for cross-event analysis
different workflow defer, --threshold semantic for
retention prune (e.g., fail CI when N+ rows would be
deleted) different context prune is destructive
separate ADR if requested, output annotation showing
'threshold met X >= Y' or 'threshold not met X < Y'
in human format defer operators read fieldDiffs
count directly, default threshold via environment
variable CROSSENGIN_DIFF_THRESHOLD for pipeline-wide
configuration defer operators set per-call for clarity.
The retention CLI now has 17 actions with 4 diff
variants in 'diff' action (cross-tenant default +
--vs-platform + --cross-table + --add-tenant) all
supporting --exit-on-divergence [--threshold N] —
operators have first-class CI-gate ergonomics with
both strict mode (--threshold 1 / default = fail on
any drift) and fuzzy mode (--threshold N>=2 = fail
on N+ field differences) across pair-wise AND N-way
comparison matrices.
ADR-0185 covers Phase 2 M6.7.zz.tenant.opt-out.history.actor-join
(`crossengin retention history --with-actor-names`
actor display name surfacing — closes ADR-0170 Q9;
operators reading audit logs previously saw raw UUIDs
in every row (actor=00000000-...) and had to copy
each one + SELECT FROM meta.users WHERE id = ... to
find the actual person, repeated per row for compliance
attestations / incident reports / audit reviews — one
flag now surfaces display_name + email alongside raw
UUID. CLI surface `retention history [...other flags
...] [--with-actor-names]`; boolean flag default off
existing behavior preserved (raw UUID or <system>);
with --with-actor-names adapter does LEFT JOIN
meta.users and returns actorDisplayName + actorEmail
fields alongside actorId. Adapter ListOptOutHistoryInput
gains optional joinActor?: boolean field (default
false); when set SQL adds LEFT JOIN meta.users u ON
u.id = h.actor_id + SELECT adds u.display_name AS
actor_display_name + u.email AS actor_email + result
entries include actorDisplayName: string | null +
actorEmail: string | null fields; when joinActor is
false or omitted SQL omits JOIN entirely + result
entries omit actorDisplayName + actorEmail
(TypeScript optional string | null | undefined).
LEFT JOIN not INNER JOIN deliberately — preserves
history rows even when actor has been deleted from
meta.users (orphan FK), preserves history rows where
actor_id is NULL (system actors), operators never
lose audit context due to user-row mutations; when
user row exists but display_name is NULL (rare —
meta.users has email NOT NULL but display_name
nullable) adapter returns actorDisplayName:null +
actorEmail:<email> CLI render layer falls back to
email then to raw UUID. Adapter SQL aliasing — history
table now aliased as h consistently (even when
joinActor is false) with all WHERE-clause column
references prefixed h. — JOIN-vs-no-JOIN paths share
same query shape modulo LEFT JOIN + SELECT additions
+ easier to reason about + avoids any column-
ambiguity surprise if meta.users adds new columns;
cursor-pagination inline subquery (SELECT occurred_at
FROM ... WHERE id = $N) stays unqualified because has
own FROM with no alias — id and occurred_at reference
inline subquery's table directly. CLI rendering rules
table — actor_id NULL → <system>, actor_id + actorDisplayName
present → 'display_name (uuid)' with paren-wrapped UUID
for unambiguous identification, actor_id + actorDisplayName
null + actorEmail present → 'email (uuid)' fallback,
actor_id + both null (orphan FK) → raw UUID no name,
actor_id without --with-actor-names (fields absent) →
raw UUID no lookup. name (uuid) format gives operators
both human-readable name AND UUID for unambiguous
identification + stale audit logs reviewed years later
still show UUID even if user has since been renamed.
JSON format — history entries include actorDisplayName
+ actorEmail ONLY when --with-actor-names is set;
otherwise these fields are absent (not null); operators
detect feature use via entries[0].actorDisplayName !==
undefined; backward compat preserved — pre-flag
callers see identical envelope shape. Two-table join
cost — meta.users.id is primary key index-only lookup,
LEFT JOIN doesn't add row-count expansion (1:1 by
actor_id), one additional query plan node negligible
cost on typical history result sets; for operators
with millions of history rows + thousands of users
LEFT JOIN still index-only bounded by LIMIT clause no
materialization concerns at typical scales. Use cases
unblocked — audit-review readability (one command +
flag yields 'Alice Smith (uuid)' immediately
recognizable), per-actor compliance report via jq
'.entries[] | "\(.occurredAt) \(.eventKind) by
\(.actorDisplayName // .actorEmail // "system")"'
producing human-readable changelog without lookup
boilerplate, orphan-actor detection via jq filter on
actorId != null + actorDisplayName == null + actorEmail
== null surfacing FK orphans for cleanup, backward-
compat for raw-UUID consumers (pipelines parsing
existing JSON output without actorDisplayName continue
to work — fields absent unless --with-actor-names is
set no schema-shift surprise). Rejected alternatives
— CLI-side --users-file <path> JSON map (operators
maintain separate file substrate stays uncoupled from
meta.users — rejected meta.users exists in substrate
using it is canonical path), INNER JOIN instead of
LEFT JOIN (would silently drop history rows with
orphan FK or NULL actor_id — rejected preserves audit
completeness), substrate change with always-on JOIN
no flag (adds query cost to every history call —
rejected opt-in keeps default cheap), add
actorDisplayName to existing JSON envelope
unconditionally null when no lookup (changes JSON
shape for backward-compat callers — rejected
conditional emission preserves existing shape), new
retention history-with-actors action (adds CLI surface
— rejected flag-on-existing matches --vs-platform /
--cross-table / --add-tenant precedent), return only
actorDisplayName omit actorEmail (operators wanting
email fallback can't get it — rejected both fields
cheap to emit), display_name <email> format (mixes
with <system> placeholder syntax — rejected
display_name (uuid) parens disambiguates), display
only display_name without UUID (strips audit-trail
context for compliance reviews — rejected UUID
disambiguation matters for forensic accuracy), cache
user lookups across paginated calls (operator-side
concern substrate stays stateless — rejected).
Drawbacks — cross-schema dependency adapter SQL now
references meta.users directly (if operators deploy
tenant_retention_opt_out_history without meta.users
very unusual but possible in custom test fixtures
--with-actor-names would fail at query time;
documented not regression because substrate ships both
tables together), no multi-tenant filtering on users
meta.users is platform-wide (one user can be a member
of multiple tenants via user_tenant_membership;
join doesn't scope users by tenant — cross-tenant
actor like platform admin appears with same
display_name in all tenants' history matches operator
intent "who did this action?" RLS on meta.users would
still apply), no email fallback in JSON envelope
shape — caller composes preference order (adapter
returns both actorDisplayName + actorEmail; CLI
rendering picks one; programmatic consumers via JSON
make own choice; documented as contract), always uses
h. SQL aliasing existing test assertions checking for
bare-column SQL substrings broke and were updated
(minor migration cost for callers verifying SQL
shape directly none outside our tests), no --actor-
name <name> filter for "show only Alice's mutations"
(operators filter at jq layer for now), one JOIN per
query operators iterating with pagination + --with-
actor-names get JOIN cost N times across N pages
(bounded — meta.users lookup is index-only — but
operators with very large cohorts might prefer to
fetch all rows first then look up actors in one
batch; future Q if measured). 9 new adapter tests in
trace-retention.test.ts (omits LEFT JOIN when
joinActor false/not set verified via not.toContain,
emits LEFT JOIN meta.users u ON u.id = h.actor_id
when joinActor=true with u.display_name AS
actor_display_name + u.email AS actor_email in
SELECT, returns actorDisplayName + actorEmail when
joinActor=true and user row exists (Alice Smith +
alice@example.com both populated), returns null for
both when joinActor=true but actor has no user row
(orphan FK — adapter passes null through), returns
null for both when actor_id is null (system actor —
adapter still returns the entry), omits
actorDisplayName + actorEmail fields when joinActor
is false (TypeScript undefined not null), LEFT JOIN
preserves history rows even when user has been
deleted (mixed Alice present + Bob orphan case
returns 2 entries one with name one without),
composes with other filters tenantId + tableName +
joinActor (h.tenant_id = $1 + h.table_name = $2
verified), composes with cursor pagination joinActor
+ afterId (LEFT JOIN + (h.occurred_at, h.id) <
cursor both present)); 11 new CLI tests in
retention.test.ts (threads joinActor=true to adapter
when --with-actor-names is set, omits joinActor from
adapter input when flag NOT set verified backward
compat, human-format renders 'Alice Smith (uuid)' when
actorDisplayName populated, human-format falls back
to 'email (uuid)' when display_name null, human-
format falls back to raw UUID when both null orphan
FK no paren-wrap, human-format renders <system> for
null actor_id regardless of --with-actor-names,
human-format without --with-actor-names renders raw
UUID no display lookup no paren-wrap, JSON envelope
includes actorDisplayName + actorEmail fields when
entries carry them, composes with other filters
--tenant + --kind + --with-actor-names (joinActor:
true threaded with all other inputs); formatActor
helper unit tests via formatHistoryList — renders
display_name (uuid) when both present, falls back to
email (uuid) when display_name null). 4 existing
tests updated to assert h.-prefixed SQL (ORDER BY
h.occurred_at DESC, h.id DESC; (h.occurred_at, h.id)
< cursor) — minor migration cost. cli.ts helpText
extended with --with-actor-names flag note + 2-line
description explaining LEFT JOIN meta.users +
display_name + email surfacing alongside raw UUIDs.
fakeRetention listOptOutHistory mock already captures
input so joinActor flag flows through automatically;
no harness change needed. Future Qs cover --actor-id
<uuid> filter to scope history to one actor's
mutations (pair with --with-actor-names for "show all
of Alice's mutations with her name shown"),
--actor-name-equals <name> filter substring or exact
match against display_name (operators currently jq-
filter), show user status alongside name (active/
suspended/deleted useful for compliance "this action
was done by a now-suspended user"), display user's
tenant_membership role like 'Alice (erp_admin)' would
need additional JOIN to meta.user_tenant_membership
(different scope defer), surface actor names in other
audit surfaces like retention restore history rows
(pattern set replicate in future milestones),
--actor-name-pattern <regex> for pattern-based
filtering (operators use jq), pretty-printed actor
format option without UUID for narrow terminals
(operators wrap output with cut/awk for now). The
retention CLI now has 17 actions with audit-readability
across the history surface — operators get human-
readable actor attribution via opt-in flag without
changing the default cheap query path.
ADR-0177 covers Phase 2 M6.7.zz.tenant.batch
(`effectiveRetentionBatch(pairs)` adapter method on
PostgresTraceRetention + exported effectiveRetentionKey
helper — closes ADR-0159 Q2; single-pair effectiveRetention
issues 2 PG round-trips per call so dashboards rendering
10K tenants × 3 prunable tables = 30K resolutions per
page = 60K queries was prohibitive; batch resolver runs
exactly TWO queries total regardless of pair count using
single tenant query with `(tenant_id, table_name) IN
((..., ...), ...)` tuple-list WHERE clause + single
platform query with `table_name IN (...)` containing only
unique table names (deduplicated even when many pairs
share same table); Promise.all parallelizes for single
wall-clock round-trip; returns ReadonlyMap<string,
EffectiveRetentionResolution> keyed by
`${tenantId}:${tableName}`; exported
effectiveRetentionKey(tenantId, tableName) helper so
operators don't need to know format detail — UUID tenant
IDs contain hyphens but no colons + table names match
[a-z_]+ per META CHECK constraints so collision-free with
':' separator; resolution algorithm matches
effectiveRetention exactly — tenant policy + opt_out=true
+ active (clock-aware via this.clock()) → tenant_opt_out
variant, tenant policy + enabled → tenant variant,
platform policy exists → platform variant, else → none
variant; expired opt-outs fall through to platform same
as single-pair (boundary semantic preserved); algorithm
— deduplicate input pairs by key (3 dup → 1 result entry),
collect unique table names, run two queries in parallel,
build lookup maps (by key for tenant policies + by
tableName for platform policies), resolve in-memory per
pair returning ReadonlyMap; empty pairs returns empty Map
without issuing queries (PG doesn't accept empty IN
lists); rejected alternatives — single query with UNION
ALL (plan harder to reason about + JOIN doesn't translate
cleanly given different column shapes + in-memory
resolution is faster than SQL-side conditional CASE WHEN),
per-pair effectiveRetention in Promise.all (still 2N
queries defeating the point), JOIN tenant + platform in
SQL (column shapes differ), return Array<{tenantId,
tableName, resolution}> triplets (Map gives O(1) lookup
for dashboard rows + implicit deduplication + smaller
wire format; Array derivable from [...result.values()]
cheaply), wrap both queries in transaction (overhead not
warranted; policy tables change rarely operator-driven;
race window negligible), stream results via async
iterator (overkill for bounded result sizes; Map is right
shape), batch resolver accepting tenant-only or table-
only filters (operators with that pattern use
listTenantPolicies/listPolicies directly), cache platform-
policy table at adapter level since policies change
rarely (operators wanting caching wrap at their layer;
substrate stays stateless), exotic separator characters
\x1F or :: (':' is simple and UUIDs don't contain colons),
return resolution alongside requested pair shape so
operators don't compute key (Map by key is the canonical
pattern; exported helper exists); drawbacks — no CLI
surface in v1 (operators wanting ad-hoc batch lookups
write Node scripts; substrate is the meaningful win;
CLI defer if requested), two non-transactional queries
(tenant + platform see independent PG snapshots; race
window negligible since policy tables change rarely),
PG IN list size limits (very large batches >10K pairs
may hit PG parser limits or query-plan inefficiencies;
operators chunk input; future Q), no streaming (results
returned as one Map; operators render all at once), same
clock as effectiveRetention (opt-out expiry boundary
shared), key format leakage (if operators construct keys
manually rather than via helper, future separator changes
silently break code; exported helper mitigates); 13 new
adapter tests covering empty pairs returns empty Map,
issues exactly 2 queries when pairs present (Promise.all
parallel verified), tenant query uses (tenant_id,
table_name) IN tuple list with params [A, tableA, B,
tableB], platform query uses table_name IN list with
UNIQUE tables only verified for same-table different-
tenant pairs, deduplicates input pairs in result Map
(3 dup input → 1 result entry), resolves tenant variant
when tenant policy exists + enabled, resolves
tenant_opt_out when opt_out=true + active (clock-aware),
expired opt_out falls through to platform, resolves
platform when no tenant + platform exists, resolves none
when neither exists, mixed variants in one batch correctly
(tenant + platform + none in single call), Promise.all
parallelism verified (both queries fired in same tick),
key format `${tenantId}:${tableName}` exported helper
test; future Qs cover CLI retention effective-batch
--pairs-file file for ad-hoc batch lookups reading
CSV/JSON, automatic chunking for very large inputs >10K
pairs hitting PG parser limits, caching platform-policy
table to avoid second query on repeated calls (defer —
substrate stateless), bulk versions of expiringOptOuts
and other readers, composable inspectBatch returning
effective + expiring + history-snippets per pair, PG
prepared statements for repeated batch calls with same
pair count, adapter-side --maxConcurrent parameter for
higher-level orchestration). Substrate-only milestone
— no CLI surface; the substrate gains a batch read API
for dashboard performance; operators wanting CLI
exposure write Node scripts calling the adapter directly
or wait for the deferred CLI milestone.
ADR-0176 covers Phase 2 M6.7.zz.tenant.opt-out.cli.restore.dry-run
(`retention restore --dry-run` flag + previewRestoreTenantPolicy
adapter method on PostgresTraceRetention — closes ADR-0171
Q1; restore is destructive (overwrites current policy state
with historical state) and operators want to see what would
change before applying — same safety motif as retention
prune --dry-run from ADR-0174; new adapter method mirrors
prune's dual-method pattern (prune + previewPrune) — separate
method rather than dryRun?: boolean parameter on
restoreTenantPolicy because return shape is fundamentally
different (Result vs Preview); keeping them separate avoids
type-system pollution where every caller would need to
narrow on every call; PreviewRestoreTenantPolicyInput just
takes {historyId} — no actorId, no attributes since preview
is purely read-only no audit row written; discriminated
RestoreTenantPolicyPreview union has three variants
mirroring restoreTenantPolicy's three dispatch branches —
would_delete {tenantId, tableName, sourceHistoryId} when
prev_state IS NULL (would call deleteTenantPolicy),
would_set_opt_out {tenantId, tableName, retentionDays,
optOutUntil, optOutReason, sourceHistoryId} when
prev_state.opt_out === true (would call setTenantOptOut),
would_set_retention {tenantId, tableName, retentionDays,
enabled, sourceHistoryId} otherwise (would call
setTenantRetention); 'would_' prefix matches the prune
dry-run convention 'would_delete=N'; variants carry EXACT
arguments that would be passed to underlying mutation —
operators reading preview verify planned action without
ambiguity; algorithm — SELECT source history row (same
shape as restoreTenantPolicy's first query), throw on
not-found, dispatch on prev_state shape, return appropriate
variant; defensive validation of retention_days as number;
sourceHistoryId echoed in every variant for forensic
traceability; CLI branches at start of runRetentionRestore
— --dry-run flag triggers preview path before falling
through to live-restore flow; --actor silently ignored on
--dry-run (operators may script with both flags always set;
ignoring is friendlier than erroring); human output renders
preview header 'Restore preview (no changes applied):' +
'Source history: <id>' + 'Tenant:         <uuid>' +
'Table:          <name>' + action-specific lines: for
would_delete 'Action:         deleteTenantPolicy
(prev_state was null)'; for would_set_opt_out
'Action:         setTenantOptOut' + indented
'    retention_days: N' + '    opt_out_until:  <iso |
indefinite>' + '    opt_out_reason: <text | <no reason>>';
for would_set_retention 'Action:         setTenantRetention'
+ '    retention_days: N' + '    enabled:        yes|no';
reuses 'indefinite' / '<no reason>' conventions from
formatPolicyChange + retention effective; JSON envelope
{action: "restore", dryRun: true, historyId, preview:
RestoreTenantPolicyPreview} for dry-run mode; live mode
emits {action: "restore", dryRun: false, historyId, result:
RestoreTenantPolicyResult} — dryRun boolean is the
canonical discriminator matching prune envelope convention
from ADR-0174; use cases unblocked — pre-restore safety
check (two-command preview then apply), compliance
workflow validation (jq '.preview.kind' returns
"would_set_opt_out"), CI gate asserting restore semantics
before commit (BASH script branches on KIND), forensic
counterfactual investigation (what WOULD have happened if
we restored this), multi-command analysis comparing
preview vs current state via retention effective; rejected
alternatives — single restoreTenantPolicy({dryRun: true})
returning discriminated union of Result | Preview (type
system pollution forcing every caller to discriminate,
breaks prune separate-method pattern, audit-log clarity
weaker), previewRestoreTenantPolicy returning same shape
as RestoreTenantPolicyResult (conflates 'what happened'
with 'what would happen' — would_* prefix makes
difference explicit at type level), CLI flag --explain
instead of --dry-run (doesn't match apply --dry-run /
prune --dry-run established convention), implicit preview
when stdout is TTY (magic behavior; operators script
regardless of TTY), error when --actor set with --dry-run
(operators may script with both always set; silent ignore
friendlier), --diff-current flag combining preview with
current state (defer to future combined-mode milestone),
preview method accepting actorId for 'what would the actor
row look like' (read-only — actor meaningless without
write), JSON preview field renamed to result for parity
(semantically distinct — preview vs result is correct
vocabulary for read-only-vs-write split); drawbacks — no
--diff shortcut (operators chain retention effective +
retention restore --dry-run + jq; future combined flag
defer), no cross-history-event preview (operators run two
separate commands; defer), --actor silently ignored on
--dry-run (could error instead but operators may script
with both; ignoring is friendlier), preview is single-
snapshot (between dry-run and live restore another
operator could mutate source history row's prev_state
which is JSONB not append-only by DDL only by convention;
documented), three variants instead of one (operators
must switch on preview.kind; mirrors RestoreTenantPolicyResult's
discrimination — consistent shape across the family); 9
new adapter tests in trace-retention.test.ts — throws
when history id not found, does NOT issue any mutation
queries (single SELECT verified — no INSERT/UPDATE/DELETE
in captured SQL), prev_state=null returns would_delete
{tenantId, tableName, sourceHistoryId}, opt_out=true with
all fields returns would_set_opt_out with retention/until/
reason, opt_out=true with null until/reason returns nulls,
opt_out=false returns would_set_retention {days, enabled},
opt_out=false + enabled=false returns enabled:false,
throws on missing retention_days defensive check, kind
discriminates three dispatch branches parameterized test
calling three times with different inputs; 14 new CLI
tests in retention.test.ts — --dry-run calls
previewRestoreTenantPolicy not restoreTenantPolicy,
threads historyId to preview adapter, --dry-run ignores
--actor flag silently (preview is read-only no audit
row), human-format renders preview header + source-history
+ action for would_delete with '(prev_state was null)'
annotation, would_set_opt_out renders all three fields,
'indefinite' for null until + '<no reason>' for null
reason, would_set_retention renders retention + enabled,
JSON envelope shape for dry-run, JSON envelope dryRun:
false discriminator for live mode, --dry-run propagates
preview-adapter errors as exit 1, formatRestorePreview
helper unit tests — renders would_delete with annotation,
renders would_set_opt_out with all fields, renders
would_set_retention with enabled:no when disabled,
includes source history id in every variant
parameterized test; cli.ts helpText retention restore
usage line extended with [--dry-run] optional flag +
description mentions 'With --dry-run, show prev_state +
planned mutation method without applying.'; future Qs
cover --diff-current flag combining preview with
effectiveRetention for 'what would change' delta view,
bulk dry-run --bulk file.csv for multiple history-ids,
multi-version preview showing what restoring to A vs B
would each produce, --from-time DATE walking multiple
history rows pairing with deferred restore --to-time from
ADR-0171 Q2, confirmation prompt linking dry-run + live
invocations via session cache (adds complexity defer),
preview integration with retention diff-history for 'what
restoring to A would look like compared to current'). The
retention CLI now has 13 actions with --dry-run support
across all destructive operations: 3 read (expiring/
effective/list-policies) + 4 write (opt-out/opt-in/set/
delete) + 1 audit (history) + 1 restore (with --dry-run)
+ 1 diff (diff-history) + 1 maintenance (prune with
--dry-run); operators have complete safety-preview coverage
for write operations.
ADR-0175 covers Phase 2 M6.7.zz.tenant.opt-out.cli.history.cursor
(`retention history --after-id <uuid>` cursor pagination
— closes ADR-0170 Q8; at low-scale deployments default
limit=100 was fine but at >100K-event tenants operators
needed pagination and OFFSET-based pagination is unstable
under concurrent inserts (PG scans + discards rows
causing linear cost growth + rows shift between pages as
new events land at top); new compound-cursor SQL uses
`(occurred_at, id) < ((SELECT occurred_at FROM
meta.tenant_retention_opt_out_history WHERE id = $N),
$N)` — single $N param reused for both occurred_at inline
subquery lookup and tiebreaker; (occurred_at, id) ordered
lexicographically handles ties when multiple rows share
occurred_at (concurrent CLI runs producing events at
same wall-clock instant); UUID v7 id is the tiebreaker;
ORDER BY widened from 'occurred_at DESC' to 'occurred_at
DESC, id DESC' — ensures result rows match cursor's
order; without id tiebreaker PG could return rows sharing
occurred_at in arbitrary order causing same row to appear
on two consecutive pages or skip across pages;
'occurred_at DESC, id DESC' naturally consistent with
'(occurred_at, id) <' (returns rows strictly less-than
in compound-order walking timeline backwards); when
afterId doesn't exist in the table inline subquery
returns NULL → outer comparison evaluates NULL → row
filtered out → empty result set (operators detect end-
of-pagination via empty OR via results.length < limit);
backward compatible — omitting --after-id produces
identical query shape modulo new id DESC tiebreaker
(stability improvement not behavior change); existing
test 'ORDER BY occurred_at DESC' substring assertion
still passes (new clause contains old as prefix); CLI
adds --after-id <uuid> flag to existing retention
history action; no boundary validation since PG enforces
UUID format at query time with clearer error than CLI
substring match; JSON envelope gains two new fields —
afterId echoes the cursor passed in (null when omitted)
+ nextAfterId is the last row's id when results.length
=== limit indicating more pages may exist (null
otherwise — operators interpret as "no more pages");
human output gains footer hint when results.length ===
limit 'Page full — next page: crossengin retention
history --after-id <last-id> ...'; omitted when
results.length < limit; nextAfterId is best-effort
accurate at query time but concurrent inserts may add
events later — operators paginating typically don't
care (snapshot semantics); why compound cursor
(occurred_at, id) over just occurred_at — ties on shared
occurred_at would cause rows to skip pages; why
occurred_at + id instead of just id — UUID v7 is mostly
time-ordered but PG's index choice + concurrent writes
could produce out-of-order rows for same occurred_at,
compound cursor is bulletproof; why inline subquery for
cursor's occurred_at — avoids requiring operator to pass
both id AND occurred_at, substrate resolves timestamp
server-side from id; rejected alternatives — OFFSET-
based pagination via --page N (unstable under concurrent
inserts, PG scans+discards rows linear cost growth),
two-cursor --after-id + --before-id (single forward
direction covers common case; bidirectional needs
operator-driven demand), single-key occurred_at cursor
(ties cause skipped pages), single-key id cursor (UUID
v7 mostly but not strictly time-ordered for concurrent
writes), totalAvailable count in envelope (separate
COUNT(*) query; not worth extra round-trip per page),
validate --after-id UUID format at CLI boundary (PG
enforces with clearer error), auto-paginate via
streaming generator (operators want explicit page
control; shell loops cover bulk-pagination pattern;
streaming hides pagination from scripts), inline
subquery rewritten as JOIN (current shape clearer; PG
optimizer handles efficiently); drawbacks — compound
cursor is asymmetric (--after-id walks backwards in
time, operators wanting "newer than X" use --since
<iso> instead), no --before-id for ascending pagination
(chain via --since + --limit instead, defer), cursor
row need not be in result set (passing arbitrary UUID
produces empty silently — documented), no total-count
field (operators run separate COUNT query), nextAfterId
null is best-effort (standard caveat for paginated
queries on live tables), one extra ORDER BY column
(occurred_at primary sort, id DESC only when ties
which are rare given UUID v7 time-ordering); 7 new
adapter tests in trace-retention.test.ts — --after-id
threads as $N param into compound cursor subquery,
compound cursor handles ties via id DESC tiebreaker in
ORDER BY, combines --after-id with other filters via
WHERE AND, returns empty when cursor row doesn't exist
(PG NULL semantic verified via shape), compound cursor
uses same $N param for both occurred_at lookup and
tiebreaker (verified via regex count $1 appears twice),
combined-flag test verifying tenantId + tableName +
eventKind + since + until + afterId + limit all threaded
correctly in seven-param array, backward compat omitting
--after-id produces identical query shape; 6 new CLI
tests in retention.test.ts — threads --after-id through
to adapter, human-format prints next-page hint when
results.length === limit, human-format omits hint when
results.length < limit, JSON envelope emits afterId +
nextAfterId fields, JSON nextAfterId null when
results.length < limit, JSON afterId null when not
provided; existing history tests updated — afterId:
undefined now expected in captured input shape; cli.ts
helpText extended — retention history usage line gains
[--after-id <uuid>] entry, description widened to
mention ORDER BY now includes 'id DESC' tiebreaker +
--after-id semantic, --after-id flag doc added in
Flags section; future Qs cover --before-id reverse
pagination, --page-size as --limit alias, server-side
opaque base64 cursor encoding, totalAvailable count in
envelope, cross-process cursor stability via point-in-
time snapshot, --all flag to auto-paginate, CLI
integration with --since for events between cursor-id
and timestamp).
ADR-0174 covers Phase 2 M6.7.zz.tenant.opt-out.cli.prune
(`crossengin retention prune [--dry-run]` CLI action —
closes ADR-0172 Q2; pure CLI delivery wrapping the two
existing adapter methods PostgresTraceRetention.prune()
(from ADR-0143) and previewPrune() (from ADR-0153) — no
new substrate code, no new adapter methods, no new tests
for actual pruning logic beyond the parameterized cases;
the pruning machinery already existed via scheduled-job
invocation (cron, Inngest, K8s CronJob, AWS EventBridge);
this milestone exposes ad-hoc invocation at the terminal
— debugging stuck prunes, on-demand compliance sweeps,
validation after configuring new policies, CI gates,
post-incident forensic snapshots; single CLI action +
one optional flag (--dry-run); default calls prune()
returning RetentionRunResult[], --dry-run calls
previewPrune() returning RetentionPreviewResult[]; two
distinct formatter functions formatPruneRun /
formatPrunePreview keep terminology distinct — header
'Retention prune results (N entries):' vs 'Retention
prune dry-run results (N entries):', count label
'deleted=N' vs 'would_delete=N', summary verb 'pruned'
vs 'would prune'; per-row format <status> <table-name>
<tenant=uuid|(platform)> <count> retention=Nd
cutoff=<iso> with extra reason=X until=Y appended for
skipped_opt_out + skipped_opt_out_expired statuses (the
latter gets '(EXPIRED)' marker); summary line aggregates
pruned count + row count + categorised skip counts sorted
alphabetically — 'Summary: 2 pruned (1042 rows), 1
skipped (1 skipped_disabled)' or multi-category 'Summary:
0 pruned (0 rows), 3 skipped (1 skipped_disabled, 1
skipped_opt_out, 1 skipped_opt_out_expired)'; JSON
envelope {action: "prune", dryRun: boolean, results:
[...]} where dryRun boolean is the discriminator
distinguishing the two modes for downstream jq consumers
+ results is the full typed array from the underlying
adapter method; empty results print 'no retention
policies configured' for live and 'no retention policies
configured (dry-run)' for preview, exit code 0 — absence
of policies is not an error; private PruneResultLike
interface shares formatter scaffolding between the two
result types (they differ in two fields deletedCount vs
wouldDeleteCount but share the rest); count-rendering
helper takes countLabel parameter ('deleted' /
'would_delete') and count value avoiding duplication
while keeping public adapter types separate; why no
--policy <table> / --tenant <uuid> filter flags — scope
creep (pruning machinery is one round trip per policy),
filter ambiguity (platform-default DELETE uses NOT IN
subqueries against ALL per-tenant policies so filtering
changes subtle semantics), operator pattern (scheduled
jobs run full prune so ad-hoc mirrors that for
determinism); why no --confirm flag — --dry-run is the
canonical preview pattern (operators preview then run
live; two-command safety documented), scheduled jobs
would bypass any prompt creating operational asymmetry,
prune is destructive but per-tenant restore action
recreates policies (just not pruned trace data); use
cases unblocked — ad-hoc dry-run after configuring new
policy (operator confirms what next scheduled prune
would delete before it runs), compliance sweep on
demand (after policy change without waiting for next
scheduled), CI/migration validation (jq count of
'pruned' results), debugging stuck pruning (inspect
which policies the substrate sees and which would
delete), forensic 'what happened last sweep'
(crossengin retention prune --format json > snapshot.json
for post-incident); rejected alternatives — two separate
actions retention prune + retention preview (--dry-run
is more idiomatic matching apply --dry-run pattern),
--policy/--tenant filter flags (partial pruning has
subtle semantic gotchas), --confirm flag with prompt
(scheduled jobs bypass anyway), render summary at TOP
of human output (operators read top-down want context
first summary last), aggregate by table_name grouping
in human (adds complexity for marginal gain; jq covers
on JSON), implicit --limit (policy table bounded), auto-
emit notification on threshold (notification delivery is
operator concern), CSV output format (JSON + jq covers);
drawbacks — no actor attribution unlike mutation actions
that thread --actor (prune is maintenance op; future
audit-pruning-runs table closes ADR-0172 Q3), no filter
flags (operators control scope via policy-table state),
no --confirm (mirrors scheduled-job pattern), destructive
without per-tenant feedback in JSON (operators jq
groupBy), one round-trip per policy at adapter level
(acceptable for bounded policy count typically <100);
11 new CLI tests + 4 new formatter tests = 15 covering
default (no flag) calls prune() not previewPrune,
--dry-run calls previewPrune() not prune, human empty
result 'no retention policies configured', --dry-run
empty result adds '(dry-run)' suffix, human renders
pruned + skipped rows with summary line including
multi-status breakdown, --dry-run uses 'would prune'
summary verb + 'would_delete=' count label, human
renders opt-out skip with reason + until extra fields,
skipped_opt_out_expired gets '(EXPIRED)' marker, JSON
envelope {action, dryRun:false, results} default mode,
JSON envelope {action, dryRun:true, results} --dry-run
mode, adapter errors propagate exit 1; formatter unit
tests — formatPruneRun renders header+rows+summary,
formatPrunePreview uses dry-run terminology, '(platform)'
for results without tenantId, summary line shows
multiple skip categories alphabetically sorted; cli.ts
helpText extended with retention prune usage line + 4-
line description explaining dry-run semantics + output
structure mentioning per-table + per-tenant results +
summary line; future Qs cover --actor attribution
pairing with deferred meta.retention_pruning_runs audit
table from ADR-0172 Q3, --filter-table/--filter-tenant
flags, --confirm flag matching apply --confirm pattern,
progress reporting for long-running prunes, concurrent
invocation safety via PG advisory locks, --summary-only
flag, --exit-on-pruned for CI gates, CLI integration
with scheduled-job framework. The retention CLI now has
12 actions covering the complete lifecycle: 3 read
(expiring/effective/list-policies) + 4 write
(opt-out/opt-in/set/delete) + 1 audit (history) + 1
restore (restore) + 1 diff (diff-history) + 1 maintenance
(prune); operators have complete ad-hoc control over the
retention substrate from one binary.
ADR-0173 covers Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history
(`crossengin retention diff-history <history-id-a>
<history-id-b>` CLI action + diffHistoryEntries adapter
method + exported computeFieldDiffs pure helper — closes
ADR-0170 Q5; operators querying retention history saw
chronological event lists but couldn't answer "what
changed between event A and event B" without manual
JSONB comparison — this action does the diff in one
command; single-query SELECT id+tenant_id+table_name+
event_kind+occurred_at+next_state FROM
meta.tenant_retention_opt_out_history WHERE id IN
($1, $2) then client-side diff via computeFieldDiffs
helper (union of keys sorted alphabetically, JSON.stringify
deep comparison, returns only differing fields); result
type DiffHistoryEntriesResult carries idA + idB +
tenantId + tableName + occurredAtA + occurredAtB +
eventKindA + eventKindB + fieldDiffs ReadonlyArray of
{field, valueA, valueB}; same-(tenant, table) constraint
enforced — throws when events on different tenants
("events on different tenants (<tenantA> vs <tenantB>)")
or different tables (same shape) because the use case
is single-policy state at two moments not cross-tenant
comparison (cross-tenant workflow covered by separate
future retention diff action closing ADR-0165 Q6);
compares next_state only not prev_state because each
history row has both columns but cross-event question
is "snapshot A vs snapshot B" while prev_state vs
next_state of single event is already covered by
retention history rendering both columns; client-side
diff chosen over PG-side jsonb_each because the diff
logic is small (10 lines TypeScript), PG-side would
need verbose "sort by key then compare via text
equality" expression, application-side is unit-testable
as pure function with no DB dependency, two JSONB
blobs (~400 bytes each) cheap to move; CLI action takes
positional <history-id-a> <history-id-b> (both required
exit 2 if missing) + --format flag; human output
renders 3-section format — metadata header (A: <id>
at <iso> event_kind=<kind>, B: <id> at <iso>
event_kind=<kind>, Tenant + Table), blank line, then
either 'No differences between the two events' policy
states.' for empty fieldDiffs OR 'Field changes (N):'
header followed by 'fieldname valueA → valueB' lines;
'absent' placeholder rendered when value is undefined
(e.g., DELETE event's null next_state shows fields as
absent → value); arrow rendered as '→'; field name
padded to 20 chars for column alignment; values
JSON.stringify'd (numbers + booleans + strings as
literals, objects/arrays as compact JSON); JSON envelope
{action: "diff-history", result: DiffHistoryEntriesResult}
preserves full structure for jq downstream; use cases
unblocked — forensic audit "what changed between
mutations X and Y" answered in one command, compliance
report "policy state transitions over time" via
retention history + diff-history between consecutive
events generates clean changelog, restore validation
(diff source-history vs current-state before running
restore to confirm what would change), JSON-driven
compliance dashboards via jq '.result.fieldDiffs[] |
"\(.field): \(.valueA) → \(.valueB)"' pipe; rejected
alternatives — PG-side diff via jsonb_each (adds SQL
complexity for small win), compare prev_state vs
next_state of single event (covered by retention history;
cross-event use case is the priority), allow cross-
tenant comparison (different concern; covered by future
retention diff action), allow cross-table comparison
(same), three-way diff idA+idB+idC (overengineered;
operators chain pair-wise comparisons), --field <name>
filter flag (jq covers on JSON output), visual color
diff red/green (substrate stays terminal-emoji-free;
operators pipe to delta or diff for colored output),
compare full event metadata kind+actor+attributes
(diff focuses on policy state; metadata visible in
rendered headers), implicit restore on diff (conflates
two operations — diff is read-only), auto-sort by
occurred_at so output always older→newer (operators
may want B-then-A semantics; argument order preserved);
drawbacks — same-(tenant, table) constraint surfaces
as error not silent skip, no diff visualisation beyond
absent/value (nested object diffs render as full JSON;
operators rely on jq or dedicated diff tools — flat
policy shape doesn't have nested fields in practice),
one-pair comparisons only (operators chain multiple
diff-history commands or use external tools), no
--field filter (all differing fields render; jq covers),
next_state only (single-event prev-vs-next covered by
retention history); 16 new adapter tests in
trace-retention.test.ts — throws when neither id exists
with clear message including both missing ids, throws
when only one id missing with single id in message,
throws on different tenants with mismatch values in
error, throws on different tables similarly, throws on
unknown event_kind, returns metadata + fieldDiffs for
valid pair on same (tenant, table), DELETE event with
next_state=null shows 'absent' (valueA: undefined) for
fields present on B-event, empty fieldDiffs when both
states deep-equal, empty fieldDiffs when both null
(both DELETE events), SELECT uses WHERE id IN ($1, $2)
with both ids as params; computeFieldDiffs pure helper
tests — returns sorted alphabetical diffs, returns
empty array when both states equal, returns empty array
when both null, treats null state as empty object,
compares values via JSON.stringify deep equality,
treats deep-equal nested objects as no diff; 8 new
CLI tests in retention.test.ts — missing idA exit 2,
missing idB exit 2, threads ids to adapter, human-
format 'No differences' for empty fieldDiffs, human-
format metadata + field-by-field diff with arrow + count
header, human-format 'absent' for undefined values,
JSON envelope shape, adapter errors propagate exit 1;
cli.ts helpText extended with retention diff-history
usage line + description explaining next_state vs
next_state semantic; future Qs cover cross-tenant
retention diff <tenant-a> <tenant-b> <table> as separate
milestone closing ADR-0165 Q6, --field <name> filter,
three-way diff or n-way merge view, visual color
highlighting via opt-in flag, prev_state vs next_state
of single event via future retention show-event <id>
action, configurable comparison depth, diff against
current policy state via --current flag for "what
would restore change?" workflows). The retention CLI
now has 11 actions covering forensic + recovery +
comparison workflows — 3 read (expiring/effective/list-
policies) + 4 write (opt-out/opt-in/set/delete) + 1
audit (history) + 1 restore (restore) + 1 diff (diff-
history); operators have full lifecycle CLI without
leaving the substrate.
ADR-0172 covers Phase 2 M6.7.zz.tenant.opt-out.history-retention
(history-table retention — closes ADR-0170 Q1; the
mechanically simplest retention milestone — three additive
changes total: (1) META_RETENTION_POLICIES.table_name CHECK
widens from 3 to 4 values adding 'tenant_retention_opt_out_history',
(2) META_TENANT_RETENTION_POLICIES.table_name CHECK widens
from 2 to 3 values adding the same, (3) PRUNABLE_TABLES
map in PostgresTraceRetention gains one entry {timeColumn:
"occurred_at", hasTenantId: true}; no new adapter methods,
no new CLI surface, no new tests for actual pruning logic
beyond the parameterized cases — history table inherits
the entire ADR-0143 + ADR-0155 + ADR-0162 retention
machinery (window-based DELETE, per-tenant overrides,
opt-outs with expiry, dry-run preview, effectiveRetention
resolver, complete CLI surface 10 actions all working);
hasTenantId:true has three implications — per-tenant
DELETE fires when tenant has explicit override, platform
DELETE uses tenant_id NOT IN exclusion for tenants with
active overrides or opt-outs, per-tenant policies CAN
opt out of history pruning (operators with retain-forever
audit requirements); why include per-tenant retention
allowlist not just platform — schema supports tenant
scoping via tenant_id column, real use cases (VIP retain-
7-years tier; free-tier 90-days; legal-hold retain-
forever-for-this-tenant), excluding would be artificial,
CHECK widening additive no migration friction; why no
retention-on-the-history-table — recursive concern (audit-
log-of-audit-log gets its own audit log gets... infinite
regress), substrate keeps it flat — history rows describe
policy mutations but don't get their own meta-audit
history, operators wanting that wrap PG pgaudit at DB
layer; why no special event_kind for "history row pruned"
— pruning DELETEs are maintenance on the audit log NOT
mutations on per-tenant policies; if we wrote a
history_pruned event it would itself be subject to
pruning (loop); operators auditing pruning runs use the
RetentionRunResult[] return value identifying which tables
were swept and how many rows; why no schema-level append-
only enforcement this milestone — substrate documents
history as append-only "by convention", pruning is the
documented exception operators explicitly accept, future
REVOKE pattern on hypothetical audit-write role would
enforce except for the system role that runs prune (pairs
with deferred roles substrate); use cases unblocked —
platform-default history retention via INSERT INTO
meta.retention_policies (table_name='tenant_retention_opt_out_history',
retention_days=365, enabled=true), per-tenant VIP history-
retention tier via `crossengin retention set <vip-tenant>
tenant_retention_opt_out_history --days 2555` (7-year),
opt-out from history pruning entirely for litigation hold
via `crossengin retention opt-out <legal-hold-tenant>
tenant_retention_opt_out_history --reason ongoing_litigation:
case#42`, dry-run via existing previewPrune adapter
(invoked via scheduled jobs today; future `crossengin
retention preview` CLI action would expose directly),
effectiveRetention resolver works uniformly across all
four prunable tables now; rejected alternatives — don't
add to retention (table grows unbounded; operators have
compliance need for bounded audit logs), platform-only
not per-tenant (artificial — schema supports tenant
scoping, real use cases for per-tenant override), special-
case prune_history method with separate code path (
existing prune mechanism already does exactly what's needed
— window-based DELETE, per-tenant exclusion via NOT IN
subquery; reuse > parallel structure), add pruned_at event
to history table itself (recursive concern), separate
history_retention_policies table (duplicates existing
infrastructure — one retention substrate is correct),
refuse enabled=false on history-table platform policy (
operators legitimately want retain-forever for compliance),
lower-bound CHECK on retention_days for history (e.g.,
>= 30 — operator policy choice, substrate doesn't
prescribe), cascade pruning where pruning per-tenant
tenant_retention_opt_out_history rows triggers pruning
of related tenant_retention_policies rows (wrong direction
of causation — live policy rows are source of truth, history
is the audit trail not vice versa); drawbacks — history
pruning is destructive (once pruned audit context is gone;
operators wanting indefinite retention set retention_days
very large or enabled=false — documented as "retention
pruning IS lossy for the audit log"), no event captures
pruning runs themselves (prune action recorded only in
live policy table's last_pruned_at + substrate's audit log
if wired — future Q for meta.retention_pruning_runs
table), no special restriction on aggressive retention
(operators can set retention_days=1; substrate doesn't
gate — operators choose), CHECK widening requires schema
migration for production deployments (PG ALTER TABLE
DROP/ADD CONSTRAINT is fast catalog-only update no row
scan since new value is additive — documented), per-tenant
overrides on history retention add small denormalization
concern (a tenant's tenant_retention_opt_out_history
retention policy is ITSELF a row in tenant_retention_policies
with its own history row — operators navigate via same
query surface, no special-case needed); 5 new tests in
trace-retention.test.ts — knownPrunableTables exposes 4
tables not 3 (adds tenant_retention_opt_out_history),
tablesWithTenantId exposes 3 tables not 2 (adds the new
table alongside workflow_traces + llm_call_traces), prune
issues DELETE against meta.tenant_retention_opt_out_history
using occurred_at column, platform-default DELETE on
history table uses tenant_id NOT IN subquery (hasTenantId
=true verified), per-tenant retention applies to history
table (per-tenant DELETE issued with tenant_id=$1 param),
effectiveRetention resolves for history table when platform
policy is set (source="platform" + retentionDays), previewPrune
renders count for history table; existing tests updated
— knownPrunableTables test 3→4 entries, tablesWithTenantId
test 2→3 entries, safety-properties test allowed.length
3→4; meta-schema.ts CHECK constraints on both retention_policies
tables widened additively (4-value + 3-value); future Qs —
default platform retention shipped row (substrate ships
empty by default matching opt-in pattern; defer), CLI
`retention prune [--dry-run]` action for ad-hoc invocation
(currently scheduled-job only; defer), meta.retention_pruning_runs
audit table capturing every prune execution with affected-
table list + row counts + duration (defer until operators
ask), REVOKE-enforced append-only pairing with deferred
roles substrate, lower-bound CHECK on retention_days to
prevent accidental aggressive pruning (rejected for now —
operator policy choice; revisit if accidental wipes
become a problem), compliance-regime-specific retention
defaults HIPAA 6yr / SOX 7yr (substrate doesn't enforce —
operators encode in deploy scripts)). The retention
substrate is now self-managing — the audit-log table it
produces is itself subject to the retention machinery it
provides.
ADR-0171 covers Phase 2 M6.7.zz.tenant.opt-out.cli.restore
(`crossengin retention restore <history-id>` CLI action +
restoreTenantPolicy adapter method on PostgresTraceRetention
— closes ADR-0169 Q7 + ADR-0170 Q4; wires undo on top of
the audit-log table shipped in ADR-0170 — prev_state was
already captured on every mutation, this milestone uses
it; adapter takes RestoreTenantPolicyInput {historyId,
actorId?, attributes?} and returns discriminated
RestoreTenantPolicyResult — {kind:"restored", policy:
TenantRetentionPolicyRow} when prev_state had data,
{kind:"deleted", tenantId, tableName} when prev_state was
null (the source event created a new row, so restoring to
before-state means delete it now); two-query algorithm —
SELECT source history row by id (throws not_found),
dispatch on prev_state: null → deleteTenantPolicy,
opt_out=true → setTenantOptOut with prev fields
(retentionDays/optOutUntil/optOutReason), otherwise →
setTenantRetention with prev fields (retentionDays/
enabled); attributes merged with {restored_from: historyId}
so new history row written by underlying mutation carries
forensic traceability; delegates to existing mutation
methods rather than custom restore SQL — reuses their
atomic CTE history-write pattern, inherits their tests +
behavior, no new code path needed; defensive runtime check
on prev_state.retention_days as number (schema-drift
safety); CLI takes positional <history-id> (exit 2 if
missing) + optional --actor flag; human output for
kind=restored reuses shared formatPolicyChange("restored",
policy) helper rendering 'Tenant restored: <uuid> /
<table>' header + day + enabled + opt-out + conditional
Until + conditional Reason lines; human output for
kind=deleted renders 'restored from <history-id>: policy
deleted (prev_state was null) — tenant X / table Y'; JSON
envelope {action: "restore", historyId, result} preserves
discriminated union shape for jq branching on .result.kind;
why no new policy_restored event_kind — audit clarity
preserved via attributes.restored_from (operators see
actual mutation kind opt_out_set/retention_set/policy_deleted
plus restore reference); restore is meta-operation not
new policy state — schema's event kinds describe what
happened on the row, restore describes how operator chose;
additive schema change avoided; query 'WHERE attributes
->>'restored_from' IS NOT NULL' works without new kind;
why delegation over custom SQL — polymorphic apply on
event_kind would make single CTE unreadable, delegation
reuses four mutation methods' tested atomic CTE write
pattern, restore inherits future improvements to those
methods; why attributes JSONB over dedicated column —
attributes designed exactly for extensible audit metadata,
restored_from joins source: "cli" / correlationId /
operator-defined keys; use cases unblocked — recover from
accidental delete (history --kind policy_deleted --limit 1
| restore), undo wrong opt-out by finding most recent
opt_out_set then restore, roll back tier migration mistake
via prev_state retentionDays reversion, compliance audit
'restore proof' via jq filter on attributes.restored_from
showing every restore action with source-of-truth history
reference, CI test recovery via clean reset from fresh
history; rejected alternatives — single CTE for source-
lookup + restore (polymorphic apply on event_kind makes
CTE unreadable beyond maintainability threshold), generic
applyPolicyState method (essentially duplicates four
existing mutation methods), new policy_restored event_kind
(audit clarity already preserved via attributes), dedicated
restored_from column on history table (attributes JSONB is
the canonical extensible audit metadata location), refuse
restore for policy_deleted events on the basis row is gone
(that IS the headline use case — DELETE history rows have
valid prev_state from RETURNING d.* and restoring re-creates
the policy), --dry-run flag this milestone (defer),
restore by tenant+table most-recent event (ambiguous —
operators may want to restore to specific historical state
not just last; by-history-id is unambiguous), atomic
restore-and-emit-policy_restored CTE (combines complexity
of #1 + #3), restore --to-time DATE (would need to walk
multiple history rows computing state at time T — defer
to advanced action if requested), cascade restore across
multiple history rows (semantics unclear — defer); 10
new adapter tests in trace-retention.test.ts — throws
when history id not found, looks up source by id with
WHERE id=$1 first-query, prev_state=null restores via
DELETE second-query (kind="deleted" result, SQL contains
'policy_deleted'), prev_state opt_out=true restores via
setTenantOptOut second-query (SQL contains 'opt_out_set',
result.policy carries restored fields), prev_state
opt_out=false restores via setTenantRetention second-query
(SQL contains 'retention_set'), attributes.restored_from
added to mutation attributes param, caller-provided
attributes merged with restored_from, actorId threaded to
underlying mutation as parameter $4 or $5, throws when
prev_state missing retention_days defensive check, kind=
"deleted" result carries tenantId+tableName from source
row not from input args; 8 new CLI tests in retention.
test.ts — missing history-id arg returns exit 2, threads
historyId+actorId=null defaults to adapter, --actor flag
threading verified, human-format renders 'Tenant restored'
for kind=restored variant with policy fields + reason,
human-format renders 'restored from <id>: policy deleted
(prev_state was null) — tenant X / table Y' for kind=
deleted variant, JSON envelope shape {action: "restore",
historyId, result} for restored variant, JSON envelope
deleted variant with result.kind="deleted" + tenantId,
adapter errors propagate as exit 1 with clear message;
cli.ts helpText extended with retention restore usage line
+ multi-line description explaining prev_state-null
behavior (restores via DELETE, populated prev_state via
setTenantOptOut or setTenantRetention based on prev_state
.opt_out); future Qs cover --dry-run flag showing prev_state
+ which method would be called, restore --to-time DATE
walking history to compute state at time T, batch restore
restore-bulk file.csv for tier migration rollbacks,
confirmation prompt --confirm for destructive restores
(when prev_state null would DELETE an existing policy
matching apply --confirm pattern), restore-from-snapshot
for cross-tenant bulk operations, lastPrunedAt preservation
semantic on restore (currently inherits underlying mutation
methods' behavior — documented), GUI/dashboard integration
with history timeline + one-click restore out of CLI
scope). The retention CLI is now operationally complete on
the audit + recovery axes — 10 actions total (3 read +
4 write + 1 audit + 1 restore-undo); the audit-log table
is now usefully connected to recovery workflows not just
forensic reads.
ADR-0170 covers Phase 2 M6.7.zz.tenant.opt-out.history
(META_TENANT_RETENTION_OPT_OUT_HISTORY append-only audit
log + atomic history writes from all 4 mutation methods +
query method + CLI action — closes six prior ADR Qs in
one milestone: ADR-0161 alt-1 separate audit table,
ADR-0162 Q7 history-aware queries, ADR-0166 Q1+Q2 audit
columns + history table, ADR-0167 Q3 --include-history,
ADR-0168 Q6 audit columns, ADR-0169 audit-log + restore
Qs; new 129th meta-schema table with id UUID v7 PK +
tenant_id FK CASCADE + table_name + event_kind CHECK
('opt_out_set'|'opt_out_cleared'|'retention_set'|
'policy_deleted') + actor_id nullable UUID + occurred_at
default now() + prev_state JSONB + next_state JSONB +
attributes JSONB NOT NULL default '{}'::jsonb; three
indexes (tenant_id+occurred_at, table_name+occurred_at,
event_kind+occurred_at) all ordered DESC for latest-first
pagination; tenant-isolated RLS; PK on id not composite
because concurrent CLI runs can share occurred_at instant
and UUID v7 gives time-ordered collision-free identity;
append-only by convention not enforced — REVOKE on audit-
write role would enforce but couples to not-yet-shipped
roles substrate; atomic history writes via CTE chain in
SAME SQL statement as the policy mutation (existing CTE
captures pre-state snapshot at statement start, mutation
CTE does INSERT...ON CONFLICT DO UPDATE / DELETE
RETURNING, history CTE INSERTs new row, outer SELECT
returns mutation result) — PG single-statement atomicity,
no race window, no transaction overhead, no two-round-
trip cost, simpler test mocks than transaction(); prev_state
is NULL for new-row INSERT (existing CTE returns empty),
populated for UPDATE (snapshot of pre-mutation row),
populated for DELETE (RETURNING d.* before deletion);
next_state populated for INSERT/UPDATE, NULL for DELETE;
four mutation inputs (setTenantOptOut, clearTenantOptOut,
setTenantRetention, deleteTenantPolicy) gain optional
actorId + attributes fields with attributes defaulting
to {} JSONB matching workflow_traces + llm_call_traces
convention so downstream jq always sees an object;
listOptOutHistory adapter method with five orthogonal
filters (tenantId, tableName, eventKind, since, until)
+ LIMIT (default 100, validated integer >= 1) all
optional combining via WHERE-clause AND; ORDER BY
occurred_at DESC for latest-first; strict event_kind
validation on returned rows throws on unknown values
(defensive against schema drift); OPT_OUT_HISTORY_EVENT_KINDS
const tuple + OptOutHistoryEventKind type +
isOptOutHistoryEventKind predicate mirror workflow runtime
+ router instrumentation kind patterns; new CLI action
`retention history` with --tenant + --table + --kind +
--since + --until + --limit flags all optional; CLI-
boundary validation — --kind against the 4-value tuple
(exit 2 on invalid), --since/--until parsed via
Date.parse and normalised to canonical ISO 8601 (exit 2
on invalid), --limit integer >= 1 (exit 2 on invalid);
human output single-row-per-event table format showing
occurred_at + event_kind padded + tenant + table + actor
with '<system>' placeholder for null actorId
distinguishing operator changes from system events;
JSON envelope {tenantFilter, tableFilter, eventKind,
since, until, limit, count, entries} echoes every filter
for jq correlation; --actor <uuid> flag added to opt-out
+ opt-in + set + delete mutation actions threading
actorId through to history rows (omitted = null = system
actor); rejected alternatives — audit columns on live
policy row set_by/set_at/prev_state JSONB (only captures
most-recent event; column proliferation 4 kinds × 3
fields = 12 dead-weight columns; no event-kind
distinction), transactions wrapping mutation+history
(two round-trips, more test mock boilerplate, same
atomicity outcome as CTE), PG trigger on policies table
writing history (hidden behavior, debugging harder,
doesn't access SQL-parameter-level actorId/attributes),
separate schema for history (breaks established meta-
schema topology), mandatory actorId (system actors have
no human attribution; null is canonical), per-field diff
in history row (JSONB diff easy app-side; both states
maximally reconstructable), pg_audit WAL-based (extension
dependency, harder tenant-scoped queries, no
actorId/attributes), materialized view aggregating into
current state (live policy table IS current state),
strict CHECK on actor_id UUID format (already TYPED
UUID, PG enforces shape), policy_state enum on history
row (can be derived from next_state; storing redundant
fields invites drift); use cases unblocked — forensic
audit who-set-this-opt-out via tenant+table filter,
compliance report all-opt-outs-in-Q3-2026 via kind+since
+until+--format json export, tier-migration audit trail
via --kind retention_set filter, operator attribution
via --actor flag on mutations flowing to history rows,
policy-state reconstruction at point-in-time via
--until + --limit 1 returning next_state JSONB, drift
detection via prev_state vs next_state diff;
21 new adapter tests + 18 new CLI tests = 39 covering
each mutation SQL contains correct event_kind literal,
captures prev_state via existing CTE for INSERT/UPDATE,
captures via DELETE RETURNING d.* for delete, threads
actorId + attributes through every mutation, listOptOutHistory
no-filter + per-filter + limit + invalid-limit error +
default 100 + unknown event_kind throws, CLI history
no-flags + threads-flags + ISO normalisation + invalid-
kind/since/until/limit exit 2 + empty result message +
table rendering + '<system>' placeholder + JSON envelope
+ adapter-errors-exit-1, --actor threading verified on
all four mutation actions + omitted=null;
meta-schema.test.ts updated table count 128 → 129 +
tenant_retention_opt_out_history added to alphabetical
name list; cli.ts helpText extended with retention
history usage line + --actor / --kind / --since / --until
/ --limit flag docs; future Qs cover history-table
retention pruning (add to meta.retention_policies allowlist
+ adapter logic), actor_id FK to meta.users when users
substrate lands, REVOKE-enforced append-only when roles
substrate lands, retention restore <history-id> action
using prev_state for rollback (closes ADR-0169 Q7),
retention diff-history <id-a> <id-b> for event comparison,
backfill tool synthesizing events from current rows for
pre-existing policies, SIEM ingestion hooks streaming
events to Splunk/Datadog, history query cursor pagination
via --after-id <uuid> for >100K-event tenants, actor
display join surfacing human names from meta.users,
--attributes CLI flag exposing structured audit context
from mutation commands).
ADR-0169 covers Phase 2 M6.7.zz.tenant.retention-delete
(`crossengin retention delete <tenant-id> <table-name>`
CLI action + deleteTenantPolicy adapter method on
PostgresTraceRetention — closes ADR-0168 Q1; the
mechanically simplest substrate method in the retention
family — single `DELETE FROM
meta.tenant_retention_policies WHERE tenant_id = $1 AND
table_name = $2` using PG's native rowCount; returns
boolean where true=row deleted, false=no matching row;
idempotent no-op semantic (deleted=false is success exit
0); CLI takes positional tenant + table args only (no
flags beyond --format); validates missing args with exit
2; no --confirm flag (matches sessions + gateway-routes
mutation pattern, bounded blast radius — single policy
row, recoverable via retention set or opt-out; operators
wanting safety run effective first); boolean return chosen
over TenantRetentionPolicyRow | null because deleted row
no longer exists post-mutation — returning pre-deletion
state via RETURNING is semantically odd; boolean
sufficient for if-then-log audit scripts; uses rowCount
rather than RETURNING since operators inspect pre-
deletion state via effective/list-policies before
deleting; no opt_out filter in WHERE clause — distinct
from clearTenantOptOut which deliberately filters AND
opt_out = true to avoid clearing fields on non-opt-out
rows; delete is the hard-delete path with no flag-state
filter, operator's intent is 'remove this row regardless
of its state'; human output 'deleted per-tenant policy:
<uuid> / <table>' or 'no per-tenant policy for tenant
<uuid> on <table> (idempotent no-op)' with printSuccess
in both cases; JSON output emits envelope {action,
deleted, tenantId, tableName} where deleted boolean
discriminates actual deletion from no-op and the queried
tenantId+tableName echo allows correlation across
multiple invocations in cron logs / audit trails; use
cases unblocked — reset tenant to platform-default in
one command (no audit baggage), tier-migration cleanup
via shell loop, compliance audit closure (jq list-
policies | filter | delete stand-by rows), end-of-
engagement tenant offboarding, CI test-tenant cleanup
(idempotent teardown), JSON pipeline for bulk reverts;
rejected alternatives — DELETE with RETURNING for the
deleted row (adds complexity for boolean question;
operators inspect via effective/list-policies first),
soft-delete via enabled=false (already covered by
retention set --enabled=false), refuse delete on
opt_out=true row (operators explicitly running delete
know intent; substrate doesn't gate destructive actions
on flag states mirroring set's willingness to overwrite
opted-out rows), --confirm prompt this milestone (defer
to future M; established CLI pattern doesn't prompt;
bounded blast radius; chains in scripts), bulk --bulk
file.csv (shell loops cover), --all-tables flag (defer
to future tenant-offboarding milestone), retention purge
naming (implies destructive sweep across many rows;
delete matches single-row scope), Promise<TenantRetentionPolicyRow
| null> return (semantically odd), filter on opt_out to
mirror clearTenantOptOut (intentional semantic — hard-
delete has no flag-state filter); 5 new adapter tests
in trace-retention.test.ts: DELETE WHERE shape verified,
threads tenantId+tableName as params, returns true when
rowCount > 0, returns false when rowCount = 0, NO
opt_out filter (verified absent from SQL, distinct from
clearTenantOptOut); 9 new CLI tests in retention.test.ts:
missing tenant returns exit 2, missing table returns exit
2, threads tenantId+tableName to adapter, human-format
prints 'deleted per-tenant policy' when row removed,
human-format prints 'idempotent no-op' when no row,
JSON envelope structure with deleted=true on actual
removal, JSON envelope structure with deleted=false on
no-op, exit 0 on idempotent no-op (re-runnable),
adapter errors propagate as exit 1; cli.ts helpText
extended with retention delete usage line; future Qs
cover --confirm flag matching apply --confirm if
operators report accidents, --all-tables for tenant
offboarding (single command across all prunable tables
for a tenant), --include-platform REJECTED PERMANENTLY
(too dangerous — platform defaults are operator-curated,
CLI shouldn't make accidental deletion easy), --exit-on
no-op for CI gates ("fail build if expected row was
already missing"), audit-log integration pairing with
deferred history-table milestone, retention purge --before
<date> bulk cleanup for time-bound row removal, retention
restore <backup-id> for undo pairing with deferred
history-table milestone for restore-from-snapshot
workflows). The retention CLI surface is now CRUD-complete
on per-tenant policies — 8 actions covering full
lifecycle (3 read: expiring/effective/list-policies; 4
write: opt-out/opt-in/set/delete; plus the foundational
list).
ADR-0168 covers Phase 2 M6.7.zz.tenant.retention-set
(`crossengin retention set <tenant-id> <table-name>
--days N [--enabled true|false]` CLI action +
setTenantRetention adapter method on PostgresTraceRetention
— closes ADR-0166 Q7; operators configuring active
per-tenant retention overrides (NOT opt-out — that's
ADR-0166's path) previously had to write raw INSERT ...
ON CONFLICT SQL — now one-command CLI; mirrors
M6.7.zz.tenant.opt-out.cli.mutate pattern for symmetry —
same INSERT ... ON CONFLICT DO UPDATE atomic upsert,
same shared formatPolicyChange output renderer, same
exit-code conventions; adapter setTenantRetention takes
{tenantId, tableName, retentionDays, enabled?} where
enabled defaults to true; validates retentionDays as
integer >= 1 at adapter boundary (clearer than DB CHECK
violation); SQL sets opt_out=false unconditionally,
opt_out_until=NULL on UPDATE, PRESERVES opt_out_reason
on UPDATE (omitted from SET clause per ADR-0161
historical audit context preservation — lifting an
opt-out keeps the reason as 'this tenant was opted out
previously due to X' historical signal; same logic
applies when transitioning from opt-out to active per-
tenant override); INSERT path explicitly writes all
fields with opt_out_reason=NULL, opt_out_until=NULL;
throws when RETURNING yields no rows (defensive); CLI
mandates --days flag (no default — operators must
explicitly state the policy value; missing --days exits
2 with clear error catching the bug); --enabled defaults
to true (common case is take effect immediately);
--enabled true|false validated as string match (anything
else exits 2); opt_out_until cleared on update because
semantically belongs to opt-out lifecycle — stale value
from previous opt-out is more common than pre-staging
operator intent ('set this tenant's retention, period');
action verb `set` chosen over update/configure/override
for canonical operator vocabulary — full command
crossengin retention set ... carries enough context that
set alone isn't ambiguous; human output via shared
formatPolicyChange("retention set", policy) — 'Tenant
retention set: <uuid> / <table>' header + Retention N
day(s) + Enabled yes|no + Opt-out:no + conditional
Until line (omitted when both opt_out=false and
opt_out_until=null) + conditional Reason line (rendered
when opt_out_reason persists from historical opt-out,
omitted when null); JSON output emits envelope {action:
"set", policy: TenantRetentionPolicyRow}; use cases
unblocked — per-tenant tier upgrade (free→enterprise
365d), per-tenant tier downgrade (free 7d), disable as
stand-by (--enabled=false; configured retention_days
stored as restore value if later re-enabled),
end-of-legal-hold workflow (opt-in then set to restore
custom retention — set also defensively clears any
residual opt_out_until from staging), compliance reset
(opt-in then set --enabled=false to inherit platform
default), JSON pipeline for bulk tier migration scripts
via shell loop; rejected alternatives — `retention
update` (implies row exists; set is symmetric across
new+existing), `retention override` (verbose+specific
to per-tenant override semantic; set reads more
naturally), make --days optional preserving existing
(operators may forget on new row creating inconsistent
state; mandatory catches bug), default --enabled=false
require explicit true (common case is take effect
immediately), preserve opt_out_until on update (stale-vs-
staging trade-off favors clear; matches most common
intent), clear opt_out_reason on update (contradicts
ADR-0161 documented preservation), refuse set on row
currently with opt_out=true (one-shot transition is
valid workflow — current behavior clears opt_out +
opt_out_until while preserving opt_out_reason is exactly
that one-shot), reject --enabled=false with --days (
staging future retention with disabled flag is valid),
two-query SELECT-then-INSERT-or-UPDATE (race window;
ON CONFLICT atomic); 10 new adapter tests in
trace-retention.test.ts covering INSERT ... ON CONFLICT
shape verified, parameter threading retentionDays +
enabled, defaults enabled=true, returns camelCase policy
row, UPDATE clears opt_out_until to NULL, PRESERVES
opt_out_reason (not in SET clause), UPDATE uses
EXCLUDED.retention_days + EXCLUDED.enabled, rejects
retentionDays < 1 at adapter boundary, rejects
non-integer 1.5, throws on empty RETURNING; 12 new CLI
tests in retention.test.ts covering missing tenant
returns exit 2, missing table returns exit 2, missing
--days flag returns exit 2, default flag threading
(tenantId + tableName + days + enabled=true) to adapter,
--enabled=false threading, --enabled=true threading
explicitly, invalid --enabled value exits 2 with clear
error, non-integer --days exits 2, --days<1 exits 2,
human output prints 'Tenant retention set:' header +
30 day(s) + Opt-out:no, JSON envelope shape
{action: "set", policy: ...}, adapter errors propagate
as exit 1; cli.ts helpText extended with retention set
usage line + --days/--enabled flag docs; future Qs
cover retention delete action for full row removal
(operators currently raw SQL DELETE), --confirm-clear-
opt-out flag for destructive transitions (force
explicit acknowledgement), --days inherit sugar for
DELETE-and-inherit-platform-default, bulk variant
--bulk file.csv for tier migration scripts, confirmation
prompt --confirm matching apply --confirm pattern, audit
columns set_by/set_at pairing with deferred actor
attribution + history-table milestones).
ADR-0167 covers Phase 2 M6.7.zz.tenant.opt-out.cli.list
(`crossengin retention list-policies [--tenant <uuid>]
[--table <name>]` broad-audit CLI action — fills the
audit gap left by the four targeted actions; wraps
existing PostgresTraceRetention.listPolicies +
listTenantPolicies methods with NO new adapter surface —
the substrate-side query methods already existed since
M6.7.zz / M6.7.zz.tenant; emits both platform-defaults
and per-tenant-policies sections in one shot — compliance
audits no longer need three SQL queries + manual
stitching; output always renders both sections with
explicit count headers including empty state '(none
configured)' giving operators complete context for the
negative space; per-tenant rows show one of three opt-out
states (opt-out=no for normal per-tenant override,
opt-out=yes (until <iso>, reason: <reason>) for active
time-bound, opt-out=yes (until indefinite, reason:
<reason>) for indefinite); null optOutReason renders as
'<no reason>' consistent with other actions;
--tenant <uuid> scopes per-tenant section only (platform
defaults stay visible so tenant audits keep fallback
context for unconfigured tables), --table <name> scopes
BOTH sections to one table, both flags AND together;
filter suffix in section headers '(filtered: tenant=...,
table=...)' preserves query parameters in saved output;
no filter-value validation (--table=typo returns empty,
operator notices — matches substrate's doesn't-prescribe
stance); JSON output emits structured envelope
{tenantFilter, tableFilter, platform, tenantPolicies}
echoing filter values for downstream jq pipes; parallel
adapter calls via Promise.all (independent queries,
single wall-clock round-trip); client-side filtering
preferred over adapter-side WHERE clauses for this
milestone since policy tables are bounded (max 3 platform
rows + ~2N tenant rows where N=tenant count; ~20K rows
at 10K-tenant scale returns in milliseconds) — adapter
signatures stay simple; action name list-policies
(hyphenated) chosen over plain `list` (ambiguous: list
what?) reserving namespace for future siblings; matches
verb-object naming of gateway routes register-pack /
unregister-pack / sync-pack conventions; use cases
unblocked — one-command compliance audit (SOC 2 / HIPAA
/ 21 CFR 11 auditor sees complete picture in one screenshot),
per-tenant retention summary (customer-success answering
"what's tenant X's retention?"), per-table compliance
check (audit one table's deviations across all tenants),
JSON export for quarterly compliance reports (lastPrunedAt
gives "was pruning actually running?" signal), CI sanity
check (jq counts disabled platforms, fails build > 0);
rejected alternatives — single flat list mixing both
row types (mental segmentation burden; two-section
matches table topology), `retention list` plain (too
generic), `retention policies` noun-only (inconsistent
with action-verb pattern), adapter-side WHERE filtering
(policy tables are small; add if measured), JSON-only
output (terminal use wants readable), built-in
--limit/--offset pagination (bounded data; head/jq
covers), single JOIN/UNION query (orthogonal shapes —
two parallel preserves discriminated structure), sort
flags --sort table|tenant|days|pruned (jq covers); 17
new tests in retention.test.ts — both sections returned
with no filters, --tenant scopes per-tenant only,
--table scopes both sections, --tenant + --table apply
both filters, empty platform renders (none configured),
empty per-tenant renders (none configured), filter
suffix on header when flags set, JSON emits structured
envelope with all sections + filters, JSON reflects
filter values, adapter errors propagate as exit 1,
formatPoliciesList renders opt-out=no for normal per-
tenant, opt-out=yes with until + reason for active,
opt-out=yes (until indefinite ...) for null optOutUntil,
'<no reason>' for null optOutReason, enabled/disabled
flag, 'last pruned <iso>' / 'last pruned never' rendering,
omits filter suffix when both filters null; cli.ts
helpText extended with retention list-policies usage
line + --tenant / --table flag docs; future Qs cover
--stale-days N filter for "policies not pruned in N+
days" CI gates, --opt-out-only filter (jq covers),
--include-history pairing with deferred ADR-0161-alt-1
history table milestone, adapter-side filtering if
measured slow, sort flags, column-selection flag,
aggregation --summary flag, --format csv).
ADR-0166 covers Phase 2 M6.7.zz.tenant.opt-out.cli.mutate
(`crossengin retention opt-out` / `opt-in` mutation
actions — closes ADR-0160 Q5 + ADR-0161 Q4 + ADR-0162 Q4;
two new adapter methods on PostgresTraceRetention —
setTenantOptOut takes {tenantId, tableName, retentionDays?,
optOutUntil?, optOutReason?} and uses single-query INSERT
... ON CONFLICT (tenant_id, table_name) DO UPDATE atomic
upsert eliminating race window of two-query SELECT-then-
INSERT-or-UPDATE; sets enabled=false + opt_out=true
unconditionally; on conflict PRESERVES retention_days
(omitted from UPDATE SET clause matching ADR-0160
placeholder semantic — operators flipping flag back and
forth shouldn't lose configured retention), sets
opt_out_reason + opt_out_until from EXCLUDED.* (new values
including NULL when not provided); new rows get
retention_days=365 default or operator-provided; validates
retentionDays as integer >= 1 at adapter boundary (clearer
than DB CHECK violation); throws on empty RETURNING (defensive
against unexpected mutation failures); clearTenantOptOut
takes {tenantId, tableName} and uses single UPDATE ...
WHERE tenant_id=$1 AND table_name=$2 AND opt_out=true SET
opt_out=false, opt_out_until=NULL, updated_at=now();
PRESERVES opt_out_reason (omitted from UPDATE SET clause)
per ADR-0161 historical context preservation — lifting
opt-out keeps audit signal 'this tenant was opted out
previously due to X'; AND opt_out=true guard prevents
accidentally clearing fields on non-opt-out rows; returns
null when no matching opt-out row exists (idempotent — re-
runnable in CI/Inngest without errors); two new CLI
actions wrap the adapter methods; opt-out validates
positional tenant + table args (exit 2 missing), --until
parses via Date.parse and normalises to canonical ISO 8601
(operators pass "2027-01-01" and get
"2027-01-01T00:00:00.000Z" stored), --reason length 1..256
(matches DB CHECK), --retention-days integer >= 1, all
invalid-flag cases exit 2 with clear messages; opt-in
validates positional args only; action verbs chosen over
set-opt-out/clear-opt-out for natural English matching
operator vocabulary; sit under retention subcommand so
full command (crossengin retention opt-out ...) carries
context making opt-out alone unambiguous; human output
via shared formatPolicyChange(action, policy) renders
verb header (Tenant opted out: <uuid> / <table>) +
retention_days + enabled + opt_out + conditional Until
(renders 'indefinite' for null on opt-out variant, omitted
for opt-in with null until — avoids printing
'Until: null') + conditional Reason (omitted when null);
JSON output emits envelope {action, policy:
TenantRetentionPolicyRow | null} where null policy is the
idempotent-no-op signal on opt-in against non-opt-out
tenant; use cases unblocked — one-command legal hold
(opt-out --until --reason), one-command lift (idempotent),
extend (re-pass same reason, --until overwrites via
EXCLUDED), bulk via shell loops, compliance cleanup
combining expiring + opt-in via jq pipe; rejected
alternatives — single retention set --opt-out=true|false
(verbose, less natural), auto-clear opt_out_reason on
opt-in (contradicts ADR-0161), DELETE on opt-in (destroys
retention_days + reason audit), mandatory --reason
(operators may record before fully scoped during incident
response), --clear-reason / --clear-until magic flags
(workflow chains opt-in+opt-out already), specialised
adapter helpers extendOptOut/changeReason (general method
covers), two-query SELECT-then-INSERT-or-UPDATE (race
window), validate --until against future-date (operators
legitimately pass past dates for backfill/testing); 16
new adapter tests in trace-retention.test.ts covering
INSERT ... ON CONFLICT shape, parameter threading, default
365/null/null, returns camelCase, UPDATE excludes
retention_days, UPDATE uses EXCLUDED.opt_out_reason +
EXCLUDED.opt_out_until, rejects retentionDays < 1, rejects
non-integer, throws on empty RETURNING, clearTenantOptOut
UPDATE shape sets opt_out=false + opt_out_until=NULL,
preserves opt_out_reason (not in clause), returns camelCase,
returns null when no row, WHERE filters opt_out=true,
threads params; 27 new CLI tests covering missing tenant/
table exit 2 for both opt-out + opt-in, default flag
threading, --until/--reason/--retention-days threading,
ISO 8601 normalisation, invalid --until / empty --reason
/ oversized --reason / non-integer --retention-days /
zero --retention-days all exit 2, human output renders
policy change, JSON envelope shape, adapter errors
propagate exit 1, opt-in idempotent no-op message + null
policy in JSON, formatPolicyChange action verb in header,
tenantId + tableName in header, indefinite for null until
on opt-out, ISO timestamp for explicit until, omits Until
line on opt-in with null, renders reason when set, omits
Reason line when null; cli.ts helpText extended with
retention opt-out + opt-in usage lines + --until/--reason/
--retention-days flag docs; future Qs cover actor
attribution opt_out_set_by/opt_out_set_at columns,
append-only history META_TENANT_RETENTION_OPT_OUT_HISTORY
table, --dry-run flag, bulk action, confirmation prompt
for destructive actions, bulk opt-in --expired convenience,
sibling retention set action for non-opt-out per-tenant
policies).
ADR-0165 covers Phase 2 M6.7.zz.tenant.opt-out.cli.effective
(`crossengin retention effective <tenant-id> <table-name>`
CLI action — closes ADR-0159 Q5; wraps the ADR-0159
effectiveRetention resolver one-for-one with a discriminated-
union-aware output renderer; positional args
<tenant-id> <table-name> match sessions show <id> + gateway
routes unregister <id> patterns rather than --tenant/--table
flags (verbose for two required args); each of the 4
resolution variants renders distinctly so operators see
the actual semantic at a glance — source="tenant" prints
"Tenant override (active)" with retention days + enabled,
source="tenant_opt_out" prints "Tenant opt-out (active)"
with optOutUntil (or "indefinite" for null) + optOutReason
(or "<no reason>" for null — same convention as ADR-0164
expiring action), source="platform" prints "Platform
default" with retention days + enabled flag,
source="none" prints "No policy configured"; platform +
none variants don't carry tenantId from resolver (platform
policy is platform-wide), so queried tenantId from CLI
arg is rendered for context keeping output self-contained;
JSON output emits the full discriminated union unchanged
inside envelope {tenantId, tableName, resolution} so
downstream consumers (jq pipes, dashboards, compliance
scripts) correlate multiple lookups even when individual
resolutions omit one field; validation — missing tenant
or table args return exit 2 with clear "missing arguments"
error; no table-name validation against META_PRUNABLE_TABLES
since resolver returns source="none" for unknown tables
(surfaces "No policy configured" with queried table name —
duplicate validation would just replicate resolver
behavior); no --clock flag for testing override (read-time
semantic, production uses Date.now via default constructor);
use cases unblocked — operator debugging "why isn't tenant
X getting custom retention?" (CLI prints Platform default
→ operator queries DB sees enabled=false or
opt_out_until past), compliance audit "is tenant X in
active legal hold?" (one-line jq pipe |
.resolution.source returns "tenant_opt_out"), tier
migration verification (shell loop across tables verifies
consistency), dashboard tooltip integration (web UI
renders badge directly from JSON); rejected alternatives
— flat positional args with --tenant/--table flags
(verbose for two required args), default to all tables
when name omitted (pattern inconsistency with sessions
show), print raw struct field-by-field (operators have
to mentally decode source="tenant_opt_out" — variant-
aware rendering surfaces semantic immediately),
CSV/TSV output format (defer to global --format csv),
retention effective <tenant> returning all tables
(bulk mode deserves own action), auto-fill table to
default like workflow_traces (likely typo; failing fast
clearer); 16 new tests in retention.test.ts — missing
tenant returns exit 2, missing table returns exit 2,
threads tenantId+tableName through to resolver, human-
format renders source=tenant with retention days + tenant,
source=tenant_opt_out with reason + until, source=tenant_opt_out
with "indefinite" when optOutUntil null, source=platform
with Enabled:yes, source=platform with Enabled:no when
disabled, source=none with "No policy configured", JSON
emits structured envelope with full resolution, propagates
resolver errors as exit 1, formatEffectiveResolution
source=tenant uses resolution.tenantId not query arg,
source=platform uses queried tenantId since resolution
lacks one, source=none uses queried tenantId, source=
tenant_opt_out renders "indefinite" for null optOutUntil,
source=tenant_opt_out renders "<no reason>" for null
optOutReason; cli.ts helpText extended with retention
effective <tenant-id> <table-name> usage line + brief
description of the 4-variant resolution semantics; future
Qs cover --all-tables bulk lookup pairing with deferred
effectiveRetentionBatch resolver from ADR-0159 Q2,
--explain flag for diagnostics surfacing raw row state
when resolver falls through to platform, --at-time
history flag pairing with deferred history substrate
from ADR-0162 Q3, exit code by source --exit-on none
for CI gates, sibling mutation actions retention opt-out/
opt-in/list-policies closing M6.7.zz.tenant.opt-out.cli.mutate
deferred milestone, comparison query retention diff
<tenant-a> <tenant-b> <table> for tier migration
verification).
ADR-0164 covers Phase 2 M6.7.zz.tenant.opt-out.cli
(`crossengin retention expiring [--within-days N]
[--include-expired]` CLI subcommand — closes ADR-0163 Q4;
new top-level `retention` subcommand added to SUBCOMMANDS
list in apps/architect-cli/src/cli.ts; first action
`expiring` follows the established sessions/gateway-routes
action-verb pattern (top-level subcommand → action verb
→ flags) rather than flat `crossengin retention-expiring`
because (1) operators don't have to remember which
subcommands are flat vs nested, (2) reserves namespace
for future actions retention effective/opt-out/opt-in/
list-policies, (3) help text groups related actions
together; defaults — --within-days=30 (matches monthly
review cadence, most common workflow), --include-expired=false
(upcoming-window query is the default, expired cleanup
is a distinct audit), --format=human (workspace standard);
human output renders a table with daysUntilExpiry as 'Nd'
for future / 'EXPIRED Nd ago' for negative + tenant +
table + reason (with '<no reason>' placeholder when null
giving operators an immediate signal that audit context
from ADR-0161 is missing); empty result prints clear
'no opt-outs ...' message with day count; --include-expired
empty uses 'expired or expiring' wording; JSON output
emits structured envelope {withinDays, includeExpired,
count, results} so downstream consumers (cron jobs,
alerting systems, spreadsheet exports) pipe through jq;
validation at CLI boundary mirrors resolver — --within-days
must parse as Number.isFinite() && >= 0, rejects negative
/ NaN / non-numeric with exit code 2 and clear error
message before any PG connection attempt; PG env required
(PGHOST/PGDATABASE/...) matching sessions/gateway-routes
patterns; new RetentionContext extends RunContext with
retentionOverride?: PostgresTraceRetention field for
test injection avoiding real DB connections; use cases
unblocked — daily cron retention-alerts (crossengin
retention expiring --format json | jq | send-slack),
pre-flight checks before weekly compliance meetings,
quarterly audit reports (--within-days 365 --include-expired
--format json > audit.json), CI alert gates (count >0
means alert needed); rejected alternatives — flat
subcommand crossengin retention-expiring (breaks pattern),
action under sessions/gateway (retention is its own
substrate concern), default within-days=7 (too aggressive,
30 matches monthly cadence), default include-expired=true
(upcoming-window is the default), built-in Slack/email
delivery (couples substrates, operators wire via
notification provider), filter flags --table/--tenant-id/
--reason-pattern (keep surface minimal, jq covers filter
on JSON for now), pagination/--limit (opt-out count
bounded in practice), wrap Inngest job definition
(operators have different schedulers — CLI stays
scheduler-agnostic); 20 new tests in retention.test.ts —
missing action returns exit 2, unknown action returns
exit 2, missing PG env returns exit 1, default within-days
+ includeExpired threaded to resolver, --within-days
threads through, --include-expired threads through,
negative --within-days returns exit 2 with clear error,
non-numeric --within-days returns exit 2, human empty-result
success message includes day count, --include-expired empty
wording is 'expired or expiring', human table renders
results with tenant + table + reason, JSON emits structured
envelope with all flags + count + results array, JSON
envelope includes both flags reflected in output, resolver
errors propagate as exit 1 with clear message,
formatExpiringTable renders positive days as 'Nd', renders
negative as 'EXPIRED Nd ago', renders <no reason> for null
optOutReason, renders actual reason when set, uses 'expired
or expiring' header when includeExpired=true, uses
'expiring' header when false; cli.test.ts SUBCOMMANDS
test updated to include 'retention' in expected list;
helpText extended with new retention expiring usage line
+ --within-days N + --include-expired flag docs; binary
dispatcher in apps/architect-cli/bin/crossengin.ts
imports runRetention and adds case 'retention' to switch;
future Qs cover sibling actions (effective, opt-out,
opt-in, list-policies — each a thin wrapper over an
existing resolver method, mechanically derivable from
this template), --tenant-id and --table filter flags
(deferred — jq covers it), --exit-on-found CI gate flag
(useful for "fail build if any opt-out expires <1d"),
--sort output ordering, CSV output format (JSON + jq
covers), verbose debugging flag).
ADR-0163 covers Phase 2 M6.7.zz.tenant.opt-out.alerts
(expiringOptOuts resolver method on PostgresTraceRetention —
closes ADR-0162 Q2; method signature expiringOptOuts({
withinDays: number, includeExpired?: boolean}):
Promise<ExpiringOptOut[]> where ExpiringOptOut = {tenantId,
tableName, optOutUntil (ISO 8601 always non-null since
NULL opt-outs are excluded — indefinite by definition no
expiry to alert on), optOutReason (string | null),
daysUntilExpiry (float, positive future / negative
expired)}; semantic — matches rows where opt_out_until
<= clock() + withinDays * 86400000; includeExpired=false
default additionally requires opt_out_until > clock();
sorted by opt_out_until ASC soonest first; pain solved —
no advance warning before opt_out auto-lift, legal teams
need extension lead time, compliance reviewers need notice,
operations need pruning prep window, customer success
needs to inform customer of contractual retention change;
without query surface operators wrote ad-hoc SQL, forgot
to run it, missed lead time; substrate stays passive
(query surface not active push) so coupling between
retention + notification substrates avoided + operators
choose notification provider; one method covers three
workflows — "what expires soon?" (withinDays=30 +
includeExpired=false), "what's already expired?"
(withinDays=0 + includeExpired=true), "everything time-
bound in next year" (withinDays=365 + includeExpired=true);
daysUntilExpiry pre-computed from injected clock since
substrate has authoritative clock (eliminates off-by-one
bugs from operators re-implementing diff with their own
timezone handling); float precision preserved so operators
bucket precisely 1d/7d/30d urgency tiers; validation —
withinDays must be finite >= 0 (rejects negative,
Infinity, NaN at API boundary with clear error);
excludes opt_out=false (not opted out) and opt_out_until
IS NULL (indefinite); returns empty array on no matches;
rejected alternatives — active push via
@crossengin/notifications (couples substrates, scheduling
logic at wrong layer, operator notification provider
choice varies), PG NOTIFY trigger (hidden behavior, no
good 30-days-before event-time expression, requires
LISTEN client process), materialized view (refresh
schedule complexity, query fast on indexed column),
separate upcomingOptOuts + expiredOptOuts methods
(broad audit needs would call both — parameterized
composable), tier bucketing in API (prescriptive —
operator tier definitions vary 60/30/14/7 vs 30/7),
stateful alert tracking substrate-side (couples retention
to alert delivery — dedup belongs at notification layer),
return raw rows without daysUntilExpiry (re-implementing
diff per dashboard), cursor pagination (opt-outs bounded
in practice — add if measured); no new schema, pure
read-side method on existing table; clock source — adapter
uses injected clock() throughout including cutoffMs
parameter, NOT PG now() (unlike prune-side NOT IN subquery
from ADR-0162) because operator-side scheduling drives
test determinism via clock injection; 15 new tests in
trace-retention.test.ts: returns opt-outs within window
with daysUntilExpiry computed, SQL excludes already-expired
by default, SQL includes already-expired when flag true,
daysUntilExpiry negative for expired rows when included,
SQL filters opt_out=true AND opt_out_until IS NOT NULL,
ORDER BY opt_out_until ASC enforced, withinDays=0 +
includeExpired=false returns empty (strict window),
withinDays=0 + includeExpired=true returns all expired,
withinDays<0 throws with clear error, withinDays=Infinity
throws, withinDays=NaN throws, empty result returns empty
array, threads optOutReason from row to result, threads
null optOutReason when not set, supports tiered alert
windows via daysUntilExpiry float precision (urgent/week/
month buckets in app code); future Qs cover partial index
on opt_out_until WHERE opt_out=true if measured slow,
cursor pagination, alert state tracking table for cross-
run dedup, CLI exposure via `crossengin retention expiring
--within-days N --include-expired`, webhook delivery
convenience wrapper, per-tier convenience method,
"recently lifted" reverse query for missed-notification
audits, channel-specific integrations remain in
@crossengin/notifications substrate scope).
ADR-0162 covers Phase 2 M6.7.zz.tenant.opt-out.expiry
(opt_out_until TIMESTAMPTZ NULLABLE column with read-time
expiry semantics — closes ADR-0160 Q2; adds opt_out_until
to META_TENANT_RETENTION_POLICIES with no CHECK on the
date value itself — operators set whatever absolute
timestamp they want, substrate doesn't prescribe past-vs-
future; semantic — opt_out=true + opt_out_until=NULL is
indefinite, opt_out=true + opt_out_until > now is active,
opt_out=true + opt_out_until <= now is expired (functionally
equivalent to opt_out=false for read/prune semantics, row
persists as audit trail); expired rows NOT auto-deleted —
operators query WHERE opt_out=true AND opt_out_until < now
to find expired rows and decide to clear/extend/convert;
pain solved — forgotten opt-outs (operator flips for 6-month
hold and forgets to lift, substrate now auto-lifts), legal
holds with known end dates (operators record exact date,
substrate honors it), audit reports showing expired-as-active
(no longer happens), compliance theater (data persists past
legal end-of-hold creating worse posture); EffectiveRetentionResolution
tenant_opt_out variant gains required optOutUntil: string |
null field — resolver only emits tenant_opt_out when active,
expired falls through to enabled check (false per CHECK
from ADR-0160) then to platform-default — self-healing at
expiry instant; new status skipped_opt_out_expired added to
RetentionRunStatus + RetentionPreviewStatus enums; per-tenant
iteration picks status active ? skipped_opt_out : skipped_opt_out_expired
so operators see expirations distinct from genuine disable;
platform-default DELETE + previewPrune COUNT NOT IN subqueries
widen from (enabled OR opt_out) to (enabled OR (opt_out
AND (opt_out_until IS NULL OR opt_out_until > now()))) —
expired opt-outs NOT excluded so platform sweep covers
their data; two clock sources by design — adapter uses
injected clock for testability (clock injection pattern
established in PostgresLatencyTracker etc.), SQL uses PG
now() to avoid parameter-shape changes; sub-second drift
acceptable for day-grained retention; operators NTP-sync;
boundary case opt_out_until == clock now treated as expired
(strict > comparison); schema choices — NULLABLE since most
opt-outs are indefinite, no CHECK on date value (> created_at
forces future-dated, > now() nonsensical at INSERT-only),
no CHECK tying to opt_out=true (operators may pre-stage
expiry before flipping flag); rejected alternatives —
TIMESTAMP not TIMESTAMPTZ (timezone ambiguity), PG trigger
auto-clearing opt_out (destroys historical audit signal +
complexity), INTERVAL duration not absolute endpoint
(relative-to-what ambiguity), separate
meta.tenant_retention_opt_out_expirations table (joins
everywhere), opt_out_indefinite BOOLEAN companion (NULL
already encodes no expiry), overloading last_pruned_at
(path to bugs), PG-side-only resolution (kills testability);
13 new tests: opt_out + null until is indefinite, opt_out
+ future until is active with optOutUntil populated, opt_out
+ past until is expired with skipped_opt_out_expired + NO
DELETE for tenant, boundary opt_out_until == clock treated
as expired, previewPrune surfaces skipped_opt_out_expired,
listTenantPolicies SELECT includes opt_out_until,
listTenantPolicies maps to optOutUntil camelCase,
effectiveRetention tenant_opt_out variant populates
optOutUntil, expired opt-out falls through to platform when
policy exists, expired + no platform returns none, null
until treated as indefinite/active, clock injection drives
expiry decision (same row resolves differently across
clocks), effectiveRetention SELECT includes opt_out_until;
future Qs cover auto-cleanup periodic job for stale
expired rows, expiry notifications via @crossengin/notifications,
set-at timestamp opt_out_until_set_at for audit, CLI
exposure via --until flag, per-table vs all-table opt-outs,
race semantics at exact expiry instant documented, history-
aware queries via append-only history table).
ADR-0161 covers Phase 2 M6.7.zz.tenant.opt-out.reason
(opt_out_reason TEXT NULLABLE audit context column —
closes ADR-0160 Q1; adds opt_out_reason TEXT to
META_TENANT_RETENTION_POLICIES with length CHECK
"opt_out_reason IS NULL OR (char_length(opt_out_reason)
BETWEEN 1 AND 256)" — nullable not NOT NULL since most
rows have opt_out=false and need no reason, operators
backfilling pre-existing rows leave NULL, forward-compat
tightening to NOT NULL after backfill period is easier
than relaxing; pain solved — audit blind spot "why is
tenant X opted out?" without hunting tickets/Slack/lawyer
emails, onboarding handoff (institutional knowledge
leaves with departing ops), compliance dashboards
asking "show every deviation with documented reason",
per-reason metrics "how many legal holds active?";
threading — TenantRetentionPolicyRow gains optOutReason
on listTenantPolicies, RetentionRunResult +
RetentionPreviewResult gain optional optOutReason
populated when status="skipped_opt_out",
EffectiveRetentionResolution.tenant_opt_out variant
gains required optOutReason: string | null field;
listTenantPolicies + effectiveRetention SELECTs both
include opt_out_reason column; DELETE/UPDATE/COUNT
queries unchanged — reason is purely informational
read-path; no CHECK tying reason to opt_out state because
historical context preservation (operators may keep
reason after lifting opt_out as "this tenant WAS opted
out due to X" audit history), staged opt-outs (legal
team writes reason during contract review, ops flips
opt_out after sign-off), simplicity — substrate doesn't
enforce semantic alignment between informational columns;
length [1, 256] — lower 1 prevents empty strings
(ambiguous no-reason vs empty-string-reason), upper 256
caps storage + forces concise classifiers; no pattern
constraint — operator-defined taxonomies vary (structured
"legal_hold:case#42" vs free-form "Subpoena from SEC,
see ticket #12345"), adding pattern later is non-
breaking but removing is breaking; rejected alternatives
— separate audit table meta.tenant_retention_opt_out_history
(invasive trigger-based, defer to unified policy-change
audit log milestone), JSONB reason for structured
metadata (overkill, harder simple-category queries),
NOT NULL with empty-string default (semantic ambiguity),
pattern enforcement slug-only (prescribes structure
operators may not want), typed enum opt_out_kind
(taxonomies vary by company); 8 new tests:
listTenantPolicies SELECT includes opt_out_reason column,
listTenantPolicies maps to optOutReason camelCase field,
prune threads optOutReason into skipped_opt_out result,
prune threads null when no reason set, previewPrune
threads optOutReason, effectiveRetention threads into
tenant_opt_out variant, effectiveRetention returns null
when no reason set, effectiveRetention SELECT includes
opt_out_reason; future Qs cover reason expiry/freshness
tracking via opt_out_reason_set_at column, actor
attribution via opt_out_set_by UUID, reason categories
companion table for taxonomies, CLI exposure via
--reason flag, i18n translation in reporting layer,
constraint tightening to require reason when
opt_out=true after backfill period).
ADR-0160 covers Phase 2 M6.7.zz.tenant.opt-out
(per-tenant retention opt_out flag — closes ADR-0159 Q1;
adds opt_out BOOLEAN NOT NULL DEFAULT false column to
META_TENANT_RETENTION_POLICIES with cross-column CHECK
constraint `NOT (enabled = true AND opt_out = true)`
rejecting contradictory state at INSERT/UPDATE; existing
enabled=false semantic was overloaded — meant both "use
this override" and "fall back to platform"; real
compliance scenarios need a distinct semantic where opt-out
tenants have NO data pruned regardless of platform default;
use cases unblocked — legal hold tenants under litigation/
subpoena/audit, 21 CFR Part 11 clinical trials with
"retain until manually purged" requirements, VIP/enterprise
contracts stipulating "retain until customer requests
deletion"; encoding scheme — opt-out = enabled:false +
opt_out:true, active policy = enabled:true + opt_out:false,
fallback-to-platform = enabled:false + opt_out:false;
contradictory enabled:true + opt_out:true rejected by
CHECK; EffectiveRetentionResolution discriminated union
grows from 3 to 4 variants with new tenant_opt_out
(retentionDays:null + enabled:false + tenantId);
resolution algorithm extended — tenant row found with
opt_out:true wins (skip platform query, highest priority),
else enabled:true returns tenant variant, else fall to
platform; retention_days stays NOT NULL with CHECK >= 1
even for opt-out rows — column stores placeholder
(typically previously-configured value) so flipping
opt_out back to false restores prior policy without
re-prompting operators; resolver's tenant_opt_out variant
returns retentionDays:null because semantically there IS
no retention applied — emitting placeholder would mislead
consumers; prune semantics extended — per-tenant loop
gains opt-out branch BEFORE enabled check;
RetentionRunStatus + RetentionPreviewStatus enums gain
"skipped_opt_out"; platform-default DELETE NOT IN
subquery widened from `enabled = true` to `(enabled = true
OR opt_out = true)` so opt-out tenants excluded from
platform pruning too; same widening in previewPrune COUNT
subquery; backward compatible additive schema — existing
rows get opt_out=false by default, no migration friction;
three rejected alternatives — retention_days = -1 sentinel
(overloads numeric semantics + breaks CHECK >= 1),
NULLABLE retention_days (operators lose placeholder when
toggling), replace enabled with policy_state TEXT enum
(breaking schema migration); rejected leaving CHECK off
(adapter could prefer opt_out and silently ignore enabled
but DB-side constraint catches inconsistent state at
INSERT/UPDATE before adapter sees row); 9 new tests:
prune skipped_opt_out + no DELETE for opt-out tenant,
opt_out precedence over enabled, platform DELETE NOT IN
subquery extended verified, previewPrune skipped_opt_out
+ no COUNT for opt-out tenant, previewPrune platform
COUNT NOT IN extended, disabled-and-not-opt-out tenant
still falls back to platform (M6.7.zz.tenant baseline
preserved), effectiveRetention returns tenant_opt_out,
opt_out precedence over platform fallback verified,
TypeScript discriminated union narrowing on
source='tenant_opt_out' asserting retentionDays:null +
tenantId:string + enabled:false; future Qs cover opt_out
reason field for audit context, opt_out_until expiry
column for time-bound holds, opt-out impact on retention
dashboard alerts, CLI exposure via `crossengin retention
opt-out` subcommand, tenant-initiated opt-out via API
endpoint).
ADR-0157 covers Phase 2 M6.8.x.trace
(`ceiling_resolved` RouterInstrumentation event +
getTenantCostCeilingDetailed callback — closes ADR-0154 Q1;
ROUTER_INSTRUMENTATION_KINDS grows 6→7 with ceiling_resolved
at slot 7; new optional callback getTenantCostCeilingDetailed?:
(tenantId) => Promise<CostCeilingResolution> for full source
attribution — detailed callback takes PRECEDENCE over the
legacy basic getTenantCostCeiling when both wired; new
CostCeilingResolution + CostCeilingSource types in
@crossengin/ai-router/cost-tracker.ts with router-side enum
widening to include "global" (resolver-side enum only emits
override|tier|none, router adds global for costCeiling
fallback); resolution precedence walks 4 levels detailed →
basic → global → none; legacy basic callback degrades to
source="override" (router can't disambiguate from tier
without detailed shape); detailed returning source="none"
falls back to router-level global; event fires BEFORE the
ceiling check so audit signal survives even when
CostCeilingExceededError throws — critical for debugging
blocked requests; event attributes use TypeScript
discriminated-union pattern (source + hasCeiling always
present, ceiling/tierId conditional); wire ordering
ceiling_resolved → llm_call_started → llm_call_completed
matches enforceCeilingPreflight's logical position;
META_LLM_CALL_TRACES.kind CHECK constraint extended
additively — no migration; three operator workflows
unblocked — compliance audit dashboards, tier migration
verification, forensic reconstruction of blocked requests;
PostgresRouterInstrumentation handles the new kind
transparently since wire format unchanged; embed() doesn't
emit ceiling_resolved yet — separate milestone needed to
add ceiling enforcement to the embed path; no breaking
change — existing callers without instrumentation, with
basic-only callback, or with no callback continue working
identically).
ADR-0156 covers Phase 2 M8.2 (Workflow runtime
timer_set + timer_cancelled instrumentation —
WORKFLOW_INSTRUMENTATION_KINDS grows 14→16 additively with
timer_set at slot 8 before timer_fired and timer_cancelled
at slot 10 after; applyScheduleTimer in engine.ts emits
timer_set BEFORE the timer_scheduled event-log append
matching M8.1's activity_started instrumentation-first
ordering — captures intent even if persistence fails;
attributes {timerId, timerName, fireAt, relativeSeconds};
the SAME timerId flows into both the instrumentation event
AND the subsequent event-log entry so operators correlate
set-to-fire latency via attributes.timerId;
META_WORKFLOW_TRACES.kind CHECK constraint extended
ADDITIVELY — no migration for pre-existing data; KEY
NUANCE: timer_cancelled is kind-defined + CHECK-allowed
but NOT YET EMITTED — the engine's cancel_timer action
handler throws "not implemented in M3" so no code path
produces cancellation events; reserving the kind now
enables the future cancel_timer milestone to land without
a schema migration; naming choice timer_set (not
timer_scheduled) deliberately disambiguates from the
event-log kind which represents persistence — different
surfaces different consumers — and the verb pair
timer_set/timer_fired/timer_cancelled mirrors operator
language; three operator workflows unblocked — timer
creation throughput, set-to-fire latency dashboards via
SQL JOIN on attributes.timerId, compliance audit;
instrumentation never crashes engine same error-swallowing
pattern as M8; no new transport, no new dependency, no
breaking change; PostgresWorkflowInstrumentation handles
new kinds transparently since wire format unchanged).
ADR-0155 covers Phase 2 M6.7.zz.tenant
(META_TENANT_RETENTION_POLICIES per-tenant retention
overrides — closes ADR-0143 Q1; 128th meta-schema table
with PK on (tenant_id, table_name) + RLS + table_name
CHECK limited to workflow_traces + llm_call_traces (NOT
llm_latency_samples since that table has no tenant_id
column); two-table design chosen over the NULLABLE-tenant_id
alternative from the original ADR-0143 Q1 sketch — PG-
version-portable without NULLS NOT DISTINCT requirement,
matches META_LLM_TENANT_TIER_MEMBERSHIPS pattern, cleaner
PK semantics; PostgresTraceRetention extended with
listTenantPolicies + refactored prune/previewPrune that
iterate tenant policies FIRST then platform-default with
NOT IN subquery exclusion in the platform-default DELETE
to skip tenants with overrides; correctly handles BOTH
SHORTER and LONGER per-tenant retention (critical for
compliance scenarios where tenants need to retain longer
than platform default); disabled per-tenant policies fall
back to platform-default via the enabled=true subquery
filter; result types gain optional tenantId field —
operators discriminate per-tenant from platform results;
no data migration — existing META_RETENTION_POLICIES rows
continue working unchanged with empty NOT IN subquery;
operator workflows unlocked: long-tail compliance, cost-
shaping per tenant, GDPR Article 17 acceleration, A/B
retention testing).
ADR-0154 covers Phase 2 M6.8.x
(PostgresCostCeilingResolver.resolveDetailed source attribution
— closes ADR-0144 Q2 + ADR-0137 Q3+Q4 + ADR-0141 Q3 in one
milestone — four deferred Qs resolved by adding a structured
attribution method; resolve() refactored to delegate to
resolveDetailed() with zero duplication and identical behavior;
returns CostCeilingResolution with three fields: ceiling
(CostCeiling | undefined as before), source enum
"override" | "tier" | "none" as discriminated union, tierId
conditional string only when source === "tier"; tier query
gains ONE additive column (t.tier_id) — no schema change;
TypeScript discriminated union pattern lets operators
narrow on source === "tier" and get tierId as string; future
enhancement: a RouterInstrumentation event kind=
"ceiling_resolved" emitted automatically from
DefaultLlmRouter.enforceCeilingPreflight, building on this
synchronous foundation; rejected alternatives — emit event
instead of method (builds on this), separate getSourceFor
method (two queries), boolean flags (operators infer),
always-present tierId (redundant checks), include row
updated_at (operator queries tables directly), "global"
source value (resolver doesn't know router-level config);
operator pain solved: audit clarity (is tenant X's cap from
their tier or an override?), tier migration verification,
per-tenant policy debugging, dashboard reporting on tier
distribution).
ADR-0153 covers Phase 2 M6.7.zz.dry-run
(PostgresTraceRetention.previewPrune — closes ADR-0143 Q4;
adds previewPrune() to PostgresTraceRetention as the
read-only counterpart of prune(); operator workflow
preview → review → prune now first-class; pain solved:
first-run trepidation over millions of accumulated rows,
policy verification, dashboard reporting, CI safety gates;
implementation mirrors prune() step-by-step but uses SELECT
COUNT(*) instead of DELETE — read-only, no last_pruned_at
mutation; distinct RetentionPreviewResult type with
wouldDeleteCount field and "previewed" status enum value
prevents TypeScript-side mix-ups with prune; same allowlist
+ skip semantics + cutoff computation as prune (modulo
sub-second clock drift in production); PG BIGINT precision
via ::TEXT cast + Number() — same pattern as cost-ceiling
resolver + latency-tracker; alternatives rejected — dryRun
boolean parameter (code smell), reusing RetentionRunResult
(deletedCount field wrong on a preview), returning actual
rows (memory cost), EXPLAIN estimates (inaccurate); no
schema change, no new dependencies, pure code addition).
ADR-0152 covers Phase 2 M6.7.z.embed (RouterInstrumentation
extends to embed() path — closes ADR-0141 Q2; the
complete() path already emitted llm_call_started/completed/
failed (M6.7.z / ADR-0141); this milestone adds the symmetric
three embed_call_* kinds; ROUTER_INSTRUMENTATION_KINDS grows
3 → 6 additively (existing kinds preserved);
META_LLM_CALL_TRACES.kind CHECK constraint extended to allow
the new values with NO migration needed for pre-existing data;
DefaultLlmRouter.embed() now wires onEvent calls per
attempt mirroring complete() lifecycle — started before
fetch with attemptIndex/totalChoices/inputTextCount,
completed on success with costUsd/tokens/vectorCount/dim/
attempts=1, failed per-provider with errorKind/errorMessage/
willFallback; attempts always 1 because embed() doesn't
retry-within-provider unlike complete() which wraps in
withRetry; fallover produces additional embed_call_started
events for the next provider so operators count attempts
via embed_call_started count with correlation window;
sessionId handling — EmbeddingRequest.sessionId is optional
unlike CompletionRequest so embed events default to empty
string when not provided (alternatives nullable-schema +
sentinel rejected for migration-free simplicity); task
hardcoded to "embedding" on every embed event for dashboard
filtering separation from complete; same interface as
llm_call_* events with kind-discriminator — PG adapter
handles new kinds transparently since wire format unchanged;
three operator workflows unblocked: cost attribution for
embedding-heavy apps (RAG ingest, semantic search), failure
diagnosis for embedding model rollouts, provider comparison
for embedding latency; no breaking change — existing
complete-only callers unaffected, new embed events only
flow when embed() is called).
ADR-0151 covers Phase 2 M2.X.5.aa.z.30 (Bedrock foundation
model discovery — getFoundationModel + listFoundationModels
read-only surfaces; operators feeding CREATE endpoints need
to know which foundation models are available, what they
support, and which regions expose them; without substrate-
side discovery operators drop to AWS Console or hard-coded
model IDs that drift as AWS releases/deprecates models;
new foundation-models-api.ts with types + builders + parsers
mirroring inference-profiles + PT-inspection URI shapes;
4 enums: Modality (TEXT/IMAGE/EMBEDDING), Customization
(FINE_TUNING/CONTINUED_PRE_TRAINING/DISTILLATION),
InferenceType (ON_DEMAND/PROVISIONED), LifecycleStatus
(ACTIVE/LEGACY); 4 list filters: byCustomizationType,
byInferenceType, byOutputModality, byProvider; no
pagination from AWS — small model catalog per region;
TYPE-ALIAS Detail=Summary pattern since AWS returns same
fields (vs ADR-0116/0123 extended-shape pattern);
parseFoundationModelDetail defensively unwraps AWS's
{modelDetails: {...}} envelope; strict enum validation on
parser responses — unknown values surface as api_error so
undocumented AWS additions fail loudly; all optional fields
preserved conditionally — no silent default injection;
discovery workflows now first-class: PT creation more
reliable, inference-profile creation more reliable, legacy-
model awareness via modelLifecycle.status === LEGACY for
migration planning; no new transport — reuses
signedControlPlaneGet; Bedrock control plane now has 22
read + 2 stop + 3 create + 5 delete + 3 tag + 2 update =
37 operations).
ADR-0150 covers Phase 2 M2.X.5.aa.z.29 (Bedrock
deleteProvisionedModelThroughput — closes ADR-0147 Q3 +
ADR-0148 Q2 + ADR-0149 Q1 in one milestone; PT lifecycle
4/4 COMPLETE on substrate (create + read + update + delete
all shipped); single DELETE endpoint with simple wire shape
/provisioned-model-throughput/{id} (singular matching
create + update; LIST/GET use plural); reuses
signedControlPlaneDelete transport from ADR-0136 — no new
infrastructure; NO pre-flight GET guard since PTs are
always operator-owned (no SYSTEM-vs-APPLICATION
distinction); NO mandatory clientRequestToken (delete
doesn't create resources, AWS doesn't expose token on
delete); the interesting AWS-side semantic is 409
ConflictException specifically when deleting a COMMITTED PT
mid-commitment (one-month or six-month lock-in not yet
expired) — substrate propagates verbatim as conflict_error
with code=ConflictException; operators handle the workflow
(wait it out, accept the cost, or convert via update —
substrate doesn't try to be clever since AWS rejects
substrate-side "force" anyway); caller-decided idempotency
via isNotFoundError predicate same pattern as ADR-0136
delete family; reconciliation workflow now full-cycle: list
→ filter on-demand → delete each → handle 409 on committed
→ schedule expiry retry; Bedrock control plane now has 20
read + 2 stop + 3 create + 5 delete + 3 tag + 2 update =
35 operations; ADR-0150 marks the 150-ADR milestone since
project bootstrap, 124 of them Phase 2 ADR-0047 onward).
ADR-0149 covers Phase 2 M2.X.5.aa.z.28 (Bedrock
updateProvisionedModelThroughput — closes ADR-0147 Q2 +
ADR-0148 Q1; mid-life PT mutation for model migration OR
rename; AWS contract PATCH /provisioned-model-throughput/{id}
with optional desiredModelId + desiredProvisionedModelName,
at least one must be provided; reuses signedControlPlanePatch
transport from ADR-0146 — no new infrastructure;
ASYMMETRIC from create (ADR-0148) on clientRequestToken —
update doesn't mandate one because update doesn't create
new resources or extend commitments, PATCH is naturally
idempotent (same body twice = same end state), and AWS
doesn't expose the token on this endpoint anyway; NO
pre-flight GET guard since PTs are always operator-owned
(no SYSTEM-vs-APPLICATION distinction); PATCH semantics —
only provided fields update; modelUnits + commitmentDuration
NOT mutable via update (AWS doesn't expose them — operators
scale or convert commitment via delete + recreate); PT ARN
stable across migration so downstream InvokeModel calls
continue transparently; after PATCH the PT enters Updating
status with desiredModelArn = target while modelArn keeps
serving traffic until AWS atomically swaps; Bedrock control
plane now has 20 read + 2 stop + 3 create + 4 delete + 3
tag + 2 update = 34 operations; two updates on substrate
now: updateInferenceProfile + updateProvisionedModelThroughput;
PT lifecycle 3/4 complete — create + read + update shipped,
delete remains).
ADR-0148 covers Phase 2 M2.X.5.aa.z.27 (Bedrock
createProvisionedModelThroughput — closes ADR-0147 Q1; the
FIRST mutation on PT resources; clientRequestToken REQUIRED
in the substrate input type even though AWS docs make it
optional — contract upgrade asymmetric from the other CREATE
endpoints which keep it optional because PT cost weight is
100×-1000× higher (one-month committed PT ~$5K/month, six-
month committed ~$30K non-cancellable, on-demand ~$100/hour);
mandatory-token rule forces deliberate operator gesture
before AWS call — trivial for intentional creates (one-line
crypto.randomUUID()) prohibitive for casual ones (typescript
error if omitted); naturally retry-safe — operators store
token alongside intent and reuse on failure with AWS dedupe
server-side; no auto-token generation (defeats idempotency),
no substrate-side local dedup (trust AWS), no commitment
auto-default (operators must explicitly choose); pure
boundary validation across 6 documented constraints; modelUnits
substrate cap at 1000 defensive on top of AWS quota — operators
wanting more file a separate substrate change; tags work
cross-resource with M2.X.5.aa.z.24 post-creation; minimal
response (provisionedModelArn only) — operators wanting full
detail call getProvisionedModelThroughput next; no dryRun /
no status-polling — substrate is raw transport, polling
belongs in operator code; Bedrock control plane now has 20
read + 2 stop + 3 create + 4 delete + 3 tag + 1 update = 33
operations; PT mutation half-done — create shipped, update +
delete pair-able more easily now that safety pattern is
established).
ADR-0147 covers Phase 2 M2.X.5.aa.z.26 (Bedrock
provisioned-throughput inspection — getProvisionedModelThroughput
+ listProvisionedModelThroughputs read-only surfaces; PTs are
paid dedicated capacity (one-month ~$5K, six-month committed)
backing foundation or custom models; substrate previously had
zero PT visibility — cost dashboards couldn't project monthly
commitments, reconciliation couldn't find orphaned PTs leaking
$5K-$50K/month after custom-model decommissioning, incident
response dropped to AWS Console; this milestone closes those
gaps; mutation (create/update/delete) deliberately deferred —
PT cost per operation is 100×-1000× higher than inference
profiles needing careful idempotency + cost-confirmation
design; new provisioned-throughput-api.ts with types +
builders + parsers; AWS contract preserved verbatim with 4
statuses + 2 commitment durations + path-based URI mirroring
inference-profiles; THREE-ARN distinction surfaces clearly —
modelArn (current backing model) vs desiredModelArn (target
after pending update) vs foundationModelArn (foundation
behind any custom variants) — operators distinguish mid-
migration (modelArn !== desiredModelArn) from steady state;
detail extends summary with optional failureMessage (only
present when status === Failed) for incident-response
context; list filters across 8 dimensions (statusEquals,
modelArnEquals, nameContains, sortBy, sortOrder, maxResults,
nextToken); pure boundary validation pre-fetch; integer
validation on modelUnits guards against floating-point JSON
quirks; unknown-status surfaces as api_error so undocumented
AWS additions fail loudly; no new transport — reuses
signedControlPlaneGet; Bedrock control plane now has 20 read
+ 2 stop + 2 create + 4 delete + 3 tag + 1 update = 32
operations).
ADR-0146 covers Phase 2 M2.X.5.aa.z.25 (Bedrock
updateInferenceProfile PATCH with APPLICATION-only guard —
closes ADR-0142 Q1; first PATCH operation on the Bedrock
control plane; new signedControlPlanePatch transport mirrors
signedControlPlanePost with content-type application/json +
Sig v4 signing; updateInferenceProfile uses 4-step defensive
validation order — identifier-blank → input body builder
rejecting empty-input → pre-flight GET to read type field →
APPLICATION-only guard (NEVER issues PATCH on SYSTEM_DEFINED;
mirrors deleteInferenceProfile from ADR-0138); description-
only by design — tags have their own M2.X.5.aa.z.24 canonical
surface and wiring them here would create two paths to the
same outcome confusing operators; PATCH semantics not PUT —
only provided fields update; pre-flight cost 1 extra GET per
update acceptable for operator-workflow not hot-path; race
window between GET and PATCH propagates the PATCH-side 404
verbatim — same idempotency-via-isNotFoundError pattern as
delete; pattern reusable for future mutation surfaces;
operator gain: description drift on existing APPLICATION
profiles is now fixable in-place without delete-recreate
destroying the ARN and breaking downstream references; Bedrock
control plane now has 18 read + 2 stop + 2 create + 4 delete
+ 3 tag + 1 update = 30 operations; FULL APPLICATION
lifecycle on the substrate). ADR-0145 covers Phase 2
M2.X.5.aa.z.24 (Bedrock cross-
resource tagging — closes ADR-0142 Q2; first multi-resource
operations on the Bedrock substrate — tagResource +
untagResource + listTagsForResource work across every
Bedrock ARN with no URI templating per resource type; AWS
wire-shape asymmetry preserved verbatim — TagResource +
UntagResource carry resourceARN in the QUERY string while
ListTagsForResource carries resourceARN in the BODY (with
uppercase ARN per AWS docs); signedControlPlanePost extended
additively with optional query strings — existing callers
unaffected; pure boundary validation enforces 7 documented
constraints (resourceArn length+prefix, tag/tagKey count
[1, 200], tag key length+pattern, tag value length+pattern
where empty value is VALID per AWS contract); error messages
include the index of the bad tag entry for crisp debugging
on 200-tag batches; BedrockTag is the canonical cross-resource
shape with existing per-resource tag types preserved for self-
documenting CREATE method signatures; pattern set for future
cross-resource operations; Bedrock control plane now has 18
read + 2 stop + 2 create + 4 delete + 3 tag = 29 operations).
ADR-0144 covers Phase 2 M6.8 (META_LLM_COST_TIERS + per-
tenant tier memberships — closes ADR-0137 Q2; two new
meta-schema tables 126th+127th; META_LLM_COST_TIERS is
platform-wide no-RLS with tier_id PK (slug pattern
^[a-z0-9][a-z0-9_-]{0,63}$) + display_name + nullable
policy columns same M6.7.x NULL=unbounded semantics;
META_LLM_TENANT_TIER_MEMBERSHIPS is tenant-scoped RLS-
enabled with tenant_id PK (one tier per tenant — multi-
tier ambiguity blocked schema-side) + tier_id FK with
ON DELETE RESTRICT (forces deliberate migration on tier
deletion; CASCADE rejected as silent-strip footgun);
PostgresCostCeilingResolver extended with three-level
fallback per-tenant override → tier → global; each level
wins as whole-object preserving M6.7.x semantics; field-
merge alternative rejected because it would break NULL=
unbounded meaning; two PG round-trips worst case (no per-
tenant + no tier), one best case (per-tenant exists tier
skipped); JOIN-in-one-query alternative rejected for
forcing field-merge or cluttering SELECT with CASE WHEN
per column; operator workflow: define tiers once via INSERT
into llm_cost_tiers, link tenants via memberships, adjust
tier-wide policy via single UPDATE on tier row that takes
effect next request for every member; per-tenant overrides
remain via existing META_LLM_COST_CEILINGS taking precedence
over tier; future Qs cover resolution-source reporting,
effective-from history, non-cost tier policy bundles).
ADR-0143 covers Phase 2 M6.7.zz
(META_RETENTION_POLICIES + PostgresTraceRetention cross-
cutting retention substrate — closes ADR-0120 Q5 + ADR-0140
Q1 + ADR-0141 Q1 in one milestone; the three append-only
trace tables shipped over M8 + M6.7.y + M6.7.z now have a
unified retention story preventing unbounded growth at
~600MB/day per million LLM calls; META_RETENTION_POLICIES
as 125th meta-schema table — table_name PK with hardcoded
CHECK constraint enforcing allowlist (workflow_traces,
llm_latency_samples, llm_call_traces), retention_days CHECK
>= 1 (zero blocked since it would delete everything
immediately — disable via enabled column instead), enabled
kill switch, last_pruned_at NULLABLE audit field; platform-
wide table no tenant scoping no RLS — retention is platform-
policy concern (per-tenant retention listed as future Q);
PostgresTraceRetention adapter in `@crossengin/kernel-pg`
(most general home since it operates on meta-schema tables;
ai-router-pg would have created cross-package dependency for
workflow_traces); HARDCODED PRUNABLE_TABLES map in the
adapter prevents SQL injection (table+column names from
static map not row data) + keeps schema knowledge in code
(operators don't need to know recorded_at vs occurred_at) +
defense-in-depth via DB CHECK + adapter allowlist; prune()
is idempotent — re-runs find fewer rows; per-policy
autonomy — no outer transaction so one prune can succeed
while another fails; clock injection for testability;
adding a new trace table is a 2-edit mechanical change —
update CHECK constraint + add PRUNABLE_TABLES entry; per-
policy result returned with status enum (pruned /
skipped_disabled / skipped_unknown_table) + deletedCount +
cutoffMs; the three trace substrates are now operationally
sustainable).
When you ship a new package, write the matching ADR in the same
session, following `0000-template.md` and the style of the
existing 0026-0037 batch.
