# ADR-0024: Repository and Migration Strategy

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0001, ADR-0003, ADR-0004, ADR-0020 |

## Context

Code lives in repositories. How code is organized across repositories — monorepo vs. polyrepo, what goes where, how branches are organized, how docs relate to code — affects velocity, build times, dependency management, release cadence, and contributor onboarding.

CrossEngin's repository decisions are constrained by:

1. **A solo-to-duo team.** Cannot maintain 10+ repos. Build and release infrastructure must be minimal.
2. **Tight package coupling.** Kernel, AI Architect, workflow engine, design system, and renderers evolve together. A change to the meta-schema may require simultaneous changes in 4–5 packages.
3. **Optional on-prem and BYOC editions later.** Code that runs in customer cloud or behind customer firewalls must be packageable as discrete artifacts.
4. **OEM / white-label distribution.** Channel partners will package CrossEngin under their own brand; the substrate must be cleanly bundlable.
5. **Existing code at /home/user/ERP.** A working but mock-heavy ERP codebase with ~22 GxP-grade Prisma models, a partial auth layer, a UI design system, and many TODO-laden pages. Cannot be discarded — months of domain work.
6. **Brand expansion.** The original ERP-only scope expanded to a meta-application platform. Existing code was written under the old framing.
7. **Documentation strategy.** Architecture decision records (ADRs) and vision should live separately from code, so they can be read, reviewed, and changed without going through code review.

### Existing-state inventory of /home/user/ERP

- **Next.js app router project** with a shadcn-based UI design system.
- **22 Prisma models** for pharma GxP/QA-QC (water systems, environmental monitoring, equipment qualification, deviation, change control, training, etc.) — the real domain assets.
- **Authentication scaffolding** (NextAuth.js).
- **Page-level monoliths** (2,000+ line files) with hardcoded UI for single entity types.
- **`INITIAL_*` mock arrays** in many pages (a previous AI generation pass populated these as placeholders).
- **~1,707 TODO comments** scattered across the codebase, ranging from "implement this" to "fix this before production."
- **No Row-Level Security** enabled on Postgres.
- **Limited observability** — no OTel, no Sentry, no structured logs.
- **No tenant isolation enforcement** at the DB level.

This is salvageable as a source of domain knowledge and individual building blocks, not as the v1 codebase.

## Decision

CrossEngin uses **one repository**: `amoufaq5/CrossEngin`. It already exists as the docs repository (vision + ADRs) and will be expanded into a unified monorepo containing docs, code, manifests, infra, and tooling.

> **Update (2026-05-11):** the original two-repository plan (separate docs repo and separate code monorepo) was revised after the Round 1 decision review. Maintaining two repos for a solo-to-duo team produced more overhead than the doc/code separation justified. The unified-repo approach is described below.

The existing **`amoufaq5/ERP`** repository becomes an **archive of pre-platform work** once Phase 1 opens the monorepo's code surface — earlier than the original "after Phase 5" plan (Round 8 decision).

### Monorepo layout (unified docs + code)

The repository expands from its current docs-only state into:

