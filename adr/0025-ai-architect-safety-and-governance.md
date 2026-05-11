# ADR-0025: AI Architect Safety and Governance

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0005, ADR-0006, ADR-0008, ADR-0009, ADR-0012, ADR-0017, ADR-0023 |

## Context

ADR-0005 defined the AI Architect's **architecture**: planner-executor loop, tool surface, kernel-mediated changes, cost telemetry. This ADR defines its **safety and governance**: the policy layer above the architecture.

The AI Architect operates in a sensitive position. It interviews tenants about regulated businesses, produces manifest patches that mutate live applications, and reads tenant data (manifests, uploaded documents) to inform its proposals. Three categories of risk emerge:

1. **Direct tenant harm.** The agent applies a manifest patch that breaks a tenant's workflow, deletes data, weakens permissions, or violates a compliance pack. Audit visibility helps recovery; prevention is better.
2. **Cross-tenant leakage.** The agent inadvertently surfaces one tenant's information (a manifest, a document excerpt, a workflow pattern) to another. Catastrophic for trust.
3. **Adversarial misuse.** A tenant (or an attacker who compromises a tenant) uses the agent to escalate privileges, exfiltrate data, or attack the platform. Prompt injection, jailbreak, social-engineering of the planner.

These risks need explicit guardrails:

- **Hard refusals** for operations that must never happen, regardless of permissions.
- **Confirmation gates** for operations that need extra friction.
- **Tenant opt-in policies** for cross-tenant features.
- **Eval gating** for model / prompt changes.
- **Audit and review** for every agent action.
- **Incident response** for AI-specific failures.

Compliance pack architecture (ADR-0012) gives some framing — compliance packs impose constraints the agent cannot loosen. This ADR formalizes those constraints + adds AI-specific ones.

## Decision

The AI Architect operates under a **three-layer safety policy**:

```
┌──────────────────────────────────────────────────────────────┐
│ Layer 3: Hard refusals (kernel-enforced; cannot be overridden) │
├──────────────────────────────────────────────────────────────┤
│ Layer 2: Confirmation gates (require explicit tenant approval) │
├──────────────────────────────────────────────────────────────┤
│ Layer 1: Soft preferences (default behaviors; tenant-tunable)  │
└──────────────────────────────────────────────────────────────┘
```

### Layer 3 — Hard refusals

The kernel rejects these operations regardless of who requests them (tenant user, tenant admin, AI Architect, CrossEngin staff):

- **Disable audit on a compliance-pack-bound entity.** A tenant cannot remove `auditable` trait from `21-cfr-part-11`-active entities. The kernel rejects manifest applies that attempt it.
- **Reduce audit retention below pack-mandated minimums.** 7-year retention on gxp records cannot be reduced to 1 year while the pack is active.
- **Grant cross-tenant access.** No role, ABAC predicate, or workflow effect can read or write another tenant's data. RLS + per-tenant Postgres roles enforce this at the database layer; the API layer enforces the same as defense-in-depth.
- **Weaken encryption strength below pack-mandated minimums.** E.g., HIPAA-active tenants cannot disable encryption at rest.
- **Disable MFA on roles with `part11Compliant` transitions.** Pack-imposed.
- **Bypass `previewManifestApply` for `applyManifestPatch`.** The approval token is non-forgeable; the agent cannot apply without it.
- **Disable the audit log.** Period. Not a configurable property.
- **Apply a manifest that fails compliance pack validation.** No override mechanism; the tenant must address the validation error or deactivate the pack (which has its own gates).
- **Grant the AI Architect principal direct database access.** Always mediated through the kernel API.
- **Self-elevate.** The agent's principal cannot grant itself a role or modify its own permissions.
- **Disable cost telemetry.** Every agent action is metered.
- **Disable the eval-suite gate** for prompt or model changes. No "hotfix" path that skips eval.

Hard refusals are logged. An attempted hard-refusal violation triggers a P0 audit event regardless of source.

### Layer 2 — Confirmation gates

Operations that require explicit, separate user confirmation beyond the standard preview:

- **Destructive manifest changes.** Dropping an entity, dropping a column, narrowing a permission, removing a workflow transition. Preview shows the destructive change with explicit warning; tenant admin clicks "I understand this will permanently affect ..." to apply.
- **Compliance pack deactivation.** A tenant disabling 21 CFR Part 11 must:
  1. Acknowledge the regulatory implications.
  2. Confirm that retained data will continue to satisfy retention obligations.
  3. Provide a "reason for deactivation" recorded in the audit log.
  4. The pack remains attestation-frozen for 90 days (no new attestations of compliance during this period).
