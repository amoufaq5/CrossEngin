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
| 0012 | Compliance pack architecture | 2 | Proposed | _pending_ |
| 0013 | Reporting and analytics | 2 | Proposed | _pending_ |
| 0014 | Files and storage | 2 | Proposed | _pending_ |
| 0015 | Jobs and async runtime | 2 | Proposed | _pending_ |
| 0016 | Search | 2 | Proposed | _pending_ |
| 0017 | Observability and SLOs | 2 | Proposed | _pending_ |
| [0018](0018-frontend-renderer-architecture.md) | Frontend renderer architecture | 1 | Proposed | 2026-05-11 |
| 0019 | PWA and Capacitor mobile | 3 | Proposed | _pending_ |
| 0020 | Build, packaging, and deployment | 2 | Proposed | _pending_ |
| 0021 | Billing and metering | 3 | Proposed | _pending_ |
| 0022 | Internationalization and localization | 3 | Proposed | _pending_ |
| 0023 | Testing strategy | 2 | Proposed | _pending_ |
| [0024](0024-repository-and-migration-strategy.md) | Repository and migration strategy | 1 | Proposed | 2026-05-11 |
| 0025 | AI Architect safety and governance | 2 | Proposed | _pending_ |

## Tiers

ADRs are written in three tiers reflecting how foundational they are:

- **Tier 1 — Foundation.** Must exist before any code. ADRs 0001, 0002, 0003, 0004, 0005, 0008, 0009, 0018, 0024.
- **Tier 2 — Phase 1-3.** Written during kernel + workflow + AI Architect build-out. ADRs 0006, 0007, 0010, 0011, 0012, 0013, 0014, 0015, 0016, 0017, 0020, 0023, 0025.
- **Tier 3 — Phase 4+.** Written as we approach mobile, billing, and i18n work. ADRs 0019, 0021, 0022.

## Statuses

- **Proposed** — drafted, in review, not yet binding.
- **Accepted** — adopted; constrains design.
- **Superseded by ADR-XXXX** — a later ADR replaces this.
- **Deprecated** — no longer applies, no successor.

## Batching plan

The 25 ADRs are written in 8 review-sized batches across multiple sessions:

| Batch | ADRs | Approx. words | Status |
|---|---|---|---|
| 1 | vision.md + 0001 + 0024 | 14,000 | Drafted |
| 2 | 0002 + 0003 | 10,000 | Drafted |
| 3 | 0004 + 0005 | 12,000 | Drafted |
| 4 | 0008 + 0009 + 0018 | 9,400 | Drafted |
| 5 | 0006 + 0007 + 0010 + 0011 | 10,200 | Drafted |
| 6 | 0012 + 0013 + 0014 + 0015 | 16,000 | Pending |
| 7 | 0016 + 0017 + 0020 + 0023 + 0025 | 17,000 | Pending |
| 8 | 0019 + 0021 + 0022 | 10,000 | Pending |
