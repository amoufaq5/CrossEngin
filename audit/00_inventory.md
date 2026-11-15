# 00 — Repository inventory

Audit target: `amoufaq5/CrossEngin` at commit `7bc8db9` (2026-10-14), branch `claude/affectionate-archimedes-nf0hx3` (identical to `main` at audit start). All figures below were measured on this checkout on 2026-11-15; commands are in `01_commands_and_results.md`.

## 1. What it is

A TypeScript monorepo for a multi-tenant, manifest-driven ERP platform. A "manifest" (entities, relations, roles, permissions, workflows, jobs, views) is compiled at boot into a REST API; an LLM "Architect" drafts manifests; "packs" (core ERP + 6 verticals) are prebuilt manifests.

## 2. Size

| Measure | Value |
|---|---:|
| Tracked files | 2,499 |
| TypeScript/TSX files | 1,825 (1,796 `.ts`, 29 `.tsx`) |
| Non-test source LOC (`.ts/.tsx/.mjs/.css`) | 224,512 in 1,076 files |
| Test LOC (`*.test.ts`) | 250,390 in 753 files |
| Markdown | 375 files (358 ADRs = 45,124 lines; `CLAUDE.md` alone is 610 KB) |
| Workspace members | 87 packages + 3 apps |
| Commits visible | 50 (shallow clone, depth 50; 2026-08-17 → 2026-10-14) |
| Authors | 1 (`amoufaq5`) |

History caveat: the clone is **shallow** (`git rev-parse --is-shallow-repository` → `true`), so only the last 50 commits could be scanned. Earlier history is NOT VERIFIED.

## 3. Languages, frameworks, tooling

| Layer | Technology |
|---|---|
| Language | TypeScript 5.6 (strict), Node ≥ 20 (audited on v22.23.4) |
| Package manager / build | pnpm 9.12 workspaces, Turborepo 2, `tsc` per package (no bundler) |
| Validation | zod 3 (81 of 87 packages) |
| Database | PostgreSQL 16 via `pg` 8 (single runtime dependency, in `packages/kernel-pg`); extensions `pg_uuidv7`, `pgcrypto` |
| HTTP API | Hand-rolled on Node `http` — no Express/Fastify/Nest |
| Web UI | Next.js 14.2.35 (app router), React 18, Tailwind 3 |
| Tests | vitest 2.1.9 |
| Lint | ESLint 9 present in `packages/config` but not wired (see results) |
| Infra | Docker Compose (Postgres, migrate, api, web, Caddy 2); no Kubernetes/Terraform/Helm |
| CI/CD | **None** — no `.github/`, no hooks, no pipeline of any kind |

### External runtime dependencies (entire workspace)

`zod@^3.23`, `pg@^8.13`, `next@^14.2.5`, `react@^18.3.1`, `react-dom@^18.3.1`, and `vitest@^2.1.0` (declared as a runtime dependency of `packages/testing`). Everything else — JWT verification, SSE parsing, AWS SigV4, Stripe/Twilio/FCM/PagerDuty/Slack clients, the HTTP router, cron parser, ICU MessageFormat parser — is written in-house.

Dev dependencies: `typescript`, `vitest`, `turbo`, `@types/node`, `@types/pg`, `@types/react(-dom)`, `tailwindcss`, `postcss`, `autoprefixer`, plus ESLint/Prettier via `packages/config`. Resolved tree: 412 packages.

## 4. Entry points

| Binary / process | Path | Type |
|---|---|---|
| `operate-server` | `apps/operate-server/src/bin/operate-server.ts` → `node.ts` (4,716 lines), `cli.ts` (3,058 lines, 144 distinct `--flags`) | Long-running API server; also `rekey`, `replay`, credential subcommands |
| `crossengin` | `apps/architect-cli/src/bin/crossengin.ts` | One-shot CLI: init/validate/diff/patch/hash/apply/chat/license |
| `crossengin-pg` | `packages/kernel-pg/src/bin/crossengin-pg.ts` | One-shot CLI: schema apply/plan, column encryption |
| `operate-web` | `apps/operate-web` (`next start`, :3000) | Next.js UI + `/api/[...path]` proxy to the API |
| `web-ui/server.mjs` | `web-ui/` | Dev-only demo, outside the workspace |

## 5. Infra / config files

`deploy/docker-compose.yml` (+ `.ai.yml`, `.ai-gpu.yml`), `deploy/Dockerfile`, `deploy/postgres/Dockerfile`, `deploy/postgres/init/00-extension.sql`, `deploy/supabase/00-uuidv7.sql`, `deploy/Caddyfile`, `deploy/.env.example`, `turbo.json`, `pnpm-workspace.yaml` (declares `manifests/*` and `tools/*`, neither exists), `.prettierrc.cjs`, `.dockerignore`, `.gitignore`, `scripts/run-dev.ps1` (PowerShell only).

