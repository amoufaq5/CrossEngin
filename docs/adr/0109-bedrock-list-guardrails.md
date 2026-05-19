# ADR-0109: Bedrock listGuardrails — second control-plane enumeration surface (Phase 2 M2.X.5.aa.z.7)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0084 (M2.9.8 Bedrock Guardrails inference integration), ADR-0085 (M2.9.8.x per-request guardrail override), ADR-0105 (M2.X.5.aa.z.3 listBatches) |

## Context

Guardrails landed at M2.9.8 as an inference-time concern: operators pass `guardrailConfig` into `BedrockProvider` and every Converse call enforces it. M2.9.8.x added per-request overrides. Neither milestone exposed any control-plane operation against guardrails themselves — operators couldn't enumerate which guardrails exist on their AWS account, can't audit them for compliance, can't reconcile their internal "tenant → guardrail" registry against AWS's view.

Demand surfaces in three operational scenarios:

1. **Compliance audits.** "Show me every guardrail this account has, when it was last updated, what status it's in." Today this requires the AWS console / CLI.
2. **Tenant-to-guardrail reconciliation.** Operators tagging guardrails per tenant (via `BedrockGuardrailConfig.guardrailIdentifier`) need to verify the mapping in their app DB matches what AWS actually has.
3. **Drift detection.** A guardrail expected to be `READY` is actually `FAILED` or `DELETING` — surface it before the next inference call hits a stale config.

M2.X.5.aa.z.7 is the second enumeration on Bedrock's control plane (after listBatches in M2.X.5.aa.z.3). It uses the SAME `signedControlPlaneGet` rail — no transport changes. The new module lives at `guardrails-api.ts` to keep it separate from the existing inference-time `guardrails.ts` (`BedrockGuardrailConfig`).

## Decision

One new module + one new provider method.

### 1. `guardrails-api.ts`

- `BEDROCK_GUARDRAIL_STATUSES` — 6-value const tuple matching AWS's documented states (`CREATING | UPDATING | VERSIONING | READY | FAILED | DELETING`).
- `BedrockGuardrailStatus` type + `isBedrockGuardrailStatus(value)` discriminator (case-sensitive — AWS uses UPPERCASE).
- `BedrockGuardrailSummary` — flat shape mirroring AWS's response item (`id` / `arn` / `status` / `name` / `version` / `createdAt` / `updatedAt` required; `description` optional).
- `BedrockGuardrailListResponse` — `{guardrails, nextToken?}` with `nextToken` omitted when empty / absent.
- `buildGuardrailListQuery(options)` — pure boundary-validator returning `Record<string, string>`. Validates `guardrailIdentifier` non-empty; `maxResults` integer in `[1, 1000]`; `nextToken` non-empty. Throws `BedrockError invalid_request_error` on bad inputs BEFORE any fetch.
- `parseGuardrailListResponse(raw)` + `parseGuardrailSummary(raw)` — strict parsers; throw `BedrockError api_error` on missing required fields, unknown status values, malformed shapes.

### 2. `BedrockProvider.listGuardrails(options?)`

```ts
async listGuardrails(options: BedrockListGuardrailsOptions = {}): Promise<BedrockGuardrailListResponse>;
```

- Validates options via `buildGuardrailListQuery`.
- GETs `https://bedrock.{region}.amazonaws.com/guardrails?...` via the existing `signedControlPlaneGet` helper (M2.X.5.aa.z.3).
- Parses JSON via `parseGuardrailListResponse`.
- Errors route through `fromHttpResponse` / `fromNetworkError` — same paths as `listBatches`.

### 3. Behavioral note — guardrailIdentifier semantics

AWS's `ListGuardrails` behaves differently when `guardrailIdentifier` is included:
- **Without `guardrailIdentifier`** → returns DRAFT version of all guardrails.
- **With `guardrailIdentifier`** → returns DRAFT + all numbered versions of that ONE guardrail.

The kernel preserves the AWS behavior — operators pass `guardrailIdentifier` when they want version history, omit it when they want a roster.

