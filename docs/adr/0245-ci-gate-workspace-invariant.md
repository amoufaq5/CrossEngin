# ADR-0245: CI gate enforcing the workspace invariant

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-25 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0244 (type-check `*.test.ts`, future Q1), ADR-0243 (debt paydown) |

## Context

ADR-0243 caught the workspace claiming "all green, zero type errors" while
`pnpm -r typecheck` reported 13 errors and a test failed. ADR-0244 closed the
systemic cause — `*.test.ts` files were never type-checked — and wired a
`typecheck:tests` guard, but left enforcement as future Q1: nothing in the repo
*runs* the guard automatically, so the invariant still depends on a human
remembering to run four commands before merging. The drift that ADR-0243 fixed
can recur the moment someone forgets.

The repo had no `.github/` directory and no CI configuration at all — every
green-state claim to date has been manually verified. The toolchain is fixed:
`packageManager: pnpm@9.12.0`, `engines.node >= 20` (`@types/node` is `^22`),
committed `pnpm-lock.yaml`, turbo for task orchestration (every task
`dependsOn: ["^build"]`).

## Decision

Add `.github/workflows/ci.yml` — a single GitHub Actions workflow that enforces
the full invariant on every pull request and on pushes to `main`/`master` (plus
`workflow_dispatch` for manual runs). One `verify` job runs, in order:

1. `pnpm install --frozen-lockfile`
2. `pnpm -r build`
3. `pnpm -r typecheck` (src, per package)
4. `pnpm typecheck:tests` (every `*.test.ts`, the ADR-0244 guard)
5. `pnpm -r test`

pnpm is installed via `pnpm/action-setup@v4` (version read from the
`packageManager` field, so it can't drift from local), then
`actions/setup-node@v4` with Node 22 and pnpm caching. `concurrency` with
`cancel-in-progress` supersedes stale runs on the same ref. A failure in any
step fails the job, so the four-part invariant (build + src types + test-file
types + tests) is a required signal before merge.

## Alternatives considered

- **Single combined script (e.g. `pnpm verify`) invoked by one CI step.**
  - **Pros:** one command locally and in CI.
  - **Cons:** collapses five distinct failure signals into one opaque step;
    harder to see *which* gate broke in the Actions UI.
  - **Why not:** explicit steps give readable, independently-cached output;
    revisit if step duplication becomes noise.

- **Parallel jobs (build artifact uploaded, typecheck / test as separate jobs).**
  - **Pros:** wall-clock speedup on large suites.
  - **Cons:** artifact upload/download + turbo-cache plumbing across jobs for a
    suite that runs in a few minutes today.
  - **Why not:** premature; a single job with in-job turbo caching is simpler.
    Revisit when total runtime warrants it.

- **Run the bare `tsc -p tsconfig.typecheck-tests.json` in CI instead of the
  `typecheck:tests` script** (build already ran in the prior step).
  - **Pros:** avoids the script's redundant inner `pnpm build`.
  - **Cons:** CI would drift from the documented gate; the inner build is a
    turbo cache hit (≈free) after step 2.
  - **Why not:** fidelity to the one documented command beats shaving a cached
    no-op.

- **Pre-push git hook instead of (or in addition to) CI.**
  - **Pros:** catches before push.
  - **Cons:** local hooks are bypassable + impose a full build on every push;
    not a merge gate.
  - **Why not:** CI is the authoritative gate; a hook is a deferred Q.

- **Trigger on every push to every branch.**
  - **Cons:** burns minutes on every WIP commit to feature branches.
  - **Why not:** PR + protected-branch push covers the merge gate; `pull_request`
    already runs on the dev branch's PR.

## Consequences

- **Positive:** the "all green, zero type errors (src + test)" invariant is
  machine-enforced, not trust-based; the ADR-0243 drift cannot silently recur.
- **Negative:** every PR pays a build + typecheck + test run (a few minutes);
  GitHub Actions minutes are consumed.
- **Neutral:** first CI in the repo — establishes `.github/workflows/` as the
  home for automation; branch protection (making the check *required*) is a
  GitHub repo-settings step outside the repo.
- **Reversibility:** trivial — delete the workflow file.

## Implementation notes

- `pnpm/action-setup@v4` reads the version from `package.json` `packageManager`
  (pnpm@9.12.0) — no second place to bump.
- `actions/setup-node@v4` `cache: pnpm` must run *after* pnpm is installed.
- Node 22 chosen to match `@types/node@^22` (engines allow ≥20).
- Steps 3–5 each trigger turbo tasks that `dependsOn: ["^build"]`; the explicit
  step 2 warms the cache so those are hits. `typecheck:tests` runs
  `pnpm build && tsc -p tsconfig.typecheck-tests.json`; its inner build is a
  cache hit after step 2.
- No lint job: ESLint is not yet migrated to flat config (documented in
  CLAUDE.md); add a lint step when it is.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Mark the `verify` check as **required** in branch protection (a GitHub repo setting, not in-repo) | platform | 2026-06-30 |
| Add a lint step once ESLint flat config lands (pairs with ADR-0244 Q2) | platform | _deferred_ |
| Split into parallel jobs if total runtime grows uncomfortable | platform | _deferred_ |
| Optional pre-push hook running `typecheck:tests` (ADR-0244 Q3) | platform | _deferred_ |

## References

- ADR-0244 — Type-check `*.test.ts` workspace-wide (this gate runs its guard).
- `.github/workflows/ci.yml`, root `package.json` scripts (`typecheck:tests`).
