# ADR-0439: The web is patched, the image is unprivileged, and every backup is test-restored

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0382 (the CI pipeline and the pre-commit hook this extends), ADR-0390 (the documented backup procedure that destroyed what it kept), ADR-0357 (the `api` healthcheck), ADR-0424 (the confined role the image runs the API as), ADR-0420 (the secret-value rule), ADR-0307 (build versus typecheck) |

## Context

The external due-diligence audit ranked three findings in the deployment, and the verified report
recorded all three as open or only partly fixed at `f6faf05`.

**H-26**: `apps/operate-web` declared `"next": "^14.2.5"` and the lockfile resolved
`next@14.2.35`, which the audit reported as carrying 2 critical and 8 high advisories. Measured
across the workspace, `pnpm audit` reported **68** advisories, 6 critical and 31 high, and CI ran no
audit step. The domain notes record what the app actually exercises: no `next/image`, no
`"use server"`, no rewrites — so the image-optimiser and Server Action advisories are likely not
reached by app code, while `/_next/image` still exists under `next start` and the App Router RSC
denial-of-service advisories do apply. **14.2.35 is the last 14.x release and still carries the
criticals**, so there was no fix on the 14 line; the lowest release clearing every critical and high
advisory is **15.5.28**. Next 15.5.x also pins a vulnerable postcss (8.4.31).

**H-22** (partly fixed by ADR-0382 and ADR-0390): CI and the hook existed, but **`pnpm lint` exited
1** — `next lint` with no config prompts interactively and the non-TTY read cancels it. The v9 flat
config in `packages/config/eslint/base.mjs` was referenced by nothing, and ESLint 9 is deprecated.
CI had no lint step and no dependency audit. And **no compose file ran a backup**: the services were
`db`, `extensions`, `migrate`, `api`, `web` and `caddy`, and a restore was manual.

**M-24**: `deploy/Dockerfile` was a single stage `FROM node:20-bookworm-slim` (Node 20 is EOL), with
no `USER` — so it ran as **root** — `COPY . .`, dev dependencies installed and the web built twice.
Measured: **1.41 GB**, `/app` 827 MB, 253 store entries, the whole toolchain inside. The compose
stack used `ollama/ollama:latest`, `caddy:2` and `postgres:16-bookworm`, set no memory limit and no
log rotation on any service, and gave `web` no healthcheck. `deploy/postgres/Dockerfile`'s comment
said its versions float.

## Decision

**H-26: upgrade, then gate.**

- `next` 15.5.29 (the lockfile resolves 15.5.29 and React 19.3.1), postcss 8.5.23, and four
  `pnpm.overrides`: `next>postcss` `^8.5.23`, `brace-expansion@^1` and `@^5`, `js-yaml@^4`.
  `engines.node` is `>=22`.
- Next 15's asynchronous `params`: the four dynamic pages (`app/e/[slug]`, `app/e/[slug]/[id]`,
  `app/platform/[id]`, `app/platform/users/[id]`) read them through `use(params)`, and the proxy
  route reads `(await params).path`.
- CI's `verify` job runs **`pnpm audit --audit-level=high --prod`** immediately after install.
  Six advisories are declared in `pnpm.auditConfig.ignoreGhsas`, each with a reason in
  `CI_AUDIT_EXCEPTIONS`, and `auditExceptionDisagreements` compares the two **in both directions**.
  Three reasons, each checkable:
  - `dev_tooling_not_shipped` — vitest 2.1.9 (critical; fixed in 3.2.6), two tinypool criticals
    (vitest 3.2.6 still pins tinypool ^1; vitest 4 drops it) and vite 5.4.21 (high). They reach
    `--prod` only because `@crossengin/testing` lists vitest as a runtime dependency. The fence
    reads every member's `dependencies` to confirm no shipped member lists the `via` package.
  - `no_patched_version` — picomatch, whose patched range is empty.
  - `fix_is_a_major_migration` — zod, whose fix is 4.6.6 against the workspace's 3.25.76.

**H-22: lint really lints, and the stack backs itself up.**

- `"lint": "eslint ."` at the root, on ESLint 10, `@eslint/js` 10 and typescript-eslint 8.73, with a
  root `eslint.config.mjs` importing `packages/config/eslint/base.mjs` — the config that existed
  and was read by nothing. The current findings are recorded as **498 suppressions in 194 files**
  (`eslint-suppressions.json`), so a *new* violation fails while the backlog is named. The turbo
  `lint` task and operate-web's `next lint` script are removed, and `next.config.mjs` sets
  `eslint.ignoreDuringBuilds` so `next build` does not run a second, different lint.
- CI is three jobs: `verify` (audit, then the existing steps), `lint` (build, then `pnpm lint`) and
  `deploy-smoke` (`bash deploy/ci-smoke.sh`). `measuredJobSeconds` replaces the single-suite total,
  with a ceiling per job.
