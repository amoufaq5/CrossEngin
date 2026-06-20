import type { Workflow } from "@crossengin/kernel/workflow";

interface TransitionDef {
  readonly name: string;
  readonly from: string | string[];
  readonly to: string;
}

/**
 * Builds an `entityLifecycle` workflow: every named state becomes an `active`
 * state unless listed in `terminals`, and every transition carries a permission
 * guard `<Entity>.transition.<name>` (matched by the entity's permission set).
 */
function lifecycle(
  entity: string,
  stateField: string,
  initialState: string,
  states: readonly string[],
  terminals: readonly string[],
  transitions: readonly TransitionDef[],
): Workflow {
  const terminalSet = new Set(terminals);
  return {
    kind: "entityLifecycle",
    entity,
    stateField,
    initialState,
    states: states.map((name) => ({
      name,
      label: { en: name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) },
      category: terminalSet.has(name) ? "terminal" : "active",
    })),
    transitions: transitions.map((t) => ({
      name: t.name,
      from: t.from,
      to: t.to,
      trigger: { kind: "userAction" as const },
      guards: [{ kind: "permission" as const, permission: `${entity}.transition.${t.name}` }],
    })),
  };
}

export const LEAD_LIFECYCLE = lifecycle(
  "Lead",
  "state",
  "new",
  ["new", "working", "qualified", "converted", "disqualified"],
  ["converted", "disqualified"],
  [
    { name: "start_working", from: "new", to: "working" },
    { name: "qualify", from: "working", to: "qualified" },
    { name: "convert", from: "qualified", to: "converted" },
    { name: "disqualify", from: ["new", "working", "qualified"], to: "disqualified" },
  ],
);

export const OPPORTUNITY_LIFECYCLE = lifecycle(
  "Opportunity",
  "stage",
  "prospecting",
  ["prospecting", "qualification", "proposal", "negotiation", "won", "lost"],
  ["won", "lost"],
  [
    { name: "advance_to_qualification", from: "prospecting", to: "qualification" },
    { name: "advance_to_proposal", from: "qualification", to: "proposal" },
    { name: "advance_to_negotiation", from: "proposal", to: "negotiation" },
    { name: "win", from: "negotiation", to: "won" },
    { name: "lose", from: ["prospecting", "qualification", "proposal", "negotiation"], to: "lost" },
  ],
);

export const QUOTE_LIFECYCLE = lifecycle(
  "Quote",
  "state",
  "draft",
  ["draft", "sent", "accepted", "rejected", "expired"],
  ["accepted", "rejected", "expired"],
  [
    { name: "send", from: "draft", to: "sent" },
    { name: "accept", from: "sent", to: "accepted" },
    { name: "reject", from: "sent", to: "rejected" },
    { name: "expire", from: "sent", to: "expired" },
  ],
);

export const SALES_ORDER_LIFECYCLE = lifecycle(
  "SalesOrder",
  "state",
  "draft",
  ["draft", "confirmed", "fulfilled", "invoiced", "closed", "cancelled"],
  ["closed", "cancelled"],
  [
    { name: "confirm", from: "draft", to: "confirmed" },
    { name: "fulfill", from: "confirmed", to: "fulfilled" },
    { name: "invoice", from: "fulfilled", to: "invoiced" },
    { name: "close", from: "invoiced", to: "closed" },
    { name: "cancel", from: ["draft", "confirmed"], to: "cancelled" },
  ],
);

export const SHIPMENT_LIFECYCLE = lifecycle(
  "Shipment",
  "state",
  "pending",
  ["pending", "picked", "packed", "shipped", "delivered", "cancelled"],
  ["delivered", "cancelled"],
  [
    { name: "pick", from: "pending", to: "picked" },
    { name: "pack", from: "picked", to: "packed" },
    { name: "ship", from: "packed", to: "shipped" },
    { name: "deliver", from: "shipped", to: "delivered" },
    { name: "cancel", from: ["pending", "picked", "packed"], to: "cancelled" },
  ],
);

export const WORK_ORDER_LIFECYCLE = lifecycle(
  "WorkOrder",
  "state",
  "planned",
  ["planned", "released", "in_progress", "completed", "cancelled"],
  ["completed", "cancelled"],
  [
    { name: "release", from: "planned", to: "released" },
    { name: "start", from: "released", to: "in_progress" },
    { name: "complete", from: "in_progress", to: "completed" },
    { name: "cancel", from: ["planned", "released", "in_progress"], to: "cancelled" },
  ],
);

export const PROJECT_LIFECYCLE = lifecycle(
  "Project",
  "state",
  "planning",
  ["planning", "active", "on_hold", "completed", "cancelled"],
  ["completed", "cancelled"],
  [
    { name: "activate", from: "planning", to: "active" },
    { name: "hold", from: "active", to: "on_hold" },
    { name: "resume", from: "on_hold", to: "active" },
    { name: "complete", from: "active", to: "completed" },
    { name: "cancel", from: ["planning", "active", "on_hold"], to: "cancelled" },
  ],
);

