# ADR-0139: `crossengin chat --max-cost-usd` session budget flag (Phase 2 M5.11)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0054 (M5.5 chat mode), ADR-0061 (M6.5.5 architect-cli router integration), ADR-0135 (M6.7 PostgresCostTracker), ADR-0137 (M6.7.x per-tenant cost ceiling) |

## Context

`crossengin chat` already accepts `--cost-ceiling-usd $X`, which maps to `CostCeiling.maxUsdPerRequest`. That gate is a **per-request** cap — a single LLM call that would exceed `$X` is refused pre-flight. It does NOT cap the total spend across a session.

Operators running interactive chat sessions need a different control: "stop the session if cumulative spend goes above $Y." Without it:

- A long debugging session can quietly burn through hundreds of dollars across dozens of turns.
- One-shot scripts that loop chat calls (e.g., across many manifests) have no spending ceiling.
- Training / evaluation runs of the CLI itself ($X per turn × N turns × M experiments) accumulate cost invisibly.

M6.7 (ADR-0135) provides `PostgresCostTracker` — durable per-tenant cost windows. M6.7.x (ADR-0137) lets ceilings be per-tenant data. Both target server-side multi-replica enforcement. Neither addresses **client-side session-scoped budgets** for the CLI.

M5.11 closes the gap with a CLI flag.

## Decision

Add `--max-cost-usd $X` to `crossengin chat`. Semantically: a **session-scoped, post-hoc cumulative cap**. Enforcement lives entirely in the REPL loop, not in the router.

### Surface

```
crossengin chat --prompt='audit this manifest' --max-cost-usd=0.50
crossengin chat --max-cost-usd=5.00         # interactive REPL with $5 budget
crossengin chat --max-cost-usd=0.05 --format=json   # one-shot with $0.05 cap
```

`--max-cost-usd` and `--cost-ceiling-usd` are **independent** and can be combined:

- `--cost-ceiling-usd=0.10` — refuse any single turn estimated above $0.10 (existing per-request gate via router preflight).
- `--max-cost-usd=2.00` — exit the REPL once cumulative real spend crosses $2.00.

Validation: must parse as a finite positive number. Otherwise exit 2 with a clear `chat: invalid --max-cost-usd: <value>` error.

### Enforcement semantic

In `runChatRepl`, the cost aggregator (`aggregate.cost`) already accumulates per-turn `usage.cost` from the `usage_final` chunk. M5.11 adds a check at the **top of each iteration** of the REPL while-loop, BEFORE consuming the next user input line:

```ts
while (true) {
  if (opts.maxCostUsd !== undefined && aggregate.cost >= opts.maxCostUsd) {
    budgetExceeded = true;
    announceBudgetExceeded(opts, aggregate.cost, opts.maxCostUsd);
    break;
  }
  const line = await opts.lines.next();
  // ...
}
```

The check is at **iteration start**. Implications:

- The LAST turn that pushes cumulative cost over the budget IS allowed to complete (cost is observed AFTER the response streams). The NEXT input is refused.
- This matches a "give me one more answer, but then stop" UX — operators get a coherent answer to their last question.
- For one-shot mode (`opts.oneShot === true`, single turn), the budget check fires AFTER the single turn completes (since there is no "next iteration"). The result flags `budgetExceeded: true` if exceeded — informational only.

### Display surfaces

In human mode:

- **Header on REPL start:** `Session budget: $0.5000 USD.`
- **After each turn:** `[budget: $0.0042 of $0.5000 spent]`
- **On budget exhaustion:** `[session budget exceeded: $0.5100 spent, $0.5000 budget — exiting]`

In JSON mode:

- A `{"kind": "budget_exceeded", "spent_usd": 0.51, "budget_usd": 0.5}` chunk is emitted on exit when the budget triggers exit.

`ChatReplResult.budgetExceeded?: boolean` surfaces on the function return + JSON output for programmatic callers.

### Why not wire through the router's CostCeiling?

The router's `CostCeiling.maxUsdPerWindow` would seem like the natural fit. Three reasons it isn't:

1. **The router's preflight uses ESTIMATED cost** (token-count × pricing). The session budget should be enforced on ACTUAL spend. Mid-session estimation drift would either over-block (estimate high, real low) or under-block (estimate low, real high).
2. **The router is provider-orchestration; the session is CLI-state.** Budgets are a UI concern, not a transport concern. Keeping them in the REPL loop preserves the router's single responsibility.
3. **`maxUsdPerWindow` requires a window duration.** A session has no natural duration (1 minute? 24 hours? until ctrl-C?). A "session-length window" would need fake values like `windowSeconds = 100_000_000` — a code smell. The REPL has direct access to the actual session state.

