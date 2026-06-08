# CrossEngin

> **Status — Phase 3 in progress.** 64 packages + 4 apps, 125
> meta-schema tables, **6,891 offline tests + 39 gated real-Postgres
> integration tests + five CI gates** (schema-drift · incident-drift ·
> PHI-encryption · gateway-execution · slo-enforcement-drift), all green,
> zero type errors. Phase 2
> (the four runtime pillars) is complete; Phase 3 has shipped the serving
> keystone (`operate-runtime` + `apps/operate-server`), the distributed
> workflow worker (`workflow-worker` + `apps/workflow-worker`), and the
> redaction-aware UI layer (`operate-web` + `operate-web-react` +
> `apps/operate-web` — view models → SSR React → hydrated pages), all proven
> end-to-end against real Postgres. ADRs 0001–0156 are drafted in
> `docs/adr/`. Resuming work? Read **[CLAUDE.md](CLAUDE.md)** — the
> concise state snapshot.

This repository is the home of **CrossEngin** — an AI-native application
platform. **Three layers:** a multi-tenant **kernel**, declarative
**manifests** that tell the kernel what application to be, and an **AI
Architect** agent that authors manifests through conversation.

ERP (under the **CrossEngin Operate** sub-brand) is the first family of
applications built on CrossEngin. The platform also targets public-sector
digitalization (**Govern**), national-scale healthcare (**Heal**),
education (**Educate**), NGOs (**Serve**), bespoke self-service apps
(**Build**), and a white-label channel for integrators (**Partner**).

## Architecture in three layers

1. **Kernel** (`packages/kernel`). The substrate: a **meta-schema** of 125
   platform-level Postgres tables, deterministic DDL emission, and
   manifest validate / diff / patch / topology / hash. `kernel-pg`
   executes that DDL against a real Postgres (advisory-lock-gated,
   idempotent, drift-detecting).

2. **Manifests.** A declarative `Manifest` — entities, relations, roles,
   permissions, `entityLifecycle` workflows, jobs, views — is the source
   of truth for an application. Vertical **packs** (`pack-erp-core`,
   `-retail`, `-healthcare`, `-grocery`) ship real manifests and compose
   via `meta.extends` lineage.

3. **AI Architect** (`ai-architect` + `architect-cli`). An agent that
   authors + edits manifests through conversation, with read tools
   (validate / hash / diff / summarize) and a human-in-the-loop write
   tool, persisting the full session to Postgres.

The platform runs on **four runtime pillars**, each a pure contract +
deterministic helpers, each with a Postgres-backed adapter:

- **DDL execution** — `kernel-pg` (apply the meta-schema, detect drift).
- **Cryptography** — `crypto` (real SHA-256 / BLAKE2b-512 / HMAC-SHA256 /
  Ed25519 + per-tenant key store), wired into pack signing, webhook HMAC,
  evidence sealing, tombstones, e-signatures.
- **Workflow execution** — `workflow-engine` (contracts) +
  `workflow-runtime` (event-sourced in-process executor) +
  `workflow-runtime-pg` (projection + replay) + `workflow-worker` (the
  distributed worker: parallel timer / retry / timeout / async-activity
  draining over the PG event log, with heartbeats + stale-worker
  incidents).
- **HTTP gateway** — `api-gateway` (contracts) + `api-gateway-runtime`
  (17-stage pipeline: auth → RBAC → idempotency → rate-limit →
  classification redaction → audit) + `api-gateway-pg` (stores). The
  **serving keystone** `operate-runtime` compiles a manifest into a live
  multi-tenant API over this gateway + a pluggable `EntityStore`.

Cross-cutting discipline (enforced by zod `superRefine` + the meta-schema
test suite): **tenant isolation by RLS** (every `tenant_id`-bearing table
has a row-level-security policy), **four-eyes** on privileged actions,
**state machines** with `canTransition*` helpers, **cryptographic
anchoring** (sha256 content addressing everywhere), and regulatory
**deadlines** (GDPR 72h breach, Art. 12(3) deletion).

## Package map by concern

`packages/<name>`, each `src/index.ts` re-exporting its modules. zod
schemas are the source of truth; types derive via `z.infer`.

- **Substrate.** `kernel`, `kernel-pg`, `crypto`, `types`, `config`,
  `testing`.
- **Identity, security, data.** `auth`, `sso`, `security`, `compliance`,
  `residency`, `files`.
- **AI surface.** `ai-providers`, `ai-providers-anthropic`,
  `ai-providers-openai`, `ai-router`, `ai-architect`, `ai-architect-pg`.
- **Runtime + operations.** `jobs`, `observability`,
  `observability-runtime`, `observability-runtime-pg`, `integrations`,
  `rate-limiting`, `api-gateway`, `api-gateway-runtime`, `api-gateway-pg`,
  `feature-flags`, `workflow-engine`, `workflow-runtime`,
  `workflow-runtime-pg`, `workflow-worker`, `operate-runtime`,
  `operate-runtime-pg`.
- **Reporting / search / UI / messaging.** `reporting`, `search`,
  `views`, `operate-web` (manifest → view-model compiler),
  `operate-web-react` (SSR React renderer), `i18n`, `notifications`.
- **Business operations.** `billing`, `finops`, `tenant-lifecycle`.
- **Delivery infrastructure.** `deploy`, `dr`, `edge`, `active-active`,
  `pwa`.
- **Developer / partner.** `sdk`, `sdk-clients`, `marketplace`,
  `migration`, `ml-training`.
