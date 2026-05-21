# CrossEngin

> **Status:** Phase 2 M1 + M2 + M2.5 + M2.6 + M2.7 + M2.8 + M2.8.5 + M2.8.6 + M2.9 + M2.9.5 + M2.9.6 + M2.9.7 + M2.9.8 + M2.9.8.x + M2.X + M2.X.5 + M2.X.5.x + M2.X.5.y + M2.X.5.z + M2.X.5.aa + M2.X.5.aa.x + M2.X.5.aa.x.1 + M2.X.5.aa.y + M2.X.5.aa.z + M2.X.5.aa.z.1 + M2.X.5.aa.z.2 + M2.X.5.aa.z.3 + M2.X.5.aa.z.4 + M2.X.5.aa.z.5 + M2.X.5.aa.z.6 + M2.X.5.aa.z.7 + M2.X.5.aa.z.8 + M2.X.5.aa.z.9 + M2.X.5.aa.z.10 + M2.X.5.aa.z.11 + M2.X.5.aa.z.12 + M2.X.5.aa.z.13 + M2.X.5.aa.z.14 + M2.X.5.aa.z.15 + M2.X.5.aa.z.16 + M2.X.5.aa.z.17 + M2.X.5.aa.z.18 + M2.X.5.aa.z.19 + M2.X.5.aa.z.20 + M2.X.5.aa.z.21 + M2.X.5.aa.z.22 + M2.X.5.aa.z.23 + M2.X.5.aa.z.24 + M2.X.5.aa.z.25 + M2.X.5.aa.z.26 + M2.X.5.aa.z.27 + M2.X.5.aa.z.28 + M2.X.5.aa.z.29 + M2.X.5.aa.z.30 + M2.X.6 + M2.X.6.x + M2.X.11 + M2.X.11.x + M2.X.12 + M2.X.13 + M2.X.14 + M2.X.15 + M2.X.16 + M5.10.5 + M6.6.x + M6.6.y + M6.7 + M6.7.x + M6.7.y + M6.7.z + M6.7.z.embed + M6.7.zz + M6.7.zz.dry-run + M6.7.zz.tenant + M6.7.zz.tenant.dashboard + M6.7.zz.tenant.opt-out + M6.7.zz.tenant.opt-out.reason + M6.7.zz.tenant.opt-out.expiry + M6.7.zz.tenant.opt-out.alerts + M6.7.zz.tenant.opt-out.cli + M6.7.zz.tenant.opt-out.cli.effective + M6.7.zz.tenant.opt-out.cli.mutate + M6.7.zz.tenant.opt-out.cli.list + M6.7.zz.tenant.retention-set + M6.7.zz.tenant.retention-delete + M6.7.zz.tenant.opt-out.history + M6.7.zz.tenant.opt-out.cli.restore + M6.7.zz.tenant.opt-out.history-retention + M6.7.zz.tenant.opt-out.cli.diff-history + M6.7.zz.tenant.opt-out.cli.prune + M6.7.zz.tenant.opt-out.cli.history.cursor + M6.7.zz.tenant.opt-out.cli.restore.dry-run + M6.7.zz.tenant.batch + M6.7.zz.tenant.opt-out.cli.diff + M6.7.zz.tenant.opt-out.cli.diff.vs-platform + M6.7.zz.tenant.opt-out.cli.diff.cross-table + M6.7.zz.tenant.opt-out.cli.diff.exit-on-divergence + M6.7.zz.tenant.opt-out.cli.effective-batch + M6.7.zz.tenant.opt-out.cli.diff.add-tenant + M6.7.zz.tenant.opt-out.cli.diff.threshold + M6.7.zz.tenant.opt-out.history.actor-join + M6.8 + M6.8.x + M6.8.x.trace + M6.8.y + M8 + M8.1 + M8.2 + M2.X.7 + M2.X.8 + M2.X.9 + M2.X.10 + M3 +
> M3.5 + M3.6 + M3.7 + M4 + M4.5 + M4.6 + M4.7 + M4.7.5 + M4.7.6 + M4.8 + M4.8.x + M4.8.y + M4.10 + M4.10.x + M5 + M5.5 + M5.6 +
> M2.8.5 + M5.7 + M5.8 + M5.9 + M5.11 + M6 + M6.5 + M6.5.5 + M6.5.6 + M6.6 + M7 + M7-wire + M7.5 + M7.6.5 + M7.7 + M7.8 + M7.9 landed. The four runtime pillars (DDL + crypto
> + workflows + gateway) are in place; both impure runtimes
> have Postgres-backed adapters; the first binary `crossengin`
> ships with init / validate / diff / patch / hash / apply /
> chat / version / help; `crossengin chat` talks to Claude
> end-to-end (streaming tokens, USD cost, REPL or one-shot),
> can dispatch read tools mid-turn (validate / hash / diff /
> summarize / optional read_file), propose manifest writes with
> human-in-the-loop approval (`--allow-file-write`), AND
> persist the full session / messages / tool invocations /
> proposals to Postgres with `--persist` for full audit; M6
> closed the HTTP-webhook → workflow-signal chain via the signal
> bridge; M7 shipped the first vertical pack
> (`@crossengin/pack-erp-core`) proving the substrate holds up
> under a real schema.
> **56 packages + 1 app, 129 meta-schema tables, 8,564 tests**,
> all green, zero type errors. ADRs 0001–0185 fully drafted.
> `crossengin apply --dry-run --pack=operate-erp/payments`
> produces the META bootstrap SQL + 4 ERP entity tables + the
> Payment table (cross-pack composition, all tenant-scoped) in
> one command. M1
> added `kernel-pg` (Postgres-backed migration applier). M2 added
> `crypto` (real SHA-256 / BLAKE2b-512 / HMAC-SHA256 / Ed25519 +
> per-tenant key store). M2.5 + M2.6 wired crypto into six
> downstream packages — marketplace pack signing, sdk webhook
> HMAC, forensics evidence sealing + hash chain, tenant-lifecycle
> tombstones, access-reviews digital signature attestations +
> campaign evidence sealing, data-lineage Article 15 GDPR
> evidence packs. M2.7 added `ai-providers-anthropic` — the
> first concrete `LlmProvider` implementation, zero runtime deps,
> pure `fetch` + SSE parsing, with per-token + cache-aware cost
> in USD. M3 added `workflow-runtime` — an in-process
> event-sourced executor that turns `WorkflowDefinition` shapes
> into actually-running instances. Real provider clients for
> Stripe / Salesforce / ServiceNow remain deferred.

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

