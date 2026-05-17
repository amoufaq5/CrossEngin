# @crossengin/ai-architect

Agent-side contract types for the AI Architect per **ADR-0005**.
V1 is the pure contract layer: types + the deterministic diff
narration helper. The planner-executor loop runner, LLM provider
router (ADR-0006), RAG layer, eval suite, and conversation runtime
are all Phase 2.

## What's here (v1)

- **Tool surface schemas** — `AgentToolCallSchema` discriminated
  union over all 10 v1 tools (per ADR-0005 § Tool surface):
  `readManifest`, `searchSimilarManifests`, `searchCompliancePack`,
  `readUploadedDocument`, `proposeManifestPatch`, `validateManifest`,
  `previewManifestApply`, `applyManifestPatch`, `askUser`,
  `finishConversation`.
- **Agent output formats** — `AgentTurn` (narration + asks + diff
  summary) and `AgentToolCall` (tool + typed args).
- **Planner-executor types** — `AgentPlan` (goal + nextAction +
  confidence + rationale), `AgentReflection` (observation +
  decision), `AgentLoopStep` (one iteration of the loop, captured
  for audit + evals).
- **Confidence** — `"low" | "medium" | "high"`.
- **`diffSummaryFromManifestDiff(manifestDiff)`** — the deterministic
  diff narration per ADR-0005 § Open questions resolved
  ("No LLM call required for the diff narration. Cheaper,
  predictable, testable.").

## API

```ts
import {
  // Tool call types (discriminated union)
  AgentToolCallSchema,
  type AgentToolCall,
  type AgentToolName,
  AGENT_TOOL_NAMES,

  // Agent output
  AgentTurnSchema,
  type AgentTurn,
  AgentAskSchema,
  type AgentAsk,

  // Planner-executor
  AgentPlanSchema,
  type AgentPlan,
  AgentReflectionSchema,
  type AgentReflection,
  AgentLoopStepSchema,
  type AgentLoopStep,

  // Confidence
  ConfidenceSchema,
  type Confidence,

  // Diff narration
  DiffSummarySchema,
  type DiffSummary,
  diffSummaryFromManifestDiff,
} from "@crossengin/ai-architect";
```

## Tool call shape (example)

```ts
const call: AgentToolCall = {
  tool: "applyManifestPatch",
  args: {
    patch: { baseHash: "abc...", manifest: { ... } },
    approvalToken: "tok_xyz",
  },
};

AgentToolCallSchema.parse(call);   // throws if shape is wrong
```

The discriminated union enforces per-tool arg shapes. `applyManifestPatch`
requires an `approvalToken`; `askUser` does not. The kernel's tool
dispatcher (Phase 2) parses against this schema before routing.

## Diff narration

```ts
import { applyManifest, computeManifestDiff } from "@crossengin/kernel/manifest";
import { diffSummaryFromManifestDiff } from "@crossengin/ai-architect";

const diff = computeManifestDiff(oldManifest, newManifest);
const summary = diffSummaryFromManifestDiff(diff);
// {
//   summary: "1 added, 1 removed, 2 modified",
//   added: ["Added entity 'Patient' (3 fields)"],
//   removed: ["Removed entity 'Legacy' (destructive)"],
//   modified: [
//     "Modified entity 'Prescription' (+1 field, ~1 field, +1 index)",
//     "Modified entity 'Order' (-1 field)",
//   ],
//   destructive: true,
// }
```

The narration is **deterministic** — no LLM call required. Same
input → same output. Tested against representative diffs.

## Deferred to Phase 2 / 3

- Loop runner (planner-executor state machine)
- LLM provider router (ADR-0006: Fireworks v1, routable to
  Anthropic / Together / self-hosted vLLM)
- Tool dispatcher (parses AgentToolCall, routes to handlers)
- Conversation memory storage (`meta.aiArchitectConversations`)
- RAG layer (pgvector + BGE embeddings)
- Sandbox tenant cloning (schema-only mock by default; full
  pg_dump/pg_restore for paid tiers per Round 5 decision)
- Eval suite (100 hand-crafted + 500 replayed conversations
  per ADR-0005 Phase 4 target)
- Cost telemetry + per-session token budgets
- Streaming via SSE
- Approval token signing + verification (kernel-side)

## Run tests

```bash
pnpm --filter @crossengin/ai-architect test
```
