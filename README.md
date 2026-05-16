# CrossEngin

> **Status:** Phase 2 M1 in progress. **41 packages, 113 meta-
> schema tables, ~4,780 tests**, all green, zero type errors.
> ADRs 0001–0047 fully drafted. M1 added `kernel-pg`, the first
> impure runtime: a Postgres-backed migration applier that
> executes the kernel's meta-schema DDL, with hash-based
> idempotency, advisory-lock concurrency safety, and pg_catalog
> drift detection. Real provider clients + real cryptography
> remain deferred.

This repository is the home of **CrossEngin** — an AI-native
application platform. Three layers: a multi-tenant **kernel**,
declarative **manifests** that tell the kernel what application to
be, and an **AI Architect** agent that authors manifests through
conversation.

ERP (under the **CrossEngin Operate** sub-brand) is the first
family of applications built on CrossEngin. The platform also
targets public-sector digitalization (**Govern**), national-scale
healthcare digitalization (**Heal**), education (**Educate**), NGOs
(**Serve**), bespoke self-service apps (**Build**), and a
white-label channel for system integrators (**Partner**).

## Current state

Forty-one packages cover the Phase 1 surface (zod schemas +
deterministic helpers) plus the first Phase 2 milestone (`kernel-
pg`: real Postgres execution). Detailed orientation is in
**[CLAUDE.md](CLAUDE.md)**.

Quick map by concern:

- **Substrate.** `kernel` (meta-schema + DDL emit + manifest
  validate/diff), `kernel-pg` (Postgres-backed migration applier
  + drift detector), `types`, `config`, `testing`.
- **Identity, security, data.** `auth`, `sso`, `security`,
  `compliance`, `residency`, `files`.
- **AI surface.** `ai-providers`, `ai-architect`.
- **Runtime + admission control.** `jobs`, `observability`,
  `integrations`, `rate-limiting`, `api-gateway`, `feature-flags`,
  `workflow-engine`.
- **Reporting / search / UI / messaging.** `reporting`, `search`,
  `views`, `i18n`, `notifications`.
- **Business operations.** `billing`, `finops`, `tenant-lifecycle`.
- **Delivery infrastructure.** `deploy`, `dr`, `edge`,
  `active-active`, `pwa`.
- **Developer / partner.** `sdk`, `sdk-clients`, `marketplace`,
  `migration`, `ml-training`.
- **Audit + compliance ops.** `incident-response`, `forensics`,
  `access-reviews`, `data-lineage`.

Three compliance triangles closed at the contract layer:
- **Privacy.** `tenant-lifecycle` (GDPR Art. 17 deletion) +
  `data-lineage` (Art. 15 access) + `forensics` (legal hold).
- **Access control.** `auth` (RBAC/ABAC) + `sso` (federation) +
  `access-reviews` (SOC 2 CC6.3 periodic attestation).
- **Runtime safety.** `feature-flags` (kill switches +
  gradual rollout) + `rate-limiting` (admission control) +
  `incident-response` (declared incidents) +
  `workflow-engine` (saga compensation).

## Repository layout

```
CrossEngin/
├── docs/             architecture decisions + vision  (CC BY 4.0)
│   ├── vision.md
│   └── adr/          ADRs 0001-0047
├── packages/         41 workspace packages
├── apps/             user-facing applications          [pending]
├── manifests/        declarative app packs             [pending]
├── infra/            terraform + helm + docker         [pending]
├── tools/            CLI tooling, codemods, eval suite [pending]
├── CLAUDE.md         project state snapshot for AI assistants
└── (root config)     pnpm-workspace.yaml, turbo.json, package.json
```

The full target layout is in
**[ADR-0024](docs/adr/0024-repository-and-migration-strategy.md)**.
The Phase 2 implementation plan is in
**[ADR-0046](docs/adr/0046-phase-2-implementation-plan.md)**.

## How to read this repository

If you're a human contributor, start with
**[`docs/vision.md`](docs/vision.md)** — the north-star concept
document. Then **[`docs/adr/index.md`](docs/adr/index.md)** — the
running index of 47 architecture decisions.

Individual decisions live at `docs/adr/NNNN-<slug>.md`. They follow
the template at
**[`docs/adr/0000-template.md`](docs/adr/0000-template.md)**.

