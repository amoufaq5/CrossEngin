import type { Workflow } from "@crossengin/kernel/workflow";

export const SALES_ORDER_LIFECYCLE_WORKFLOW: Workflow = {
  kind: "entityLifecycle",
  entity: "SalesOrder",
  stateField: "state",
  initialState: "cart",
  states: [
    { name: "cart", label: { en: "Cart" }, category: "active" },
    { name: "placed", label: { en: "Placed" }, category: "active" },
    { name: "fulfilled", label: { en: "Fulfilled" }, category: "active" },
    { name: "cancelled", label: { en: "Cancelled" }, category: "terminal" },
    { name: "returned", label: { en: "Returned" }, category: "terminal" },
  ],
  transitions: [
    {
      name: "place",
      from: "cart",
      to: "placed",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "SalesOrder.transition.place" }],
    },
    {
      name: "fulfill",
      from: "placed",
      to: "fulfilled",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "SalesOrder.transition.fulfill" }],
    },
    {
      name: "cancel",
      from: ["cart", "placed"],
      to: "cancelled",
      trigger: { kind: "userAction" },
      guards: [{ kind: "permission", permission: "SalesOrder.transition.cancel" }],
    },
    {
      name: "mark_returned",
      from: "fulfilled",
      to: "returned",
      trigger: { kind: "userAction" },
      guards: [
        { kind: "permission", permission: "SalesOrder.transition.mark_returned" },
      ],
    },
  ],
  slas: [
    {
      name: "placed_to_fulfilled_2d",
      from: "placed",
      to: "fulfilled",
      deadline: "P2D",
      businessHoursOnly: true,
      escalation: "notify_store_manager",
    },
  ],
};

export const ERP_RETAIL_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  sales_order_lifecycle: SALES_ORDER_LIFECYCLE_WORKFLOW,
};