- **Residency profile change.** Moving a tenant from `eu-only` to `unrestricted` requires re-attestation + 7-day wait period.
- **Bulk operations.** Deleting > 100 records, mass-updating > 1000 records, or canceling > 10 in-flight orchestrations.
- **Granting cross-pack-conflicting permissions.** E.g., a custom role that a compliance pack would normally forbid.
- **OpenAI / external-provider opt-in.** Default Fireworks; opt-in to OpenAI requires explicit consent because data flows to a US-based provider.
- **Cross-tenant similar-manifest sharing.** A tenant opting into the shared catalog must explicitly enable.
- **Schema migration that requires `data_migration` SQL.** Per ADR-0003, requires explicit `confirm_destructive: true` plus separate UI confirmation.
- **Manifest apply when AI Architect confidence is low.** The agent flags low-confidence proposals; the preview UI shows "the AI Architect is uncertain about this change" and requires explicit "Apply anyway" confirmation.

Confirmation gates produce a distinct audit entry tagging the confirmer + reason.

### Layer 1 — Soft preferences

Default behaviors that tenant admins can tune within compliance-pack bounds:

- **Schema-change approval gate** (per ADR-0008): tiered / always-human / agent-can-do-anything.
- **AI Architect cost ceiling per session:** default 50K tokens (~$5); tenants can raise on premium tiers.
- **AI Architect cost ceiling per tenant per month:** default $200 base tier, $2000 premium; configurable in plan.
- **Conversation summarization frequency:** default every 20 turns; tunable.
- **Diff preview detail level:** default standard; option for "verbose" showing every kernel call.

### Tenant opt-ins

The agent's defaults respect tenant privacy:

- **Similar-manifest catalog:** opt-in. Tenants choose whether their manifest patterns (anonymized) contribute to and benefit from the catalog. Default off. Compliance packs (HIPAA, 21 CFR Part 11) override the default to a stricter "off + cannot enable until tenant explicitly waives."
- **Cross-tenant pattern learning:** opt-in. The agent never trains on tenant data; "learning" here refers only to retrieval at conversation time. Default off.
- **External LLM providers beyond Fireworks:** opt-in. Default Fireworks (which serves EU-resident inference); OpenAI / Anthropic Cloud opt-in for tenants who explicitly accept US data flow.
- **AI Architect conversation analytics:** CrossEngin sees aggregate metrics (length, success rate, eval-correlated outcomes) by default; per-tenant access to specific conversation transcripts requires tenant-admin authorization for support escalations.

Opt-ins are managed in `meta.tenant_ai_settings` with audit-trail of toggles.

### Eval-suite gating

Every change to:

- Model selection (per ADR-0006).
- System prompt.
- Tool schemas.
- Loop-runner code.
- Retrieval (RAG) configuration.

…runs the eval suite (per ADR-0023). Acceptance criteria:

- **No regression > 5%** on overall eval score (weighted by task severity).
- **No new failures on safety-critical cases** (e.g., "agent must refuse to remove audit on gxp tenant" must continue to pass).
- **Cost per session not > 20% higher** than prior baseline (without manual approval).
- **Latency per turn not > 30% higher** than prior baseline.

Failures block deploy. Acceptable regressions require explicit "regression accepted" sign-off + documented reason in the deploy notes.

### Per-conversation safety

Every conversation has:

- **Cost ceiling** enforced session-wide.
- **Tool-call cap per turn** (12; per ADR-0005).
- **Per-tool rate limit** (no tool called > N times per session without explicit reason in plan).
- **Confidence reporting** (low/medium/high per plan).
- **Refusal hooks**: if the user asks the agent to do something forbidden (e.g., "disable audit logging"), the agent explains why it cannot, references the pack/citation, and offers alternatives.

### Refusal copy

When the agent refuses, the refusal includes:

- **What is requested** (paraphrased).
- **Why it is refused** (citing the policy: hard refusal, pack rule, confirmation-gate-pending, residency violation).
- **Citation** (where applicable: "21 CFR §11.10(e)").
- **Alternative path** if one exists ("If you want to reduce retention, the path is to deactivate the 21 CFR Part 11 pack first, which has its own confirmation flow.").

Refusal messages are templated; the agent fills in specifics. Templates are reviewed by the compliance officer (Year 2+ hire) for accuracy and tone.

### Incident response for AI-specific failures

In addition to standard severity tiers (per ADR-0009):

| Incident class | Severity | Response |
|---|---|---|
| Cross-tenant data leak via agent retrieval | P0 | Disable retrieval globally; investigate; notify affected tenants within 24h |
| Prompt-injection successful bypass | P1 | Disable affected tools temporarily; reproduce; patch + eval |
| Eval regression > 10% detected in production | P1 | Rollback to prior version; investigate |
| Cost-runaway (1 tenant > $1000 in 1 hour) | P2 | Pause agent for that tenant; investigate; communicate |
| Refused operation attempted via UI manipulation | P2 | Audit + alert; verify defense-in-depth holds |
| Refusal copy regression (agent gives wrong reason) | P3 | Patch template; redeploy; no further action |

