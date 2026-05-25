import type { Workflow } from "@crossengin/kernel/workflow";

export const INVOICE_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Invoice",
  stateField: "state",
  initialState: "draft",
  states: [
    { name: "draft", label: { en: "Draft" }, category: "active" },
    { name: "sent", label: { en: "Sent" }, category: "active" },
    { name: "overdue", label: { en: "Overdue" }, category: "active" },
    { name: "paid", label: { en: "Paid" }, category: "terminal" },
    { name: "void", label: { en: "Void" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "send",
      from: "draft",
      to: "sent",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Invoice.transition.send" }],
    },
    {
      name: "mark_overdue",
      from: "sent",
      to: "overdue",
      trigger: { kind: "automatic" },
    },
    {
      name: "mark_paid",
      from: ["sent", "overdue"],
      to: "paid",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Invoice.transition.mark_paid" }],
    },
    {
      name: "void",
      from: ["draft", "sent", "overdue"],
      to: "void",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Invoice.transition.void" }],
    },
  ],
  slas: [
    {
      name: "sent_to_paid_30d",
      from: "sent",
      to: "paid",
      deadline: "P30D",
      businessHoursOnly: false,
      escalation: "notify_accountant",
    },
  ],
};

export const ERP_CORE_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  invoice_lifecycle: INVOICE_LIFECYCLE_WORKFLOW,
};