There are **no SQL migration files**. The schema is a TypeScript catalog (`packages/kernel/src/bootstrap/meta-schema.ts`, 12,181 lines, 146 tables) diffed against `pg_catalog` at deploy time ("reconciliation"); tenant entity tables are generated from the manifest at server boot.

## 6. Module map and LOC

Grouping (source LOC, tests excluded):

| Group | Members | Src LOC |
|---|---|---:|
| API server app | `apps/operate-server` | 50,207 |
| Schema catalog + manifest compiler | `kernel`, `kernel-pg`, `types`, `config` | 23,631 |
| ERP serving engine | `operate-runtime`, `operate-runtime-pg` | 15,500 |
| ERP content (manifests) | `pack-erp-core` + 6 vertical packs | 6,719 |
| Web UI | `apps/operate-web` | 10,031 |
| Workflow + jobs | `workflow-*`, `jobs` | 16,147 |
| Request edge + identity + crypto | `api-gateway*`, `auth`, `crypto*`, `sso`, `security`, `rate-limiting` | 15,704 |
| AI | `ai-*` (8 packages), `apps/architect-cli` | 10,140 |
| Notifications | `notifications`, `notification-providers` | 9,714 |
| Tenant lifecycle / GDPR erasure | `tenant-lifecycle*` | 7,745 |
| Test infrastructure / workspace rules | `testing` | 12,512 |
| Other runtime + persistence | incident, DR, observability, feature flags, forensics, access reviews, certification, billing, marketplace, residency | ~27,000 |
| Contracts-only (schemas, no executor) | active-active, compliance, data-lineage, deploy, edge, finops, migration, ml-training, pwa, sdk, sdk-clients, files, i18n, search, reporting, views, integrations | ~17,000 |

Full per-module table:

| Module | Src files | Src LOC | Test files | Test LOC |
|---|---:|---:|---:|---:|
| `apps/operate-server` | 125 | 50207 | 121 | 65741 |
| `packages/kernel` | 31 | 15408 | 18 | 8903 |
| `packages/testing` | 21 | 12512 | 16 | 7727 |
| `apps/operate-web` | 54 | 10031 | 0 | 0 |
| `packages/operate-runtime` | 37 | 9635 | 35 | 11317 |
| `packages/kernel-pg` | 20 | 7798 | 16 | 10357 |
| `packages/notification-providers` | 17 | 6938 | 12 | 7754 |
| `packages/workflow-runtime-pg` | 28 | 6676 | 26 | 9769 |
| `packages/operate-runtime-pg` | 23 | 5865 | 21 | 7315 |
| `packages/tenant-lifecycle-pg` | 10 | 4523 | 7 | 6654 |
| `packages/pack-erp-core` | 24 | 3676 | 6 | 592 |
| `packages/workflow-runtime` | 10 | 3609 | 8 | 5683 |
| `packages/tenant-lifecycle` | 10 | 3222 | 8 | 5353 |
| `apps/architect-cli` | 12 | 2969 | 10 | 3675 |
| `packages/api-gateway-runtime` | 11 | 2825 | 10 | 3688 |
| `packages/workflow-engine` | 10 | 2814 | 8 | 3039 |
| `packages/notifications` | 11 | 2776 | 9 | 4181 |
| `packages/access-reviews-runtime-pg` | 12 | 2136 | 9 | 1884 |
| `packages/incident-response-runtime-pg` | 11 | 2108 | 9 | 3258 |
| `packages/feature-flags-pg` | 8 | 2018 | 5 | 2197 |
| `packages/api-gateway-pg` | 9 | 1990 | 7 | 2708 |
| `packages/crypto-pg` | 8 | 1925 | 4 | 2494 |
| `packages/access-reviews` | 11 | 1848 | 9 | 2151 |
| `packages/observability-runtime` | 11 | 1814 | 9 | 2088 |
| `packages/crypto` | 13 | 1792 | 11 | 2628 |
| `packages/sso` | 9 | 1695 | 7 | 1691 |
| `packages/auth` | 9 | 1691 | 7 | 4899 |
| `packages/api-gateway` | 9 | 1684 | 7 | 1768 |
| `packages/jobs` | 11 | 1639 | 9 | 2104 |
| `packages/dr-runtime-pg` | 11 | 1589 | 8 | 2262 |
| `packages/data-lineage` | 9 | 1479 | 7 | 1617 |
| `packages/feature-flags` | 9 | 1466 | 7 | 1577 |
| `packages/forensics` | 9 | 1391 | 7 | 1683 |
| `packages/sdk` | 10 | 1373 | 8 | 1807 |
| `packages/incident-response` | 8 | 1371 | 6 | 1621 |
| `packages/rate-limiting` | 9 | 1369 | 7 | 1408 |
| `packages/marketplace` | 9 | 1368 | 7 | 1875 |
| `packages/access-reviews-runtime` | 9 | 1344 | 6 | 1337 |
| `packages/migration` | 8 | 1269 | 6 | 1551 |
| `packages/ai-architect-runtime` | 8 | 1262 | 6 | 1492 |
| `packages/ai-architect` | 14 | 1248 | 11 | 1503 |
| `packages/active-active` | 8 | 1229 | 6 | 1344 |
| `packages/ml-training` | 8 | 1227 | 6 | 1457 |
| `packages/deploy` | 9 | 1181 | 7 | 1585 |
| `packages/compliance` | 9 | 1167 | 4 | 891 |
| `packages/sdk-clients` | 8 | 1155 | 6 | 1270 |
| `packages/observability-runtime-pg` | 9 | 1106 | 7 | 2339 |
| `packages/edge` | 8 | 1102 | 6 | 1368 |
| `packages/incident-response-runtime` | 8 | 1048 | 6 | 2399 |
| `packages/billing` | 10 | 1010 | 8 | 1054 |
| `packages/workflow-worker` | 13 | 956 | 8 | 1220 |
| `packages/dr` | 8 | 951 | 6 | 1230 |
| `packages/finops` | 8 | 935 | 6 | 1142 |
| `packages/forensics-pg` | 10 | 923 | 7 | 1147 |
| `packages/pwa` | 8 | 903 | 6 | 931 |
| `packages/views` | 9 | 876 | 7 | 979 |
| `packages/ai-providers-openai` | 7 | 826 | 5 | 817 |
| `packages/ai-providers-anthropic` | 7 | 798 | 5 | 940 |
| `packages/i18n` | 9 | 786 | 7 | 702 |
| `packages/marketplace-runtime-pg` | 9 | 751 | 4 | 349 |
| `packages/certification-runtime` | 7 | 735 | 5 | 656 |
| `packages/security` | 10 | 733 | 8 | 838 |
| `packages/dr-runtime` | 7 | 727 | 5 | 889 |
| `packages/ai-providers-local` | 7 | 726 | 5 | 525 |
| `packages/ai-router` | 7 | 719 | 5 | 825 |
| `packages/ai-architect-pg` | 7 | 649 | 5 | 768 |
| `packages/reporting` | 7 | 626 | 5 | 720 |
| `packages/pack-erp-construction` | 10 | 611 | 4 | 426 |
| `packages/billing-stripe` | 9 | 589 | 6 | 591 |
| `packages/marketplace-runtime` | 7 | 586 | 4 | 587 |
| `packages/billing-runtime` | 9 | 578 | 6 | 318 |
| `packages/search` | 7 | 570 | 5 | 684 |
| `packages/observability` | 7 | 570 | 5 | 696 |
| `packages/residency` | 6 | 556 | 4 | 516 |
| `packages/pack-erp-retail` | 10 | 545 | 4 | 386 |
| `packages/pack-erp-healthcare` | 10 | 533 | 5 | 481 |
| `packages/pack-erp-government` | 10 | 503 | 4 | 420 |
| `packages/certification-runtime-pg` | 6 | 502 | 3 | 413 |
| `packages/pack-erp-education` | 10 | 488 | 4 | 392 |
| `packages/billing-runtime-pg` | 8 | 486 | 5 | 372 |
| `packages/ai-providers` | 7 | 483 | 3 | 592 |
| `packages/files` | 7 | 476 | 5 | 584 |
| `packages/ai-architect-runtime-pg` | 7 | 460 | 3 | 654 |
| `packages/workflow-signal-bridge` | 7 | 453 | 5 | 840 |
| `packages/types` | 10 | 398 | 5 | 624 |
| `packages/pack-erp-grocery` | 10 | 363 | 3 | 387 |
| `packages/integrations` | 4 | 330 | 2 | 490 |
| `packages/residency-runtime` | 5 | 113 | 2 | 106 |
| `packages/residency-runtime-pg` | 4 | 94 | 1 | 95 |
| `packages/config` | 1 | 27 | 0 | 0 |

## 7. First-pass observations (to be verified in the deep review)

1. `deploy/.env.example` (HEAD, commit `7bc8db9`) contains what appears to be a real Postgres password (line with `POSTGRES_PASSWORD=`) and, at line 117, a string in the format of a live Anthropic API key (`sk-ant-usr-1-ARL0…`), plus a personal e-mail address. Validity NOT tested (would require calling the provider). Treat as compromised.
2. `README.md` is badly stale: it describes "51 packages + 1 app, 119 meta-schema tables, 5,768 tests"; the tree has 87 + 3 and 146 tables.
3. No CI, no git hooks. Quality gates run only when a human runs them.
4. One author, 50 visible commits in two months for ~475k lines; `CLAUDE.md` describes an AI-assistant-driven workflow. Bus factor = 1.
5. `LICENSE` is a self-described placeholder ("final proprietary license wording is pending").
6. `pnpm audit`: 73 advisories (6 critical, 32 high, 31 moderate, 4 low) across 412 packages; the production-relevant ones are all in `next@14.2.35`.
