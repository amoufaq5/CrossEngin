# ADR-0005: AI Architect Contract

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0003, ADR-0004, ADR-0006, ADR-0008, ADR-0011, ADR-0012, ADR-0025 |

## Context

The **AI Architect** is the conversational layer that distinguishes CrossEngin from a "kernel + manifest spec" engineering toolkit. It is the interface through which a community pharmacist, a procurement officer at a ministry, or an admissions director at a graduate school describes their business and receives a running application within an hour.

Without the AI Architect, CrossEngin is a manifest-driven platform comparable to Mendix or OutSystems: powerful, but requiring expert authoring. With the AI Architect, CrossEngin is a product anyone who can describe their business can use. The AI Architect is the moat.

Getting the AI Architect right is hard because four pressures compete:

1. **It must produce manifests that work without manual correction.** A pharmacist who describes "I dispense prescriptions, track narcotics, file insurance claims, and manage expiry dates" should get a manifest that produces a working pharmacy app. If the resulting app is broken, missing critical fields, or violates compliance, the AI Architect has failed.
2. **It must be safe.** The agent operates on a live multi-tenant platform with regulated industries. A wrong move can corrupt a tenant's data, leak across tenants, or apply a manifest that violates a regulation. Some actions must never happen, even with explicit user confirmation (e.g., disabling audit retention on a GxP tenant).
3. **It must be efficient.** Token cost is a real budget item. A manifest-producing conversation should cost dollars, not hundreds of dollars. Per-tenant cost telemetry is required for pricing and unit economics.
4. **It must be replaceable.** The underlying LLM will change every few months. The agent architecture must let us swap models without rewriting the agent. Today's Anthropic Sonnet 4.6 will be tomorrow's Sonnet 5.x or self-hosted Qwen 3 successor.

This ADR defines the AI Architect's **contract**: what it does, what it does not do, what tools it has, what its inputs and outputs look like, what safety guarantees it provides, how it is evaluated, and how it interacts with the kernel and the manifest pipeline.

The substance of LLM provider routing is ADR-0006. The substance of safety and governance — the policy layer above the architecture — is ADR-0025. This ADR specifies the architecture.

## Decision

The AI Architect is a **planner-executor agent** that runs as a service in `packages/ai-architect`. It interviews a tenant through a chat interface, retrieves relevant context, proposes manifest patches, previews changes, and applies them on user approval.

### Roles

- **Tenant user** — the human in the conversation. Owner, operations lead, compliance officer, system integrator. Has authority to approve or reject the agent's proposals.
- **Agent** — the AI Architect process. Plans, calls tools, produces manifest patches, narrates the conversation.
- **Kernel** — the substrate that validates and applies manifest patches. Authoritative for what the platform can and cannot do.

The agent never bypasses the kernel. Every manifest change goes through the kernel's manifest-apply API (ADR-0004). The agent has no direct database access.

### High-level architecture

```
┌────────────────────────────────────────────────────────────┐
│                       Tenant browser                          │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Chat UI (apps/web/architect)                          │  │
│  └─────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                              │
                              │  HTTP/WS
                              ▼
┌────────────────────────────────────────────────────────────┐
│              packages/ai-architect (service)                  │
│                                                                │
│  ┌──────────────┐    ┌───────────────────────────────┐        │
│  │  Conversation│ ─► │ Planner-executor loop          │        │
│  │  state       │    │  - Plan (which tool next)      │        │
│  └──────────────┘    │  - Execute (call tool)         │        │
│                       │  - Reflect (was result OK)    │        │
│                       │  - Decide (next step or end)  │        │
│                       └───────────────────────────────┘        │
│                              │                                 │
│                              ▼                                 │
│  ┌───────────────────────────────────────────────┐             │
│  │  Tool surface                                 │             │
│  │  - readManifest(tenantId)                    │             │
│  │  - searchSimilarManifests(query)             │             │
│  │  - searchCompliancePack(name)                │             │
│  │  - readUploadedDocument(docId)               │             │
│  │  - proposeManifestPatch(patch)               │             │
│  │  - validateManifest(manifest)                │             │
│  │  - previewManifestApply(patch)               │             │
│  │  - applyManifestPatch(patch, approval)       │             │
│  │  - askUser(question, options)                │             │
│  │  - finishConversation(summary)               │             │
│  └───────────────────────────────────────────────┘             │
│                              │                                 │
│                              ▼                                 │
│  ┌───────────────────────────────────────────────┐             │
│  │  LLM Provider Router (ADR-0006)              │             │
│  └───────────────────────────────────────────────┘             │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│  Kernel APIs (manifest validate/preview/apply, tenant data,   │
│  audit log, files, conversation history)                      │
└────────────────────────────────────────────────────────────┘
```

