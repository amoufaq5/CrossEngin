# ADR-0007: Workflow Engine

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0003, ADR-0004, ADR-0008, ADR-0011, ADR-0012, ADR-0015 |

## Context

Workflows are the second-most-defining feature of CrossEngin after entities. The kernel knows about state machines, transitions, guards, effects, SLAs, and orchestrations. Every regulated app sits on this engine:

- A **prescription** moves `pending → verified → dispensed`; the `verified` transition requires a pharmacist's e-signature; SLA on `pending → verified` is 4 hours during business hours.
- A **change control** in a pharma manufacturer moves `draft → reviewed → approved → implemented → verified`; each transition requires a different role; the `approved → implemented` step assigns to a manufacturing supervisor and waits for a manual confirmation step.
- A **building permit** in a Govern app moves `submitted → reviewed → site-visited → conditional-approved → approved`; an SLA breach triggers an escalation to the head planner.
- A **vaccination follow-up** in a Heal app schedules a dose-2 reminder 28 days after dose-1.

These workflows must be:

- **Declared in the manifest** (per ADR-0004), not coded per tenant.
- **Backed by a durable runtime** that survives process crashes, retries on transient failures, and supports long-running waits (hours to weeks).
- **Permission-checked** at every transition (per ADR-0008).
- **Auditable** — every transition emits an audit record.
- **Composable** — workflows can call sub-workflows; orchestrations span multiple entities.
- **Compliance-aware** — packs (21 CFR Part 11, HIPAA, EU GMP) impose constraints (e-signature, dual-control approval, retention).
- **Editable at runtime** by the AI Architect, with the same diff/preview/apply pipeline as schema changes.

The original `/home/user/ERP` codebase has scattered state-transition logic in API routes. Phase 1 lifts that into a real workflow engine. Two technical commitments from ADR-0024 frame this:

- **React Flow** for the visual workflow designer.
- **Inngest** for the durable runtime.

This ADR defines the workflow DSL, runtime contract, integration with the kernel, and the visual designer surface.

## Decision

CrossEngin's workflow engine has three layers:

1. **DSL** — declarative workflow definitions in the manifest's `workflows` section.
2. **Runtime** — Inngest functions that execute state machines and orchestrations, durably.
3. **Designer** — a React Flow-based visual editor that round-trips with the DSL.

### Workflow kinds

Three kinds of workflow live in a manifest:

| Kind | Scope | Example |
|---|---|---|
| `entityLifecycle` | Single-entity state machine | Prescription `pending → verified → dispensed → ...` |
| `orchestration` | Multi-entity / multi-step process; may span time and human actors | Pharma change-control across deviation, CAPA, training, qualification |
| `scheduled` | Time-triggered; no state machine, just an action that runs on schedule | Daily expiry-check job; vaccination dose-2 reminder |

### Entity-lifecycle workflows

```jsonc
"workflows": {
  "prescriptionLifecycle": {
    "kind": "entityLifecycle",
    "entity": "prescription",
    "stateField": "status",
    "states": [
      { "name": "pending",            "label": { "en": "Pending" }, "category": "active" },
      { "name": "verified",           "label": { "en": "Verified" }, "category": "active" },
      { "name": "dispensed",          "label": { "en": "Dispensed" }, "category": "terminal" },
      { "name": "partiallyDispensed", "label": { "en": "Partially Dispensed" }, "category": "active" },
      { "name": "cancelled",          "label": { "en": "Cancelled" }, "category": "terminal" }
    ],
    "initialState": "pending",
    "transitions": [
      {
        "name": "verify",
        "from": "pending",
        "to":   "verified",
        "trigger":  { "kind": "userAction" },
        "guards": [
          { "permission": "prescription.transitions.verify" },
          { "rego": "data.prescription.access.signature_required_and_valid" }
        ],
        "preEffects":  [{ "kind": "requireESignature", "method": "username-password-otp" }],
        "postEffects": [
          { "kind": "audit", "event": "prescriptionVerified" },
          { "kind": "notify", "template": "patientPrescriptionReady" },
          { "kind": "emitEvent", "name": "prescription.verified" }
        ]
      },
      { "name": "dispense", "from": "verified", "to": "dispensed", "trigger": { "kind": "userAction" }, "guards": [...], "preEffects": [...], "postEffects": [...] },
      { "name": "cancel",   "from": ["pending", "verified"], "to": "cancelled", "trigger": { "kind": "userAction" }, "guards": [...], "postEffects": [...] }
    ],
    "slas": [
      { "name": "verifyWithin4h", "from": "pending", "to": "verified", "deadline": "PT4H", "businessHoursOnly": true, "escalation": "notifyPharmacyManager" }
    ]
  }
}
```

