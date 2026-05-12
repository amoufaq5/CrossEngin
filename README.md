# CrossEngin

> **Status:** Phase 1 in progress. Monorepo code surface opening
> per ADR-0024. ADRs 0001–0025 drafted. No production code yet.

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

## Repository layout

The unified monorepo (per ADR-0024) is shaped as follows. `docs/`
exists today; the remaining directories arrive as package skeletons
land in subsequent Phase 1 commits.

```
CrossEngin/
├── docs/             architecture decisions + vision  (CC BY 4.0)
│   ├── vision.md
│   └── adr/
├── apps/             user-facing applications          [pending]
├── packages/         kernel + auth + workflow + AI + UI [pending]
├── manifests/        declarative app packs              [pending]
├── infra/            terraform + helm + docker          [pending]
├── tools/            CLI tooling, codemods, eval suite  [pending]
└── (root config)     pnpm-workspace.yaml, turbo.json, package.json
```

The full target layout is in
**[ADR-0024](docs/adr/0024-repository-and-migration-strategy.md)**.

## How to read this repository

Start with **[`docs/vision.md`](docs/vision.md)** — the north-star
concept document.

Then **[`docs/adr/index.md`](docs/adr/index.md)** — the running
index of all 25 architecture decisions.

Individual decisions live at `docs/adr/NNNN-<slug>.md`. They follow
the template at
**[`docs/adr/0000-template.md`](docs/adr/0000-template.md)**.

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

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for ADR contribution
guidance. Code contribution guidelines will land alongside the
first package skeletons in subsequent Phase 1 commits.

## License

This repository is **dual-licensed**:

- **`docs/`** subtree (vision, ADRs) — Creative Commons Attribution
  4.0 International (CC BY 4.0). See
  **[`docs/LICENSE`](docs/LICENSE)**.
- **All other paths** (apps, packages, manifests, infra, tools,
  root config) — proprietary. See **[`LICENSE`](LICENSE)**.

Final proprietary license wording is pending per ADR-0024.