### Planner-executor loop

Each user turn triggers the loop:

1. **Plan.** The agent receives the conversation history, the current resolved manifest, retrieved context (similar tenants, compliance pack docs, uploaded documents), and the user's latest message. It produces a plan: a short JSON describing the immediate goal and the next tool call.
2. **Execute.** The agent calls the tool. The tool returns a structured result.
3. **Reflect.** The agent reads the tool result and updates its working state. If the result is unexpected (validation error, ambiguity, missing data), it adjusts.
4. **Decide.** The agent decides whether to continue (next tool call), ask the user a clarifying question, or end the turn with a narration.

Total tool calls per user turn are capped (default **12**, configurable per plan; 2026-05-11 decision). When the cap is reached, the agent must either ask the user or end the turn. Pathological loops are prevented by step accounting in the loop runner.

### Tool surface

Every tool is JSON-in, JSON-out. The schemas are TypeScript types in `packages/ai-architect/src/tools/`.

- **`readManifest(tenantId)`** — returns the tenant's currently active manifest. Read-only.
- **`searchSimilarManifests(query)`** — vector search over the manifest catalog, filtered by family/sub-family. Returns top-K with redacted tenant identifiers. Privacy boundaries: returns only public manifests (those in the catalog) or manifests owned by tenants who have opted in to anonymized sharing. Detail in ADR-0025.
- **`searchCompliancePack(name)`** — returns the spec, requirements, and parameters for a named compliance pack.
- **`readUploadedDocument(docId)`** — returns the parsed contents of a document the tenant uploaded in this session (SOP, regulatory filing, sample contract). Documents are scoped to the session.
- **`proposeManifestPatch(patch)`** — submits a manifest patch to the kernel for validation. Returns either the validated patch with computed diff or a list of validation errors. **Does not apply.**
- **`validateManifest(manifest)`** — validates a complete manifest. Returns OK or errors.
- **`previewManifestApply(patch)`** — runs the manifest pipeline up to but not including DDL. Returns the structured diff, the predicted DDL operations, and the predicted UI changes. Used to show the user what would happen.
- **`applyManifestPatch(patch, approval)`** — applies the patch. Requires an `approval` token issued by `previewManifestApply` and explicitly accepted by the user. Returns the new manifest version. **The only tool that mutates tenant state.**
- **`askUser(question, options?)`** — the agent yields control back to the user with a structured question. `options` is an optional list of suggested answers (renderable as buttons). The conversation pauses; the next user turn resumes the loop.
- **`finishConversation(summary)`** — ends the agent's turn. The summary is shown to the user as the agent's closing message.

The agent CANNOT:

- Read or write tenant data directly. Only the kernel APIs touch the database.
- Call external APIs. No web browsing, no third-party HTTP. All knowledge comes from the conversation, uploaded documents, the manifest catalog, and the compliance pack documentation.
- Run arbitrary code. No code generation that executes; the agent's outputs are manifest patches (data), not programs.
- Bypass user approval for `applyManifestPatch`. The approval token is non-forgeable (issued by the kernel after `previewManifestApply` + user click).

### Output formats

The agent's structured outputs are JSON. Two kinds:

