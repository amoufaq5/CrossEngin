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
      guards: [
        { kind: "permission", permission: "Invoice.transition.mark_paid" },
      ],
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

export const PURCHASE_ORDER_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "PurchaseOrder",
  stateField: "state",
  initialState: "draft",
  states: [
    { name: "draft", label: { en: "Draft" }, category: "active" },
    { name: "submitted", label: { en: "Submitted" }, category: "active" },
    { name: "approved", label: { en: "Approved" }, category: "active" },
    { name: "received", label: { en: "Received" }, category: "active" },
    { name: "closed", label: { en: "Closed" }, category: "terminal" },
    { name: "cancelled", label: { en: "Cancelled" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "submit",
      from: "draft",
      to: "submitted",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "PurchaseOrder.transition.submit" }],
    },
    {
      name: "approve",
      from: "submitted",
      to: "approved",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "PurchaseOrder.transition.approve" }],
    },
    {
      name: "receive",
      from: "approved",
      to: "received",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "PurchaseOrder.transition.receive" }],
    },
    {
      name: "close",
      from: "received",
      to: "closed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "PurchaseOrder.transition.close" }],
    },
    {
      name: "cancel",
      from: ["draft", "submitted", "approved"],
      to: "cancelled",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "PurchaseOrder.transition.cancel" }],
    },
  ],
  slas: [
    {
      name: "submitted_to_approved_3d",
      from: "submitted",
      to: "approved",
      deadline: "P3D",
      businessHoursOnly: true,
      escalation: "notify_procurement_manager",
    },
  ],
};

export const BILL_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Bill",
  stateField: "state",
  initialState: "draft",
  states: [
    { name: "draft", label: { en: "Draft" }, category: "active" },
    { name: "approved", label: { en: "Approved" }, category: "active" },
    { name: "overdue", label: { en: "Overdue" }, category: "active" },
    { name: "paid", label: { en: "Paid" }, category: "terminal" },
    { name: "void", label: { en: "Void" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "approve",
      from: "draft",
      to: "approved",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Bill.transition.approve" }],
    },
    {
      name: "mark_overdue",
      from: "approved",
      to: "overdue",
      trigger: { kind: "automatic" },
    },
    {
      name: "mark_paid",
      from: ["approved", "overdue"],
      to: "paid",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Bill.transition.mark_paid" }],
    },
    {
      name: "void",
      from: ["draft", "approved", "overdue"],
      to: "void",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Bill.transition.void" }],
    },
  ],
  slas: [
    {
      name: "approved_to_paid_due",
      from: "approved",
      to: "paid",
      deadline: "P30D",
      businessHoursOnly: false,
      escalation: "notify_ap_clerk",
    },
  ],
};

export const PAYMENT_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Payment",
  stateField: "state",
  initialState: "draft",
  states: [
    { name: "draft", label: { en: "Draft" }, category: "active" },
    { name: "pending", label: { en: "Pending" }, category: "active" },
    { name: "completed", label: { en: "Completed" }, category: "active" },
    { name: "failed", label: { en: "Failed" }, category: "terminal" },
    { name: "refunded", label: { en: "Refunded" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "submit",
      from: "draft",
      to: "pending",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Payment.transition.submit" }],
    },
    {
      name: "complete",
      from: "pending",
      to: "completed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Payment.transition.complete" }],
    },
    {
      name: "fail",
      from: "pending",
      to: "failed",
      trigger: { kind: "automatic" },
    },
    {
      name: "refund",
      from: "completed",
      to: "refunded",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Payment.transition.refund" }],
    },
  ],
};

export const JOURNAL_ENTRY_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "JournalEntry",
  stateField: "state",
  initialState: "draft",
  states: [
    { name: "draft", label: { en: "Draft" }, category: "active" },
    { name: "posted", label: { en: "Posted" }, category: "active" },
    { name: "reversed", label: { en: "Reversed" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "post",
      from: "draft",
      to: "posted",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "JournalEntry.transition.post" }],
    },
    {
      name: "reverse",
      from: "posted",
      to: "reversed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "JournalEntry.transition.reverse" }],
    },
  ],
};

export const EXPENSE_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "Expense",
  stateField: "state",
  initialState: "draft",
  states: [
    { name: "draft", label: { en: "Draft" }, category: "active" },
    { name: "submitted", label: { en: "Submitted" }, category: "active" },
    { name: "approved", label: { en: "Approved" }, category: "active" },
    { name: "reimbursed", label: { en: "Reimbursed" }, category: "terminal" },
    { name: "rejected", label: { en: "Rejected" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "submit",
      from: "draft",
      to: "submitted",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Expense.transition.submit" }],
    },
    {
      name: "approve",
      from: "submitted",
      to: "approved",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Expense.transition.approve" }],
    },
    {
      name: "reimburse",
      from: "approved",
      to: "reimbursed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Expense.transition.reimburse" }],
    },
    {
      name: "reject",
      from: ["submitted", "approved"],
      to: "rejected",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "Expense.transition.reject" }],
    },
  ],
};

export const LEAVE_REQUEST_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "LeaveRequest",
  stateField: "state",
  initialState: "draft",
  states: [
    { name: "draft", label: { en: "Draft" }, category: "active" },
    { name: "submitted", label: { en: "Submitted" }, category: "active" },
    { name: "approved", label: { en: "Approved" }, category: "terminal" },
    { name: "rejected", label: { en: "Rejected" }, category: "terminal" },
    { name: "cancelled", label: { en: "Cancelled" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "submit",
      from: "draft",
      to: "submitted",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "LeaveRequest.transition.submit" }],
    },
    {
      name: "approve",
      from: "submitted",
      to: "approved",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "LeaveRequest.transition.approve" }],
    },
    {
      name: "reject",
      from: "submitted",
      to: "rejected",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "LeaveRequest.transition.reject" }],
    },
    {
      name: "cancel",
      from: ["draft", "submitted"],
      to: "cancelled",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "LeaveRequest.transition.cancel" }],
    },
  ],
};

export const ERP_CORE_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  invoice_lifecycle: INVOICE_LIFECYCLE_WORKFLOW,
  purchase_order_lifecycle: PURCHASE_ORDER_LIFECYCLE_WORKFLOW,
  bill_lifecycle: BILL_LIFECYCLE_WORKFLOW,
  payment_lifecycle: PAYMENT_LIFECYCLE_WORKFLOW,
  journal_entry_lifecycle: JOURNAL_ENTRY_LIFECYCLE_WORKFLOW,
  expense_lifecycle: EXPENSE_LIFECYCLE_WORKFLOW,
  leave_request_lifecycle: LEAVE_REQUEST_LIFECYCLE_WORKFLOW,
};
