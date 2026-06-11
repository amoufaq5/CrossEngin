import type { Relation } from "@crossengin/types/meta-schema";

// Cross-pack: `from` is the core ERP `Account` (the client commissioning the work).
export const ACCOUNT_PROJECTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "projects",
  to: "Project",
  onDelete: "cascade",
};

export const PROJECT_COST_CODES_RELATION: Relation = {
  kind: "one_to_many",
  from: "Project",
  field: "cost_codes",
  to: "CostCode",
  onDelete: "cascade",
};

export const PROJECT_CHANGE_ORDERS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Project",
  field: "change_orders",
  to: "ChangeOrder",
  onDelete: "cascade",
};

export const PROJECT_DAILY_LOGS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Project",
  field: "daily_logs",
  to: "DailyLog",
  onDelete: "cascade",
};

// Cross-pack: an approved ChangeOrder optionally bills to a core ERP `Invoice`.
export const CHANGE_ORDER_INVOICE_RELATION: Relation = {
  kind: "many_to_one",
  from: "ChangeOrder",
  field: "invoice_id",
  to: "Invoice",
  onDelete: "restrict",
};

export const ERP_CONSTRUCTION_RELATIONS: readonly Relation[] = [
  ACCOUNT_PROJECTS_RELATION,
  PROJECT_COST_CODES_RELATION,
  PROJECT_CHANGE_ORDERS_RELATION,
  PROJECT_DAILY_LOGS_RELATION,
  CHANGE_ORDER_INVOICE_RELATION,
];