## Cross-cutting invariants enforced

- **Reuse the M2.X.5.aa.z.3 transport rail.** `signedControlPlaneGet` called unchanged.
- **Provider-native pagination.** AWS's opaque `nextToken` preserved as-is. No attempt to normalize against OpenAI / Anthropic.
- **Boundary validation BEFORE network.** Bad `maxResults` / empty `nextToken` / empty `guardrailIdentifier` fail-fast.
- **Strict response parsing.** Missing required fields, unknown status values, malformed shapes throw `api_error`.
- **Case-sensitive status matching.** AWS uses UPPERCASE (`READY`, not `Ready`). The discriminator + tuple match exactly.
- **No kernel changes.** `LlmProvider` interface unchanged. `listGuardrails` is Bedrock-specific.
- **Backwards compat preserved.** No M2.9.8 / M2.9.8.x / M2.X.5.aa.z.3 / .4 / .5 / .6 tests changed; only additions.
- **Module separation.** `guardrails.ts` continues to own inference-time concerns (`BedrockGuardrailConfig`); `guardrails-api.ts` owns control-plane concerns. Both export through the package barrel.

## End-to-end semantic

```ts
// Audit: show every guardrail + its status.
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });
const all: BedrockGuardrailSummary[] = [];
let cursor: string | undefined;
do {
  const page = await provider.listGuardrails({
    maxResults: 100,
    ...(cursor !== undefined ? { nextToken: cursor } : {}),
  });
  all.push(...page.guardrails);
  cursor = page.nextToken;
} while (cursor !== undefined);

const byStatus = new Map<BedrockGuardrailStatus, BedrockGuardrailSummary[]>();
for (const g of all) {
  if (!byStatus.has(g.status)) byStatus.set(g.status, []);
  byStatus.get(g.status)!.push(g);
}
const failed = byStatus.get("FAILED") ?? [];
if (failed.length > 0) {
  logger.error({ failed }, "guardrails in FAILED state");
}

// Drift detection: verify the tenant→guardrail mapping in our DB.
async function reconcile(expected: Map<string, string>): Promise<void> {
  const actual = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await provider.listGuardrails({
      ...(cursor !== undefined ? { nextToken: cursor } : {}),
    });
    for (const g of page.guardrails) {
      if (g.status === "READY") actual.add(g.id);
    }
    cursor = page.nextToken;
  } while (cursor !== undefined);
  for (const [tenant, expectedId] of expected) {
    if (!actual.has(expectedId)) {
      logger.warn({ tenant, expectedId }, "guardrail missing or not READY");
    }
  }
}

// Version history for one guardrail.
const versions = await provider.listGuardrails({
  guardrailIdentifier: "gr12345",
});
console.log(`guardrail gr12345 has ${versions.guardrails.length.toString()} versions`);
```

## Alternatives considered

- **Add `listGuardrails` as a method on `guardrails.ts` instead of a new module.**
  - **Considered.** One module per AWS resource type.
  - **Cons.** `guardrails.ts` is small + focused on the inference-time config. Mixing in 130 lines of control-plane code would dilute it. The batch surface is already a separate module; consistency favors a separate module here too.
  - **Decision.** New module `guardrails-api.ts`.

- **Unify with `listBatches` under a kernel "control-plane enumeration" abstraction.**
  - **Considered.** Both methods follow the same shape (sig v4 GET + sorted query + parse).
  - **Cons.** The response shapes are different (`{invocationJobSummaries, nextToken}` vs `{guardrails, nextToken}`); the option shapes are different (`statusEquals/submitTimeAfter/...` vs `guardrailIdentifier/maxResults/nextToken`); the validation rules are different. Lowest-common-denominator abstraction loses too much information.
  - **Decision.** Provider-native methods. The shared rail is `signedControlPlaneGet` at the transport layer.

