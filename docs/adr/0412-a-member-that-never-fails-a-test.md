# ADR-0412: A member that never fails a test

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0307 (the typecheck overlay, and the rule that enforces it), ADR-0382 (the CI workflow and the pre-commit hook), ADR-0385 (this fix is fenced by nothing, measured from inside), ADR-0372 (never claim a reading nobody took), ADR-0386 (a dead exemption reads as a considered judgement), ADR-0398 (a document-the-hazard-check-nothing test) |

## Context

Register P1.3 is two halves. ADR-0382 closed the half about *running* the rules — there is a
`.github/workflows/ci.yml` and a `.githooks/pre-commit` now, so the twelve strategy rules and the
whole suite run without a human typing anything. What that increment deliberately did not take is
the other half: **whether every workspace member has a test runner at all.**

`typecheck-config.ts` is the precedent and the shape. ADR-0307 found that `tsconfig.json` excludes
`**/*.test.ts`, so tests were transpiled by esbuild and never typechecked; the fix was a two-line
overlay per package, and the *rule* — `typecheck-config.ts`, asserting against the real workspace
that every member with a `src/` has the file, extends both bases and runs the one script — is what
makes a missing overlay a test failure rather than a convention. The same question one tool over had
no rule: **a member that never runs a test never fails one**, which is invisible by construction.

### What the measurement found, and the two things it refuted

