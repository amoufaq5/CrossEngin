# ADR-0110: Bedrock getGuardrail with policy detail (Phase 2 M2.X.5.aa.z.8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0084 (M2.9.8 Bedrock Guardrails inference integration), ADR-0109 (M2.X.5.aa.z.7 listGuardrails) |

## Context

M2.X.5.aa.z.7 shipped `listGuardrails` returning shallow summaries (id, arn, status, name, version, createdAt, updatedAt, description). The summary is enough for auditing — "show me every guardrail" — but compliance teams need to see WHAT each guardrail blocks: which content filters, which topics, which PII entities, which regex patterns, what messaging surfaces on violations.

`GetGuardrail` is the AWS endpoint for this — same `bedrock.{region}.amazonaws.com` control-plane host, same sig v4 transport rail, but ~5x the response shape: 9 required top-level fields + 9 optional fields including FIVE nested policy types (contentPolicy, topicPolicy, wordPolicy, sensitiveInformationPolicy, contextualGroundingPolicy).

Demand surfaces in three workflows:

1. **Compliance disclosures.** "What does this guardrail actually block?" — required for SOC 2 / HIPAA / GDPR review.
2. **Drift between authoring and runtime.** Operator authored guardrail v3 in the AWS console; runtime config in their app points to v3; getGuardrail surfaces the exact policy bytes both teams should agree on.
3. **Multi-version comparison.** `GetGuardrail(id, v=1)` vs `GetGuardrail(id, v=2)` to diff what changed between versions.

M2.X.5.aa.z.8 ships `BedrockProvider.getGuardrail(guardrailIdentifier, guardrailVersion?)` returning `BedrockGuardrailDetail` — the full typed shape.

## Decision

One new provider method + extensive typed model in `guardrails-api.ts`.

### 1. `BedrockProvider.getGuardrail(guardrailIdentifier, guardrailVersion?)`

```ts
async getGuardrail(
  guardrailIdentifier: string,
  guardrailVersion?: string,
): Promise<BedrockGuardrailDetail>;
```

- Validates both inputs non-empty BEFORE the fetch.
- URI-encodes `guardrailIdentifier` (handles ARN colons → `%3A`).
- Threads optional `guardrailVersion` as a query string parameter (omitted → AWS returns DRAFT).
- GETs `/guardrails/{encoded}[?guardrailVersion=...]` via the existing `signedControlPlaneGet` helper.
- Parses via `parseGuardrailDetail`.

### 2. Typed policy model

5 nested policy types, each with strict enum-tuple discriminators where AWS's vocabulary is stable:

- **contentPolicy** — `filters[]` of `{type, inputStrength, outputStrength}`.
  - `BEDROCK_GUARDRAIL_CONTENT_FILTER_TYPES`: 6 values (`SEXUAL | VIOLENCE | HATE | INSULTS | MISCONDUCT | PROMPT_ATTACK`).
  - `BEDROCK_GUARDRAIL_FILTER_STRENGTHS`: 4 values (`NONE | LOW | MEDIUM | HIGH`).
- **contextualGroundingPolicy** — `filters[]` of `{type, threshold: number}`.
  - `BEDROCK_GUARDRAIL_CONTEXTUAL_GROUNDING_FILTER_TYPES`: 2 values (`GROUNDING | RELEVANCE`).
  - `threshold` validated as a finite number.
- **sensitiveInformationPolicy** — `piiEntities[]` of `{type, action}` + `regexes[]` of `{name, pattern, action, description?}`.
  - `BEDROCK_GUARDRAIL_PII_ACTIONS`: 2 values (`BLOCK | ANONYMIZE`).
  - `type` (PII entity type) preserved as a `string` — AWS adds new types frequently (currently 30+); enumerating would be brittle.
- **topicPolicy** — `topics[]` of `{name, type, definition, examples?}`.
  - `type` preserved as `string` (currently only `DENY` but AWS may grow this).
