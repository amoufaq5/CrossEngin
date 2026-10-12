import type { EntityLifecycleWorkflow, Workflow } from "@crossengin/kernel/workflow";

export const PROJECT_LIFECYCLE_WORKFLOW: EntityLifecycleWorkflow = {
  kind: "entityLifecycle",
  entity: "Project",
  stateField: "status",
  initialState: "bidding",
  states: [
    { name: "bidding", label: { en: "Bidding" }, category: "active" },
    { name: "active", label: { en: "Active" }, category: "active" },
    { name: "on_hold", label: { en: "On hold" }, category: "active" },
    { name: "completed", label: { en: "Completed" }, category: "terminal" },
    { name: "cancelled", label: { en: "Cancelled" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "start_work",
      from: "bidding",
      to: "active",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Project.transition.start_work" }],
    },
    {
      name: "hold",
      from: "active",
      to: "on_hold",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Project.transition.hold" }],
    },
    {
      name: "resume",
      from: "on_hold",
      to: "active",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Project.transition.resume" }],
    },
    {
      name: "complete",
      from: "active",
      to: "completed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Project.transition.complete" }],
    },
    {
      name: "cancel",
      from: ["bidding", "active", "on_hold"],
      to: "cancelled",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Project.transition.cancel" }],
    },
  ],
  slas: [
    {
      name: "active_to_completed_90d",
      from: "active",
      to: "completed",
      deadline: "P90D",
      businessHoursOnly: false,
      escalation: "notify_project_manager",
    },
  ],
};

/**
 * Replaces core's `work_order_lifecycle`, which this pack's `WorkOrder` outgrew the moment it
 * declared `overrides: true`.
 *
 * Core's manufacturing work order has a `state` column over
 * `planned → released → in_progress → completed`; construction's is a subcontractor order with a
 * `status` column over `draft → scheduled → in_progress → done`. The entity was replaced and the
 * lifecycle was not, so until now this pack inherited a workflow naming a field no entity here has.
 * Nothing caught it: `stateField` was `z.string().min(1)` and the only check on an
 * `entityLifecycle` was that its *entity* exists.
 *
 * What it cost was not the transitions — no role in this pack is granted core's `release`/`start`/
 * `complete`, so they were unreachable anyway — but the **list surface**:
 * `withLifecycleStateFilter` adds the state field to `filterableFields` unconditionally, so
 * `?state=` became a filter against a phantom column that the two Postgres stores answer
 * *oppositely* (every row, or none). Keyed `work_order_lifecycle` so it overrides rather than
 * joining core's, since `mergeRecord` lets the overlay win by key.
 */
export const WORK_ORDER_LIFECYCLE_WORKFLOW: EntityLifecycleWorkflow = {
  kind: "entityLifecycle",
  entity: "WorkOrder",
  stateField: "status",
  initialState: "draft",
  states: [
    { name: "draft", label: { en: "Draft" }, category: "active" },
    { name: "scheduled", label: { en: "Scheduled" }, category: "active" },
    { name: "in_progress", label: { en: "In progress" }, category: "active" },
    { name: "done", label: { en: "Done" }, category: "terminal" },
    { name: "cancelled", label: { en: "Cancelled" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "schedule",
      from: "draft",
      to: "scheduled",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "WorkOrder.transition.schedule" }],
    },
    {
      name: "start",
      from: "scheduled",
      to: "in_progress",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "WorkOrder.transition.start" }],
    },
    {
      name: "complete",
      from: "in_progress",
      to: "done",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "WorkOrder.transition.complete" }],
    },
    {
      name: "cancel",
      from: ["draft", "scheduled", "in_progress"],
      to: "cancelled",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "WorkOrder.transition.cancel" }],
    },
  ],
};

export const ERP_CONSTRUCTION_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  project_lifecycle: PROJECT_LIFECYCLE_WORKFLOW,
  work_order_lifecycle: WORK_ORDER_LIFECYCLE_WORKFLOW,
};
