# ADR-0029: ML training and feedback

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0005, ADR-0006, ADR-0009, ADR-0012, ADR-0017, ADR-0025 |

## Context

CrossEngin operates models in several places: the AI Architect (manifest proposer), SQL codegen for reporting, permission classifiers, redaction classifiers, summarizers, embeddings, safety filters, and intent classifiers. These models improve when fine-tuned on observed tenant interactions — schema decisions that worked well, SQL queries that ran without errors, redaction calls that humans agreed with.

But: using tenant data for training is **regulated, sensitive, and trust-critical**. Three constraints set the design boundary:

1. **PHI and regulated data can never be used.** Even with consent, even with redaction, even with k-anonymity. This is a hard `FORBIDDEN_TRAINING_DATA_CLASSES = {phi, regulated}` regardless of any other setting.
2. **Tenant opt-in is explicit and revocable.** Default state is no training data shared. Tenant admins must explicitly grant per-purpose consent. Consent can be withdrawn; withdrawal removes the tenant's data from future training corpora (already-trained models retain prior learning, but the next dataset rebuild excludes them).
3. **Safety regressions are release blockers.** Eval sets for `safety_refusal` and `permission_decision` taskKinds must require 100% pass rate. A model that allows a previously-refused unsafe request is never published, even if every other metric improves.

Beyond consent, this ADR addresses dataset shaping (frozen content-addressed datasets), eval governance (golden regression guards, peer-reviewed eval sets), training run audit (cost overrun detection), evaluation runs (verdict + baseline-comparison), and the model registry (one production model per family, blocking-eval-runs requirement).

## Decision

ML training contract has **six modules** in `@crossengin/ml-training`:

1. **`consent.ts`.** Five training purposes (global_model_improvement, tenant_specific_finetune, shared_catalog_patterns, redteam_evaluation, benchmarking_only) × 6 data classes × 3 legal bases (consent / contract / legitimate_interest). `FORBIDDEN_TRAINING_DATA_CLASSES` = {phi, regulated} enforced at schema level. `tenant_specific_finetune` requires `legal_basis='contract'` (signed MSA). PII inclusion requires `redactPii=true`. Withdrawn consents need timestamp + by + reason.

2. **`datasets.ts`.** Four-status lifecycle (drafting → frozen → deprecated → purged) × 4 redaction strategies (drop_row / mask_token / fake_replacement / differential_privacy). `Dataset` requires a `train` split; split sampleCount sum = totalSampleCount. Frozen datasets require `frozenSha256` (content addressing). PII + differential_privacy requires `minimumKAnonymity >= 10`. Datasets cannot include phi or regulated data classes (defense-in-depth against the consent layer).

3. **`evalsets.ts`.** Eight eval task kinds (manifest_proposal, sql_generation, permission_decision, redaction_decision, summarization, intent_classification, safety_refusal, regression_replay) × 7 scoring metrics (exact_match, json_equality, embedding_cosine, rouge_l, binary_correctness, rubric_grade, structural_diff). `safety_refusal` and `permission_decision` eval sets must have `blocksProductionPromotion=true` and `requiredPassRate=1.0`. Golden regression guards flag specific examples that must never regress.

4. **`training.ts`.** Six training kinds (supervised_finetune, preference_finetune, embedding_train, lora_adapter, qlora_adapter, full_pretrain_continue) × 6 statuses. LoRA / QLoRA kinds require `hyperparameters.loraRank`. `full_pretrain_continue` requires explicit `approvedBy` (cost + risk gate). Succeeded runs require `outputModelArtifactSha256`, `outputModelStorageUri`, `actualCostUsd`. Cost-overrun > 3× estimate is rejected at validation time (record budget breach incident first).

5. **`evaluations.ts`.** Four verdicts (passed / failed / regressed / improved) × 4 example outcomes (pass / fail / error / skipped). `EvaluationRun` enforces counter sum = examplesEvaluated, passRate computed from passed/evaluated within 0.001, p99 >= p50. Regressed/improved require baselineRunId for comparison. Failed/regressed must set `blocksPromotion=true`.

6. **`models.ts`.** Eight-state lifecycle (draft → evaluating → approved → shadow → canary → production → deprecated → retired). Eight model families (manifest_proposer, sql_codegen, permission_classifier, redaction_classifier, summarizer, embeddings, safety_filter, intent_classifier). Production models require: blocking-eval-run references, promotedToProductionAt + By. Canary state requires `canaryTrafficPercent` in (0, 100). At most one production model per family. Safety/permission/redaction families require fairnessConsiderations in the model card.