- **wordPolicy** — `words[]` of `{text}` + `managedWordLists[]` of `{type}`.
  - `type` preserved as `string` (currently only `PROFANITY` but AWS may grow this).

### 3. `parseGuardrailDetail(raw)`

Strict parser:
- All 9 required top-level fields throw `BedrockError api_error` on missing / non-string / empty.
- Status validated against the M2.X.5.aa.z.7 6-value tuple (case-sensitive).
- Each policy is parsed only when present in the response; AWS only returns the policies the operator configured.
- Stable-enum fields validated against their tuples (filter strength, content filter type, contextual grounding type, PII action) — throw on unknown.
- Open-vocabulary fields (PII entity type, topic type, managed word list type) preserved as `string`.

### 4. Field naming asymmetry preserved

AWS uses different field names between list and detail:
- `ListGuardrails` returns `{id, arn}`.
- `GetGuardrail` returns `{guardrailId, guardrailArn}`.

The kernel preserves both. `BedrockGuardrailSummary` has `id` + `arn`; `BedrockGuardrailDetail` has `guardrailId` + `guardrailArn`. Operators map between them at the application layer.

## Cross-cutting invariants enforced

- **Strict on stable enums; lenient on growing enums.** The four AWS vocabularies that are stable get tuples + discriminators that throw on unknown; PII entity types / topic types / word list types stay as `string`.
- **Sub-policies are independent.** A guardrail with only `topicPolicy` configured returns a detail object where `contentPolicy / wordPolicy / sensitiveInformationPolicy / contextualGroundingPolicy` are all `undefined`.
- **Boundary validation BEFORE network.** Empty identifier / empty version reject fast-fail.
- **Reuses M2.X.5.aa.z.7 status tuple + discriminator.** Detail status validation calls `isBedrockGuardrailStatus` from the list module.
- **Same transport rail as listGuardrails.** Reuses `signedControlPlaneGet` from M2.X.5.aa.z.3.
- **No kernel changes.** `LlmProvider` interface unchanged.
- **Backwards compat preserved.** No M2.9.8 / M2.X.5.aa.z.7 tests changed; only additions.

## End-to-end semantic

```ts
// Compliance review — show what this guardrail blocks.
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });
const detail = await provider.getGuardrail("gr12345");

if (detail.contentPolicy !== undefined) {
  for (const filter of detail.contentPolicy.filters) {
    console.log(`${filter.type}: input=${filter.inputStrength}, output=${filter.outputStrength}`);
  }
}
if (detail.sensitiveInformationPolicy?.piiEntities !== undefined) {
  for (const e of detail.sensitiveInformationPolicy.piiEntities) {
    console.log(`PII ${e.type}: ${e.action}`);
  }
}

// Version-diff workflow.
const v1 = await provider.getGuardrail("gr12345", "1");
const v2 = await provider.getGuardrail("gr12345", "2");
diffPolicies(v1, v2);

// Roster-then-detail enumeration.
const roster = await provider.listGuardrails();
for (const summary of roster.guardrails) {
  if (summary.status === "READY") {
    const detail = await provider.getGuardrail(summary.id);
    auditRecord(detail);
  }
}
```

## Alternatives considered

- **Make `BedrockGuardrailDetail` extend `BedrockGuardrailSummary`.**
  - **Considered.** Cleaner type relationship.
  - **Cons.** AWS uses different field names (`id` / `arn` vs `guardrailId` / `guardrailArn`). Inheriting would either require renaming or duplication. Preserving AWS's verbatim naming is more honest.
  - **Decision.** Independent types. Operators map between them.

- **Use enums for ALL Bedrock guardrail vocabularies including PII entity types.**
  - **Considered.** Maximum type safety.
  - **Cons.** AWS ships new PII entity types regularly (CA_HEALTH_NUMBER, UK_NATIONAL_INSURANCE_NUMBER, etc.). Enumerating 30+ values means every new AWS addition requires a kernel release.
  - **Decision.** Stable enums get tuples; growing enums stay as strings.

