import type { Workflow } from "@crossengin/kernel/workflow";

export const ENROLLMENT_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Enrollment",
  stateField: "status",
  initialState: "enrolled",
  states: [
    { name: "enrolled", label: { en: "Enrolled" }, category: "active" },
    { name: "active", label: { en: "Active" }, category: "active" },
    { name: "completed", label: { en: "Completed" }, category: "terminal" },
    { name: "withdrawn", label: { en: "Withdrawn" }, category: "terminal" },
    { name: "failed", label: { en: "Failed" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "activate",
      from: "enrolled",
      to: "active",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Enrollment.transition.activate" }],
    },
    {
      name: "complete",
      from: "active",
      to: "completed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Enrollment.transition.complete" }],
    },
    {
      name: "withdraw",
      from: ["enrolled", "active"],
      to: "withdrawn",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Enrollment.transition.withdraw" }],
    },
    {
      name: "fail",
      from: "active",
      to: "failed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Enrollment.transition.fail" }],
    },
  ],
  slas: [
    {
      name: "active_to_completed_term",
      from: "active",
      to: "completed",
      deadline: "P120D",
      businessHoursOnly: false,
      escalation: "notify_registrar",
    },
  ],
};

export const ERP_EDUCATION_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  enrollment_lifecycle: ENROLLMENT_LIFECYCLE_WORKFLOW,
};
