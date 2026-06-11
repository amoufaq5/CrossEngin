import type { Workflow } from "@crossengin/kernel/workflow";

/** Course catalog lifecycle: draft → open → closed → archived. */
export const COURSE_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Course",
  stateField: "state",
  initialState: "draft",
  states: [
    { name: "draft", label: { en: "Draft" }, category: "active" },
    { name: "open", label: { en: "Open" }, category: "active" },
    { name: "closed", label: { en: "Closed" }, category: "active" },
    { name: "archived", label: { en: "Archived" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "publish",
      from: "draft",
      to: "open",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Course.transition.publish" }],
    },
    {
      name: "close",
      from: "open",
      to: "closed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Course.transition.close" }],
    },
    {
      name: "archive",
      from: "closed",
      to: "archived",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Course.transition.archive" }],
    },
  ],
};

/** Enrollment lifecycle: enrolled → in_progress → completed | withdrawn | failed. */
export const ENROLLMENT_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Enrollment",
  stateField: "state",
  initialState: "enrolled",
  states: [
    { name: "enrolled", label: { en: "Enrolled" }, category: "active" },
    { name: "in_progress", label: { en: "In progress" }, category: "active" },
    { name: "completed", label: { en: "Completed" }, category: "terminal" },
    { name: "withdrawn", label: { en: "Withdrawn" }, category: "terminal" },
    { name: "failed", label: { en: "Failed" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "begin",
      from: "enrolled",
      to: "in_progress",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Enrollment.transition.begin" }],
    },
    {
      name: "complete",
      from: "in_progress",
      to: "completed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Enrollment.transition.complete" }],
    },
    {
      name: "fail",
      from: "in_progress",
      to: "failed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Enrollment.transition.fail" }],
    },
    {
      name: "withdraw",
      from: ["enrolled", "in_progress"],
      to: "withdrawn",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Enrollment.transition.withdraw" }],
    },
  ],
};

export const ERP_EDUCATION_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  course_lifecycle: COURSE_LIFECYCLE_WORKFLOW,
  enrollment_lifecycle: ENROLLMENT_LIFECYCLE_WORKFLOW,
};