- **Tool call** — `{ "tool": "<name>", "args": { ... } }`.
- **User-facing turn** — `{ "narration": "string", "asks": [...], "diffSummary": { ... } }`. The narration is shown as the agent's chat message. `asks` is a list of structured questions (zero or more). `diffSummary` accompanies a preview.

The agent never produces free-form Markdown or HTML in `narration`. The chat UI renders the narration with consistent styling. Diffs are rendered by the UI from `diffSummary`, not from agent prose.

### Conversation memory

Conversation state per tenant per session is stored in `meta.aiArchitectConversations`:

- **Session ID** — unique per conversation thread.
- **Tenant ID** and **User ID** — who is talking.
- **Messages** — full transcript (user, agent, tool calls, tool results).
- **Working manifest** — the agent's in-progress draft, separate from the active manifest.
- **Uploaded documents** — references, OCR text, parsed structure.
- **Tool-call audit** — every tool call with timestamp, latency, cost.
- **Plan trace** — every plan + reflection produced by the agent (for evaluation and debugging).

Conversations are durable and resumable. A tenant can return days later and continue where they left off. The working manifest persists until applied or discarded.

Long conversations are **summarized**. After every N turns, the agent's running summary of "what we've discussed and decided" is captured. The summary becomes the truncation point for older messages; the most recent N turns are retained verbatim. The summary is the agent's responsibility, written via a dedicated `summarizeConversation` internal tool.

### Retrieval-augmented context (RAG)

At plan time, the agent receives:

- **Current resolved manifest** (entities, workflows, roles snapshot).
- **Conversation summary + recent verbatim turns.**
- **Top-K similar manifests** (semantic search; only those the tenant has access to per ADR-0025).
- **Top-K relevant compliance pack sections** (when the conversation mentions regulation).
- **Uploaded-document excerpts** indexed by relevance to the latest user message.

The RAG layer is implemented over pgvector with embeddings produced by a dedicated embedding model (separate from the chat model). Embedding model choice is part of ADR-0006.

### Safety rails

Three layers:

1. **Hard refusals.** Some operations are never allowed: disabling audit on a GxP tenant; reducing PHI encryption strength; granting cross-tenant access. These are enforced by the kernel; the agent's `applyManifestPatch` calls fail. ADR-0025 enumerates the full set.
2. **Confirmation gates.** Destructive operations (drop column, drop entity, narrow a permission) require user re-confirmation beyond the standard preview. The preview UI surfaces destructiveness explicitly.
3. **Cost caps.** Per-session token budget (default $5 of inference at v1 pricing; configurable per tenant tier). When the cap is reached, the agent ends the session with a summary; the conversation can be resumed but a new budget must be granted.

### Confidence and uncertainty

The agent's plans carry a confidence value (low / medium / high). Low confidence triggers `askUser` rather than `proposeManifestPatch`. The confidence is a learned signal, surfaced in the planner prompt; it is also calibrated post-hoc by comparing predicted to actual outcomes.

When the agent is stuck — repeated validation failures, contradictory user input, missing critical context — it explicitly hands off: `finishConversation` with a summary that names what is unresolved. A human (Customer Success or eventually a routing tier of more capable agents) picks up.

### Evaluation and accuracy

The AI Architect has an explicit accuracy target: **80% first-pass at v1, 95% at v3.** "First-pass" means the conversation produces a manifest that the tenant adopts without manual correction.

Accuracy is measured against an **eval suite** in `packages/ai-architect/src/evals/`:

- **Hand-crafted conversations.** A curated set of representative conversations (e.g., "Community pharmacist sets up a basic store," "Hospital adds a narcotics tracking workflow," "Procurement officer extends an e-procurement portal to handle two-stage approvals"). Each has expected manifest outputs (entities, key fields, workflows, roles) and forbidden outputs (e.g., must not auto-disable HIPAA).
- **Replayed real conversations.** With user consent, real conversations are replayed against new agent versions; outputs are diffed and reviewed.
- **Property tests.** Generated manifests must pass: validation, kernel apply on a sandbox tenant, smoke tests of the rendered UI.