Transitions have:

- `trigger` — `userAction` (default; tied to a UI button), `event` (kernel-emitted; e.g., another entity's transition), `time` (after a delay), or `automatic` (immediately on entering the from-state if guards pass).
- `guards` — permission check + zero-or-more Rego predicates (per ADR-0008). All must pass.
- `preEffects` — run before the state changes. `requireESignature` halts the transition until re-auth completes; `runValidation` runs domain validation; etc.
- `postEffects` — run after the state changes. Audit, notifications, downstream event emission, integration calls (per ADR-0011), background jobs (per ADR-0015).
- `slas` — deadline-based escalations. If the state hasn't advanced by the deadline, the escalation runs (notify, auto-transition, raise event).

### Orchestrations

Orchestrations span multiple entities and may include long waits or branches:

```jsonc
"workflows": {
  "deviationToCapa": {
    "kind": "orchestration",
    "trigger": { "kind": "event", "name": "deviation.created" },
    "steps": [
      { "id": "review",    "kind": "humanTask", "assignTo": { "role": "qaSpecialist" }, "deadline": "PT72H", "form": "deviationReview" },
      { "id": "decideCapa","kind": "branch", "condition": { "rego": "data.deviation.requires_capa" },
        "ifTrue":  [ { "id": "createCapa", "kind": "createEntity", "entity": "capa", "from": "$deviation" } ],
        "ifFalse": [ { "id": "closeDeviation", "kind": "transition", "workflow": "deviationLifecycle", "transition": "close" } ]
      },
      { "id": "trainingCheck", "kind": "humanTask", "assignTo": { "role": "trainingCoordinator" }, "deadline": "P7D", "form": "trainingAssessment" },
      { "id": "qualifyReturn", "kind": "humanTask", "assignTo": { "role": "qaManager" }, "deadline": "P14D", "form": "qualificationReturn" }
    ],
    "compensations": {
      "review":      [{ "kind": "transition", "workflow": "deviationLifecycle", "transition": "reopen" }],
      "createCapa":  [{ "kind": "deleteEntity", "scope": "$step.createCapa.output" }]
    }
  }
}
```

Step kinds:

| Step | Purpose |
|---|---|
| `humanTask` | Assign to a role/user; wait for them to complete a form; on completion, advance |
| `transition` | Trigger a transition on another workflow |
| `createEntity` / `updateEntity` / `deleteEntity` | Direct entity manipulation (subject to RBAC/ABAC) |
| `callIntegration` | Invoke an integration defined in `integrations` (ADR-0011) |
| `runJob` | Schedule an async job (ADR-0015) |
| `wait` | Pause for a duration or until an event |
| `branch` | Conditional branching by Rego predicate |
| `parallel` | Run sub-steps concurrently; converge on completion |
| `subOrchestration` | Call another orchestration; pass arguments |
| `emitEvent` | Emit a kernel event for downstream consumers |

Compensations are step-level rollback actions, run in reverse order if the orchestration fails or is cancelled. (Saga pattern.)

### Scheduled workflows

```jsonc
"workflows": {
  "dailyExpiryCheck": {
    "kind": "scheduled",
    "schedule": "0 6 * * * Asia/Dubai",
    "action": {
      "kind": "runJob",
      "job": "scanInventoryForExpiringStock",
      "input": { "withinDays": 30 }
    }
  },
  "doseTwoReminder": {
    "kind": "scheduled",
    "trigger": { "kind": "event", "name": "vaccinationDoseAdministered", "filter": "$event.doseNumber == 1" },
    "delay": "P28D",
    "action": { "kind": "notify", "template": "doseTwoReminder", "recipient": "$event.patient_id" }
  }
}
```

### Runtime: Inngest

Every workflow definition compiles to one or more Inngest functions at manifest apply time. Inngest provides:

- Durable state across process restarts.
- Native step retries with exponential backoff.
- Long-running waits (hours, days, weeks) without holding a process open.
- Concurrency control per workflow / per tenant.
- Replay and time-travel debugging.

The kernel's manifest pipeline emits Inngest function definitions in `packages/workflow/runtime/__generated__/<tenant>/<workflow>.ts`. Hot-reloaded on manifest apply. The kernel registers function metadata with Inngest's serving layer.

Per-tenant isolation:

- Inngest function IDs are prefixed `<tenant_id>__<workflow_name>__<version>`.
- Per-tenant concurrency limits prevent one tenant's runaway workflows from blocking others.
- Event names are namespaced `<tenant_id>.<event_name>` to prevent cross-tenant subscriptions.

### Triggers and events

Kernel events are emitted on:

- Entity lifecycle transitions.
- Entity create/update/delete.
- Custom `emitEvent` step kinds.

Events are stored in `meta.events` (append-only, per-tenant scoped) and delivered to Inngest. Workflows subscribe to events via their `trigger` declaration.

### Compliance pack integration

Compliance packs (ADR-0012) augment workflows:

- **21 CFR Part 11** adds a `requireESignature` preEffect to any transition on a `gxpSigned` entity; defines the dual-control approval template; mandates audit retention.
- **HIPAA** adds `notify` constraints (no PHI in email body; portal-only notifications).
- **EU GMP** adds dual-signature requirements for `release` transitions on manufactured-batch entities.

Pack-imposed rules are applied at manifest validation time. Manifests cannot override pack-imposed transition guards (only narrow them).

### Visual designer

`packages/workflow/designer` is a React Flow-based editor:

- Each state is a node; each transition is an edge.
- Tenants drag-drop to add/move/connect states; the editor outputs the DSL JSON.
- Orchestrations have a separate canvas with step nodes.
- Compliance-pack-required transitions are rendered with a lock icon; cannot be deleted.
- ABAC predicate fields show a Rego mini-editor with syntax highlighting (Monaco).
- Live preview: applying a workflow change shows the structured diff (per ADR-0005) before commit.

The designer is the human-facing alternative to the AI Architect for workflow editing. Both round-trip the same DSL JSON.

### Permissions in workflow steps

Every transition and step is permission-checked:

- `humanTask` steps assign to a role; only users with that role and ABAC-permission for the bound entity see the task in their queue.
- `transition` steps re-check the target transition's permissions; if the orchestration runs as a system principal, the audit log records `actor.kind = "workflow"` plus the orchestrating user's session.
- AI Architect-edited workflows go through the per-tenant approval gate (ADR-0003 / ADR-0008): destructive workflow changes (deleting a state in use; tightening permissions) require explicit human OK.

### Performance

Workflow execution is asynchronous (Inngest functions); user-facing latency comes from the API call that requests a transition + the synchronous portion of the transition (audit emit + state field update + immediate effects). Long-running effects (notify, integrations) run async.

Per-transition latency budget: < 200 ms p95 from user click to "transition succeeded" confirmation, excluding e-signature challenge time.

## Alternatives considered

### Option A — Pure database state machine (no Inngest)

State machines as Postgres rows + cron jobs for time-based triggers.

- **Pros:** Fewer moving parts. One service (Postgres) to operate.
- **Cons:** No durable state for long-running orchestrations (a 30-day vaccination reminder = process-of-cron-job-on-30th-day; fragile). No native retries. Replay is manual SQL.
- **Why not:** Inngest gives us all of these natively. Postgres remains the source of truth for entity state; Inngest handles the time / retry / replay machinery.

### Option B — Temporal.io

Workflow-as-code platform with strong durability and replay.

- **Pros:** Mature; supports complex workflows; SDK-first.
- **Cons:** Self-hosted Temporal is operational complexity we don't have headroom for. Temporal Cloud is expensive at scale. Workflow-as-code conflicts with the manifest-driven model.
- **Why not:** Inngest is the right fit for a manifest-driven, declarative-workflow shape. Reconsider Temporal if we hit Inngest scale limits or need code-level workflows (we don't).

### Option C — AWS Step Functions

Managed state-machine service.

- **Pros:** No infra. Visual editor.
- **Cons:** Vendor lock-in to AWS. Per-state pricing scales unpredictably with workflow size. Less ergonomic for TypeScript-heavy stacks.
- **Why not:** Inngest is TypeScript-native, multi-cloud, and prices on executions not state transitions.

### Option D — Build our own workflow runtime

Custom Postgres-backed runtime tailored to CrossEngin.

- **Pros:** Maximum fit.
- **Cons:** Workflow engines are weeks-to-months of foundational work. Inngest has 5+ years of engineering already done.
- **Why not:** Buy don't build. Use Inngest until we hit a wall.

### Option E — n8n / Make.com as embedded workflow engine

Use a third-party workflow tool embedded in CrossEngin.

- **Pros:** Vast integration catalog.
- **Cons:** Designed for end-user automation, not platform-internal state machines. Heavyweight UI; doesn't fit the renderer architecture (ADR-0018).
- **Why not:** Wrong abstraction layer. We are the platform; n8n is a platform-on-platform.

## Consequences

### Positive

- **Durable workflows out of the box.** Inngest handles retries, long waits, replay, concurrency.
- **One DSL, two editors.** AI Architect and human visual designer both emit the same JSON. Round-trip preserves semantics.
- **Permission and audit integration.** Every transition is checked, every transition is audited. Compliance packs compose cleanly.
- **Manifest-driven.** Workflow changes flow through the same apply pipeline as schema changes — diff, preview, approval gate, commit.
- **Saga pattern via compensations** lets orchestrations roll back partially-completed work cleanly.
- **Visual designer for non-conversational tenants** gives an alternative to the AI Architect for tenants who prefer direct editing.

### Negative

- **Two execution paths to maintain.** Synchronous-pre-state-change effects + async post-state-change effects + Inngest functions. Mental model takes time to internalize.
- **React Flow designer is significant UI work.** ~4 weeks for v1 designer.
- **Inngest dependency is real.** A multi-region Inngest outage breaks workflow execution. Mitigation: in-Postgres backup queue for critical immediate transitions; degrades gracefully to "transition recorded, async effects deferred."
- **Code generation per tenant** (Inngest function definitions) increases the apply-pipeline complexity. Mitigation: deterministic codegen; hash-keyed caching; integration tests on the codegen output.

### Neutral

- **Workflow versioning is a workflow concept, not a manifest concept.** Each manifest version pins workflow versions; in-flight orchestrations continue under their original version until completion.
- **React Flow as the designer** matches the broader Next.js + shadcn stack (ADR-0024).

### Reversibility

**Moderate cost to evolve the DSL.** Additive changes (new step kinds, new triggers) are cheap. Renaming a step kind requires a manifest migration pass.

**High cost to swap Inngest.** Replaying historical workflow state into another runtime is non-trivial. Once tenants have orchestrations running in production, Inngest is a long-term commitment.

**Moderate cost to swap the designer.** React Flow is mainstream; replacement libraries exist; ~2 weeks of work.

## Implementation notes

- **Package locations:**
  - `packages/workflow` — DSL types, validator, kernel-side runtime API.
  - `packages/workflow/runtime` — Inngest function generation.
  - `packages/workflow/designer` — React Flow visual editor.
- **Codegen pipeline:** manifest apply triggers `workflow-compile` which produces Inngest function definitions. Output: `apps/web/inngest/__generated__/<tenant_id>/`. Hot-reloaded.
- **Event store:** `meta.events` partitioned by `(tenant_id, occurred_at)` monthly. Indexed on `event_name`. Retention 90 days hot; expired events archived to R2.
- **Concurrency limits:** per-tenant default 100 concurrent workflow runs; raised per tenant tier. Enforced via Inngest concurrency keys.
- **SLA evaluation:** Inngest scheduled jobs run hourly checking `(tenant, workflow, entity_id)` tuples whose state hasn't advanced past the SLA threshold. Escalations triggered.
- **E-signature integration:** `requireESignature` preEffect calls into ADR-0008's signature challenge endpoint; on success, attaches the signature proof to the audit row.
- **Compensation execution:** ordered reverse of completed steps; idempotency via step-completion markers.
- **Testing:**
  - Unit tests for DSL parsing and validation.
  - Inngest local-runtime tests for orchestration behavior (steps, branches, parallel).
  - Property tests for state machine invariants (no transitions from terminal states; every state reachable from initial state if reachable from any non-terminal).
  - Snapshot tests for compiled Inngest function output.
  - E2E tests for designer round-trip (designer → JSON → Inngest → execution → designer view).
- **Observability** (ADR-0017): per-workflow execution time, retry counts, failure rates, p50/p95 latency. Per-orchestration dashboard.
- **AI Architect tool integration:** the agent's `proposeManifestPatch` includes workflow changes; the preview/diff explainer (ADR-0005) renders workflow diffs as side-by-side state-machine diagrams.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Inngest pricing model at v1 — Inngest's free tier covers up to N runs/month; pricing tier transitions affect unit economics. | amoufaq5 | Phase 2 |
| Designer feature parity vs. AI Architect — is the visual designer expected to express the full DSL, or a curated subset (entityLifecycle only at v1)? | amoufaq5 | Phase 3 |
| Workflow versioning UX — in-flight orchestrations continue under their original version; how does the UI surface "this prescription is on workflow v2.4; the active version is v2.6"? | _pending design hire_ | Phase 4 |
| Long-running orchestration timeouts — at what duration does an orchestration become a long-running concern (UI surfacing, ops alerts)? Months for vaccination cohorts; years for change-controls. | amoufaq5 | Phase 4 |
| Compensation guarantees — best-effort or transactional? Compensations that fail leave the system in partial-rollback state. | amoufaq5 + _pending compliance hire_ | Phase 5 |
| External event ingestion — when do we let workflows subscribe to external (third-party) events directly, vs. through the integration mesh (ADR-0011)? | amoufaq5 | Phase 4 |

## References

- ADR-0003 (Meta-schema and dynamic entity engine) — defines entities and state fields workflows operate on.
- ADR-0004 (Manifest specification) — defines the `workflows` manifest section.
- ADR-0008 (RBAC v2, ABAC, audit) — defines guards and audit emission on transitions.
- ADR-0011 (Integration mesh) — defines integration calls invoked from workflow effects.
- ADR-0012 (Compliance pack architecture) — defines pack-imposed workflow constraints.
- ADR-0015 (Jobs and async runtime) — defines the Inngest job layer used by workflow effects.
- Inngest documentation; React Flow documentation; Saga pattern (Garcia-Molina + Salem); Temporal.io (alternative).