### Adversarial red-team

Annual external red-team specifically for the AI Architect:

- Prompt-injection attacks.
- Jailbreaks asking for forbidden actions.
- Social-engineering: pretending to be a CrossEngin staff member.
- Exfiltration: encouraging the agent to leak conversation history or document content.
- DoS: maximizing cost per session.
- Cross-tenant probing: from one tenant's session, trying to retrieve another's data.

Red-team findings drive prompt + tool + retrieval changes.

### Governance roles

- **Tenant admin** controls tenant-scope settings (opt-ins, confirmation gate, cost ceilings).
- **CrossEngin compliance officer** (Year 2+ hire) owns hard-refusal list, pack-imposed rules, and eval-gating policy.
- **Founder / engineering** owns architecture (per ADR-0005), deployment, telemetry.
- **External legal review** of refusal copy + pack rules before publication.
- **Per-pack regulatory affairs** advisor for pack authoring (cross-link ADR-0012).

Escalation path: tenant admin → CrossEngin support → compliance officer → founder. CrossEngin staff cannot override hard refusals; they can only initiate confirmation-gate flows on tenant's behalf with audit trail.

### Visibility and disclosure

- **Per-tenant AI Architect activity dashboard.** Tenant admins see what the agent did in their tenant: conversations + applied manifest patches + cost.
- **Public AI use disclosure.** `apps/docs-site/ai-policy.md` describes how the agent operates, what data it sees, what it cannot do. Updated when policies change.
- **Compliance pack annotations.** Each pack ships an "AI Architect interaction notes" section in its README describing how the agent interacts with the pack's surface.
- **Incident disclosure.** P0/P1 incidents involving the agent are disclosed publicly (statuspage + email to affected tenants) within 24h.

### Privacy boundaries

- **No tenant data sent to LLM providers for training.** Verified via Fireworks contractual terms; reverified annually. Same for any future provider.
- **No conversation content used to train CrossEngin's own future model** (when self-hosted LLM ships Year 3+). Conversation transcripts are operational records only.
- **Eval-suite conversations are synthetic** unless tenants explicitly contribute (with consent + anonymization).
- **Per-tenant similarity search** respects opt-in flags; never serves a non-opted-in tenant's manifest patterns to another.

### Sunset and supersession

This ADR will be revisited when:

- A new compliance framework with AI-specific provisions emerges (e.g., EU AI Act enforcement details Year 2-3).
- The platform crosses 1000 tenants and audit / incident-response patterns mature.
- A material AI Architect architecture change makes some policies obsolete.

Until then, this ADR is the canonical safety reference.

## Alternatives considered

### Option A — Pure architectural safety (no policy layer)

Rely on ADR-0005's architecture without explicit policy enforcement.

- **Pros:** Simpler.
- **Cons:** Architecture is "what we can do"; policy is "what we will do." Regulators ask for policies. Without explicit refusal lists, every edge case is a judgment call.
- **Why not:** Policy layer is required for credibility with regulated buyers.

### Option B — Tenant-supplied policy (every tenant defines hard refusals)

Tenants author their own forbidden operations.

- **Pros:** Maximum flexibility.
- **Cons:** Hard refusals must hold across tenants for platform integrity (cross-tenant access, audit disable, encryption weakening). Some policies are platform-wide; tenants cannot weaken.
- **Why not:** Hybrid is right: platform-wide hard refusals + per-tenant tunable soft preferences.

### Option C — External AI safety vendor (Lakera, Robust Intelligence)

Use a third-party AI safety platform.

- **Pros:** Pre-built prompt-injection detection + adversarial testing.
- **Cons:** Adds a vendor with closed-source posture friction. Most third-party safety platforms target the model layer; CrossEngin's safety is largely at the architectural + policy layer.
- **Why not:** Adopt specific point solutions if needed (e.g., prompt-injection detector as a pre-filter for user messages); broad vendor relationships defer.

### Option D — Periodic manual policy review (no automated enforcement)

Compliance officer reviews agent behavior periodically.

- **Pros:** Less engineering overhead.
- **Cons:** Cannot scale. Regressions slip in between reviews.
- **Why not:** Automated enforcement + periodic review combined.

### Option E — Open public bug bounty for AI Architect

Crowdsource adversarial testing.

- **Pros:** Larger attacker pool.
- **Cons:** Public disclosure timeline conflicts with closed-source posture. Year 5+ at earliest.
- **Why not:** Private red-team Year 2-3; public bounty later.

## Consequences

### Positive