Every model swap or prompt change runs the eval suite. Regressions block deployment.

### Cost telemetry

Every agent action is tagged with model, prompt tokens, completion tokens, tool latency, and cost. Costs are aggregated per session, per tenant, per plan, per family. Telemetry feeds:

- Pricing (we know how much a tenant costs to support).
- Optimization (which prompts are expensive; which tool calls dominate).
- Anomaly detection (a tenant suddenly costing 10× more is a signal of either an attack or a broken prompt).

## Alternatives considered

### Option A — Single-shot prompt (no agent loop)

Send the conversation + manifest + retrieved context to the LLM. Receive a full manifest in one shot. Apply.

- **Pros:** Simple. Few moving parts.
- **Cons:** Manifests are complex, multi-section JSON documents; one-shot generation fails on large manifests. No way to validate before applying. No way to ask clarifying questions mid-flight. No way to do retrieval beyond the initial fetch. The model has no recourse if it produces something invalid.
- **Why not:** Single-shot generation is fine for small completions. CrossEngin manifests are too large and structured. The planner-executor loop is the right shape for this problem.

### Option B — Code-generation agent

The agent generates code (TypeScript files) that, when run, builds the manifest. The user inspects code, runs it, gets manifest.

- **Pros:** Maximum flexibility. The code can do anything.
- **Cons:** Code is harder to validate than data. Maliciously-generated code is a real risk. Tenants who can't read code can't review the agent's work. Code execution requires a sandbox; sandbox escapes are a class of vulnerability we'd rather not add.
- **Why not:** Manifests are data. Producing data is the right output for a declarative platform. Code generation would be a step backward.

### Option C — Drag-and-drop UI as primary interface, agent as secondary

The primary interface is a Mendix-style visual builder. The agent is an optional helper that suggests fields.

- **Pros:** Visual builders are familiar. Tenants understand "drag this onto that."
- **Cons:** Visual builders cap at the complexity of their visual language. Real businesses produce manifests that exceed the visual surface — workflows with branching, ABAC predicates, integration mappings. We'd end up with a partial visual interface plus a hidden code interface. The agent in conversational form scales to any complexity.
- **Why not:** Conversation scales further than visuals. We will ship visual components for specific manifest sections (workflow designer in ADR-0007; permission matrix in ADR-0008), but the primary entry point is the AI Architect.

### Option D — Multiple specialized agents (entity agent, workflow agent, etc.)

Each manifest section has its own agent. A router dispatches sub-conversations.

- **Pros:** Specialized agents can have specialized prompts, optimized for their narrow domain.
- **Cons:** Coordinating across agents reintroduces the orchestration problem the planner-executor loop solves. Conversation handoffs feel choppy to users. Per-agent context is fragmented. Implementation complexity multiplies.
- **Why not:** One agent with a rich tool surface handles cross-section coherence better than multiple agents with handoffs. We may add specialized sub-agents later for narrow tasks (e.g., a compliance-checker agent that runs in parallel), but the primary architect is one.

### Option E — Use a third-party agent framework (LangChain, LangGraph, AutoGen, CrewAI)

Build on top of an existing framework.

- **Pros:** Pre-built primitives. Community.
- **Cons:** Frameworks add abstraction layers we don't need. Our tool surface and safety model are specific to CrossEngin; a framework optimized for general agents fights us. Vendor risk: framework deprecation cycles are short. Performance is poorer than direct LLM-API calls. Eval surface is harder to control.
- **Why not:** Our agent is small enough to own end-to-end. ~3000 lines of TypeScript for the loop runner + tool dispatcher + LLM provider router. We control performance, cost, safety, and evolution.

### Option F — Foundation-model API directly, no planner-executor structure

The conversation is just a chat with the model, with function-calling for tool use.

