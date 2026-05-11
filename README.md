# CrossEngin

> **Status:** In active design. ADRs in progress. No production code in this repository.

This repository holds the vision, architecture decision records (ADRs), and design documents for **CrossEngin** — an AI-native application platform.

## What CrossEngin is

CrossEngin is a meta-application platform. Tenants describe a business, regulation, mission, or process in natural language; the **AI Architect** provisions a complete, multi-tenant, compliant, integration-ready application on a shared **kernel** — covering data model, workflows, roles, forms, dashboards, reports, and integrations.

ERP is the first family of applications built on CrossEngin. The platform also targets public-sector digitalization, healthcare digitalization at national scale, education, NGOs, and bespoke enterprise applications.

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

Thirteen families of business and organizational types, ~150 specific sub-types. See [`vision.md`](vision.md) for the full map.

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

## How to read this repository

Start with [`vision.md`](vision.md) — the north-star concept document.

Then [`adr/index.md`](adr/index.md) — the running index of all architecture decisions.

Individual decisions live at `adr/NNNN-<slug>.md`. They follow the template at [`adr/0000-template.md`](adr/0000-template.md).

## ADR statuses

| Status | Meaning |
|---|---|
| **Proposed** | Drafted. Under review. Not yet binding. |
| **Accepted** | Reviewed and adopted. Implementable. Constrains future architecture. |
| **Superseded by ADR-XXXX** | A later decision replaces this one. Both ADRs cross-reference each other. |
| **Deprecated** | No longer applies, no replacement. |

Accepted ADRs are not rewritten. If a decision changes, a new ADR supersedes the old one.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

All contents licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](LICENSE).