- A `backup` service and a `db-backups` volume. `run-backups.sh` does, in order: `pg_dump -Fc -f`
  with no pipe; `pg_restore --list`; **a real restore into a scratch database, comparing its table
  count with the source**; `mv` into place; a `.last-verified` stamp; and the retention prune
  **last**. A failed run writes `/backups/.last-failed`, retries after `BACKUP_RETRY_SECONDS`, and
  leaves earlier dumps untouched; a successful run removes the marker. The healthcheck requires the
  stamp to be recent **and** the marker to be absent. An interval under 60 s is refused (exit 2).
  The rule is ADR-0390's, applied in the stack: **a dump is not a backup until it has been restored,
  and nothing old is deleted until something new has been proved.**

**M-24: a two-stage, non-root image and a pinned, bounded stack.**

- `deploy/Dockerfile` builds on pinned `node:22.23.5-bookworm-slim` and the runtime stage is a fresh
  `--prod --filter-prod` install from the three apps, with Next's SWC compiler binaries, sharp's
  musl build and the sources removed. It runs as **`USER node`**, and the only writable path is
  `.next/cache`.
- Pinned tags: `postgres:16.16-bookworm`, `caddy:2.11.9`, `ollama:0.40.16`.
- json-file log rotation on all nine services; `mem_limit` on `db`, `api`, `web`, `backup` and
  `caddy`. `web` runs `node …/next start` rather than `pnpm`, which the runtime image no longer
  contains, and gains a healthcheck; `caddy` waits on healthy `web` and `api`.

## Alternatives considered

- **Stay on Next 14.** Refused: 14.2.35 is the last 14.x and still carries the criticals.
- **Gate on the full `pnpm audit`.** Refused: it reports dev-only advisories (two browserslist highs
  through autoprefixer) that no shipped image contains, so the job would be red on things the gate
  cannot act on. `--prod` plus a fence over what `--prod` over-reports is the narrower true answer.