- **Normalize status values to lowercase.**
  - **Considered.** Most kernel enums use lowercase.
  - **Cons.** AWS Bedrock returns uppercase verbatim. Translating bidirectionally adds bug surface for zero benefit. Operators reading the field see exactly what AWS sent.
  - **Decision.** Preserve AWS's casing.

- **Include `parseGuardrailDetail` for future `getGuardrail` (proactive).**
  - **Considered.** Mirrors what we did with `parseBatchJobDetail = parseBatchJobSummary` in M2.X.5.aa.z.4.
  - **Cons.** `GetGuardrail` returns a much richer shape than `ListGuardrails` (contentPolicy, topicPolicy, wordPolicy, sensitiveInformationPolicy, contextualGroundingPolicy, kmsKeyArn, blockedInputMessaging, blockedOutputsMessaging, failureRecommendations). Reusing the summary parser would silently drop those fields.
  - **Decision.** Defer detail parsing to when `getGuardrail` is implemented (Q1).

- **Auto-iterate all pages in `listGuardrails` (return a flat array).**
  - **Considered.** Operators never want a single page in practice.
  - **Cons.** Hides `nextToken`; operators can't resume from a checkpoint.
  - **Decision.** Plain page-at-a-time. Auto-paginator is operator-side.

- **Cache the result for a short TTL.**
  - **Considered.** Status polling can be frequent.
  - **Cons.** Caching policy is operator-specific; some need fresh reads on every call (drift detection), some are happy with 30s staleness.
  - **Decision.** No caching.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,976 tests** (+29 from M2.X.5.aa.z.7: 21 guardrails-api + 8 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 5 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails.
- **Compliance audit workflows viable on Bedrock.** Operators can enumerate guardrails, count by status, identify FAILED / DELETING entries.
- **Tenant-to-guardrail reconciliation unblocked.** Operators tracking the mapping in their app DB can diff against AWS's view periodically.
- **Drift detection unblocked.** Periodic scans surface guardrails that drifted out of `READY`.
- **Module separation pattern established.** Control-plane and inference-time concerns for the same AWS resource (Guardrails) live in separate modules. Future resources with both surfaces follow the same split.
- **Second control-plane enumeration shipped.** The pattern (boundary-validated query builder + strict parser + provider thin wrapper) is now proven twice; adding `listInferenceProfiles` / `listImportedModels` / `listCustomModels` is mechanical.

## Open questions

- **Q1:** `getGuardrail(guardrailIdentifier, guardrailVersion?)` next?
  - _Current direction:_ High demand — operators auditing a specific guardrail's content policy need the full body. Rich response shape (5 policy types + KMS + failure recommendations). Likely the next milestone if guardrails depth continues.
- **Q2:** `createGuardrail` / `updateGuardrail` / `deleteGuardrail`?
  - _Current direction:_ Wait for operator demand. Guardrails are typically authored via the AWS console; programmatic creation is a niche workflow.
- **Q3:** Should the status field thread through `BedrockGuardrailConfig` so operators know if their configured guardrail is healthy?
  - _Current direction:_ No. Inference-time config is config; status is observability. Coupling them would require a network call to construct the provider.
- **Q4:** Async iterator helper `forEachGuardrail(provider, opts, callback)`?
  - _Current direction:_ Out of scope for this milestone. If three operators write essentially-identical pagination loops, lift to `@crossengin/ai-router` as a generic helper.
- **Q5:** Cross-provider guardrail abstraction (Anthropic + OpenAI both have content moderation / safety APIs)?
  - _Current direction:_ Watch the M2.X.6 / M2.X.8 surfaces. Today the shapes are too different to share a kernel interface.
- **Q6:** Should `listGuardrails` support a status filter param?
  - _Current direction:_ AWS doesn't expose one. Client-side filtering happens after the call.
- **Q7:** `listGuardrails` performance — does AWS rate-limit control-plane reads more aggressively than inference?
  - _Current direction:_ Watch in production. AWS's documented Bedrock control-plane throttle is ~1 RPS per account; the kernel surfaces ThrottlingException → `rate_limit_error` for operators to retry/backoff.