export const PROJECT_TASK_LIFECYCLE = lifecycle(
  "ProjectTask",
  "state",
  "todo",
  ["todo", "in_progress", "review", "done", "cancelled"],
  ["done", "cancelled"],
  [
    { name: "start", from: "todo", to: "in_progress" },
    { name: "submit_review", from: "in_progress", to: "review" },
    { name: "complete", from: "review", to: "done" },
    { name: "cancel", from: ["todo", "in_progress", "review"], to: "cancelled" },
  ],
);

export const TIMESHEET_LIFECYCLE = lifecycle(
  "Timesheet",
  "state",
  "draft",
  ["draft", "submitted", "approved", "rejected"],
  ["approved", "rejected"],
  [
    { name: "submit", from: "draft", to: "submitted" },
    { name: "approve", from: "submitted", to: "approved" },
    { name: "reject", from: "submitted", to: "rejected" },
  ],
);

export const FIXED_ASSET_LIFECYCLE = lifecycle(
  "FixedAsset",
  "state",
  "in_service",
  ["in_service", "under_maintenance", "retired", "disposed"],
  ["disposed"],
  [
    { name: "send_to_maintenance", from: "in_service", to: "under_maintenance" },
    { name: "return_to_service", from: "under_maintenance", to: "in_service" },
    { name: "retire", from: ["in_service", "under_maintenance"], to: "retired" },
    { name: "dispose", from: ["in_service", "under_maintenance", "retired"], to: "disposed" },
  ],
);

export const MAINTENANCE_ORDER_LIFECYCLE = lifecycle(
  "MaintenanceOrder",
  "state",
  "requested",
  ["requested", "scheduled", "in_progress", "completed", "cancelled"],
  ["completed", "cancelled"],
  [
    { name: "schedule", from: "requested", to: "scheduled" },
    { name: "start", from: "scheduled", to: "in_progress" },
    { name: "complete", from: "in_progress", to: "completed" },
    { name: "cancel", from: ["requested", "scheduled", "in_progress"], to: "cancelled" },
  ],
);

export const TAX_RETURN_LIFECYCLE = lifecycle(
  "TaxReturn",
  "state",
  "draft",
  ["draft", "ready", "filed", "paid", "amended"],
  ["paid"],
  [
    { name: "mark_ready", from: "draft", to: "ready" },
    { name: "file", from: "ready", to: "filed" },
    { name: "mark_paid", from: "filed", to: "paid" },
    { name: "amend", from: "filed", to: "amended" },
    { name: "refile", from: "amended", to: "filed" },
  ],
);

export const ERP_EXT_WORKFLOWS: Readonly<Record<string, Workflow>> = {
  lead_lifecycle: LEAD_LIFECYCLE,
  opportunity_lifecycle: OPPORTUNITY_LIFECYCLE,
  quote_lifecycle: QUOTE_LIFECYCLE,
  sales_order_lifecycle: SALES_ORDER_LIFECYCLE,
  shipment_lifecycle: SHIPMENT_LIFECYCLE,
  work_order_lifecycle: WORK_ORDER_LIFECYCLE,
  project_lifecycle: PROJECT_LIFECYCLE,
  project_task_lifecycle: PROJECT_TASK_LIFECYCLE,
  timesheet_lifecycle: TIMESHEET_LIFECYCLE,
  fixed_asset_lifecycle: FIXED_ASSET_LIFECYCLE,
  maintenance_order_lifecycle: MAINTENANCE_ORDER_LIFECYCLE,
  tax_return_lifecycle: TAX_RETURN_LIFECYCLE,
};

/** Transition names per entity, so the permission sets can grant them. */
export const ERP_EXT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  Lead: ["start_working", "qualify", "convert", "disqualify"],
  Opportunity: ["advance_to_qualification", "advance_to_proposal", "advance_to_negotiation", "win", "lose"],
  Quote: ["send", "accept", "reject", "expire"],
  SalesOrder: ["confirm", "fulfill", "invoice", "close", "cancel"],
  Shipment: ["pick", "pack", "ship", "deliver", "cancel"],
  WorkOrder: ["release", "start", "complete", "cancel"],
  Project: ["activate", "hold", "resume", "complete", "cancel"],
  ProjectTask: ["start", "submit_review", "complete", "cancel"],
  Timesheet: ["submit", "approve", "reject"],
  FixedAsset: ["send_to_maintenance", "return_to_service", "retire", "dispose"],
  MaintenanceOrder: ["schedule", "start", "complete", "cancel"],
  TaxReturn: ["mark_ready", "file", "mark_paid", "amend", "refile"],
};