- **Explicit policy reduces ambiguity.** Tenant questions about agent behavior have documented answers.
- **Hard refusals + confirmation gates + soft preferences** is a defensible tiered model auditors recognize.
- **Eval-suite gating** prevents silent agent regressions.
- **Privacy boundaries are explicit.** No tenant data trains models, no cross-tenant leakage, no surprises.
- **Incident response for AI-specific failures** is pre-planned; no scrambling.

### Negative

- **Policy maintenance is real work.** Hard-refusal list evolves; pack rules evolve; tenant-opt-in defaults need periodic review. Mitigation: compliance officer hire Year 2.
- **Refusal copy is a UX surface.** Tenants frustrated by refusals can churn. Mitigation: clear citations + alternative-path suggestions in every refusal.
- **Eval-suite cost** is real. Mitigation: budget capped; recorded fixtures for most cases.
- **External red-team is annual recurring cost.** Mitigation: bundle with annual pen-test (ADR-0009).

### Neutral

- **Tenant settings UX** for opt-ins + cost ceilings is part of `apps/web` admin views.
- **Disclosure docs** maintained in `apps/docs-site`.

### Reversibility

**Low cost** to evolve soft preferences and tenant opt-ins.

**Moderate cost** to evolve confirmation gates — UI changes + tenant communication required.

**High cost** to change hard refusals after tenants have built workflows around them. Hard refusals are committed-by-promise.

## Implementation notes

- **Package locations:**
  - `packages/ai-architect/policy` — hard-refusal evaluators, refusal copy templates.
  - `packages/compliance` — pack-imposed refusals (cross-link ADR-0012).
  - `apps/web/api/v1/architect/policy` — runtime policy enforcement on every agent action.
- **Hard refusal enforcement points:**
  - Manifest validator (rejects manifests that violate hard refusals).
  - Kernel API middleware (rejects API calls that would violate).
  - Database constraints (where representable as SQL constraints / triggers).
- **Confirmation gate UI:** modal in `apps/web/architect` with citation + reason field + multi-step confirm.
- **Tenant settings storage:** `meta.tenant_ai_settings(tenant_id, key, value, set_by, set_at)`.
- **Eval-gate config:** `packages/ai-architect/evals/gate-config.yaml` — thresholds + safety-critical cases.
- **Refusal template registry:** `packages/ai-architect/policy/refusals/<id>.md` with placeholders.
- **Adversarial test suite:** `tools/architect-redteam/` — automated tests for known attack patterns (prompt injection, jailbreak, self-elevation, cross-tenant probing).
- **Audit emission on refusals:** every refusal emits to `meta.audit_log` (per ADR-0008); aggregated to detect repeated refusal-triggering attempts.
- **Dashboard for refusals:** `apps/ops` view shows refusal types per tenant per week; anomalies surfaced.
- **Disclosure doc maintenance:** `apps/docs-site/ai-policy.md` updated within 7 days of any policy change; version-controlled.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| EU AI Act compliance — Year 2-3 enforcement details; "high-risk AI system" classification may apply to CrossEngin in healthcare/government contexts. Posture update needed. | _pending compliance hire_ | Year 2 |
| Cross-tenant catalog opt-in mechanics — exact UX, default state per compliance pack, retroactive opt-out implications. | _pending compliance hire_ | Phase 5 |
| Public bug-bounty timing — Phase 5+ private; public when? | amoufaq5 | Year 3+ |
| Refusal copy localization — Arabic, French for ME / EU tenants. Translation quality matters for legal clarity. | _pending design hire_ | Year 2 |
| Adversarial red-team vendor — bundle with annual pen-test (cross-link ADR-0009) or specialist AI-safety firm. | amoufaq5 | Phase 5 |
| Per-conversation severity tiering — low-stakes-tenant vs. regulated-tenant — different cost ceilings, different MFA-rechallenge cadence? | amoufaq5 | Phase 5 |
| AI Architect operating in shared-screen / pair-mode with CrossEngin support — when support staff joins a conversation, audit captures dual-principal; UX clarification needed. | _pending design hire_ | Phase 5 |
| Compliance officer fractional-consultant engagement — when does pre-Year-2 budget justify? | amoufaq5 | Phase 4 |

## References

- ADR-0005 (AI Architect contract) — defines agent architecture.
- ADR-0006 (LLM provider router) — defines provider selection and opt-ins.
- ADR-0008 (RBAC v2, ABAC, audit) — defines per-tenant approval gate and audit.
- ADR-0009 (Security model) — defines incident response framework.
- ADR-0012 (Compliance pack architecture) — defines pack-imposed constraints.
- ADR-0017 (Observability and SLOs) — defines AI Architect telemetry.
- ADR-0023 (Testing strategy) — defines eval suite.
- EU AI Act (Regulation 2024/1689); NIST AI Risk Management Framework; OWASP LLM Top 10.