Forty-eight packages cover the Phase 1 surface (zod schemas +
deterministic helpers) plus Phase 2 M1-M6 + M2.7 (`kernel-pg`:
real Postgres execution; `crypto`: real signatures + hashes;
`workflow-runtime` + `workflow-runtime-pg`: event-sourced
in-process executor with Postgres projection;
`api-gateway-runtime` + `api-gateway-pg`: 17-stage HTTP pipeline
with Postgres-backed stores; `workflow-signal-bridge`: webhook
→ workflow signal routing; `ai-providers-anthropic`: real
Anthropic Messages API client). The first binary,
`architect-cli`, ships under `apps/`. Detailed orientation is
in **[CLAUDE.md](CLAUDE.md)**.

Quick map by concern:

- **Substrate.** `kernel` (meta-schema + DDL emit + manifest
  validate/diff), `kernel-pg` (Postgres-backed migration applier
  + drift detector), `crypto` (Ed25519 + HMAC-SHA256 + SHA-256 +
  BLAKE2b-512 + per-tenant key store), `types`, `config`,
  `testing`.
- **Identity, security, data.** `auth`, `sso`, `security`,
  `compliance`, `residency`, `files`.
- **AI surface.** `ai-providers`, `ai-providers-anthropic`,
  `ai-providers-openai`, `ai-router`, `ai-architect`,
  `ai-architect-pg`.
- **Runtime + admission control.** `jobs`, `observability`,
  `integrations`, `rate-limiting`, `api-gateway`,
  `api-gateway-runtime`, `api-gateway-pg`, `feature-flags`,
  `workflow-engine`, `workflow-runtime`, `workflow-runtime-pg`.
- **Reporting / search / UI / messaging.** `reporting`, `search`,
  `views`, `i18n`, `notifications`.
- **Business operations.** `billing`, `finops`, `tenant-lifecycle`.
- **Delivery infrastructure.** `deploy`, `dr`, `edge`,
  `active-active`, `pwa`.
- **Developer / partner.** `sdk`, `sdk-clients`, `marketplace`,
  `migration`, `ml-training`.
- **Audit + compliance ops.** `incident-response`, `forensics`,
  `access-reviews`, `data-lineage`.
- **Vertical packs.** `pack-erp-core`, `pack-erp-payments`.

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
│   └── adr/          ADRs 0001-0133
├── apps/             1 workspace app  (architect-cli)
├── packages/         53 workspace packages
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
running index of 104 architecture decisions.

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
