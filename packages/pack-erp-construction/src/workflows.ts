import type { Workflow } from "@crossengin/kernel/workflow";

export const PROJECT_LIFECYCLE_WORKFLOW: Workflow = {
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

export const ERP_CONSTRUCTION_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  project_lifecycle: PROJECT_LIFECYCLE_WORKFLOW,
};