- **Auto-call listGuardrails when getGuardrail returns 404 to suggest alternatives.**
  - **Considered.** Better DX on typos.
  - **Cons.** Hidden network calls + cost. Operators inspect the error and retry as needed.
  - **Decision.** Surface 404 verbatim.

- **Cache guardrail details for a short TTL.**
  - **Considered.** Compliance review pages re-fetch frequently.
  - **Cons.** Caching policy is operator-specific. Some need 5-second freshness on drift detection; others tolerate 5-minute staleness on review pages.
  - **Decision.** No caching at the provider layer.

- **Throw on `unknown` field at top level (strict mode).**
  - **Considered.** Surfaces AWS additions immediately.
  - **Cons.** AWS adds fields without bumping API versions. Forward-compat requires tolerating unknown fields.
  - **Decision.** Strict on known fields; tolerate unknown fields at the JSON level.

- **Validate `pattern` regex syntax in `parseRegex`.**
  - **Considered.** Catch malformed regexes at parse time.
  - **Cons.** AWS uses Java regex syntax; JS doesn't support all of it (look-behind in older Node, named groups, etc.). False positives would be worse than not validating.
  - **Decision.** Preserve `pattern` as a string. Operator validates regex against the target runtime if needed.

- **Combine `getGuardrail` + `listGuardrails` into a single helper that auto-resolves shallow vs deep.**
  - **Considered.** Convenience.
  - **Cons.** Two different AWS endpoints with two different cost profiles + two different cache strategies. Combining hides that.
  - **Decision.** Keep them separate. Operators pick which they need.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 7,003 tests** (+27 from M2.X.5.aa.z.8: 18 guardrails-api + 9 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 6 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail.
- **Guardrail compliance disclosures unblocked.** Operators can dump the full policy of any guardrail for review.
- **Version diff workflows unblocked.** Get v1, get v2, compare programmatically.
- **Five typed policy types modeled.** Operators get full IntelliSense on contentPolicy.filters[i].inputStrength, sensitiveInformationPolicy.piiEntities[i].action, etc.
- **Pattern set for getX detail methods.** Future getX endpoints with rich responses follow the same shape: thin provider wrapper + strict parser + sub-parsers for nested types + boundary validation.
- **Bedrock module count: 11.** batch-api + converse-api + embeddings + errors + event-stream + guardrails + guardrails-api + pricing + provider + signing + index.

## Open questions

- **Q1:** `createGuardrail` / `updateGuardrail` / `deleteGuardrail`?
  - _Current direction:_ Wait for operator demand. Authoring is typically done via the AWS console. `createGuardrail` would have the largest body shape we've encoded (5 nested policy types as inputs).
- **Q2:** `listGuardrailVersions` (separate from `listGuardrails` with `guardrailIdentifier`)?
  - _Current direction:_ Not needed — M2.X.5.aa.z.7's `listGuardrails({guardrailIdentifier: x})` already returns version history.
- **Q3:** Should the typed enum tuples be exposed for operator use (e.g., to render UI dropdowns)?
  - _Current direction:_ Already exported. Operators can import `BEDROCK_GUARDRAIL_CONTENT_FILTER_TYPES` and iterate.
- **Q4:** Provide a `comparePolicies(a, b)` diff helper?
  - _Current direction:_ Out of scope for the provider. Operators use their preferred diff library (`fast-deep-equal`, `microdiff`, etc.).
- **Q5:** Lift the PII entity type to an enum tuple by enumerating AWS's documented values?
  - _Current direction:_ No. AWS ships new types regularly; the tuple would be perpetually stale.
- **Q6:** Should the parser preserve unknown filter types (forward-compat)?
  - _Current direction:_ No. Throwing on unknown surfaces AWS additions immediately, prompting a kernel update. Forward-compat would silently drop new filter types.
- **Q7:** `getGuardrailVersion(id, version)` as a separate method (no optional second param)?
  - _Current direction:_ Optional second param is more ergonomic. `getGuardrail(id)` for DRAFT; `getGuardrail(id, v)` for a specific version.