- **Pros:** The model's native chat semantics handle conversation flow.
- **Cons:** No reflection step. No confidence accounting. No plan trace for evaluation. Limited control over tool-call budgets. Harder to swap models because each model's function-calling API differs.
- **Why not:** The planner-executor structure makes the agent's reasoning legible and auditable. Native function-calling is used as the implementation detail beneath the planner-executor structure, not as the structure itself.

## Consequences

### Positive

- **Predictable contract.** Every input (conversation + context) maps to outputs (tool calls + narration). Engineers and operators can reason about the agent.
- **Replaceable LLM.** The provider router (ADR-0006) isolates the LLM choice. Swapping Anthropic Sonnet 4.6 for self-hosted Qwen 3 changes one config.
- **Auditable.** Every tool call is logged. Every plan + reflection is captured. Disputes ("why did the agent do this?") have an answer.
- **Safe by construction.** The agent cannot bypass the kernel; the kernel enforces invariants. Confirmation gates and hard refusals catch errors at the right layer.
- **Evaluable.** The eval suite gives us a metric. Model swaps and prompt changes have evidence-based decisions.
- **Cost-controlled.** Per-session budgets prevent runaway costs. Telemetry feeds pricing.

### Negative

- **Implementation cost.** ~6–8 weeks for v1 of the agent (loop runner, tool surface, RAG layer, eval suite, conversation UI). Mitigation: scoping v1 narrow (single pharma manifest target) and expanding outward.
- **Eval suite maintenance.** Every new manifest pack or kernel feature requires eval cases. Mitigation: each ADR that touches manifests must update the eval suite as part of its acceptance.
- **Prompt engineering is a real ongoing cost.** Each model change risks regressions. Mitigation: prompts live in version-controlled `packages/ai-architect/src/prompts/`; changes go through PR with eval run.
- **The agent's quality bounds the product's quality.** A flaky agent makes a flaky product. There is no "the platform is fine even if the agent isn't" escape; the agent is the primary interface.

### Neutral

- **Tool surface is finite.** Adding tools requires careful design. New tools may take weeks to land.
- **Conversation persistence is large.** Long conversations accumulate transcripts. Summarization + truncation manages this; some storage cost remains.

### Reversibility

**Low to moderate for architecture.** Swapping the LLM is cheap. Swapping the planner-executor structure is expensive (rewrites the loop runner, prompts, eval suite). Adding tools is cheap; removing tools after tenants have used them requires a deprecation cycle.

**High for prompts.** Prompts can be edited freely with eval runs as gates.

The fundamental shape — agent in service, tool surface, kernel-mediated changes — is hard to undo once tenants use it. We must get the shape reasonably right at v1.

## Implementation notes