```
CrossEngin/
├── README.md
├── LICENSE                          # Proprietary license at root (covers code, manifests, infra, tools)
├── CONTRIBUTING.md
├── .gitignore
│
├── docs/                            # MOVED from root in Phase 1 (was vision.md + adr/)
│   ├── vision.md
│   ├── LICENSE                      # CC-BY 4.0, scoped to this subtree
│   └── adr/
│       ├── 0000-template.md
│       ├── index.md
│       └── 0001..0025-*.md
│
├── apps/
│   ├── web/                         # Next.js — primary SaaS frontend (PWA-enabled)
│   ├── marketing/                   # Public marketing site (crossengin.com or .io)
│   ├── docs-site/                   # Developer docs (Nextra)
│   └── ops/                         # Internal admin (tenant ops, billing, AI runs review)
│
├── packages/
│   ├── kernel/                      # Meta-schema, dynamic entity engine, Postgres provisioning
│   ├── kernel-supabase/             # Supabase adapter (primary v1 — Round 1 decision)
│   ├── kernel-prisma/               # Prisma adapter (used internally by kernel-supabase + on-prem)
│   ├── auth/                        # RBAC v2 + ABAC (OPA Rego via opa-wasm) + audit + sessions
│   ├── workflow/                    # React Flow designer + Inngest runtime + DSL
│   ├── ai-architect/                # Planner-executor agent, interview UI, kernel tools, RAG
│   ├── ai-providers/                # Fireworks (v1), Together, OpenAI, Anthropic, vLLM adapters
│   ├── embeddings/                  # BGE-large/M3 self-hosted via inference container
│   ├── ui/                          # shadcn design system + dashboard shell
│   ├── ui-renderers/                # Generic List / Record / Kanban / Calendar / Map / Dashboard / Form
│   ├── integrations/                # Webhooks, OAuth, HL7/FHIR/UBL/EDI/Stripe/QuickBooks
│   ├── compliance/                  # 21 CFR Part 11 / EU GMP / UAE MoH / HIPAA / GDPR packs
│   ├── reporting/                   # Report engine + OLAP (ClickHouse adapter)
│   ├── files/                       # R2/S3 + signed URLs + virus scan
│   ├── jobs/                        # Inngest wrapper + queue primitives
│   ├── search/                      # Postgres FTS + pgvector + Typesense adapter
│   ├── observability/               # OTel + Sentry + pino + per-tenant scoping
│   ├── billing/                     # Stripe + per-tenant flat tier + AI usage metering
│   ├── i18n/                        # Translation, currency, locale, RTL
│   ├── pwa/                         # Service worker + IndexedDB sync + offline queue
│   ├── capacitor-plugins/           # Native plugins (BLE/ESC-POS/NFC/camera) — Phase 7+
│   ├── types/                       # Shared TS types
│   ├── config/                      # ESLint / TS / Prettier presets
│   └── testing/                     # Test utils, fixtures, factories
│
├── manifests/                       # Declarative app packs (proprietary)
│   ├── _starter/                    # Template for new manifests
│   ├── operate-pharma-healthcare/   # First-class citizen (v1 lighthouse)
│   │   ├── community-pharmacy/
│   │   ├── polyclinic/
│   │   ├── hospital/
│   │   └── pharma-manufacturer/
│   ├── operate-retail-fnb/          # Post-v1
│   ├── operate-construction-re-fm/  # Post-v1
│   ├── operate-profserv-staffing/   # Post-v1
│   ├── govern-procurement/          # Year 3
│   ├── govern-citizen-services/     # Year 3+
│   ├── heal-vaccination-registry/   # Year 3
│   ├── educate-university/          # Year 4
│   └── serve-ngo-program/           # Year 4
│
├── infra/
│   ├── terraform/                   # Supabase + Vercel + Cloudflare + GPU host modules
│   ├── helm/                        # On-prem Kubernetes charts (Phase 6+)
│   ├── docker/                      # Compose files + container definitions
│   ├── inference/                   # BGE / future self-hosted LLM container definitions
│   └── cdn/                         # Cloudflare worker scripts
│
├── tools/
│   ├── manifest-cli/                # Generate / validate / apply manifests
│   ├── kernel-migrate/              # Per-tenant schema migration runner
│   ├── seed/                        # Seed data per manifest
│   ├── architect-eval/              # AI Architect eval suite runner
│   └── codemod/                     # Codemods for migrating /home/user/ERP code
│
├── .github/workflows/               # CI/CD
├── turbo.json                       # Turborepo
├── pnpm-workspace.yaml
└── package.json
```

The docs are moved from the repository root into `docs/` when Phase 1 lands. `git mv` preserves history.

### Tooling choices

- **Package manager:** pnpm with workspaces.
- **Build orchestrator:** Turborepo.
- **TypeScript:** strict mode, `noEmit` invariant on every package.
- **Linting:** ESLint with shared config in `packages/config`.
- **Formatting:** Prettier.
- **Testing:** Vitest (units), Playwright (E2E), MSW (HTTP mocks).

Rationale: pnpm + Turborepo is the standard for TypeScript monorepos in 2026 and is well-supported by Vercel for SaaS deployment.

