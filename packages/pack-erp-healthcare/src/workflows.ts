import type { Workflow } from "@crossengin/kernel/workflow";

export const ENCOUNTER_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Encounter",
  stateField: "state",
  initialState: "scheduled",
  states: [
    { name: "scheduled", label: { en: "Scheduled" }, category: "active" },
    { name: "in_progress", label: { en: "In progress" }, category: "active" },
    { name: "completed", label: { en: "Completed" }, category: "terminal" },
    { name: "cancelled", label: { en: "Cancelled" }, category: "terminal" },
    { name: "no_show", label: { en: "No show" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "check_in",
      from: "scheduled",
      to: "in_progress",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Encounter.transition.check_in" }],
    },
    {
      name: "complete",
      from: "in_progress",
      to: "completed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Encounter.transition.complete" }],
    },
    {
      name: "cancel",
      from: ["scheduled", "in_progress"],
      to: "cancelled",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Encounter.transition.cancel" }],
    },
    {
      name: "mark_no_show",
      from: "scheduled",
      to: "no_show",
      trigger: { kind: "automatic" },
    },
  ],
  slas: [
    {
      name: "scheduled_to_completed_1d",
      from: "scheduled",
      to: "completed",
      deadline: "P1D",
      businessHoursOnly: true,
      escalation: "notify_front_desk",
    },
  ],
};

export const ERP_HEALTHCARE_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  encounter_lifecycle: ENCOUNTER_LIFECYCLE_WORKFLOW,
};