- **Service runtime.** The agent runs as a Node.js service. v1 deploys on Vercel (the simplest path); production deploys to a long-running worker (Fly.io, Render, or AWS Fargate) once we hit Vercel timeout limits for long conversations.
- **Streaming.** Agent responses stream to the chat UI via Server-Sent Events. Tool calls are not streamed (they are atomic).
- **Tool dispatcher.** A central dispatcher routes tool calls to handlers. Each handler validates its input with Zod, calls the underlying kernel API, validates the output, and returns. Tools have explicit timeouts and retry policies.
- **Prompt structure.** System prompt + tool schemas + retrieved context + conversation history + current user message. System prompt is short (under 2K tokens) and stable. Tool schemas are auto-generated from `packages/ai-architect/src/tools/`. Context is the variable part.
- **Loop runner.** Implemented as a state machine in `packages/ai-architect/src/runner/`. Each iteration: plan → execute → reflect → decide. Configurable max-iterations (default **12** per Round 5 decision), max-token budget, max-wall-clock (default 60s).
- **Conversation API.** A thin REST + WS API in `apps/web/api/v1/architect/`. Endpoints: `POST /sessions`, `POST /sessions/:id/messages`, `GET /sessions/:id`, `POST /sessions/:id/abort`.
- **Permission model.** Conversations are scoped to a `userTenantMembership`. A tenant admin can review any conversation in their tenant. Cross-tenant access is forbidden (ADR-0002).
- **Audit log.** Every applied manifest patch records the conversation session ID. Auditors can trace any manifest version to the conversation that produced it.
- **Sandbox.** Before applying, the agent can apply to a `sandbox` tenant copy and let the user explore. **Hybrid model (Round 5 decision):** schema-only mock with synthetic seed data by default; full `pg_dump`/`pg_restore` copy of the active tenant available on demand for paid tiers. Schema-only is cheap and fast; full copy gives real-data fidelity at higher storage cost.
- **Eval runner.** `tools/architect-eval` runs the eval suite against any agent version. Outputs a coverage report and a regression report compared to the prior version.
- **Cost ceiling.** A per-session ceiling (configurable; default 50K total tokens, ~$5 at v1 hosted-OSS pricing) hard-stops the agent. The tenant is told why; the conversation can be resumed after a budget grant.
- **Conversation UI.** Lives in `apps/web/architect`. Renders narration, tool-call summaries (collapsed by default), preview diffs, ask-user widgets, and approval flows. Streaming via SSE.
- **Document upload.** Tenants can upload SOPs, sample contracts, regulatory PDFs. Documents are OCR'd (ADR-0014) and embedded into the session's RAG index. Document scope is the session unless the tenant explicitly elevates it to tenant-wide.

## Open questions

### Resolved (2026-05-11)

- **Default LLM for v1:** Fireworks (hosted OSS — Qwen / DeepSeek). Anthropic and Together added as routable options through ADR-0006 when accuracy or cost shifts demand.
- **Embedding model:** self-hosted BGE-large-en / BGE-M3. Requires a GPU inference container (host TBD: Fly Machines / RunPod / Lambda Labs).
- **Tool-call cap:** 12 per user turn (raised from 8 default).
- **Sandbox tenants:** hybrid — schema-only mock with synthetic seed data by default; full `pg_dump`/`pg_restore` copy on demand for paid tiers.
- **Per-family agent specialization:** single general system prompt + per-family context-snippet injection at runtime. Per-family or per-sub-vertical prompts only introduced when measured eval gap justifies.
- **User-facing diff explanation:** deterministic function from the structured diff. No LLM call required for the diff narration. Cheaper, predictable, testable.

### Still open

| Question | Owner | Deadline |
|---|---|---|
| Cross-tenant similar-manifest search privacy — exact opt-in mechanism for tenants who want to contribute to the catalog. Compliance pack alignment with the AI Architect retrieval surface. | _pending compliance hire_ | Phase 4 |
| Long-conversation summarization — model choice (use the chat model, or a cheaper summarizer?), summary structure (free text vs. structured JSON?). | amoufaq5 | Phase 3 |
| Eval suite size and curation — how many conversations cover the v1 surface? Working target: 100 hand-crafted + 500 replayed by end of Phase 4. | amoufaq5 | Phase 4 |
| GPU inference host for the BGE embedding container — latency from Frankfurt vs. cost. Same decision affects future self-hosted LLM (Year 3 trigger). | amoufaq5 | Phase 2 |

## References

- ADR-0003 (Meta-schema and dynamic entity engine) — defines what manifest patches affect.
- ADR-0004 (Manifest specification) — defines the manifest the agent produces.
- ADR-0006 (LLM provider router) — defines the LLM API surface the agent calls.
- ADR-0008 (RBAC v2, ABAC, audit) — defines permissions on conversations and manifest applies.
- ADR-0011 (Integration mesh) — defines the integrations the agent declares.
- ADR-0012 (Compliance pack architecture) — defines packs the agent retrieves.
- ADR-0025 (AI Architect safety and governance) — defines hard refusals, opt-in policies, and policy escalation.
- [vision.md](../vision.md), section 6 (AI Architect as moat).
- Prior art: AutoGPT planner-executor patterns, Anthropic Claude tool-use documentation, OpenAI function-calling documentation.