- **Fail lint on the existing backlog.** Refused: a CI job that is red on arrival teaches people to
  ignore it (ADR-0382's reason). The suppression file names the backlog and fails on a stale count.
- **Put lint inside `verify`.** Refused on measurement: 530.5 + 96.0 = 626.5 s exceeds the 10-minute
  budget. In parallel it costs a second build and moves the critical path by nothing; a test pins it.
- **Trust `pg_dump`'s exit status, or `gunzip -t`.** Refused for ADR-0390's reasons: neither proves a
  dump restores. The restore is the check.

## Consequences

- **Positive:** the shipped web has no ungated critical or high advisory; a new one fails CI.
  Lint runs. The runtime image is unprivileged and less than half the size. The stack produces a
  backup and proves each one restores before keeping it.
- **Negative:** a 498-entry suppression backlog. Three dependency migrations remain declared rather
  than done. The image needs `.next/cache` writable and nothing else, so a future feature that
  writes elsewhere fails at runtime as `node`.
- **Neutral:** `deploy-smoke` adds a job that builds and boots the stack on every run.
- **Reversibility:** each part reverts independently. The Next upgrade is the costly one to undo,
  because it touched the four dynamic pages.

## Implementation notes

**Measured before and after (implementer, re-measured by review and live):**

- `pnpm audit --audit-level=high --prod`: exit 0 in about 4 s. Review and the live run both counted
  **17** findings — 1 low, 10 moderate, 3 high, 3 critical — with the six high and critical
  ignored. (The implementer's figure of 14 was not reproduced; this ADR uses 17.) Removing one
  ignore makes the step exit 1.
- Runtime image: **1.41 GB → 644 MB**, root → uid 1000, `/app` 827 → 252 MB, 253 → 39 store
  entries. None of vitest, vite, tinypool, TypeScript, eslint or next-swc is inside. `/app` is
  read-only and `.next/cache` is writable.
- `pnpm lint`: exit 1 → exit 0, in 96 s after a build (the review measured 104 s). A violation in
  an operate-web file makes it exit 1, so the web app is linted; a stale suppression count exits 2.
- CI model: `verify` 530.5 s (ceiling 9 min), `lint` 245.3 s (ceiling 5), `deploy-smoke` 152 s
  (ceiling 3). The 152 s was measured on this host, not on a GitHub runner.
- Idle memory after light load: api 101 MiB, web 106 MiB, db 80 MiB, backup 2 MiB. The Node heap
  ceiling is 524 MiB for the API and 259 MiB for the web. The limits apply in `docker stats`; they
  are not load-tested.
- `pnpm install --frozen-lockfile` reports the lockfile up to date.

**Review found five defects in the first version and fixed three (all in the backup):**

1. **The restore check passed when both table counts failed to read.** `backup_once` is called as
   an `if` condition, so bash ignored `set -e` inside it. The script compared two empty strings and
   kept the dump. Reproduced in the real image with a `psql` that fails the count queries: the log
   read `restore check passed:  tables` followed by `wrote …dump`, twice. An unchecked `mv` had the
   same weakness. Every step is now checked explicitly, both counts must be non-empty digits, and
   `mv` and the stamp return on failure.
2. **A failing backup stayed healthy for up to two days,** because the healthcheck read only the
   stamp's age: leftover containers showed `FAILED` in the log since 18:36 and `(healthy)` in
   `docker ps`. This produced the `.last-failed` marker, verified both ways.
3. **`BACKUP_RETRY_SECONDS` was documented and never passed into the container.** Compose passes
   it now, default 600.

The other two: stale and contradictory text in `deploy/README.md` and `deploy/ORACLE.md`, corrected;
and three leftover containers, removed.

**Verified live** against PG 16 with the API running as `crossengin_app`:

- **Web:** `operate-web` builds in 18 s on Next 15.5.29 / React 19.3.1, 18 of 18 static pages.
  Under `next start`, the async-`params` routes answer:
  - `/login` 200;
  - the proxy with no cookie 401 JSON, with a cookie 200;
  - `/e/vendors` 200 and `/platform/<id>` 200.
- **Image:** builds in 107 s and is 644 MB. Its API answers `readyz` 200, running as `node`,
  "confined on all 115".
- **Backup:**
  - success arm: "restore check passed: 251 tables", a 1.6 MB dump kept, healthcheck passing;
  - failure arm (missing database): "FAILED; the previous dumps are untouched", `.last-failed`
    written, healthcheck failing.
- **Smoke:** `ci-smoke.sh` on fresh images passed in 33 s. That run used the review-fixed script;
  it replaces the stale smoke image review flagged.

The implementer also ran three backup arms before review:

- success, 147 tables;
- forced failure, earlier dumps surviving;
- retention, a 20-day-old dump pruned only after a new verified one existed.

Review ran the fixed script against a real Postgres 16.16: 2 tables, dump kept, scratch database
dropped.

Two host quirks, not defects: the app image built only with `--network host` (npm
`ECONNREFUSED` otherwise), and the postgres image's apt step built only from a local shim of the
base image.

**Tests:**

- `pnpm --filter @crossengin/testing test`: 805 passed.
- `deployment-defaults.test.ts`: 92 passed.
- `@crossengin/operate-server`: 5,685 tests in 149 files.
- operate-web typecheck: clean.
- `pnpm -r build`: exit 0.

**Mutation checks**, each caught and reversed by its exact edit:

- removing an audit ignore;
- removing the audit step, the lint step, `USER node`, the `web` logging block, the backup's `mv`
  or the API `mem_limit`;
- `caddy:2` for the pinned tag, and `ollama` `latest`;
- review's four: removing the empty-count guard, unguarding `mv`, removing the retry variable, and
  removing `.last-failed` from the healthcheck.

**Claims found false while measuring:**

- `deploy/postgres/Dockerfile` said its versions float.
- The compose `web` command would have broken on the new image, since it ran `pnpm`.
- A 48-character hex secret fails `refuseWeakSecret` about 55% of the time (computed). The smoke
  script generates base64 instead. No deployment is affected: `.env.example` uses base64, and the
  hex secrets in `deploy/` are Postgres passwords, which that check does not cover.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Migrate zod 3 → 4, vitest 2 → 4 (which also clears tinypool), and replace picomatch when a patched release exists; then delete the matching ignores | Platform | _N/A_ |
| Work down the 498 lint suppressions. They were generated against a tree carrying other lanes' uncommitted changes, so they may need regenerating once those land | Platform | _N/A_ |
| `dev_tooling_not_shipped` checks only that no member lists the `via` package. A member listing `vitest` directly, or a `tinypool` path not through `@crossengin/testing`, would pass it | Platform | _N/A_ |
| Two dev-only browserslist highs (fixed in 4.28.7+) appear in the full audit and are not gated, since autoprefixer is a build-time dev dependency | Platform | _N/A_ |
| No off-host backup copy is automated. Pointing `BACKUP_DIR` at a mounted remote store works, and the README says so | Operations | _N/A_ |
| The restore check reads the source table count after the dump, so a schema created in that window fails the run, which retries. This fails closed | Platform | _N/A_ |
| CI still sets no `timeout-minutes`, and the `deploy-smoke` figure is from this host; a cold GitHub runner is likely slower | Platform | _N/A_ |
| The memory limits are not load-tested | Operations | _N/A_ |
| H-22's other halves are outside this slice: no metrics, structured logs or tracing, an unlogged write 500, and no rollback | Platform | _N/A_ |

## References

- Root `package.json` (`lint`, `engines`, `pnpm.overrides`, `pnpm.auditConfig.ignoreGhsas`),
  `eslint.config.mjs`, `eslint-suppressions.json`, `turbo.json`
- `apps/operate-web/package.json`, `next.config.mjs`, the four dynamic pages and
  `app/api/[...path]/route.ts`
- `.github/workflows/ci.yml`; `packages/testing/src/strategy/ci.ts` (`CI_AUDIT_EXCEPTIONS`,
  `measuredJobSeconds`), `ci-workflow.ts` (`auditExceptionDisagreements`)
- `deploy/Dockerfile`, `deploy/postgres/Dockerfile`, `deploy/postgres/backup/run-backups.sh`,
  `deploy/docker-compose.yml`, `deploy/docker-compose.ai.yml`, `deploy/ci-smoke.sh`,
  `deploy/README.md` (*Backups*, *The image and the services' limits*), `deploy/ORACLE.md`
- `apps/operate-server/src/deployment-defaults.test.ts`
- ADR-0382, ADR-0390, ADR-0357, ADR-0424