If you're an AI assistant resuming work on the codebase, start
with **[CLAUDE.md](CLAUDE.md)** — concise state snapshot covering
the package map, cross-cutting invariants, meta-schema discipline,
build/test commands, and the workflow pattern used to extend the
codebase.

## Sub-brand map

| Sub-brand | Role |
|---|---|
| **CrossEngin Core** | The substrate: kernel, AI Architect, workflow engine, integration mesh, design system. Never sold alone. |
| **CrossEngin Operate** | ERP family — four commercial verticals × N sub-tiers. The lighthouse app family. |
| **CrossEngin Govern** | Government and public sector — procurement, citizen services, licensing, tax administration, courts. |
| **CrossEngin Heal** | National and multi-org healthcare digitalization — ministry platforms, EMR rollouts, registries, claims. |
| **CrossEngin Educate** | Education — K-12 administration, university student lifecycle, vocational training, libraries. |
| **CrossEngin Serve** | NGO, non-profit, and faith-based organizations — programs, grants, M&E, donor CRM. |
| **CrossEngin Build** | Self-service app builder for customers and partners. |
| **CrossEngin Partner** | White-label and OEM channel for system integrators and consultancies. |

## Target families

Thirteen families of business and organizational types, ~150
specific sub-types. See [`docs/vision.md`](docs/vision.md) for the
full map.

| # | Family | Brand |
|---|---|---|
| 1 | Healthcare + Pharma + Life Sciences | Operate |
| 2 | Retail + F&B + Hospitality + POS | Operate |
| 3 | Construction + Real Estate + Facilities Management | Operate |
| 4 | Professional Services + Staffing + Field Service | Operate |
| 5 | Government + Public Sector | Govern |
| 6 | Healthcare digitalization (national / multi-org) | Heal |
| 7 | Education | Educate |
| 8 | NGO / Non-profit / Faith | Serve |
| 9 | Financial services adjacent | Operate or Build |
| 10 | Logistics + Mobility | Operate |
| 11 | Agriculture + Mining + Energy | Operate |
| 12 | General Manufacturing | Operate |
| 13 | Media + Entertainment + Membership | Operate or Build |

## ADR statuses

| Status | Meaning |
|---|---|
| **Proposed** | Drafted. Under review. Not yet binding. |
| **Accepted** | Reviewed and adopted. Implementable. Constrains future architecture. |
| **Superseded by ADR-XXXX** | A later decision replaces this one. Both ADRs cross-reference each other. |
| **Deprecated** | No longer applies, no replacement. |

Accepted ADRs are not rewritten. If a decision changes, a new ADR
supersedes the old one.

## Tooling

The monorepo uses:

- **pnpm** workspaces (`pnpm-workspace.yaml`)
- **Turborepo** as the build orchestrator (`turbo.json`)
- **TypeScript** strict mode across all packages
- **Vitest** for unit tests, **Playwright** for E2E, **MSW** for HTTP mocks
- **Node** ≥ 20, **pnpm** ≥ 9

Common commands:

```bash
pnpm install                                # install workspace
pnpm -r build                               # build all packages
pnpm -r test                                # test all packages (~45s)
pnpm -r typecheck                           # type-check all packages
pnpm --filter @crossengin/<name> test       # one package
```

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for ADR contribution
guidance. Code contribution guidelines for new packages: scaffold
follows the existing layout (`package.json`, `tsconfig.json`,
`vitest.config.ts`, `src/index.ts` re-exporting modules, matching
`src/*.test.ts` files); add any `META_*` tables to
`packages/kernel/src/bootstrap/meta-schema.ts`; aim for 15–30
tests per module covering schema accept/reject + helpers + state
transitions. [CLAUDE.md](CLAUDE.md) §Workflow has the full
11-step shape.

## License

This repository is **dual-licensed**:

- **`docs/`** subtree (vision, ADRs) — Creative Commons Attribution
  4.0 International (CC BY 4.0). See
  **[`docs/LICENSE`](docs/LICENSE)**.
- **All other paths** (apps, packages, manifests, infra, tools,
  root config) — proprietary. See **[`LICENSE`](LICENSE)**.

Final proprietary license wording is pending per ADR-0024.
