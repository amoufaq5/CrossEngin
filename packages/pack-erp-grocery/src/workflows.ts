import type { Workflow } from "@crossengin/kernel/workflow";

export const PERISHABLE_LOT_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "PerishableLot",
  stateField: "state",
  initialState: "received",
  states: [
    { name: "received", label: { en: "Received" }, category: "active" },
    { name: "on_shelf", label: { en: "On shelf" }, category: "active" },
    { name: "depleted", label: { en: "Depleted" }, category: "terminal" },
    { name: "expired", label: { en: "Expired" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "shelve",
      from: "received",
      to: "on_shelf",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "PerishableLot.transition.shelve" }],
    },
    {
      name: "deplete",
      from: "on_shelf",
      to: "depleted",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "PerishableLot.transition.deplete" }],
    },
    {
      name: "expire",
      from: ["received", "on_shelf"],
      to: "expired",
      trigger: { kind: "automatic" },
    },
  ],
  slas: [
    {
      name: "received_to_shelf_1d",
      from: "received",
      to: "on_shelf",
      deadline: "P1D",
      businessHoursOnly: true,
      escalation: "notify_grocery_admin",
    },
  ],
};

export const ERP_GROCERY_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  perishable_lot_lifecycle: PERISHABLE_LOT_LIFECYCLE_WORKFLOW,
};