For server-side multi-tenant cost gating, M6.7 (PostgresCostTracker) + M6.7.x (PostgresCostCeilingResolver) remain the right substrate. M5.11 is the per-process client-side complement.

## Cross-cutting invariants enforced

- **No breaking change.** Existing callers without `--max-cost-usd` see identical behavior. Default `maxCostUsd === undefined` skips every budget code path.
- **Budget orthogonal to per-request ceiling.** `--cost-ceiling-usd` and `--max-cost-usd` can coexist or be set independently. They enforce different gates.
- **Real cost only.** Enforcement reads `aggregate.cost` (sourced from provider `usage_final.cost`). No estimation.
- **Exit gracefully, not abruptly.** The REPL emits a clear announcement, then breaks the loop. `emitSessionEnd` still fires (transcripts are flushed). Exit code 0 (the session ran successfully; the budget was honored).
- **JSON parity.** Every human-mode signal has a JSON counterpart (header omitted in JSON since machine consumers shouldn't need it).
- **Symmetric with existing flags.** Same parsing pattern (`getStringFlag` → `Number.parseFloat` → finite/positive check → exit 2 on bad value).

## End-to-end semantic

```bash
# Operator caps the session at $0.50; the chat REPL halts once cumulative
# spend crosses the budget. The current turn completes; no further input
# is read.
$ crossengin chat --max-cost-usd=0.50
CrossEngin Architect chat. Type your message; Ctrl-D to exit; /exit to quit.
Attach blocks with /attach <type> <value>; /show-attachments; /clear-attachments.
Session budget: $0.5000 USD.

You: audit my manifest

Architect: <answer>
[budget: $0.1042 of $0.5000 spent]

You: now add a permission rule
Architect: <answer>
[budget: $0.2918 of $0.5000 spent]

... (turns continue) ...

You: one more question
Architect: <answer>
[budget: $0.5180 of $0.5000 spent]

[session budget exceeded: $0.5180 spent, $0.5000 budget — exiting]
Session ended after 5 turn(s). Aggregate input=12340 output=2156 cost=0.5180 USD.

# JSON consumer:
$ crossengin chat --max-cost-usd=0.05 --format=json --prompt='analyze' --one-shot
{"kind":"text","text":"The manifest..."}
{"kind":"usage_final","usage":{...,"cost":0.067}}
{"kind":"budget_exceeded","spent_usd":0.067,"budget_usd":0.05}
{"ok":true,"turns":1,"aggregateUsage":{...,"cost":0.067},"providerKind":"single","availableProviders":["anthropic"],"budgetExceeded":true}
```

## Alternatives considered

- **Force the router path and use `maxUsdPerWindow` with a fake-long window.**
  - **Considered.** Plumb through the router's `CostCeiling.maxUsdPerWindow`, use `windowSeconds = 100 years`.
  - **Cons.** Estimation drift (router preflight uses estimated token-count × pricing, not actual). Forces router instantiation even for single-provider setups. Couples CLI session state to provider orchestration. Code smell with the long window.
  - **Decision.** REPL-level enforcement on actual cost.

- **Check the budget BEFORE the turn (using estimated cost like the router does).**
  - **Considered.** "If sending this turn might exceed the budget, refuse upfront."
  - **Cons.** Estimation requires knowing the response size, which isn't knowable until the LLM responds. Cannot accurately predict cost pre-flight. Operators end up with arbitrary refusals or overrides.
  - **Decision.** Post-hoc: let the turn complete; refuse the next.

- **Kill the in-flight turn when cost crosses the budget during streaming.**
  - **Considered.** Aborts the AsyncIterable on `usage_final.cost > budget`.
  - **Cons.** UX worse than letting the answer complete. Cuts off a half-rendered response. The cost is already incurred (the LLM call ran). Refusing the next turn captures the budget intent without ugly cancellation.
  - **Decision.** Allow the in-flight turn to complete.

- **Refuse the LAST turn that would exceed the budget (use post-hoc cost AFTER previous turn).**
  - **Considered.** After turn N completes, if `aggregate.cost + estimated_next > budget`, refuse turn N+1.
  - **Cons.** Still needs estimation of next turn's cost. Same problem as upfront check.
  - **Decision.** Refuse turn N+1 unconditionally once cumulative cost crosses the budget.

- **Make `--max-cost-usd` a hard ceiling (exit 1 on exceedance).**
  - **Considered.** "The budget was violated; signal failure."
  - **Cons.** The session ran successfully; the budget was HONORED (we exited before continuing). Exit 0 with `budgetExceeded: true` in the JSON output is the correct semantic. Operators wanting hard failure check the flag.
  - **Decision.** Exit 0. `budgetExceeded` flag is the signal.

- **Add a `--warn-cost-usd $W` flag that prints a warning but doesn't exit.**
  - **Considered.** Two-tier: warn at $W, exit at $X.
  - **Cons.** Complexity for marginal value. Operators wanting just a warning can set a budget they're willing to hit. Defer.
  - **Decision.** No warn flag.

- **Make the budget reset on `/clear-history` or similar REPL command.**
  - **Considered.** Some operators want to "reset" a session mid-flow.
  - **Cons.** Two competing notions of "session." Budget is process-scoped; conversation history is REPL-scoped. Reset would muddle. If operators want a budget reset, they exit and restart.
  - **Decision.** Budget is process-lifetime.

- **Read the budget from a per-tenant Postgres row (M6.7.x style) instead of a CLI flag.**
  - **Considered.** Reuse `META_LLM_COST_CEILINGS`.
  - **Cons.** CLI is single-user, single-session. Postgres infrastructure isn't always available. CLI flag is local + immediate. Operators wanting server-side enforcement should use the gateway (M6.7.x substrate); the CLI flag is for ad-hoc developer workflows.
  - **Decision.** CLI flag. Server-side per-tenant ceilings remain a separate substrate.

## Consequences

- **56 packages + 1 app, 122 meta-schema tables, 7,637 tests** (+11 from M5.11: 9 in `chat.test.ts`, 2 in `commands.test.ts`). All green, zero type errors.
- **Operators can run bounded interactive sessions.** A long debugging session with `--max-cost-usd=5.00` won't accidentally burn $50.
- **Loop / batch / eval scripts have a guard rail.** `for m in manifests; do crossengin chat --prompt="audit $m" --max-cost-usd=0.10 --one-shot; done` enforces $0.10/manifest.
- **Operator-facing UI surface for cost.** Header announces the budget; per-turn line shows running spend; exit notice names spent + budget. JSON parity throughout.
- **Architecture stays clean.** Router stays a transport concern. Session budgets stay a UI concern. Multi-replica server enforcement (M6.7/M6.7.x) remains a separate substrate.
- **No `Number` precision issues at the scale operators care about.** `.toFixed(4)` on display, `Number(x.toFixed(6))` on aggregation — same precision conventions as the existing usage line.

## Open questions

- **Q1:** Should the budget integrate with `crossengin sessions` (M5.9) so operators can review historical cost vs budget?
  - _Current direction:_ Out of scope for M5.11. `aggregateUsage.cost` is already in the session record via M5.7 persistence; a future `crossengin sessions show` enhancement can compare against the budget used.
- **Q2:** Should there be a `--max-cost-usd-from-env` variant reading from `$CROSSENGIN_MAX_COST_USD`?
  - _Current direction:_ Future ergonomic. The flag suffices for now; operators wrap in a shell function if they want env-var defaults.
- **Q3:** Should the budget apply to embedding calls too (currently ignored — chat REPL doesn't issue them)?
  - _Current direction:_ N/A — chat doesn't use embeddings. If a future "search" subcommand uses embeddings, it would need its own budget control.
- **Q4:** Should the JSON output include a per-turn budget snapshot alongside `usage_final`?
  - _Current direction:_ No — operators can compute it from cumulative `cost` values. Adding a duplicate channel doubles the surface area.
- **Q5:** Should the human-mode per-turn line be silenced behind a flag (some operators find it noisy)?
  - _Current direction:_ Acceptable noise level for the operator who explicitly set a budget. If feedback comes in, add `--quiet-budget-line`.
- **Q6:** What about `--max-cost-usd=0` (explicit zero)?
  - _Current direction:_ Rejected at parse (`parsed <= 0` check). Zero would mean "never run a turn," which is just "don't invoke chat." If operators want a dry-run, that's a separate flag.
- **Q7:** Multi-currency support.
  - _Current direction:_ Out of scope — provider pricing is USD-only across all three integrated providers. If multi-currency arrives, the flag becomes `--max-cost <amount><currency>`.
- **Q8:** Budget vs `--max-tokens`?
  - _Current direction:_ Independent. `--max-tokens` is per-completion token limit. `--max-cost-usd` is session cost limit. Both can be set; they enforce different things.