### Migration plan from /home/user/ERP

#### What migrates (salvaged)

| From `/home/user/ERP` | To new monorepo | Notes |
|---|---|---|
| The 22 GxP/QA-QC Prisma models | `manifests/operate-pharma-healthcare/_seed/prisma` | Seed for the pharma manifest. |
| Auth + RBAC infrastructure | `packages/auth` | Refactored to add ABAC and per-tenant audit. |
| shadcn-based design system | `packages/ui` + `apps/web` | Extracted from the monolithic Next.js app. |
| Dashboard shell | `apps/web` | Cleaned up; data-fetching layer replaced. |
| Data dictionaries / lookups | `manifests/operate-pharma-healthcare/lookups` | Kept as-is. |
| Working API routes against real Prisma | reference patterns in `packages/kernel-prisma` | The few that aren't mocked. |

#### What gets rebuilt (not salvaged)

| Existing | Why rebuilt |
|---|---|
| All `INITIAL_*` mock arrays | Mocks. Have no place in v1. |
| Page-level monoliths (2,000+ line files) | Replaced by generic renderers + manifests. |
| TODO-laden incomplete features | Replaced by feature-complete equivalents. |
| Auth without ABAC / RLS | Replaced per ADR-0002 and ADR-0008. |
| Module duplication | Eliminated by kernel + manifest abstraction. |

#### Migration phases

**Phase 0 (Week 1–2) — Cleanup of /home/user/ERP**

Goal: get the existing repo to an "honestly working" state before the new monorepo opens. Output: same feature surface, zero mocks, real RLS, real observability.

Steps:

1. Audit and delete every `INITIAL_*` array; replace with TanStack Query against real `/api/...`.
2. Wire every existing API route to real Prisma + tenancy.
3. Enable Postgres RLS with `tenantId` policies, set per-request from session.
4. Install OpenTelemetry, Sentry, pino structured logs.
5. Split the largest page monoliths into list/detail components.
6. Add CI hardening: contract tests on every route, Playwright smoke on the dashboard, type-coverage gate.
7. Land all changes on `claude/design-erp-system-OvuW9` in one-PR-per-chunk fashion.

This work happens in `/home/user/ERP`, not in the new monorepo.

**Phase 1 (Week 3+) — Open the monorepo's code surface**

`git mv vision.md docs/vision.md` and `git mv adr docs/adr` in `amoufaq5/CrossEngin`. Add `docs/LICENSE` (CC-BY 4.0) covering `docs/`. Replace the root `LICENSE` with proprietary terms covering code/manifests/infra/tools. Initialize package skeletons: `packages/kernel`, `packages/kernel-supabase`, `packages/auth`, `packages/types`, `packages/config`, `packages/testing`, `apps/web` (empty shell), `manifests/_starter`, root config files (`pnpm-workspace.yaml`, `turbo.json`, `package.json`).

At Phase 1 opening, **archive `amoufaq5/ERP`** as read-only with the `archived-pre-crossengin` tag — earlier than the original "after Phase 5" plan (Round 8 decision).

**Phase 2–3 (Months 2–5) — Kernel and AI Architect build-out**

In the unified monorepo. The archived `amoufaq5/ERP` remains as historical record and salvage reference.

**Phase 4 (Months 5–7) — Migrate Pharma + Healthcare manifest**

Copy the GxP/QA-QC Prisma models into `manifests/operate-pharma-healthcare/_seed/prisma`. Rewrite them as manifest declarations. The kernel + manifest engine provisions the equivalent Postgres schemas per tenant.

**Phase 5 (Months 7–8) — Launch SaaS**

Vercel deploy of `apps/web`. Marketing site at `crossengin.com` (primary if available) or `crossengin.io` (alternate). Pricing, Stripe billing, customer onboarding.

`amoufaq5/ERP` is already archived as of Phase 1. Its README points to `amoufaq5/CrossEngin` as the current codebase.

### Branch strategy

In `amoufaq5/CrossEngin`:

- **`main`** is always deployable. Vercel auto-deploys `apps/web` from main to production after green CI. The local-proxy push limitation observed during this session (proxy denies pushes to main) is worked around via PR + squash-merge for now; if the proxy is reconfigured, direct push to main is acceptable.
- **Feature branches** named `<owner>/<short-description>` or `<owner>/<topic>/<sub-topic>`. Merged via squash PR.
- **Release tags** on main: `v0.1.0` at end of Phase 1, `v0.x` through Year 1, `v1.0.0` at first paying customer.

For the archived `/home/user/ERP`:

- Phase 0 work happens on **`claude/design-erp-system-OvuW9`** (the assigned branch). Merged to `main` of ERP repo before Phase 1 archives ERP.

### Docs and code coexistence in one repo

- **`/docs/`** holds vision.md and ADRs. Licensed CC-BY 4.0 (a `docs/LICENSE` file scopes the permissive license to this subtree).
- **All other top-level directories** (`apps/`, `packages/`, `manifests/`, `infra/`, `tools/`) are covered by the proprietary `/LICENSE` at the root.
- **`/apps/docs-site/`** is a Nextra-rendered public developer docs site, generated partly from `/packages` source comments and partly from hand-written prose. Distinct from `/docs/adr/` (architectural decision records) — `apps/docs-site` is API reference + manifest cookbook + AI Architect prompt library.
- PR titles that touch only `docs/` may carry `docs:` prefix and skip code review by domain experts; PRs that touch any non-`docs/` path go through normal code review.

## Alternatives considered

### Option A — Single repo (`amoufaq5/ERP` evolved into a monorepo)

Keep the existing repo, refactor in place. Add `packages/`, `manifests/`, `infra/` alongside the existing `app/`.

- **Pros:** No migration. Existing git history preserved. No new repo creation.
- **Cons:** The repo's name and history are tied to the old ERP framing. Cleaning up old code WHILE building the kernel in the same repo is operationally messy. Branch hygiene gets complicated. The mock-heavy state of the existing app contaminates the kernel work.
- **Why not:** Clean substrate matters more than git history preservation. The cost of starting fresh is one-time; the cost of intertwined history is permanent.

### Option B — Polyrepo (many small repos)

`packages/kernel` → its own repo. Each manifest → its own repo. Each app → its own repo.

- **Pros:** Independent releases. Smaller blast radius per repo. Clean ownership boundaries.
- **Cons:** Cross-package changes require coordinated PRs across multiple repos. Dependency version drift. Higher CI overhead. Solo-to-duo team cannot maintain 20+ repos.
- **Why not:** Operational overhead exceeds benefit at our team size.

### Option C — Three repos (substrate, apps, manifests)

`amoufaq5/crossengine-core` (kernel + AI Architect), `amoufaq5/crossengine-apps` (web + ops + marketing), `amoufaq5/crossengine-manifests` (all manifest packs).

- **Pros:** Cleaner separation between substrate and product layers. Each repo can be open-sourced or closed independently. Manifests have a natural home.
- **Cons:** Three repos to coordinate releases across. CI duplication. pnpm workspaces don't span repos, so dependency management gets harder. Cross-cutting changes (kernel concept used by AI Architect requiring manifest spec updates) require three PRs and version-pinning.
- **Why not:** Real coupling between substrate, apps, and manifests dominates. Monorepo wins.

### Option D — Use the existing /home/user/ERP repo, but rebrand

Rename the repo `amoufaq5/ERP` → `amoufaq5/crossengine`, keep git history, evolve in place.

- **Pros:** History preserved. No migration. No new repo.
- **Cons:** Same problems as Option A. The existing code's state contaminates the new direction. Rename is cosmetic.
- **Why not:** Same reasoning as Option A.

## Consequences

### Positive

- **Clean substrate.** New monorepo starts uncontaminated by mock-heavy code, page monoliths, or TODO accumulation.
- **Single source of dependencies.** pnpm workspaces + Turborepo allow atomic cross-package changes.
- **Manifests are first-class.** They live in the same repo as the kernel; engineers can iterate on manifest + kernel changes together.
- **Existing /home/user/ERP work is preserved.** Phase 0 cleanup makes it presentable; it then becomes archived rather than abandoned.
- **Docs/code separation.** ADRs live in their own repo, can be reviewed without code-review noise.
- **Future on-prem and BYOC packaging.** Monorepo with explicit `infra/helm/` and `infra/terraform/` directories naturally supports packaging the kernel + apps as deployable artifacts.

