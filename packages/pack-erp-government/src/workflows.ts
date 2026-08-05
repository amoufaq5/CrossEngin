import type { Workflow } from "@crossengin/kernel/workflow";

export const CASE_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Case",
  stateField: "state",
  initialState: "intake",
  states: [
    { name: "intake", label: { en: "Intake" }, category: "active" },
    { name: "under_review", label: { en: "Under review" }, category: "active" },
    { name: "approved", label: { en: "Approved" }, category: "active" },
    { name: "denied", label: { en: "Denied" }, category: "active" },
    { name: "closed", label: { en: "Closed" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "submit_for_review",
      from: "intake",
      to: "under_review",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Case.transition.submit_for_review" }],
    },
    {
      name: "approve",
      from: "under_review",
      to: "approved",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Case.transition.approve" }],
    },
    {
      name: "deny",
      from: "under_review",
      to: "denied",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Case.transition.deny" }],
    },
    {
      name: "close",
      from: ["approved", "denied"],
      to: "closed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Case.transition.close" }],
    },
  ],
  slas: [
    {
      name: "intake_to_review_3d",
      from: "intake",
      to: "under_review",
      deadline: "P3D",
      businessHoursOnly: true,
      escalation: "notify_case_supervisor",
    },
  ],
};

export const ERP_GOVERNMENT_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  case_lifecycle: CASE_LIFECYCLE_WORKFLOW,
};
