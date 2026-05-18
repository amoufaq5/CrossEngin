import type { Workflow } from "@crossengin/kernel/workflow";

export const PAYMENT_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Payment",
  stateField: "state",
  initialState: "pending",
  states: [
    { name: "pending", label: { en: "Pending" }, category: "active" },
    { name: "captured", label: { en: "Captured" }, category: "active" },
    { name: "settled", label: { en: "Settled" }, category: "active" },
    { name: "refunded", label: { en: "Refunded" }, category: "terminal" },
    { name: "failed", label: { en: "Failed" }, category: "terminal" },
    { name: "cancelled", label: { en: "Cancelled" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "capture",
      from: "pending",
      to: "captured",
      trigger: { kind: "automatic" },
      guards: [
        { kind: "permission", permission: "Payment.transition.capture" },
      ],
    },
    {
      name: "settle",
      from: "captured",
      to: "settled",
      trigger: { kind: "automatic" },
      guards: [
        { kind: "permission", permission: "Payment.transition.settle" },
      ],
    },
    {
      name: "refund",
      from: ["captured", "settled"],
      to: "refunded",
      trigger: { kind: "userAction" },
      guards: [
        { kind: "permission", permission: "Payment.transition.refund" },
      ],
    },
    {
      name: "fail",
      from: "pending",
      to: "failed",
      trigger: { kind: "automatic" },
    },
    {
      name: "cancel",
      from: "pending",
      to: "cancelled",
      trigger: { kind: "userAction" },
      guards: [
        { kind: "permission", permission: "Payment.transition.cancel" },
      ],
    },
  ],
  slas: [
    {
      name: "pending_to_captured_24h",
      from: "pending",
      to: "captured",
      deadline: "P1D",
      businessHoursOnly: false,
      escalation: "notify_billing_ops",
    },
    {
      name: "captured_to_settled_5d",
      from: "captured",
      to: "settled",
      deadline: "P5D",
      businessHoursOnly: false,
      escalation: "notify_billing_ops",
    },
  ],
};

export const ERP_PAYMENTS_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  payment_lifecycle: PAYMENT_LIFECYCLE_WORKFLOW,
};