- **Audit + compliance ops.** `incident-response`, `forensics`,
  `access-reviews`, `data-lineage`.
- **Vertical packs.** `pack-erp-core`, `pack-erp-retail`,
  `pack-erp-healthcare`, `pack-erp-grocery`.

## Apps

Four runnable binaries under `apps/` (each `src/*` + a `bin/`):

| app | binary | role |
|---|---|---|
| **`architect-cli`** | `crossengin` | author manifests — `init` / `validate` / `diff` / `patch` / `hash` / `apply` / `chat` (talks to Claude, tool dispatch, write proposals, `--persist` audit) |
| **`operate-server`** | `operate-server` | serve a manifest as a multi-tenant HTTP API (Node + edge/Workers), three `EntityStore`s (memory / pg JSONB / pg-columns typed+encrypted), API-key + JWT/JWKS auth — see [its README](apps/operate-server/README.md) |
| **`workflow-worker`** | `workflow-worker` | advance deferred workflow progression (8 modes: tick · claim · retry · timeout · execute · reap · resync · all) over the PG event log, with heartbeats + stale-worker incidents — see [its README](apps/workflow-worker/README.md) |
| **`operate-web`** | `operate-web` | serve a manifest as a redaction-aware UI — view models as JSON (`/ui/...`) + SSR React HTML pages (`/app/...`) with client hydration, API-key + JWT/JWKS auth, Node + edge/Workers |

## Meta-schema — the integration point

`packages/kernel/src/bootstrap/meta-schema.ts` is the central catalog of
125 platform-level Postgres tables. Every package that persists records
wires its `META_*` table definitions there; the kernel emits DDL
deterministically. The test suite enforces two invariants: every
`tenant_id`-bearing table has RLS enabled, and every FK resolves to a
table declared earlier. Adding tables means appending to the array +
updating `meta-schema.test.ts` (count, sorted names, column checks).

## Repository layout

```
CrossEngin/
├── docs/             vision + ADRs 0001-0156  (CC BY 4.0)
│   ├── vision.md
│   └── adr/          docs/adr/index.md is the running index
├── apps/             4 runnable binaries  (architect-cli, operate-server, workflow-worker, operate-web)
├── packages/         64 workspace packages
├── scripts/          emit-bootstrap.mjs, setup-integration-db.sh
├── .github/workflows/  ci.yml  (build/typecheck/offline + Postgres integration)
├── CLAUDE.md         project state snapshot for AI assistants
└── (root config)     pnpm-workspace.yaml, turbo.json, package.json
```

## How to read this repository

- **Human contributor?** Start with **[`docs/vision.md`](docs/vision.md)**
  (the north star), then **[`docs/adr/index.md`](docs/adr/index.md)** (the
  index of 156 architecture decisions). Individual ADRs live at
  `docs/adr/NNNN-<slug>.md`, following
  **[`0000-template.md`](docs/adr/0000-template.md)**.
- **AI assistant resuming work?** Start with **[CLAUDE.md](CLAUDE.md)** —
  the package map, cross-cutting invariants, meta-schema discipline,
  build/test commands, and the `go [letter]` workflow used to extend the
  codebase.

## Tooling + commands

pnpm workspaces + Turborepo, TypeScript strict, Vitest, Node ≥ 20, pnpm
≥ 9.

```bash
pnpm install                                # install workspace
pnpm -r build                               # build all packages (fast)
pnpm -r test                                # offline tests (~30s)
pnpm -r typecheck                           # type-check all packages
pnpm --filter @crossengin/<name> test       # one package
```

There is **no top-level lint script** yet (ESLint v9 flat-config
migration pending).

### Real-Postgres integration tests (gated)

The 24 integration tests in `apps/workflow-worker` + `apps/operate-server`
are skipped unless `CROSSENGIN_PG_TEST=1` (so the offline suite stays
hermetic). Provision a throwaway database + run them:

```bash
pnpm -r build
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres PGDATABASE=crossengin_test \
  bash scripts/setup-integration-db.sh
CROSSENGIN_PG_TEST=1 PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
  PGDATABASE=crossengin_test PGSSLMODE=disable \
  pnpm --filter @crossengin/workflow-worker-app test   # and --filter @crossengin/operate-server
```

`.github/workflows/ci.yml` runs both — an offline job and a `postgres:16`
integration job — automatically.

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

## ADR statuses

| Status | Meaning |
|---|---|
| **Proposed** | Drafted. Under review. Not yet binding. |
| **Accepted** | Reviewed and adopted. Implementable. Constrains future architecture. |
| **Superseded by ADR-XXXX** | A later decision replaces this one. Both cross-reference each other. |
| **Deprecated** | No longer applies, no replacement. |

Accepted ADRs are not rewritten — a new ADR supersedes the old one.

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)**. New packages follow the
existing layout (`package.json`, `tsconfig.json`, `vitest.config.ts`,
`src/index.ts` re-exporting modules, matching `src/*.test.ts`); add any
`META_*` tables to `packages/kernel/src/bootstrap/meta-schema.ts`; aim for
15–30 tests per module. [CLAUDE.md](CLAUDE.md) §Workflow has the full
shape.

## License

Dual-licensed:

- **`docs/`** (vision, ADRs) — Creative Commons Attribution 4.0
  International (CC BY 4.0). See **[`docs/LICENSE`](docs/LICENSE)**.
- **All other paths** — proprietary. See **[`LICENSE`](LICENSE)**.