Six meta-schema tables: `META_ML_CONSENT` (RLS, tenant-scoped), `META_ML_DATASETS`, `META_ML_EVALSETS`, `META_ML_TRAINING_RUNS`, `META_ML_EVALUATIONS`, `META_ML_MODELS` (last five platform-wide for lineage).

## Alternatives considered

- **Option A:** No tenant data ever used for training; rely solely on public + synthetic data.
  - **Pros:** Zero privacy risk.
  - **Cons:** Model quality plateaus; can't learn from real workloads.
  - **Why not:** Opt-in with strict guardrails is the right balance. Forbidden-list + redaction + k-anonymity + consent give defense in depth.

- **Option B:** Implicit consent via terms-of-service.
  - **Pros:** Lower friction; more data.
  - **Cons:** Regulatory unacceptable for GDPR (Article 7), HIPAA, and increasingly for AI-specific regs. Erodes trust.
  - **Why not:** Explicit per-purpose consent is the only defensible position.

- **Option C:** No eval gating — ship models when training metrics look good.
  - **Pros:** Faster iteration.
  - **Cons:** Safety regressions ship. A model that newly allows a previously-refused unsafe request damages trust catastrophically.
  - **Why not:** Eval gates are non-negotiable for safety-critical model families.

- **Option D:** Centralized cross-tenant models only; no per-tenant fine-tunes.
  - **Pros:** Simpler operations.
  - **Cons:** Enterprise tenants want their own fine-tuned model. Big-money customers will pay for it.
  - **Why not:** Tenant-specific fine-tune is a contract-revenue lever; we keep it gated by `legal_basis='contract'`.

## Consequences

- **Positive.** Tenants control their data with explicit consent. Forbidden-data classes prevent the worst-case leak. Eval gating means safety regressions can't ship. Model registry traces every production model to its training data + evals. Cost-overrun guards stop runaway training jobs.
- **Negative.** Consent UX must be excellent — tenants need to understand what they're agreeing to. Eval-set authoring is expensive (especially safety eval sets, which need adversarial creativity).
- **Neutral.** Hyperparameter space is intentionally narrow; we don't model every possible HPO setting. Add knobs as workloads demand.
- **Reversibility.** Consent withdrawal works (next dataset rebuild excludes). Already-deployed models can't easily "unlearn" — that's a Phase 3+ problem (machine unlearning is a research area).

## Implementation notes

- **Forbidden data classes.** `permitsDataClass()` returns false for PHI/regulated regardless of consent. Double-checked at dataset construction (`Dataset` schema rejects phi/regulated in `dataClasses`).
- **Cost overrun threshold.** Hard-coded at 3× estimate. Beyond that, a separate incident workflow (record + investigate) must complete before the training run can save successfully.
- **Model card.** Every entry requires `intendedUse`, `knownLimitations` (min 1), `trainingDataSummary`, `evaluationSummary`, `contactOwner`. Safety/permission/redaction families add `fairnessConsiderations`.
- **Canary aggregate cap.** `canaryAggregate(registry, family)` sums canary traffic percent across a family. Operators must keep this under some platform-wide ceiling (set per-family in operations config, not in this schema).
- **Eval pass-rate enforcement.** verdict='passed' requires passRate >= requiredPassRate; verdict='failed' requires passRate < requiredPassRate. Both verdicts must be consistent with computed passRate from counters.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Machine unlearning — when does it become feasible to remove a specific tenant's contribution from an existing model | _pending_ | Phase 4+ |
| Federated training — train without centralizing data | _pending_ | Phase 4+ |
| Cross-tenant pattern sharing without raw data (e.g., aggregated schema patterns) | _pending_ | Phase 3 |
| Hyperparameter optimization service shape | _pending_ | Phase 3 |

## References

- ADR-0025 (AI Architect safety and governance) for the policy layer above models.
- ADR-0006 (LLM provider router) for the inference-time provider selection.
- ADR-0009 (security model) for data classification definitions.
- GDPR Article 7 (conditions for consent) and Article 22 (automated decisions).
- `packages/ml-training/src/` for the zod schemas and helpers.
