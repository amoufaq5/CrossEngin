import type { Workflow } from "@crossengin/kernel/workflow";

/** Project lifecycle: planning → active → on_hold → completed | cancelled. */
export const PROJECT_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Project",
  stateField: "state",
  initialState: "planning",
  states: [
    { name: "planning", label: { en: "Planning" }, category: "active" },
    { name: "active", label: { en: "Active" }, category: "active" },
    { name: "on_hold", label: { en: "On hold" }, category: "active" },
    { name: "completed", label: { en: "Completed" }, category: "terminal" },
    { name: "cancelled", label: { en: "Cancelled" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "start",
      from: "planning",
      to: "active",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Project.transition.start" }],
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
      from: ["planning", "active", "on_hold"],
      to: "cancelled",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Project.transition.cancel" }],
    },
  ],
  slas: [
    {
      name: "active_to_completed_180d",
      from: "active",
      to: "completed",
      deadline: "P180D",
      businessHoursOnly: false,
      escalation: "notify_project_manager",
    },
  ],
};

/** Change-order approval lifecycle: draft → submitted → approved | rejected. */
export const CHANGE_ORDER_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "ChangeOrder",
  stateField: "co_state",
  initialState: "draft",
  states: [
    { name: "draft", label: { en: "Draft" }, category: "active" },
    { name: "submitted", label: { en: "Submitted" }, category: "active" },
    { name: "approved", label: { en: "Approved" }, category: "terminal" },
    { name: "rejected", label: { en: "Rejected" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "submit",
      from: "draft",
      to: "submitted",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "ChangeOrder.transition.submit" }],
    },
    {
      name: "approve",
      from: "submitted",
      to: "approved",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "ChangeOrder.transition.approve" }],
    },
    {
      name: "reject",
      from: "submitted",
      to: "rejected",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "ChangeOrder.transition.reject" }],
    },
  ],
};

export const ERP_CONSTRUCTION_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  project_lifecycle: PROJECT_LIFECYCLE_WORKFLOW,
  change_order_lifecycle: CHANGE_ORDER_LIFECYCLE_WORKFLOW,
};
