import type { Workflow } from "@crossengin/kernel/workflow";

export const ENCOUNTER_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Encounter",
  stateField: "state",
  initialState: "scheduled",
  states: [
    { name: "scheduled", label: { en: "Scheduled" }, category: "active" },
    { name: "checked_in", label: { en: "Checked in" }, category: "active" },
    { name: "in_progress", label: { en: "In progress" }, category: "active" },
    { name: "completed", label: { en: "Completed" }, category: "terminal" },
    { name: "cancelled", label: { en: "Cancelled" }, category: "terminal" },
    { name: "no_show", label: { en: "No show" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "check_in",
      from: "scheduled",
      to: "checked_in",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Encounter.transition.check_in" }],
    },
    {
      name: "start",
      from: "checked_in",
      to: "in_progress",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Encounter.transition.start" }],
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
      from: ["scheduled", "checked_in"],
      to: "cancelled",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Encounter.transition.cancel" }],
    },
    {
      name: "mark_no_show",
      from: ["scheduled", "checked_in"],
      to: "no_show",
      trigger: { kind: "automatic" },
      guards: [{ kind: "permission", permission: "Encounter.transition.mark_no_show" }],
    },
  ],
  slas: [
    {
      name: "checked_in_to_in_progress_30m",
      from: "checked_in",
      to: "in_progress",
      deadline: "PT30M",
      businessHoursOnly: true,
      escalation: "notify_front_desk",
    },
    {
      name: "in_progress_to_completed_1d",
      from: "in_progress",
      to: "completed",
      deadline: "P1D",
      businessHoursOnly: false,
      escalation: "notify_clinic_manager",
    },
  ],
};

export const OBSERVATION_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Observation",
  stateField: "status",
  initialState: "preliminary",
  states: [
    { name: "preliminary", label: { en: "Preliminary" }, category: "active" },
    { name: "final", label: { en: "Final" }, category: "active" },
    { name: "amended", label: { en: "Amended" }, category: "active" },
    {
      name: "entered_in_error",
      label: { en: "Entered in error" },
      category: "terminal",
    },
  ],
  transitions: [
    {
      name: "finalize",
      from: "preliminary",
      to: "final",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Observation.transition.finalize" }],
    },
    {
      name: "amend",
      from: ["final", "amended"],
      to: "amended",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Observation.transition.amend" }],
    },
    {
      name: "mark_in_error",
      from: ["preliminary", "final", "amended"],
      to: "entered_in_error",
      trigger: { kind: "userAction" },
      guards: [
        {
          kind: "permission",
          permission: "Observation.transition.mark_in_error",
        },
      ],
    },
  ],
};

export const ERP_HEALTHCARE_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  encounter_lifecycle: ENCOUNTER_LIFECYCLE_WORKFLOW,
  observation_lifecycle: OBSERVATION_LIFECYCLE_WORKFLOW,
};
