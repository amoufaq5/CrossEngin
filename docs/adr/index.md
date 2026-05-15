# ADR index

| # | Title | Tier | Status | Date |
|---|---|---|---|---|
| [0000](0000-template.md) | _Template_ | — | — | — |
| [0001](0001-platform-positioning-and-brand-architecture.md) | Platform positioning and brand architecture | 1 | Proposed | 2026-05-11 |
| [0002](0002-multi-tenancy-model.md) | Multi-tenancy model | 1 | Proposed | 2026-05-11 |
| [0003](0003-meta-schema-and-dynamic-entity-engine.md) | Meta-schema and dynamic entity engine | 1 | Proposed | 2026-05-11 |
| [0004](0004-manifest-specification.md) | Manifest specification | 1 | Proposed | 2026-05-11 |
| [0005](0005-ai-architect-contract.md) | AI Architect contract | 1 | Proposed | 2026-05-11 |
| [0006](0006-llm-provider-router.md) | LLM provider router | 2 | Proposed | 2026-05-11 |
| [0007](0007-workflow-engine.md) | Workflow engine | 2 | Proposed | 2026-05-11 |
| [0008](0008-rbac-abac-and-audit.md) | RBAC v2, ABAC, and audit | 1 | Proposed | 2026-05-11 |
| [0009](0009-security-model.md) | Security model | 1 | Proposed | 2026-05-11 |
| [0010](0010-multi-region-and-data-residency.md) | Multi-region and data residency | 2 | Proposed | 2026-05-11 |
| [0011](0011-integration-mesh.md) | Integration mesh | 2 | Proposed | 2026-05-11 |
| [0012](0012-compliance-pack-architecture.md) | Compliance pack architecture | 2 | Proposed | 2026-05-11 |
| [0013](0013-reporting-and-analytics.md) | Reporting and analytics | 2 | Proposed | 2026-05-11 |
| [0014](0014-files-and-storage.md) | Files and storage | 2 | Proposed | 2026-05-11 |
| [0015](0015-jobs-and-async-runtime.md) | Jobs and async runtime | 2 | Proposed | 2026-05-11 |
| [0016](0016-search.md) | Search | 2 | Proposed | 2026-05-11 |
| [0017](0017-observability-and-slos.md) | Observability and SLOs | 2 | Proposed | 2026-05-11 |
| [0018](0018-frontend-renderer-architecture.md) | Frontend renderer architecture | 1 | Proposed | 2026-05-11 |
| [0019](0019-pwa-and-capacitor-mobile.md) | PWA and Capacitor mobile | 3 | Proposed | 2026-05-11 |
| [0020](0020-build-packaging-and-deployment.md) | Build, packaging, and deployment | 2 | Proposed | 2026-05-11 |
| [0021](0021-billing-and-metering.md) | Billing and metering | 3 | Proposed | 2026-05-11 |
| [0022](0022-internationalization-and-localization.md) | Internationalization and localization | 3 | Proposed | 2026-05-11 |
| [0023](0023-testing-strategy.md) | Testing strategy | 2 | Proposed | 2026-05-11 |
| [0024](0024-repository-and-migration-strategy.md) | Repository and migration strategy | 1 | Proposed | 2026-05-11 |
| [0025](0025-ai-architect-safety-and-governance.md) | AI Architect safety and governance | 2 | Proposed | 2026-05-11 |
| [0026](0026-marketplace-and-extensions.md) | Marketplace and extensions | 3 | Proposed | 2026-05-15 |
| [0027](0027-developer-sdk.md) | Developer SDK | 2 | Proposed | 2026-05-15 |
| [0028](0028-migration-and-onboarding.md) | Migration and onboarding | 2 | Proposed | 2026-05-15 |
| [0029](0029-ml-training-and-feedback.md) | ML training and feedback | 3 | Proposed | 2026-05-15 |
| [0030](0030-edge-and-latency-slo.md) | Edge and latency SLO | 2 | Proposed | 2026-05-15 |
| [0031](0031-disaster-recovery.md) | Disaster recovery | 2 | Proposed | 2026-05-15 |
| [0033](0033-cost-attribution-and-finops.md) | Cost attribution and FinOps | 3 | Proposed | 2026-05-15 |
| [0035](0035-audit-and-forensics.md) | Audit and forensics | 3 | Proposed | 2026-05-15 |
| [0036](0036-tenant-lifecycle.md) | Tenant lifecycle | 2 | Proposed | 2026-05-15 |
| [0037](0037-incident-response.md) | Incident response | 2 | Proposed | 2026-05-15 |

## Reserved (not yet drafted)

| # | Title (provisional) | Note |
|---|---|---|
| 0032 | Multi-region active-active | Reserved for future ADR; package not yet built. |
| 0034 | SDK client libraries (TS / Python / Go) | Reserved for future ADR; package not yet built. |

## Tiers

ADRs are written in three tiers reflecting how foundational they are:

- **Tier 1 — Foundation.** Must exist before any code. ADRs 0001, 0002, 0003, 0004, 0005, 0008, 0009, 0018, 0024.
- **Tier 2 — Phase 1-3.** Written during kernel + workflow + AI Architect build-out. ADRs 0006, 0007, 0010, 0011, 0012, 0013, 0014, 0015, 0016, 0017, 0020, 0023, 0025, 0027, 0028, 0030, 0031, 0036, 0037.
- **Tier 3 — Phase 4+.** Written as we approach mobile, billing, i18n, marketplace, ML, FinOps, and forensics work. ADRs 0019, 0021, 0022, 0026, 0029, 0033, 0035.

## Statuses

- **Proposed** — drafted, in review, not yet binding.
- **Accepted** — adopted; constrains design.
- **Superseded by ADR-XXXX** — a later ADR replaces this.
- **Deprecated** — no longer applies, no successor.

## Batching plan

The 25 + 10 ADRs are written in 9 review-sized batches across multiple sessions:

| Batch | ADRs | Approx. words | Status |
|---|---|---|---|
| 1 | vision.md + 0001 + 0024 | 14,000 | Drafted |
| 2 | 0002 + 0003 | 10,000 | Drafted |
| 3 | 0004 + 0005 | 12,000 | Drafted |
| 4 | 0008 + 0009 + 0018 | 9,400 | Drafted |
| 5 | 0006 + 0007 + 0010 + 0011 | 10,200 | Drafted |
| 6 | 0012 + 0013 + 0014 + 0015 | 10,200 | Drafted |
| 7 | 0016 + 0017 + 0020 + 0023 + 0025 | 12,200 | Drafted |
| 8 | 0019 + 0021 + 0022 | 7,400 | Drafted |
| 9 | 0026 + 0027 + 0028 + 0029 + 0030 + 0031 + 0033 + 0035 + 0036 + 0037 | 18,000 | Drafted (backfilled from shipped packages) |