Census over all 90 workspace members (`pnpm-workspace.yaml`'s `packages/*` and `apps/*`), reading
each member's `package.json` and its tracked file list:

| | members |
|---|---|
| vitest config **and** a `test` script **and** `src/` | **88** |
| none of the three | **2** (`packages/config`, `apps/operate-web`) |
| half-wired (config with no script, or script with no config) | **0** |

So the biconditional already holds and this rule is a fence rather than a fix — which is the
cheapest moment to write one, exactly as `pg-storeless-tables.ts` argues for its own population.

Two things the measurement **refuted about its own prescription**, and both decided the design:

**The precondition cannot be `hasSrcDirectory`.** `apps/operate-web` has **no `src/`** — it is a
Next app-router layout of `app/`, `components/`, `lib/` — and tracks **58** `.ts`/`.tsx` files. A
`src/` precondition would exclude the one member this rule exists to name, and the whole thing would
be vacuous. The precondition is *tracked TypeScript source*.

**`packages/config` must not be declared exempt.** It holds **zero** TypeScript files — only JSON
config bases — so any precondition over TypeScript excludes it mechanically. Declaring it would be a
**dead exemption**, which is ADR-0386's finding about seven `notForwarded` entries naming fields the
fence never compared: a declaration that excuses something already outside the population reads as a
considered judgement and is not one.

### A census read off build output

My first measurement of `operate-web`'s size used `find`, which counts `.next/types/**`: **81 files
and 16,853 lines** against the tracked **58 files and 14,318 lines**. The inflated figure was one
step from going into a declaration. This register has a standing note about exactly this, and the
remedy is `git ls-files`, not a wider `-not -path`.

## Decision

`packages/testing/src/strategy/test-runner-config.ts` is the thirteenth workspace rule, and it is a
**biconditional** rather than an assertion about the one exempt member:

```
tracks TypeScript source  ⟺  declares a vitest config AND a `test` script
```

A biconditional and not `count === 0`, for the reason ADR-0372 names as its own class: `count === 0`
would pin the defect as the specification, and the natural fix for the resulting red would be to
delete the assertion. As a biconditional, **half-wiring a runner goes red** (a config with no
script, a script with no config) and **the first real test in an exempt member lands green** once
the config, the script and the removal of the exemption line arrive together.

Six violation kinds, chosen so the half-wired cases cannot be silent:

| kind | when |
|---|---|
| `no_runner` | tracks TypeScript, declares neither |
| `config_without_script` | has the config; `pnpm -r test` never runs it |
| `script_without_config` | has the script; the runner has nothing to read |
| `tests_without_runner` | reported **beside** `no_runner`, never instead of it |
| `exempt_but_wired` | declared exempt and now wired — delete the line |
| `wrong_script` | `test` is not `vitest run` |

`tests_without_runner` is reported beside `no_runner` rather than in place of it because it is the
*sharper statement of the same absence*: a member with test files and no runner has written tests
that never run, which no other workspace rule can see, and collapsing the two would lose it.

One exemption, with its consequence **required** — the half that makes it a declaration rather than
a waiver, and the shape `pg-storeless-tables.ts` and `pg-unreachable-stores.ts` use for the same job:

> `apps/operate-web` — 58 tracked `.ts`/`.tsx` files, 14,318 lines, 19 pages and 41 `fetch(` call
> sites are fenced by no test. It also sets no `noUnusedLocals`, so a change that orphans a binding
> leaves `tsc` and `next build` both green — measured in ADR-0385, where commenting out that
> increment's one publish line was invisible to both. The cost has been paid three times: ADR-0335
> shipped a console button that was a guaranteed 400 because the request body crosses as a `string`;
> ADR-0385's fix is fenced by nothing; and ADR-0398's `forwardedResponseHeaders` is a pure function
> with an argued deny-list for which no unit test is possible, because there is no runner to add one
> to.

## Consequences

The rule is 17 tests and the suite is 748 green. Mutation-checked three ways, each restoring
byte-identically (`ba68c3ad964d1788024960ab007a3f53`): removing the exemption reds the real-workspace
arm by name, weakening the biconditional to `count === 0` fails the half-wired cases, and declaring
`packages/config` fails the dead-exemption assertion.

The real-workspace arm carries a **bound rather than an equality** on `operate-web`'s file count
(40 < n < 70): an exact figure would red on the next page added, while a bound catches the one thing
worth catching — a census silently re-inflated by build output, which is how the 81 arrived.

A non-vacuity floor asserts the population is non-empty before anything is asserted about it, since
a precondition that excluded every member would pass every assertion having examined nothing.

## Alternatives

**Assert `count === 0` over members with no runner.** Refused above: it pins today's exemption as
the specification and makes deleting the assertion the natural response to the first real test.

**Precondition on `src/`.** Refused on measurement: it excludes `apps/operate-web`, which is the
only member the rule names.

**Declare both members exempt.** Refused: `packages/config` is outside the population by
construction, so the entry would excuse nothing (ADR-0386).

**Give `apps/operate-web` a runner in this increment.** That is P1.3's remaining half and is a
larger piece of work — a vitest config for a Next app-router tree, a jsdom environment, and the
first tests over 19 pages — and it is strictly better done *after* the rule exists, because then the
exemption's deletion is the thing that proves it landed.

**Also assert `noUnusedLocals`.** Out of scope here and worth its own rule: it is a property of a
member's `tsconfig`, which `typecheck-config.ts` already reads, so the honest home is that rule
rather than this one.

## Open questions

1. **`apps/operate-web` still has zero tests**, which is the rest of P1.3 and the thing the
   exemption's consequence measures. ADR-0385 measured the cost from the inside; this makes the
   absence a declared fact with a figure, and does not close it.
2. **No smoke, e2e, load or migration test exists anywhere**, which this rule does not ask about —
   it asks whether a member runs *a* runner, not what that runner covers. That is the other clause
   P1.3 bundles and is a different instrument.
3. **`TEST_SCRIPT` is the single literal `vitest run`.** Every member matches today, so the
   `wrong_script` kind has no member — correct now, and the first member that legitimately needs a
   different invocation (a Next app's `vitest run --environment jsdom`, say) turns this into a
   declaration rather than a constant.
4. **`noUnusedLocals` is unasserted for all 90 members.** `operate-web` is the one known to omit it,
   measured, and whether the other 89 set it was not surveyed.