### Negative

- **Initial migration cost.** Phase 1 includes ~1 week of monorepo scaffolding + ~2 weeks of moving auth/UI/Prisma assets from ERP to the new monorepo. Not free.
- **Existing /home/user/ERP git history doesn't carry over.** People who want to know "when did we add the QA/QC models?" will find it in the ERP repo's history, not in the new monorepo's. Acceptable.
- **Two repositories to monitor.** Docs and code. Minor admin overhead.
- **Allowlist dependency.** The new monorepo cannot be created until the harness allowlist supports it. Until then, ADRs progress; code waits.

### Neutral

- **One repository name, `amoufaq5/CrossEngin`,** matches the brand exactly. No naming mismatch between docs and code.
- **Mixed-license repository:** unusual but well-tooled (npm `repository.directory`, GitHub linguist handles per-subtree licensing). The two LICENSE files are unambiguous.

### Reversibility

**Low cost reversibility for new monorepo.** Until code is in production, the layout can be reshuffled. Renaming the monorepo after launch costs SEO, partner integrations, and CI configurations.

**Moderate cost reversibility for the docs/code split.** If we later decide ADRs should live alongside code, we move them into `docs-internal/` in the monorepo. Git history of the docs repo is preserved as historical record.

## Implementation notes

- **Initial commits in the new monorepo** should be small and focused — one PR per package skeleton, then incremental fill-in. Avoid a single 100K-line "initial commit."
- **Codemods for migration** live in `tools/codemod/`. Examples: a codemod that takes a Prisma model from the old repo and emits a manifest entity declaration; a codemod that rewrites imports from `@app/ui/...` to `@crossengine/ui/...`.
- **The existing ERP branch** `claude/design-erp-system-OvuW9` carries Phase 0 work and is merged to ERP's `main` before being archived.
- **Tag the ERP repo** with `archived-pre-crossengine` once migration completes.
- **The docs repo (`amoufaq5/CrossEngin`) does not move.** It remains the home for vision.md and ADRs.

## Open questions

### Resolved (2026-05-11)

- **Final monorepo name:** `amoufaq5/CrossEngin` (unified docs + code).
- **ERP archive timing:** at Phase 1 monorepo-opening (was: after Phase 5 launch).
- **Open-source vs. closed-source:** everything closed source. `docs/` subtree remains CC-BY 4.0 for transparency; code/manifests/infra/tools are proprietary.
- **`packages/kernel-supabase`:** built alongside `packages/kernel-prisma` from day one (Round 1 picked Supabase as the v1 host).
- **Internal ADR mirror:** moot — docs and code share one repo, so no mirror is needed.

### Still open

| Question | Owner | Deadline |
|---|---|---|
| GPU host for the self-hosted embedding container (Fly Machines, RunPod, Lambda Labs, or AWS GPU spot). Latency to Frankfurt vs. cost. | amoufaq5 | Phase 2 |
| LICENSE wording for the proprietary root license. Off-the-shelf (BSL with infinity date, modified Apache) or hand-written restrictive terms? | amoufaq5 | Phase 1 |
| `apps/docs-site` framework: Nextra vs. Mintlify vs. custom Next.js. | amoufaq5 | Phase 4 |
| Manifest authoring tooling location: under `tools/manifest-cli` only, or also a dedicated `apps/manifest-studio` for visual editing of compliance-grade manifests? | amoufaq5 | Phase 3 |

## References

- ADR-0001 (Platform positioning) — defines sub-brand names that map to manifest folder names.
- ADR-0003 (Meta-schema) — defines how manifests are validated and applied.
- ADR-0020 (Build / packaging / deployment) — defines how the monorepo builds and deploys for SaaS, on-prem, BYOC.
- [vision.md](../vision.md), section 7 (five-year arc) — phase numbering and goals.
- The current state of `/home/user/ERP` (as of 2026-05-11).
